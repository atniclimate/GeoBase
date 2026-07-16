//! CeremonyGate — the **seam** between export mechanics and sovereign
//! authorization (Phase 1.3 shipped the seam; Phase B item B3 ships the
//! sovereign process against `docs/CEREMONY-DESIGN.md`, RATIFIED
//! 2026-07-16).
//!
//! Every export of data governed by the TSDF passes through a
//! [`CeremonyGate`] before any bytes leave the node. The gate answers one
//! question — *may this authenticated requester export this derived
//! product at this tier?* — and its answer is a [`CeremonyRecord`] the
//! export pipeline MUST write into the artifact-adjacent audit trail.
//!
//! ## B3 breaking seam change (recorded, `docs/CEREMONY-DESIGN.md` §2.4)
//!
//! The free-text `requester: &str` and `conditions: Vec<String>` are
//! **REPLACED, not extended**: identity is the typed
//! [`ExportIdentity`](crate::consent::ExportIdentity), conditions are the
//! typed [`Conditions`](crate::consent::Conditions), and the record gains
//! `authority_of_record`, `observed_at`, and consent-store provenance.
//! A deprecated free-text identity field would be a shadow path the
//! ratified "no free text" rule exists to kill.
//!
//! The **source set** is likewise no longer a requester claim: the gate
//! consumes only node-derived [`SourcePackWitness`] entries (session
//! provenance, design §4) — `source_tier` stopped being an independently
//! trusted input at B3.
//!
//! ## Refusal taxonomy (design §5.3)
//!
//! Governance denial ([`ExportRefused`], HTTP 403, refusal row) and
//! infrastructure failure ([`CeremonyError::Infrastructure`], HTTP 503,
//! attempted infra row) are DISTINCT outcomes: a technical outage is never
//! attributed to the sovereign ceremony.

use geobase_tsdf::Tier;
use serde_json::{json, Value};

use crate::consent::{Conditions, ConsentBasis, ExportIdentity, UtcInstant};

/// The provisional basis sentence, verbatim. A sovereign gate must NEVER
/// emit it (contract test below; B8 asserts `basis != PROVISIONAL_BASIS`).
pub const PROVISIONAL_BASIS: &str =
    "provisional — no sovereign ceremony process ran (Phase 1.2 pending)";

/// The sovereign process name (design §8). Renaming is an audit-schema
/// migration; B8 asserts this independently of the basis.
pub const SOVEREIGN_PROCESS: &str = "geobase-recorded-consent-check-v1";

/// The sovereign basis sentence (design §8). It deliberately claims only
/// what the code establishes: an active recorded evidence-complete
/// agreement matched — never legal sufficiency, never that advisory
/// conditions were enforced.
pub const SOVEREIGN_BASIS: &str =
    "active recorded consent evidence matched for T2 derived-product export";

/// One source pack as WITNESSED BY THE NODE (design §4): identity plus the
/// effective tier re-resolved from the catalog at export time. Never
/// request-supplied — the export session record is the only producer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourcePackWitness {
    pub id: String,
    /// Effective tier at export time; a pack that could not be resolved
    /// against the catalog MUST be witnessed as T3 (missing/unclassifiable
    /// → T3 → the floor refuses).
    pub tier: Tier,
}

/// A request to authorize one export. Everything here is either
/// node-derived (`source_packs`) or authenticated (`requester`) — the only
/// requester-supplied content is the product name and optional purpose,
/// both recorded verbatim and never used as match inputs.
#[derive(Debug, Clone)]
pub struct ExportAuthorization<'a> {
    /// The derived product's name (file stem; a seam field, never a match
    /// criterion).
    pub product: &'a str,
    /// The node-witnessed source set (design §4): every pack the export
    /// session served, re-resolved against the catalog. The request can
    /// neither add nor subtract.
    pub source_packs: &'a [SourcePackWitness],
    /// Tier stamped on the exported product itself (RStep: T2).
    pub product_tier: Tier,
    /// The class of derived product (a recorded agreement term, §3.2): the
    /// matched agreement must authorize THIS class. Fixed per SoLO app in
    /// 1.0 (RStep: `painted-opportunity-shapefile`).
    pub product_class: &'a str,
    /// The AUTHENTICATED actor asking. Typed — free text is abolished.
    pub requester: &'a ExportIdentity,
    /// Free-text purpose, recorded verbatim in the ceremony record
    /// (recorded context, never an enforcement or match input).
    pub purpose: Option<&'a str>,
}

impl ExportAuthorization<'_> {
    /// The effective source tier: maximum (most restrictive) across the
    /// node-witnessed set. An EMPTY set resolves to T3 — a session that
    /// served nothing proves nothing, and the floor refuses it.
    pub fn effective_source_tier(&self) -> Tier {
        self.source_packs
            .iter()
            .map(|p| p.tier)
            .max()
            .unwrap_or(Tier::T3)
    }
}

/// Consent-store provenance carried by every SOVEREIGN record — the ledger
/// row is self-contained for evidence (design §2.2), while the store stays
/// the system of record for status/matching/revocation.
#[derive(Debug, Clone, PartialEq)]
pub struct ConsentProvenance {
    /// The matched agreement (the active lineage head that covered the
    /// source set).
    pub agreement_id: String,
    /// The consent-store sequence snapshot at authorization (design §10:
    /// revalidated at the publication point).
    pub consent_store_sequence: i64,
    /// The product class the matched agreement authorizes (§3.2) — copied
    /// forward so the ledger row is self-contained for that term.
    pub product_class: String,
    /// The agreement's evidence, copied forward so the row stands alone.
    pub evidence: ConsentBasis,
}

/// The gate's affirmative answer — written into the audit trail by the
/// export pipeline (action `export.ceremony`).
#[derive(Debug, Clone, PartialEq)]
pub struct CeremonyRecord {
    /// Which process ran: [`SOVEREIGN_PROCESS`] from the sovereign gate,
    /// `"provisional-dev"` from the dev gate.
    pub process: String,
    /// Basis for the authorization ([`SOVEREIGN_BASIS`] / [`PROVISIONAL_BASIS`]).
    pub basis: String,
    /// WHO PERFORMED the authorization act at export time (authenticated).
    pub authorized_by: ExportIdentity,
    /// The tribal signatory or witnessed consenter COPIED FROM THE
    /// AGREEMENT STORE RECORD, never request-supplied (design §2.3 — the
    /// anti-echo property lives in the store). The provisional gate, which
    /// has no store, records an explicit "(provisional)" marker here.
    pub authority_of_record: String,
    /// Typed conditions from the matched agreement (design §2.5).
    pub conditions: Conditions,
    /// The node-clock UTC instant the authorization actually used —
    /// captured once, before matching, so it exists on refusal paths too.
    pub observed_at: UtcInstant,
    /// Store provenance + self-contained evidence. `None` ONLY from the
    /// provisional dev gate; every sovereign record carries `Some`.
    pub consent: Option<ConsentProvenance>,
}

impl CeremonyRecord {
    /// The JSON payload the export pipeline writes as the `export.ceremony`
    /// audit row's `details`. One shape, one writer.
    ///
    /// `resolved_source_hashes` are the EXPORT-TIME artifact hashes of the
    /// witnessed source set — recorded under a field name deliberately
    /// distinct from the agreement-time `agreement_evidence_hash` inside
    /// the evidence object (design §4).
    pub fn audit_details(
        &self,
        auth: &ExportAuthorization<'_>,
        resolved_source_hashes: &[(String, String)],
    ) -> Value {
        json!({
            "process": self.process,
            "basis": self.basis,
            "authorized_by": self.authorized_by.audit_string(),
            "authority_of_record": self.authority_of_record,
            "conditions": self.conditions.audit_json(),
            "observed_at": self.observed_at.to_rfc3339(),
            "agreement_id": self.consent.as_ref().map(|c| c.agreement_id.clone()),
            "consent_store_sequence": self.consent.as_ref().map(|c| c.consent_store_sequence),
            "product_class": self.consent.as_ref().map(|c| c.product_class.clone()),
            "evidence": self.consent.as_ref().map(|c| c.evidence.audit_json()),
            "product": auth.product,
            "resolved_sources": auth
                .source_packs
                .iter()
                .map(|p| json!({"id": p.id, "tier": p.tier.code()}))
                .collect::<Vec<_>>(),
            "resolved_source_hashes": resolved_source_hashes
                .iter()
                .map(|(id, sha)| json!({"id": id, "sha256": sha}))
                .collect::<Vec<_>>(),
            "effective_source_tier": auth.effective_source_tier().code(),
            "product_tier": auth.product_tier.code(),
            "purpose": auth.purpose,
        })
    }
}

/// GOVERNANCE refusals from a ceremony gate — a normal, expected outcome
/// (HTTP 403 + exactly one refusal row). Distinct from infrastructure
/// failure by design (§5.3).
#[derive(Debug, thiserror::Error)]
pub enum ExportRefused {
    /// The tier can never leave the node — no process can authorize it.
    #[error(
        "export refused: tier {} data never leaves the node — no ceremony \
         process can authorize T3 egress (invariant, not policy)",
        .tier.code()
    )]
    TierNeverExports { tier: Tier },
    /// The governing process declined: no/expired/revoked/superseded/
    /// wrong-scope/wrong-requester agreement, malformed evidence, or an
    /// unauthenticated requester. `observed_at` is the node-clock instant
    /// the decision used (design §2.5 — captured before matching, so it
    /// exists on the refusal path too; the `export.refused` row carries
    /// it). `None` only for refusals that precede the clock capture.
    #[error("export refused by the ceremony process: {reason}")]
    Declined {
        reason: String,
        observed_at: Option<UtcInstant>,
    },
}

/// All gate outcomes that are not an authorization.
#[derive(Debug, thiserror::Error)]
pub enum CeremonyError {
    /// Governance denial → HTTP 403, one refusal row.
    #[error(transparent)]
    Refused(#[from] ExportRefused),
    /// Infrastructure failure → HTTP 503, attempted infra row, NEVER
    /// attributed to the sovereign ceremony: consent store unavailable/
    /// corrupt/unreadable, invalid node clock, ledger failure.
    #[error("ceremony infrastructure failure: {reason} — a technical outage is never attributed to the sovereign ceremony (this is not a governance denial)")]
    Infrastructure { reason: String },
}

/// The result of a publication-point revalidation (design §10, review B3
/// F3): the consent-store sequence observed at the publication point,
/// plus — for a gate with a consent store — a held store lock that keeps
/// any consent write from committing until the export pipeline's ledger
/// seal. The pipeline holds this guard across the seal and drops it
/// immediately after; a store-less gate returns an unlocked guard.
#[derive(Debug)]
pub struct PublicationGuard {
    /// The consent-store sequence at the publication point (`Some` for a
    /// sovereign gate; `None` for a store-less gate).
    pub sequence: Option<i64>,
    _lock: Option<crate::consent_store::ConsentStoreLock>,
}

impl PublicationGuard {
    /// A guard without a held lock (store-less gates).
    pub fn unlocked(sequence: Option<i64>) -> Self {
        Self {
            sequence,
            _lock: None,
        }
    }

    /// A guard holding the consent store's publication lock through the
    /// ledger seal.
    pub fn locked(sequence: Option<i64>, lock: crate::consent_store::ConsentStoreLock) -> Self {
        Self {
            sequence,
            _lock: Some(lock),
        }
    }
}

/// The seam. The export pipeline is generic over it and cannot tell
/// implementations apart except through the record they return.
pub trait CeremonyGate {
    /// Authorize one export, refuse it (governance), or fail
    /// (infrastructure). Implementations must treat refusal as a
    /// first-class outcome — no panics, no logging side channels; the
    /// record/refusal IS the interface.
    fn authorize_export(
        &self,
        auth: &ExportAuthorization<'_>,
    ) -> Result<CeremonyRecord, CeremonyError>;

    /// Revalidate a previously issued record at the PUBLICATION POINT
    /// (design §10 export linearization: snapshot at authorization,
    /// revalidate at the §6 step-3/4 boundary). A consent change that
    /// committed between authorization and publication aborts THIS export;
    /// one that commits after governs the next. Returns the consent-store
    /// sequence observed AT THE PUBLICATION POINT (`Some` for a sovereign
    /// gate) so the sealed ceremony row records the revalidated sequence,
    /// not the authorization-time one. The default is a no-op returning
    /// `None` — only a gate with a consent store has anything to
    /// revalidate.
    fn revalidate(
        &self,
        _auth: &ExportAuthorization<'_>,
        _record: &CeremonyRecord,
    ) -> Result<Option<i64>, CeremonyError> {
        Ok(None)
    }

    /// Revalidate at the publication point AND return a guard the export
    /// pipeline holds across the ledger seal (design §10, review B3 F3).
    /// A gate with a consent store must acquire the store's publication
    /// lock BEFORE revalidating and carry it in the guard, so no consent
    /// change can commit between the revalidation snapshot and the seal.
    /// The default wraps [`CeremonyGate::revalidate`] with no lock — only
    /// a gate with a consent store has anything to serialize.
    fn revalidate_for_publication(
        &self,
        auth: &ExportAuthorization<'_>,
        record: &CeremonyRecord,
    ) -> Result<PublicationGuard, CeremonyError> {
        Ok(PublicationGuard::unlocked(self.revalidate(auth, record)?))
    }
}

/// The development gate: authorizes T0–T2 with the provisional basis
/// recorded verbatim, refuses T3 unconditionally. **Not compiled into
/// release builds after B3** — it is gated behind `cfg(test)` / the
/// `test-support` feature so no production composition (and no downstream
/// release-code caller of `export_product`) can reach it; the sovereign
/// gate replaced it at the single `server.rs` `router()` composition
/// point. It survives only for tests and store-less test tooling. Carries
/// no configuration on purpose — there is nothing to widen.
#[cfg(any(test, feature = "test-support"))]
#[derive(Debug, Clone, Copy, Default)]
pub struct ProvisionalDevGate;

#[cfg(any(test, feature = "test-support"))]
impl CeremonyGate for ProvisionalDevGate {
    fn authorize_export(
        &self,
        auth: &ExportAuthorization<'_>,
    ) -> Result<CeremonyRecord, CeremonyError> {
        let source_tier = auth.effective_source_tier();
        if source_tier == Tier::T3 || auth.product_tier == Tier::T3 {
            let tier = if source_tier == Tier::T3 {
                source_tier
            } else {
                auth.product_tier
            };
            return Err(ExportRefused::TierNeverExports { tier }.into());
        }
        // An implausible clock is an infrastructure failure even on the dev
        // gate — no record carries a knowingly-wrong instant.
        let observed_at = UtcInstant::now().map_err(|e| CeremonyError::Infrastructure {
            reason: e.to_string(),
        })?;
        Ok(CeremonyRecord {
            process: "provisional-dev".into(),
            basis: PROVISIONAL_BASIS.into(),
            authorized_by: auth.requester.clone(),
            authority_of_record:
                "(provisional — no authority of record; no sovereign ceremony ran)".into(),
            conditions: Conditions::default(),
            observed_at,
            consent: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn operator() -> ExportIdentity {
        ExportIdentity::local_operator("test-operator").unwrap()
    }

    fn witnessed(source: Tier) -> Vec<SourcePackWitness> {
        vec![SourcePackWitness {
            id: "rstep-fixture".into(),
            tier: source,
        }]
    }

    /// CONTRACT TEST — every CeremonyGate implementation, the sovereign
    /// gate included, must pass this against its own gate: T3 never
    /// exports, whether as (node-witnessed) source or as product.
    #[test]
    fn t3_is_refused_unconditionally_as_source_and_as_product() {
        let requester = operator();
        for (source, product) in [(Tier::T3, Tier::T2), (Tier::T0, Tier::T3)] {
            let packs = witnessed(source);
            let auth = ExportAuthorization {
                product: "rstep-fixture",
                source_packs: &packs,
                product_tier: product,
                product_class: "painted-opportunity-shapefile",
                requester: &requester,
                purpose: Some("unit test"),
            };
            let err = ProvisionalDevGate.authorize_export(&auth).unwrap_err();
            assert!(matches!(
                err,
                CeremonyError::Refused(ExportRefused::TierNeverExports { .. })
            ));
            assert!(err.to_string().contains("never leaves the node"));
        }
    }

    /// CONTRACT TEST — the provisional wording comes ONLY from the
    /// provisional gate; the sovereign gate must never emit it (its own
    /// side of this contract is asserted in the consent-gate tests).
    #[test]
    fn provisional_gate_always_records_the_provisional_basis() {
        let requester = operator();
        for tier in [Tier::T0, Tier::T1, Tier::T2] {
            let packs = witnessed(tier);
            let auth = ExportAuthorization {
                product: "rstep-fixture",
                source_packs: &packs,
                product_tier: Tier::T2,
                product_class: "painted-opportunity-shapefile",
                requester: &requester,
                purpose: None,
            };
            let record = ProvisionalDevGate.authorize_export(&auth).unwrap();
            assert_eq!(record.process, "provisional-dev");
            assert_eq!(record.basis, PROVISIONAL_BASIS);
            assert_ne!(record.basis, SOVEREIGN_BASIS);
            assert!(record.consent.is_none());
            assert!(record.authority_of_record.contains("provisional"));
        }
    }

    /// An EMPTY node-witnessed source set is T3 by construction — a
    /// session that served nothing cannot prove a low-tier derivation.
    #[test]
    fn empty_witnessed_source_set_is_t3_and_refused() {
        let requester = operator();
        let auth = ExportAuthorization {
            product: "nothing-served",
            source_packs: &[],
            product_tier: Tier::T2,
            product_class: "painted-opportunity-shapefile",
            requester: &requester,
            purpose: None,
        };
        assert_eq!(auth.effective_source_tier(), Tier::T3);
        let err = ProvisionalDevGate.authorize_export(&auth).unwrap_err();
        assert!(matches!(
            err,
            CeremonyError::Refused(ExportRefused::TierNeverExports { .. })
        ));
    }

    #[test]
    fn audit_details_carry_the_full_authorization_context() {
        let requester = operator();
        let packs = witnessed(Tier::T1);
        let auth = ExportAuthorization {
            product: "rstep-fixture",
            source_packs: &packs,
            product_tier: Tier::T2,
            product_class: "painted-opportunity-shapefile",
            requester: &requester,
            purpose: Some("unit test"),
        };
        let record = ProvisionalDevGate.authorize_export(&auth).unwrap();
        let details = record.audit_details(&auth, &[("rstep-fixture".into(), "ff".repeat(32))]);
        assert_eq!(details["process"], "provisional-dev");
        assert_eq!(details["basis"], PROVISIONAL_BASIS);
        assert_eq!(details["product"], "rstep-fixture");
        assert_eq!(details["effective_source_tier"], "T1");
        assert_eq!(details["product_tier"], "T2");
        assert_eq!(details["authorized_by"], "local-operator:test-operator");
        assert_eq!(details["purpose"], "unit test");
        assert_eq!(details["resolved_sources"][0]["id"], "rstep-fixture");
        assert_eq!(
            details["resolved_source_hashes"][0]["sha256"],
            "ff".repeat(32)
        );
        // Free-text requester/conditions fields are GONE (breaking change,
        // design §2.4) — the old names must not reappear.
        assert!(details.get("requester").is_none());
        assert!(details.get("source_tier").is_none());
    }

    #[test]
    fn sovereign_constants_are_the_ratified_strings() {
        // Renaming either constant is an audit-schema migration (design §8).
        assert_eq!(SOVEREIGN_PROCESS, "geobase-recorded-consent-check-v1");
        assert_eq!(
            SOVEREIGN_BASIS,
            "active recorded consent evidence matched for T2 derived-product export"
        );
        assert_ne!(SOVEREIGN_BASIS, PROVISIONAL_BASIS);
    }
}
