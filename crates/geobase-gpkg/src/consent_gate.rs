//! The sovereign ceremony gate — Phase B item B3
//! (`docs/CEREMONY-DESIGN.md` §5, implemented against the RATIFIED
//! design of record).
//!
//! [`RecordedConsentGate`] answers the seam's one question by consulting
//! the recorded-consent store in the §5.1 order, **each step fail-closed**:
//!
//! 1. *(caller)* the node resolves the export session and derives the
//!    authoritative source set — this gate consumes only node-witnessed
//!    [`SourcePackWitness`](crate::ceremony::SourcePackWitness) entries;
//! 2. **T3 floor** — before authentication and before ANY consent-store
//!    access (the floor-first contract test proves the store is never
//!    consulted);
//! 3. *(caller)* the requester was authenticated before the gate ran —
//!    this gate consumes only the typed, authenticated identity;
//! 4. capture `observed_at` once, then **match** (expiry filtering before
//!    multiplicity, inside the store);
//! 5. **construct** the `FpicAuthorization` from the matched store record
//!    (`fpic_satisfied` derived, never asserted);
//! 6. *(caller)* record via the publication protocol.
//!
//! Refusal taxonomy (§5.3): the store's [`MatchRefusal`] values are
//! GOVERNANCE denials (`Declined`, HTTP 403, one refusal row);
//! [`ConsentStoreError`] values are INFRASTRUCTURE failures (HTTP 503) —
//! a technical outage is never attributed to the sovereign ceremony.
//!
//! The gate holds no cached state: the store is opened per authorization
//! and statuses are folded fresh — authorization results are never cached
//! (§3.3), so a revocation applies at the next check.

use std::path::PathBuf;
use std::sync::Arc;

use geobase_tsdf::Tier;

use crate::ceremony::{
    CeremonyError, CeremonyGate, CeremonyRecord, ConsentProvenance, ExportAuthorization,
    ExportRefused, SOVEREIGN_BASIS, SOVEREIGN_PROCESS,
};
use crate::cipher::AtRestCipher;
use crate::consent::{FpicAuthorization, UtcInstant};
use crate::consent_store::ConsentStore;

/// The sovereign gate. Composed at the single `server.rs` `router()`
/// composition point — nowhere else.
#[derive(Debug, Clone)]
pub struct RecordedConsentGate {
    /// Directory holding the consent store (alongside the export ledger).
    store_dir: PathBuf,
    tsdf_version: String,
    tsdf_origin: String,
    cipher: Arc<dyn AtRestCipher>,
}

impl RecordedConsentGate {
    pub fn new(
        store_dir: PathBuf,
        tsdf_version: &str,
        tsdf_origin: &str,
        cipher: Arc<dyn AtRestCipher>,
    ) -> Self {
        Self {
            store_dir,
            tsdf_version: tsdf_version.to_string(),
            tsdf_origin: tsdf_origin.to_string(),
            cipher,
        }
    }

    /// Open the store — INFRASTRUCTURE on any failure (§5.3). Called only
    /// after the T3 floor has passed.
    fn open_store(&self) -> Result<ConsentStore, CeremonyError> {
        ConsentStore::open_or_create(
            &self.store_dir,
            &self.tsdf_version,
            &self.tsdf_origin,
            self.cipher.as_ref(),
        )
        .map_err(|e| CeremonyError::Infrastructure {
            reason: e.to_string(),
        })
    }

    /// Steps 2–5 shared by authorize and revalidate. Returns the matched
    /// record's ceremony answer. Opens the store itself (floor first).
    fn check(&self, auth: &ExportAuthorization<'_>) -> Result<CeremonyRecord, CeremonyError> {
        // §5.1 step 2 — T3 floor, BEFORE any consent-store access. The
        // effective source tier is node-derived by construction (the
        // witness type has no requester-supplied producer), and an empty
        // witnessed set resolves to T3.
        Self::floor(auth)?;
        let store = self.open_store()?;
        self.check_with_store(&store, auth)
    }

    /// §5.1 step 2 — the T3 floor, total and store-free.
    fn floor(auth: &ExportAuthorization<'_>) -> Result<(), CeremonyError> {
        let source_tier = auth.effective_source_tier();
        if source_tier == Tier::T3 || auth.product_tier == Tier::T3 {
            let tier = if source_tier == Tier::T3 {
                source_tier
            } else {
                auth.product_tier
            };
            return Err(ExportRefused::TierNeverExports { tier }.into());
        }
        Ok(())
    }

    /// Steps 2–5 against an ALREADY-OPEN store — used by the publication-
    /// point revalidation so the check runs under a held publication lock
    /// (design §10, review B3 F3).
    fn check_with_store(
        &self,
        store: &ConsentStore,
        auth: &ExportAuthorization<'_>,
    ) -> Result<CeremonyRecord, CeremonyError> {
        Self::floor(auth)?;

        // §5.1 step 4 preamble — capture the node-clock instant ONCE,
        // immediately before matching begins, so the same instant exists
        // on the authorized path and on every governance-refusal path.
        // An implausible clock is an infrastructure failure, never an
        // authorization (§2.5).
        let observed_at = UtcInstant::now().map_err(|e| CeremonyError::Infrastructure {
            reason: e.to_string(),
        })?;

        let source_set: Vec<String> = auth.source_packs.iter().map(|p| p.id.clone()).collect();
        let matched = store
            .match_agreement(&source_set, auth.requester, auth.product_class, observed_at)
            .map_err(|e| CeremonyError::Infrastructure {
                reason: e.to_string(),
            })?
            .map_err(|refusal| {
                CeremonyError::Refused(ExportRefused::Declined {
                    reason: refusal.to_string(),
                    observed_at: Some(observed_at),
                })
            })?;

        // §5.1 step 5 — construct the authorization FROM the matched store
        // record; `fpic_satisfied` is derived by the constructor, never
        // asserted. A constructor failure here is an internal invariant
        // breach (the floor already excluded non-T2 targets), reported as
        // infrastructure — never as a governance decision that didn't
        // happen.
        let fpic = FpicAuthorization::new(
            auth.product_tier,
            matched.evidence.clone(),
            auth.requester.clone(),
            observed_at,
        )
        .map_err(|e| CeremonyError::Infrastructure {
            reason: format!("authorization construction failed: {e}"),
        })?;

        Ok(CeremonyRecord {
            process: SOVEREIGN_PROCESS.into(),
            basis: SOVEREIGN_BASIS.into(),
            authorized_by: fpic.authorized_by().clone(),
            authority_of_record: matched.authority_of_record,
            conditions: matched.conditions,
            observed_at: fpic.timestamp(),
            consent: Some(ConsentProvenance {
                agreement_id: matched.agreement_id,
                consent_store_sequence: matched.store_sequence,
                product_class: matched.product_class,
                evidence: fpic.consent_basis().clone(),
            }),
        })
    }

    /// §10: the fresh publication-point check must resolve to the SAME
    /// lineage head the authorization matched — a different head (or any
    /// refusal upstream) aborts this publication. Returns the sequence
    /// observed at the publication point.
    fn confirm_same_head(
        record: &CeremonyRecord,
        fresh: &CeremonyRecord,
    ) -> Result<Option<i64>, CeremonyError> {
        let (Some(original), Some(current)) = (&record.consent, &fresh.consent) else {
            return Err(CeremonyError::Infrastructure {
                reason: "revalidation of a record without consent provenance".into(),
            });
        };
        if current.agreement_id != original.agreement_id {
            return Err(CeremonyError::Refused(ExportRefused::Declined {
                reason: format!(
                    "consent changed between authorization and publication: agreement \
                     '{}' no longer governs this export (now '{}') — the export is \
                     aborted; the current consent state governs the next attempt",
                    original.agreement_id, current.agreement_id
                ),
                observed_at: Some(fresh.observed_at),
            }));
        }
        // The revalidated sequence (design §10): a revocation committing
        // AFTER this snapshot governs the next export, not this one.
        Ok(Some(current.consent_store_sequence))
    }
}

impl CeremonyGate for RecordedConsentGate {
    fn authorize_export(
        &self,
        auth: &ExportAuthorization<'_>,
    ) -> Result<CeremonyRecord, CeremonyError> {
        self.check(auth)
    }

    /// §10 export linearization: re-run the check at the publication
    /// point. A consent change that committed since authorization either
    /// refuses now (revoked/superseded/expired) or resolves to a
    /// DIFFERENT lineage head — both abort this publication.
    fn revalidate(
        &self,
        auth: &ExportAuthorization<'_>,
        record: &CeremonyRecord,
    ) -> Result<Option<i64>, CeremonyError> {
        let fresh = self.check(auth)?;
        Self::confirm_same_head(record, &fresh)
    }

    /// §10 + review B3 F3: acquire the consent store's publication lock
    /// FIRST, revalidate UNDER it, and hand the held lock to the export
    /// pipeline. No consent write — this process or another (the
    /// `record-consent` CLI included) — can commit between the snapshot
    /// this returns and the ledger seal the pipeline performs while the
    /// guard lives.
    fn revalidate_for_publication(
        &self,
        auth: &ExportAuthorization<'_>,
        record: &CeremonyRecord,
    ) -> Result<crate::ceremony::PublicationGuard, CeremonyError> {
        // Floor first: a floor refusal must never open the store.
        Self::floor(auth)?;
        let store = self.open_store()?;
        let lock = store
            .lock_for_publication()
            .map_err(|e| CeremonyError::Infrastructure {
                reason: e.to_string(),
            })?;
        let fresh = self.check_with_store(&store, auth)?;
        let sequence = Self::confirm_same_head(record, &fresh)?;
        Ok(crate::ceremony::PublicationGuard::locked(sequence, lock))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ceremony::SourcePackWitness;
    use crate::cipher::DevPlaintextCipher;
    use crate::consent::{Conditions, ConsentBasis, ExportIdentity, Sha256Digest, Witness};
    use crate::consent_store::{AgreementKind, AgreementRecord};
    use std::path::Path;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("geobase-gate-{name}-{nonce}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn operator() -> ExportIdentity {
        ExportIdentity::local_operator("op-1").unwrap()
    }

    fn gate(dir: &Path) -> RecordedConsentGate {
        RecordedConsentGate::new(
            dir.to_path_buf(),
            "0.9.4",
            "vendored:test",
            Arc::new(DevPlaintextCipher::new()),
        )
    }

    fn store(dir: &Path) -> ConsentStore {
        ConsentStore::open_or_create(dir, "0.9.4", "vendored:test", &DevPlaintextCipher::new())
            .unwrap()
    }

    fn t(s: &str) -> UtcInstant {
        UtcInstant::parse_rfc3339(s).unwrap()
    }

    fn record_agreement(dir: &Path, id: &str, scope: &[&str]) {
        let evidence = ConsentBasis::signed_agreement(
            "agreements/test.pdf",
            Sha256Digest::from_hex(&"ab".repeat(32)).unwrap(),
            t("2026-07-01T00:00:00Z"),
            UtcInstant::now().unwrap(),
        )
        .unwrap();
        store(dir)
            .record_agreement(
                &AgreementRecord {
                    agreement_id: id.into(),
                    kind: AgreementKind::TribalSigned,
                    source_scope: scope.iter().map(|s| s.to_string()).collect(),
                    product_class: "painted-opportunity-shapefile".into(),
                    evidence,
                    authority_of_record: "Example Signatory, Example Nation".into(),
                    requester_binding: operator(),
                    conditions: Conditions::default(),
                    recorded_by: operator(),
                },
                &[],
                false,
            )
            .unwrap();
    }

    fn witnessed(packs: &[(&str, Tier)]) -> Vec<SourcePackWitness> {
        packs
            .iter()
            .map(|(id, tier)| SourcePackWitness {
                id: id.to_string(),
                tier: *tier,
            })
            .collect()
    }

    fn auth<'a>(
        packs: &'a [SourcePackWitness],
        requester: &'a ExportIdentity,
        product_tier: Tier,
    ) -> ExportAuthorization<'a> {
        ExportAuthorization {
            product: "wind-north",
            source_packs: packs,
            product_tier,
            product_class: "painted-opportunity-shapefile",
            requester,
            purpose: Some("unit test"),
        }
    }

    /// ★ CONTRACT TEST (sovereign side) + floor-first precedence spy.
    /// With a FULLY VALID active T2 agreement recorded AND an
    /// authenticated requester present, a T3 witnessed source (and a T3
    /// product) is refused `TierNeverExports` — and the consent store is
    /// NEVER consulted. The spy: the gate's `store_dir` is replaced by a
    /// path whose store open MUST fail (a plain file sits where the
    /// directory should be), so any store access would surface as an
    /// infrastructure failure instead of the floor refusal.
    #[test]
    fn floor_first_t3_refused_before_any_store_access() {
        let dir = temp_dir("floor");
        record_agreement(&dir, "valid", &["dem", "secret"]);
        // The spy gate: store access is IMPOSSIBLE (store_dir is a file).
        let spy_path = dir.join("not-a-directory");
        std::fs::write(&spy_path, b"spy").unwrap();
        let spy_gate = gate(&spy_path);
        let requester = operator();
        for (packs, product_tier) in [
            (
                witnessed(&[("secret", Tier::T3), ("dem", Tier::T0)]),
                Tier::T2,
            ),
            (witnessed(&[("dem", Tier::T0)]), Tier::T3),
        ] {
            let err = spy_gate
                .authorize_export(&auth(&packs, &requester, product_tier))
                .unwrap_err();
            assert!(
                matches!(
                    err,
                    CeremonyError::Refused(ExportRefused::TierNeverExports { .. })
                ),
                "floor must refuse BEFORE store access; got: {err}"
            );
            assert!(err.to_string().contains("never leaves the node"));
        }
    }

    /// CONTRACT TEST — the sovereign gate never emits the provisional
    /// wording; process and basis are the ratified §8 constants.
    #[test]
    fn sovereign_gate_never_emits_provisional_wording() {
        let dir = temp_dir("wording");
        record_agreement(&dir, "a1", &["dem"]);
        let requester = operator();
        let packs = witnessed(&[("dem", Tier::T1)]);
        let record = gate(&dir)
            .authorize_export(&auth(&packs, &requester, Tier::T2))
            .unwrap();
        assert_eq!(record.process, SOVEREIGN_PROCESS);
        assert_eq!(record.basis, SOVEREIGN_BASIS);
        assert_ne!(record.basis, crate::ceremony::PROVISIONAL_BASIS);
        assert!(!record.basis.contains("provisional"));
    }

    #[test]
    fn positive_path_carries_store_provenance_and_authority_of_record() {
        let dir = temp_dir("positive");
        record_agreement(&dir, "a1", &["dem", "landcover"]);
        let requester = operator();
        let packs = witnessed(&[("dem", Tier::T0), ("landcover", Tier::T1)]);
        let record = gate(&dir)
            .authorize_export(&auth(&packs, &requester, Tier::T2))
            .unwrap();
        // authorized_by is the AUTHENTICATED identity…
        assert_eq!(record.authorized_by, requester);
        // …and authority_of_record is the STORE record's authority, never
        // a requester echo.
        assert_eq!(
            record.authority_of_record,
            "Example Signatory, Example Nation"
        );
        let consent = record
            .consent
            .as_ref()
            .expect("sovereign record carries provenance");
        assert_eq!(consent.agreement_id, "a1");
        assert!(consent.consent_store_sequence > 0);
        assert!(matches!(
            consent.evidence,
            ConsentBasis::SignedAgreement { .. }
        ));
    }

    #[test]
    fn no_agreement_is_declined_with_observed_at() {
        let dir = temp_dir("noagreement");
        // Store exists but holds nothing relevant.
        record_agreement(&dir, "other", &["other-pack"]);
        let requester = operator();
        let packs = witnessed(&[("dem", Tier::T1)]);
        let err = gate(&dir)
            .authorize_export(&auth(&packs, &requester, Tier::T2))
            .unwrap_err();
        match err {
            CeremonyError::Refused(ExportRefused::Declined {
                reason,
                observed_at,
            }) => {
                assert!(reason.contains("no recorded agreement"));
                assert!(
                    observed_at.is_some(),
                    "the refusal must carry the instant the decision used"
                );
            }
            other => panic!("expected Declined, got: {other}"),
        }
    }

    #[test]
    fn expired_agreement_is_declined_governance_not_infrastructure() {
        let dir = temp_dir("expired");
        let evidence = ConsentBasis::signed_agreement(
            "agreements/test.pdf",
            Sha256Digest::from_hex(&"ab".repeat(32)).unwrap(),
            t("2026-07-01T00:00:00Z"),
            UtcInstant::now().unwrap(),
        )
        .unwrap();
        store(&dir)
            .record_agreement(
                &AgreementRecord {
                    agreement_id: "expiring".into(),
                    kind: AgreementKind::TribalSigned,
                    source_scope: vec!["dem".into()],
                    product_class: "x".into(),
                    evidence,
                    authority_of_record: "Example Signatory".into(),
                    requester_binding: operator(),
                    conditions: Conditions {
                        // Expired long before any plausible test clock.
                        expires_at: Some(t("2026-07-02T00:00:00Z")),
                        purpose_limit: None,
                        geography_limit: None,
                    },
                    recorded_by: operator(),
                },
                &[],
                false,
            )
            .unwrap();
        let requester = operator();
        let packs = witnessed(&[("dem", Tier::T1)]);
        let err = gate(&dir)
            .authorize_export(&auth(&packs, &requester, Tier::T2))
            .unwrap_err();
        match err {
            CeremonyError::Refused(ExportRefused::Declined {
                reason,
                observed_at,
            }) => {
                assert!(reason.contains("expired"));
                assert!(observed_at.is_some());
            }
            other => panic!("expected governance Declined for expiry, got: {other}"),
        }
    }

    #[test]
    fn store_unavailable_is_infrastructure_not_declined() {
        let dir = temp_dir("infra");
        // Corrupt store: a non-SQLite file bearing the reserved name.
        std::fs::write(
            dir.join(crate::consent_store::RESERVED_CONSENT_STORE_NAME),
            b"not a database",
        )
        .unwrap();
        let requester = operator();
        let packs = witnessed(&[("dem", Tier::T1)]);
        let err = gate(&dir)
            .authorize_export(&auth(&packs, &requester, Tier::T2))
            .unwrap_err();
        assert!(
            matches!(err, CeremonyError::Infrastructure { .. }),
            "a corrupt store is an infrastructure failure, never a governance denial; got: {err}"
        );
        assert!(err
            .to_string()
            .contains("never attributed to the sovereign ceremony"));
    }

    #[test]
    fn revalidation_aborts_after_intervening_revocation() {
        let dir = temp_dir("linearize");
        record_agreement(&dir, "a1", &["dem"]);
        let requester = operator();
        let packs = witnessed(&[("dem", Tier::T1)]);
        let g = gate(&dir);
        let authorization = auth(&packs, &requester, Tier::T2);
        let record = g.authorize_export(&authorization).unwrap();
        // Consent changes between authorization and the publication point.
        store(&dir).revoke("a1", &operator()).unwrap();
        let err = g.revalidate(&authorization, &record).unwrap_err();
        assert!(
            matches!(err, CeremonyError::Refused(ExportRefused::Declined { .. })),
            "an intervening revocation must abort the publication; got: {err}"
        );
        // And an untouched store revalidates cleanly.
        record_agreement(&dir, "a2", &["dem"]);
        let record2 = g.authorize_export(&authorization).unwrap();
        g.revalidate(&authorization, &record2).unwrap();
    }

    #[test]
    fn revalidation_refuses_a_different_lineage_head() {
        let dir = temp_dir("headswap");
        record_agreement(&dir, "a1", &["dem"]);
        let requester = operator();
        let packs = witnessed(&[("dem", Tier::T1)]);
        let g = gate(&dir);
        let authorization = auth(&packs, &requester, Tier::T2);
        let record = g.authorize_export(&authorization).unwrap();
        // A superseding head lands between authorization and publication.
        let evidence = ConsentBasis::signed_agreement(
            "agreements/v2.pdf",
            Sha256Digest::from_hex(&"cd".repeat(32)).unwrap(),
            t("2026-07-02T00:00:00Z"),
            UtcInstant::now().unwrap(),
        )
        .unwrap();
        store(&dir)
            .record_agreement(
                &AgreementRecord {
                    agreement_id: "a2".into(),
                    kind: AgreementKind::TribalSigned,
                    source_scope: vec!["dem".into()],
                    // Same class as the auth so the refusal under test is
                    // the lineage-head change, not a product-class mismatch.
                    product_class: "painted-opportunity-shapefile".into(),
                    evidence,
                    authority_of_record: "Example Signatory".into(),
                    requester_binding: operator(),
                    conditions: Conditions::default(),
                    recorded_by: operator(),
                },
                &["a1"],
                false,
            )
            .unwrap();
        let err = g.revalidate(&authorization, &record).unwrap_err();
        match err {
            CeremonyError::Refused(ExportRefused::Declined { reason, .. }) => {
                assert!(reason.contains("no longer governs"));
            }
            other => panic!("expected Declined on head change, got: {other}"),
        }
    }

    /// Design §10 / review B3 F3: `revalidate_for_publication` returns a
    /// guard that HOLDS the consent store's publication lock — a
    /// revocation attempted while the guard lives cannot commit (the §6
    /// step-3 seal happens inside that window); after the guard drops,
    /// the revocation commits and governs the next export.
    #[test]
    fn publication_guard_blocks_revocation_until_dropped() {
        let dir = temp_dir("pubguard");
        record_agreement(&dir, "a1", &["dem"]);
        let requester = operator();
        let packs = witnessed(&[("dem", Tier::T1)]);
        let g = gate(&dir);
        let authorization = auth(&packs, &requester, Tier::T2);
        let record = g.authorize_export(&authorization).unwrap();
        // Writer handle opened BEFORE the lock (a separate connection,
        // standing in for the record-consent CLI process).
        let writer = store(&dir);
        let guard = g
            .revalidate_for_publication(&authorization, &record)
            .unwrap();
        assert!(
            guard.sequence.is_some(),
            "sovereign guard carries the sequence"
        );
        assert!(
            writer.revoke("a1", &operator()).is_err(),
            "a revocation must not commit inside the revalidation→seal window"
        );
        drop(guard);
        writer.revoke("a1", &operator()).unwrap();
        // The revocation that committed AFTER the window governs the next
        // export: a fresh revalidation refuses.
        let err = g.revalidate(&authorization, &record).unwrap_err();
        assert!(matches!(
            err,
            CeremonyError::Refused(ExportRefused::Declined { .. })
        ));
    }

    #[test]
    fn witnessed_verbal_agreement_authorizes_too() {
        let dir = temp_dir("verbal");
        let evidence = ConsentBasis::witnessed_verbal(
            vec![
                Witness::new("Witness A").unwrap(),
                Witness::new("Witness B").unwrap(),
            ],
            "operator verified both witnesses in person",
        )
        .unwrap();
        store(&dir)
            .record_agreement(
                &AgreementRecord {
                    agreement_id: "individual".into(),
                    kind: AgreementKind::IndividualWitnessed,
                    source_scope: vec!["interviews".into()],
                    product_class: "painted-opportunity-shapefile".into(),
                    evidence,
                    authority_of_record: "The consenting individual (witnessed)".into(),
                    requester_binding: operator(),
                    conditions: Conditions::default(),
                    recorded_by: operator(),
                },
                &[],
                false,
            )
            .unwrap();
        let requester = operator();
        let packs = witnessed(&[("interviews", Tier::T2)]);
        let record = gate(&dir)
            .authorize_export(&auth(&packs, &requester, Tier::T2))
            .unwrap();
        let consent = record.consent.unwrap();
        assert!(matches!(
            consent.evidence,
            ConsentBasis::WitnessedVerbal { .. }
        ));
    }
}
