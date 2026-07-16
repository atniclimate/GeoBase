//! Node-witnessed export sessions — Phase B item B3
//! (`docs/CEREMONY-DESIGN.md` §4).
//!
//! Before B3, `POST /api/export` trusted the request body's declared
//! `source_packs`: the node verified the declared packs existed but could
//! not verify **completeness**, so a caller could omit a contributing
//! higher-tier pack and evade the T3 floor (the T3-omission bypass). B3
//! closes it:
//!
//! - The node issues an unforgeable **export session id** when the app
//!   begins work (`POST /api/sessions`).
//! - Every pack the node serves into that session is accumulated **by the
//!   node** (the serving handlers witness the pack id whenever the
//!   session header accompanies a successful serve).
//! - At export, the request names the session; the source set is **the
//!   node's own record — every pack served, period**. The request can
//!   neither add nor subtract. Deliberate over-counting is the point: it
//!   fails closed, because "prove the operator didn't use it" is not a
//!   game the node can win.
//! - No valid session → the export is refused.
//!
//! Sessions are in-memory and per-boot on purpose: a session that
//! survived a crash would be a session whose accumulation record might be
//! incomplete — the fail-closed answer is to start over.

use std::collections::{BTreeSet, HashMap};
use std::sync::Mutex;

/// The request header that attaches a serving request to an export
/// session. A non-breaking SDK addition: requests without it are served
/// exactly as before, but the packs they touch are witnessed by no
/// session and therefore can never appear in an export's source set.
pub const SESSION_HEADER: &str = "x-geobase-session";

/// The per-boot session registry. Interior mutability so the axum state
/// can share one registry across handlers.
#[derive(Debug, Default)]
pub struct SessionRegistry {
    sessions: Mutex<HashMap<String, BTreeSet<String>>>,
}

/// Errors surfaced to serving/export handlers.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SessionError {
    #[error("unknown export session — sessions are per-boot; obtain one from POST /api/sessions")]
    Unknown,
    #[error("session registry poisoned")]
    Poisoned,
}

impl SessionRegistry {
    /// Issue a new, unforgeable session id (OS CSPRNG, 32 hex chars).
    pub fn issue(&self) -> Result<String, getrandom::Error> {
        let mut bytes = [0u8; 16];
        getrandom::fill(&mut bytes)?;
        let id: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        self.sessions
            .lock()
            .map_err(|_| getrandom::Error::UNSUPPORTED)?
            .insert(id.clone(), BTreeSet::new());
        Ok(id)
    }

    /// Witness one served pack into a session. Called by the serving
    /// handlers at the point of successful serve — never by the requester.
    pub fn witness(&self, session_id: &str, pack_id: &str) -> Result<(), SessionError> {
        let mut sessions = self.sessions.lock().map_err(|_| SessionError::Poisoned)?;
        match sessions.get_mut(session_id) {
            Some(packs) => {
                packs.insert(pack_id.to_string());
                Ok(())
            }
            None => Err(SessionError::Unknown),
        }
    }

    /// The node's record for a session: every pack served, period.
    /// `Err(Unknown)` for a session this boot never issued.
    pub fn source_set(&self, session_id: &str) -> Result<Vec<String>, SessionError> {
        let sessions = self.sessions.lock().map_err(|_| SessionError::Poisoned)?;
        sessions
            .get(session_id)
            .map(|packs| packs.iter().cloned().collect())
            .ok_or(SessionError::Unknown)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issue_witness_and_read_back() {
        let registry = SessionRegistry::default();
        let id = registry.issue().unwrap();
        assert_eq!(id.len(), 32);
        registry.witness(&id, "dem").unwrap();
        registry.witness(&id, "landcover").unwrap();
        registry.witness(&id, "dem").unwrap(); // idempotent
        assert_eq!(registry.source_set(&id).unwrap(), vec!["dem", "landcover"]);
    }

    #[test]
    fn unknown_session_is_refused_for_witness_and_read() {
        let registry = SessionRegistry::default();
        assert_eq!(
            registry.witness("deadbeef", "dem"),
            Err(SessionError::Unknown)
        );
        assert_eq!(
            registry.source_set("deadbeef").unwrap_err(),
            SessionError::Unknown
        );
    }

    #[test]
    fn sessions_are_independent_and_ids_unique() {
        let registry = SessionRegistry::default();
        let a = registry.issue().unwrap();
        let b = registry.issue().unwrap();
        assert_ne!(a, b);
        registry.witness(&a, "dem").unwrap();
        assert!(registry.source_set(&b).unwrap().is_empty());
    }

    #[test]
    fn empty_session_yields_empty_source_set_not_error() {
        // An issued-but-unused session is valid; its EMPTY source set
        // resolves to T3 downstream and the floor refuses — fail-closed
        // without a special case here.
        let registry = SessionRegistry::default();
        let id = registry.issue().unwrap();
        assert!(registry.source_set(&id).unwrap().is_empty());
    }
}
