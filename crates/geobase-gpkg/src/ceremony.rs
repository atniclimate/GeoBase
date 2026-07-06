//! CeremonyGate — the **seam** between export mechanics and sovereign
//! authorization (Phase 1.3 ships the seam; Phase 1.2 ships the process).
//!
//! Every export of data governed by the TSDF passes through a
//! [`CeremonyGate`] before any bytes leave the node. The gate answers one
//! question — *may this requester export this pack's product at this
//! tier?* — and its answer is a [`CeremonyRecord`] that the export
//! pipeline MUST write into the artifact-adjacent audit trail. The
//! guarantee is a verifier, not a promise: the RStep gate (1.3d) asserts
//! the record's presence in the trail, so an export path that skips the
//! seam fails the phase gate loudly.
//!
//! ## What ships in Phase 1.3 (this module)
//!
//! [`ProvisionalDevGate`] — the ONLY implementation until Phase 1.2:
//! - **T3 is refused unconditionally.** The seam must never be the hole
//!   in invariant §3 (no code path exports T3); a dev gate that could be
//!   configured to pass T3 would be exactly that hole.
//! - T0–T2 are authorized, and the returned record ALWAYS carries the
//!   provisional basis verbatim: *"provisional — no sovereign ceremony
//!   process ran (Phase 1.2 pending)"*. Nothing about the provisional
//!   gate can be mistaken for consent having been given.
//!
//! ## What Phase 1.2 must implement against this trait (Patrick)
//!
//! See `docs/CEREMONY-GATE.md` for the full handoff note. In short: a
//! sovereign implementation replaces [`ProvisionalDevGate`] behind the
//! same trait — FPIC process binding, authenticated requester identity,
//! per-tier requirements, conditions that travel with the record — and
//! MUST keep the two contract tests at the bottom of this module green
//! (T3 refusal; provisional wording only from the provisional gate).

use geobase_tsdf::Tier;
use serde_json::{json, Value};

/// The provisional basis sentence, verbatim. The 1.3d gate greps the
/// audit trail for this exact string; do not reword it casually.
pub const PROVISIONAL_BASIS: &str =
    "provisional — no sovereign ceremony process ran (Phase 1.2 pending)";

/// A request to authorize one export. Fields are the floor the seam
/// needs today; Phase 1.2 may extend this struct (new optional fields)
/// without breaking the trait.
#[derive(Debug, Clone)]
pub struct ExportAuthorization<'a> {
    /// The pack (dataset/package id) whose derived product is leaving.
    pub pack_id: &'a str,
    /// Effective tier of the SOURCE data the product derives from.
    pub source_tier: Tier,
    /// Tier stamped on the exported product itself (RStep: T2).
    pub product_tier: Tier,
    /// Who is asking. Phase 1.2 binds this to authenticated identity;
    /// until then it is the audit-trail actor string.
    pub requester: &'a str,
    /// Free-text purpose, recorded verbatim in the ceremony record.
    pub purpose: Option<&'a str>,
}

/// The gate's affirmative answer — written into the audit trail by the
/// export pipeline (action `export.ceremony`).
#[derive(Debug, Clone, PartialEq)]
pub struct CeremonyRecord {
    /// Which process ran, e.g. `"provisional-dev"`; Phase 1.2 names the
    /// sovereign process here.
    pub process: String,
    /// Basis for the authorization. For the provisional gate this is
    /// ALWAYS [`PROVISIONAL_BASIS`].
    pub basis: String,
    /// Who/what authority authorized (the requester echo for the
    /// provisional gate; a real authority in Phase 1.2).
    pub authorized_by: String,
    /// Conditions attached to the authorization (empty = none recorded).
    pub conditions: Vec<String>,
}

impl CeremonyRecord {
    /// The JSON payload the export pipeline writes as the audit row's
    /// `details` (action `export.ceremony`). One shape, one writer.
    pub fn audit_details(&self, auth: &ExportAuthorization<'_>) -> Value {
        json!({
            "process": self.process,
            "basis": self.basis,
            "authorized_by": self.authorized_by,
            "conditions": self.conditions,
            "pack": auth.pack_id,
            "source_tier": auth.source_tier.code(),
            "product_tier": auth.product_tier.code(),
            "requester": auth.requester,
            "purpose": auth.purpose,
        })
    }
}

/// Refusals from a ceremony gate. Refusal is a normal, expected outcome
/// — the caller surfaces it verbatim and writes nothing but the refusal
/// audit row.
#[derive(Debug, thiserror::Error)]
pub enum ExportRefused {
    /// The tier can never leave the node — no process can authorize it.
    #[error(
        "export refused: tier {} data never leaves the node — no ceremony \
         process can authorize T3 egress (invariant, not policy)",
        .tier.code()
    )]
    TierNeverExports { tier: Tier },
    /// The governing process declined (Phase 1.2 semantics).
    #[error("export refused by the ceremony process: {reason}")]
    Declined { reason: String },
}

/// The seam. Phase 1.2 implements this for the sovereign process; the
/// export pipeline is generic over it and cannot tell implementations
/// apart except through the record they return.
pub trait CeremonyGate {
    /// Authorize one export, or refuse it. Implementations must treat
    /// refusal as a first-class outcome (no panics, no logging side
    /// channels — the record/refusal IS the interface).
    fn authorize_export(
        &self,
        auth: &ExportAuthorization<'_>,
    ) -> Result<CeremonyRecord, ExportRefused>;
}

/// The Phase-1.3 development gate: authorizes T0–T2 with the provisional
/// basis recorded verbatim, refuses T3 unconditionally. Carries no
/// configuration on purpose — there is nothing to widen.
#[derive(Debug, Clone, Copy, Default)]
pub struct ProvisionalDevGate;

impl CeremonyGate for ProvisionalDevGate {
    fn authorize_export(
        &self,
        auth: &ExportAuthorization<'_>,
    ) -> Result<CeremonyRecord, ExportRefused> {
        if auth.source_tier == Tier::T3 || auth.product_tier == Tier::T3 {
            let tier = if auth.source_tier == Tier::T3 {
                auth.source_tier
            } else {
                auth.product_tier
            };
            return Err(ExportRefused::TierNeverExports { tier });
        }
        Ok(CeremonyRecord {
            process: "provisional-dev".into(),
            basis: PROVISIONAL_BASIS.into(),
            authorized_by: format!("{} (self, unverified — dev gate)", auth.requester),
            conditions: Vec::new(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn auth(source: Tier, product: Tier) -> ExportAuthorization<'static> {
        ExportAuthorization {
            pack_id: "rstep-fixture",
            source_tier: source,
            product_tier: product,
            requester: "test",
            purpose: Some("unit test"),
        }
    }

    /// CONTRACT TEST — every CeremonyGate implementation, Phase 1.2
    /// included, must pass this against its own gate: T3 never exports.
    #[test]
    fn t3_is_refused_unconditionally_as_source_and_as_product() {
        for a in [auth(Tier::T3, Tier::T2), auth(Tier::T0, Tier::T3)] {
            let err = ProvisionalDevGate.authorize_export(&a).unwrap_err();
            assert!(matches!(err, ExportRefused::TierNeverExports { .. }));
            assert!(err.to_string().contains("never leaves the node"));
        }
    }

    /// CONTRACT TEST — the provisional wording comes ONLY from the
    /// provisional gate; a Phase-1.2 sovereign gate must never emit it.
    #[test]
    fn provisional_gate_always_records_the_provisional_basis() {
        for tier in [Tier::T0, Tier::T1, Tier::T2] {
            let record = ProvisionalDevGate
                .authorize_export(&auth(tier, Tier::T2))
                .unwrap();
            assert_eq!(record.process, "provisional-dev");
            assert_eq!(record.basis, PROVISIONAL_BASIS);
            assert!(record.conditions.is_empty());
        }
    }

    #[test]
    fn audit_details_carry_the_full_authorization_context() {
        let a = auth(Tier::T1, Tier::T2);
        let record = ProvisionalDevGate.authorize_export(&a).unwrap();
        let details = record.audit_details(&a);
        assert_eq!(details["process"], "provisional-dev");
        assert_eq!(details["basis"], PROVISIONAL_BASIS);
        assert_eq!(details["pack"], "rstep-fixture");
        assert_eq!(details["source_tier"], "T1");
        assert_eq!(details["product_tier"], "T2");
        assert_eq!(details["requester"], "test");
        assert_eq!(details["purpose"], "unit test");
    }
}
