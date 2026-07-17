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

/// The registry's interior: sessions by id plus the per-owner index that
/// makes issuance idempotent (review B3 F2). Both maps live under ONE
/// mutex so issue/witness/consume are atomic against each other.
#[derive(Debug, Default)]
struct Registry {
    sessions: HashMap<String, SessionRecord>,
    /// owner → the id of their single live session.
    by_owner: HashMap<String, String>,
}

/// The per-boot session registry. Interior mutability so the axum state
/// can share one registry across handlers.
///
/// **One live session per operator** (review B3 F2): issuance is
/// idempotent — an operator who already holds an open session gets the
/// SAME id back, so there is no way to hold two simultaneously valid
/// sessions, serve a higher-governance pack under one and export under
/// the other. Every serve for an operator accumulates into their one open
/// session; consuming it (at export) closes it, and only then does a new
/// issuance mint a fresh id. Full session↔work-unit binding with
/// authenticated serves is B5 territory (operator identity); this closure
/// is the proportionate B3 boundary.
#[derive(Debug, Default)]
pub struct SessionRegistry {
    inner: Mutex<Registry>,
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
    /// Issue the operator's session id — **idempotent per owner** (review
    /// B3 F2): if `owner` already holds an open session its id is returned
    /// unchanged, so two simultaneously valid sessions for one operator
    /// cannot exist and a serve can never be split away from the session
    /// an export names. A fresh id (OS CSPRNG, 32 hex chars) is minted
    /// only when the owner has no open session. Issuance is only reached
    /// after the operator token is verified, so a session cannot be
    /// minted anonymously.
    pub fn issue(&self, owner: &str) -> Result<String, getrandom::Error> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| getrandom::Error::UNSUPPORTED)?;
        if let Some(existing) = inner.by_owner.get(owner) {
            if inner.sessions.contains_key(existing) {
                return Ok(existing.clone());
            }
        }
        let mut bytes = [0u8; 16];
        getrandom::fill(&mut bytes)?;
        let id: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        inner.sessions.insert(
            id.clone(),
            SessionRecord {
                owner: owner.to_string(),
                packs: BTreeSet::new(),
            },
        );
        inner.by_owner.insert(owner.to_string(), id.clone());
        Ok(id)
    }

    /// Witness one served pack into a session. Called by the serving
    /// handlers at the point of successful serve — never by the requester.
    /// A closed/unknown session is refused loudly (an app that believes it
    /// is accumulating provenance must not silently accumulate nothing).
    pub fn witness(&self, session_id: &str, pack_id: &str) -> Result<(), SessionError> {
        let mut inner = self.inner.lock().map_err(|_| SessionError::Poisoned)?;
        match inner.sessions.get_mut(session_id) {
            Some(record) => {
                record.packs.insert(pack_id.to_string());
                Ok(())
            }
            None => Err(SessionError::Unknown),
        }
    }

    /// Resolve a session READ-ONLY: verify it belongs to `owner` and
    /// return the node's current record (every pack served) WITHOUT
    /// closing it. This is §5.1 step 1's primitive — the export route
    /// derives the floor input from it BEFORE authentication, and a
    /// pre-authentication refusal (floor, bad token) must never burn the
    /// operator's session: only the authenticated path consumes.
    pub fn resolve(&self, session_id: &str, owner: &str) -> Result<Vec<String>, SessionError> {
        let inner = self.inner.lock().map_err(|_| SessionError::Poisoned)?;
        match inner.sessions.get(session_id) {
            Some(record) if record.owner != owner => Err(SessionError::WrongOwner),
            Some(record) => Ok(record.packs.iter().cloned().collect()),
            None => Err(SessionError::Unknown),
        }
    }

    /// Consume a session at export: verify it belongs to `owner`, return
    /// the node's record (every pack served), and **close it** so it can
    /// neither be replayed nor extended after the snapshot. `Err(Unknown)`
    /// for a session this boot never issued or already consumed;
    /// `Err(WrongOwner)` if it was issued to a different operator.
    /// Reached only AFTER authentication (the read-only [`Self::resolve`]
    /// serves the pre-authentication steps).
    pub fn consume(&self, session_id: &str, owner: &str) -> Result<Vec<String>, SessionError> {
        let mut inner = self.inner.lock().map_err(|_| SessionError::Poisoned)?;
        match inner.sessions.get(session_id) {
            Some(record) if record.owner != owner => Err(SessionError::WrongOwner),
            // Total match on the request path (review B3 F10): removal is
            // re-checked, never assumed — no panic can reach a handler.
            Some(_) => match inner.sessions.remove(session_id) {
                Some(record) => {
                    // Clear the per-owner index so the NEXT issuance mints
                    // a fresh session (review B3 F2).
                    if inner.by_owner.get(&record.owner).map(String::as_str) == Some(session_id) {
                        inner.by_owner.remove(&record.owner);
                    }
                    Ok(record.packs.into_iter().collect())
                }
                None => Err(SessionError::Unknown),
            },
            None => Err(SessionError::Unknown),
        }
    }

    /// Whether a session id is currently known and open (for serve-time
    /// gating on export-enabled nodes).
    pub fn is_open(&self, session_id: &str) -> Result<bool, SessionError> {
        let inner = self.inner.lock().map_err(|_| SessionError::Poisoned)?;
        Ok(inner.sessions.contains_key(session_id))
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

    /// §5.1 steps 1–2 must not burn the session: `resolve` is read-only —
    /// owner-checked like `consume`, but the session stays open, keeps
    /// accumulating, and is still there for the authenticated consume.
    #[test]
    fn resolve_is_read_only_and_owner_checked() {
        let registry = SessionRegistry::default();
        let id = registry.issue("local-operator:op").unwrap();
        registry.witness(&id, "dem").unwrap();
        assert_eq!(
            registry.resolve(&id, "local-operator:op").unwrap(),
            vec!["dem"]
        );
        assert_eq!(
            registry.resolve(&id, "local-operator:other").unwrap_err(),
            SessionError::WrongOwner
        );
        assert_eq!(
            registry
                .resolve("deadbeef", "local-operator:op")
                .unwrap_err(),
            SessionError::Unknown
        );
        // Still open: it keeps witnessing and consume still finds it.
        assert!(registry.is_open(&id).unwrap());
        registry.witness(&id, "landcover").unwrap();
        assert_eq!(
            registry.consume(&id, "local-operator:op").unwrap(),
            vec!["dem", "landcover"]
        );
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

    /// Review B3 F2: issuance is idempotent per owner — the session-
    /// substitution split (serve under A, export under a fresh B) is
    /// structurally impossible because A and B are the same session.
    #[test]
    fn issue_is_idempotent_per_owner_until_consumed() {
        let registry = SessionRegistry::default();
        let a = registry.issue("local-operator:op").unwrap();
        let b = registry.issue("local-operator:op").unwrap();
        assert_eq!(a, b, "an open session is returned unchanged");
        // Serves before and after the second issuance accumulate into the
        // SAME record — nothing can be split away.
        registry.witness(&a, "dem").unwrap();
        registry.witness(&b, "landcover").unwrap();
        assert_eq!(
            registry.consume(&b, "local-operator:op").unwrap(),
            vec!["dem", "landcover"]
        );
        // Only after consumption does issuance mint a fresh id.
        let c = registry.issue("local-operator:op").unwrap();
        assert_ne!(a, c);
        assert!(registry
            .consume(&c, "local-operator:op")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn distinct_owners_get_distinct_sessions() {
        let registry = SessionRegistry::default();
        let a = registry.issue("local-operator:a").unwrap();
        let b = registry.issue("local-operator:b").unwrap();
        assert_ne!(a, b);
        registry.witness(&a, "dem").unwrap();
        assert!(registry.consume(&b, "local-operator:b").unwrap().is_empty());
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
