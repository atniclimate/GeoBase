//! Node-witnessed export sessions — Phase B item B3
//! (`docs/CEREMONY-DESIGN.md` §4; hardened per review B3 F2).
//!
//! Before B3, `POST /api/export` trusted the request body's declared
//! `source_packs`: the node verified the declared packs existed but could
//! not verify **completeness**, so a caller could omit a contributing
//! higher-tier pack and evade the T3 floor (the T3-omission bypass). B3
//! closes it:
//!
//! - The node issues an unforgeable **export session id** when the app
//!   begins work (`POST /api/sessions`). Issuance requires the operator
//!   token, so a session is bound to the authenticated operator — a
//!   random local page cannot mint one (review B3 F2).
//! - Every pack the node serves into that session is accumulated **by the
//!   node** (the serving handlers witness the pack id whenever the
//!   session header accompanies a successful serve). The node only ever
//!   serves T0/T1 feature data, so a T3 source can never be served and
//!   therefore can never enter a session's source set.
//! - At export, the request names the session; the source set is **the
//!   node's own record — every pack served, period**. The request can
//!   neither add nor subtract. The session is **consumed (closed) at
//!   export** so it cannot be replayed or extended after its source set
//!   was snapshotted.
//! - No valid, open session bound to the requesting operator → the export
//!   is refused.
//!
//! Sessions are in-memory and per-boot on purpose: a session that
//! survived a crash would be a session whose accumulation record might be
//! incomplete — the fail-closed answer is to start over.
//!
//! **Honest residual (B5 boundary):** the serving endpoints are not yet
//! authenticated (only export is, via the interim A1 token), so serve-time
//! witnessing cannot bind the *serving* request to an operator. It does
//! not need to: T3 is never served, so it can never be omitted-from-session
//! at the node; a product derived from T3 data the operator holds OUTSIDE
//! the node is the physical-operator threat (Class C), explicitly out of
//! the app-mediated scope. B5's authenticated serve path tightens this
//! further.

use std::collections::{BTreeSet, HashMap};
use std::sync::Mutex;

/// The request header that attaches a serving request to an export
/// session. A non-breaking SDK addition: requests without it are served
/// exactly as before, but the packs they touch are witnessed by no
/// session and therefore can never appear in an export's source set.
pub const SESSION_HEADER: &str = "x-geobase-session";

/// One session's node-kept record: the operator it was issued to and the
/// set of packs the node served into it.
#[derive(Debug)]
struct SessionRecord {
    /// The operator identity (audit string) issuance was bound to.
    owner: String,
    packs: BTreeSet<String>,
}

/// The per-boot session registry. Interior mutability so the axum state
/// can share one registry across handlers.
#[derive(Debug, Default)]
pub struct SessionRegistry {
    sessions: Mutex<HashMap<String, SessionRecord>>,
}

/// Errors surfaced to serving/export handlers.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SessionError {
    #[error("unknown or closed export session — sessions are per-boot and single-use; obtain one from POST /api/sessions")]
    Unknown,
    #[error("export session was issued to a different operator")]
    WrongOwner,
    #[error("session registry poisoned")]
    Poisoned,
}

impl SessionRegistry {
    /// Issue a new, unforgeable session id (OS CSPRNG, 32 hex chars) bound
    /// to `owner` (the authenticated operator identity). Issuance is only
    /// reached after the operator token is verified, so a session cannot
    /// be minted anonymously.
    pub fn issue(&self, owner: &str) -> Result<String, getrandom::Error> {
        let mut bytes = [0u8; 16];
        getrandom::fill(&mut bytes)?;
        let id: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        self.sessions
            .lock()
            .map_err(|_| getrandom::Error::UNSUPPORTED)?
            .insert(
                id.clone(),
                SessionRecord {
                    owner: owner.to_string(),
                    packs: BTreeSet::new(),
                },
            );
        Ok(id)
    }

    /// Witness one served pack into a session. Called by the serving
    /// handlers at the point of successful serve — never by the requester.
    /// A closed/unknown session is refused loudly (an app that believes it
    /// is accumulating provenance must not silently accumulate nothing).
    pub fn witness(&self, session_id: &str, pack_id: &str) -> Result<(), SessionError> {
        let mut sessions = self.sessions.lock().map_err(|_| SessionError::Poisoned)?;
        match sessions.get_mut(session_id) {
            Some(record) => {
                record.packs.insert(pack_id.to_string());
                Ok(())
            }
            None => Err(SessionError::Unknown),
        }
    }

    /// Consume a session at export: verify it belongs to `owner`, return
    /// the node's record (every pack served), and **close it** so it can
    /// neither be replayed nor extended after the snapshot. `Err(Unknown)`
    /// for a session this boot never issued or already consumed;
    /// `Err(WrongOwner)` if it was issued to a different operator.
    pub fn consume(&self, session_id: &str, owner: &str) -> Result<Vec<String>, SessionError> {
        let mut sessions = self.sessions.lock().map_err(|_| SessionError::Poisoned)?;
        match sessions.get(session_id) {
            Some(record) if record.owner != owner => Err(SessionError::WrongOwner),
            Some(_) => {
                let record = sessions.remove(session_id).expect("checked present above");
                Ok(record.packs.into_iter().collect())
            }
            None => Err(SessionError::Unknown),
        }
    }

    /// Whether a session id is currently known and open (for serve-time
    /// gating on export-enabled nodes).
    pub fn is_open(&self, session_id: &str) -> Result<bool, SessionError> {
        let sessions = self.sessions.lock().map_err(|_| SessionError::Poisoned)?;
        Ok(sessions.contains_key(session_id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issue_witness_and_consume_closes_single_use() {
        let registry = SessionRegistry::default();
        let id = registry.issue("local-operator:op").unwrap();
        assert_eq!(id.len(), 32);
        registry.witness(&id, "dem").unwrap();
        registry.witness(&id, "landcover").unwrap();
        registry.witness(&id, "dem").unwrap(); // idempotent
        let set = registry.consume(&id, "local-operator:op").unwrap();
        assert_eq!(set, vec!["dem", "landcover"]);
        // Single-use: a second consume finds nothing (closed).
        assert_eq!(
            registry.consume(&id, "local-operator:op").unwrap_err(),
            SessionError::Unknown
        );
        assert!(!registry.is_open(&id).unwrap());
    }

    #[test]
    fn consume_rejects_a_different_owner() {
        let registry = SessionRegistry::default();
        let id = registry.issue("local-operator:a").unwrap();
        registry.witness(&id, "dem").unwrap();
        assert_eq!(
            registry.consume(&id, "local-operator:b").unwrap_err(),
            SessionError::WrongOwner
        );
        // The session is NOT closed by a rejected consume — the real owner
        // can still use it.
        assert_eq!(
            registry.consume(&id, "local-operator:a").unwrap(),
            vec!["dem"]
        );
    }

    #[test]
    fn unknown_session_is_refused_for_witness_and_consume() {
        let registry = SessionRegistry::default();
        assert_eq!(
            registry.witness("deadbeef", "dem"),
            Err(SessionError::Unknown)
        );
        assert_eq!(
            registry
                .consume("deadbeef", "local-operator:op")
                .unwrap_err(),
            SessionError::Unknown
        );
    }

    #[test]
    fn sessions_are_independent_and_ids_unique() {
        let registry = SessionRegistry::default();
        let a = registry.issue("local-operator:op").unwrap();
        let b = registry.issue("local-operator:op").unwrap();
        assert_ne!(a, b);
        registry.witness(&a, "dem").unwrap();
        assert!(registry
            .consume(&b, "local-operator:op")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn empty_session_yields_empty_source_set_not_error() {
        // An issued-but-unused session is valid; its EMPTY source set
        // resolves to T3 downstream and the floor refuses — fail-closed
        // without a special case here.
        let registry = SessionRegistry::default();
        let id = registry.issue("local-operator:op").unwrap();
        assert!(registry
            .consume(&id, "local-operator:op")
            .unwrap()
            .is_empty());
    }
}
