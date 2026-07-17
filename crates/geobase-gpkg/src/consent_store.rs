//! The consent store — Phase B item B3 (`docs/CEREMONY-DESIGN.md` §3, §5.2).
//!
//! A **separate local T3 GPKG artifact** alongside the export ledger: its
//! own reserved name ([`RESERVED_CONSENT_STORE_NAME`]), append-only-by-
//! trigger, artifact-level TSDF tags, excluded by construction from
//! catalog scans, file-serving, export, automatic backup/sync, and every
//! network route (the vault scanner skips it by name; no route reads it;
//! recording is a local operator act, never an endpoint). It is the system
//! of record for agreement **status, matching, and revocation**; the
//! export-ledger row is self-contained for **evidence** (design §2.2).
//!
//! ## Event model (§3.1)
//!
//! Every write is an event: immutable `event_id`, subject `agreement_id`,
//! **monotonic store sequence** (assigned by the store), `event_kind`
//! (`recorded` | `revoked` | `superseded_by` | `corrected_by`),
//! `recorded_at` (UTC), optional related agreement. **Status resolution
//! uses the store sequence, never evidence timestamps** — `acknowledged_at`
//! and expiry are evidence/condition times, not ordering.
//!
//! ## Schema classes (§3.2, §9)
//!
//! Agreement fields are partitioned into the permanent **proof-core**
//! (`consent_agreements`: ids, kinds, scope, status lineage, hashes,
//! timestamps) and **identifying evidence detail** (`consent_evidence`:
//! witness identities, attestations, document locators) with owner-set
//! retention. Nothing auto-deletes in 1.0; compaction is a future explicit
//! sovereign act — the separation ships so minimization is structurally
//! possible.
//!
//! ## Lifecycle authority (§3.3)
//!
//! Recording is a **LocalOperator act**; delegates request exports, they
//! do not record ceremonies. A record is active the moment it is recorded
//! evidence-complete — no separate activation step. Revocation,
//! supersession, and correction are later appends (correction *is*
//! supersession); effects apply at the next authorization check —
//! authorization results are never cached.
//!
//! ## Honest residual — the raw-SQL boundary (review B3 F5/r3 F2, B4 seals it)
//!
//! `GeoPackage::conn()` is public, so the store defends its own surface:
//! append-only triggers, insert-shape triggers, no-resurrection status
//! folding, and (for witnessed-verbal records) a proof-core commitment
//! recomputed and enforced on the authorization read path. What a local
//! plaintext SQLite file CANNOT prevent is a **perfectly-shaped** forgery
//! written through raw SQL — and that residual covers **BOTH evidence
//! kinds** (review B3-r3 F2). For a `tribal_signed` record the evidence
//! hash binds an EXTERNAL document no local recomputation can check. For
//! an `individual_witnessed` record the §9 commitment is an UNKEYED
//! digest over the stored detail: it binds detail to hash (integrity —
//! corruption and detail-edited-under-the-hash refuse, and compaction
//! can later verify what it carries forward), but a raw-SQL writer who
//! supplies both the fabricated detail AND its correctly computed digest
//! authorizes. The commitment is **not writer authentication** — nothing
//! unkeyed can be. That residual is inherent to the storage medium, not
//! to this schema; B4 (sealed/encrypted store) closes the raw-write
//! channel itself. `honest_residual_a_correctly_hashed_witnessed_forgery
//! _authorizes_until_b4` in this module's tests pins the exact boundary.

use std::path::{Path, PathBuf};

use geobase_tsdf::Tier;

use crate::cipher::{AtRestCipher, AtRestProtection, EncryptionRefused};
use crate::consent::{Conditions, ConsentBasis, ExportIdentity, Sha256Digest, UtcInstant, Witness};
use crate::{GeoPackage, GpkgError, TsdfTag};

/// The reserved file name of the T3 consent store. Never catalogued,
/// never served, never exported, wherever it is found.
pub const RESERVED_CONSENT_STORE_NAME: &str = "node-consent.gpkg";

/// Store-side DDL. Both tables and the event log are append-only **by
/// trigger** — UPDATE and DELETE abort (mechanism, not convention). The
/// `product_tier = 'T2'` CHECK is the store-side half of the typed
/// constraint (the Rust write path rejects non-T2 first).
const CONSENT_DDL: &str = "
CREATE TABLE IF NOT EXISTS consent_agreements (
  agreement_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('tribal_signed','individual_witnessed')),
  source_scope TEXT NOT NULL,
  product_class TEXT NOT NULL,
  product_tier TEXT NOT NULL CHECK (product_tier = 'T2'),
  authority_of_record TEXT NOT NULL,
  requester_binding TEXT NOT NULL,
  expires_at TEXT,
  purpose_limit TEXT,
  geography_limit TEXT,
  evidence_hash TEXT,
  acknowledged_at TEXT,
  recorded_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS consent_evidence (
  agreement_id TEXT PRIMARY KEY REFERENCES consent_agreements(agreement_id),
  document_ref TEXT,
  witnesses TEXT,
  verification_attestation TEXT
);
CREATE TABLE IF NOT EXISTS consent_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  agreement_id TEXT NOT NULL,
  event_kind TEXT NOT NULL CHECK
    (event_kind IN ('recorded','revoked','superseded_by','corrected_by')),
  recorded_at TEXT NOT NULL,
  related_agreement TEXT
);
CREATE TRIGGER IF NOT EXISTS consent_agreements_no_update
BEFORE UPDATE ON consent_agreements
BEGIN SELECT RAISE(ABORT, 'consent_agreements is append-only'); END;
CREATE TRIGGER IF NOT EXISTS consent_agreements_no_delete
BEFORE DELETE ON consent_agreements
BEGIN SELECT RAISE(ABORT, 'consent_agreements is append-only'); END;
CREATE TRIGGER IF NOT EXISTS consent_evidence_no_update
BEFORE UPDATE ON consent_evidence
BEGIN SELECT RAISE(ABORT, 'consent_evidence is append-only'); END;
CREATE TRIGGER IF NOT EXISTS consent_evidence_no_delete
BEFORE DELETE ON consent_evidence
BEGIN SELECT RAISE(ABORT, 'consent_evidence is append-only'); END;
CREATE TRIGGER IF NOT EXISTS consent_events_no_update
BEFORE UPDATE ON consent_events
BEGIN SELECT RAISE(ABORT, 'consent_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS consent_events_no_delete
BEFORE DELETE ON consent_events
BEGIN SELECT RAISE(ABORT, 'consent_events is append-only'); END;
-- Insert-time authorization-safety (review B3 F5): make a FORGED complete
-- record impossible at the SQL surface, not only through the Rust
-- constructors. `GeoPackage::conn()` is public, so the store — not just the
-- typed writer — must reject a structurally-thin or mis-shaped agreement.
-- 1. Only the enrolled local operator records; requester binding non-empty.
CREATE TRIGGER IF NOT EXISTS consent_agreements_recorder_shape
BEFORE INSERT ON consent_agreements
WHEN NEW.recorded_by NOT LIKE 'local-operator:%'
  OR length(trim(NEW.requester_binding)) = 0
  OR length(trim(NEW.authority_of_record)) = 0
  OR length(trim(NEW.product_class)) = 0
BEGIN SELECT RAISE(ABORT,
  'consent_agreements: recorded_by must be a local operator and binding/authority/class non-empty'); END;
-- 2. Evidence must be complete FOR ITS KIND (no thin evidence row).
CREATE TRIGGER IF NOT EXISTS consent_evidence_completeness
BEFORE INSERT ON consent_evidence
WHEN (SELECT kind FROM consent_agreements WHERE agreement_id = NEW.agreement_id) IS NULL
  OR ((SELECT kind FROM consent_agreements WHERE agreement_id = NEW.agreement_id) = 'tribal_signed'
      AND (NEW.document_ref IS NULL OR length(trim(NEW.document_ref)) = 0))
  OR ((SELECT kind FROM consent_agreements WHERE agreement_id = NEW.agreement_id) = 'individual_witnessed'
      AND (NEW.witnesses IS NULL OR length(trim(NEW.witnesses)) = 0
           OR NEW.verification_attestation IS NULL
           OR length(trim(NEW.verification_attestation)) = 0))
BEGIN SELECT RAISE(ABORT,
  'consent_evidence: evidence is incomplete for the agreement kind (thin evidence is unrecordable)'); END;
-- 3. A `recorded` event requires the agreement AND its evidence to already
--    exist (row presence alone never authorizes — the recorded marker is
--    unforgeable without the full proof). Also the proof-core hash and,
--    for signed agreements, acknowledged_at must be present.
CREATE TRIGGER IF NOT EXISTS consent_events_recorded_requires_proof
BEFORE INSERT ON consent_events
WHEN NEW.event_kind = 'recorded'
  AND (
    NOT EXISTS (SELECT 1 FROM consent_agreements a
                WHERE a.agreement_id = NEW.agreement_id
                  AND a.evidence_hash IS NOT NULL
                  AND length(trim(a.evidence_hash)) > 0)
    OR NOT EXISTS (SELECT 1 FROM consent_evidence e WHERE e.agreement_id = NEW.agreement_id)
  )
BEGIN SELECT RAISE(ABORT,
  'consent_events: a recorded event requires a complete agreement (proof hash) and evidence row'); END;
";

/// Agreement kind — must match the evidence variant (checked on record).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgreementKind {
    TribalSigned,
    IndividualWitnessed,
}

impl AgreementKind {
    fn code(self) -> &'static str {
        match self {
            Self::TribalSigned => "tribal_signed",
            Self::IndividualWitnessed => "individual_witnessed",
        }
    }
}

/// One agreement to record (§3.2). Validation happens in
/// [`ConsentStore::record_agreement`]; the typed evidence inside is
/// already unconstructible-if-thin (`crate::consent`).
#[derive(Debug, Clone)]
pub struct AgreementRecord {
    pub agreement_id: String,
    pub kind: AgreementKind,
    /// Source pack ids this agreement covers (ID-scoped; non-empty).
    pub source_scope: Vec<String>,
    /// The class of derived product authorized (recorded agreement term).
    pub product_class: String,
    pub evidence: ConsentBasis,
    /// The tribal signatory or witnessed consenter — agreement content,
    /// copied into every ceremony record (anti-echo, design §2.3).
    pub authority_of_record: String,
    /// The identity this agreement authorizes to request exports.
    pub requester_binding: ExportIdentity,
    pub conditions: Conditions,
    /// WHO records. MUST be a LocalOperator (§3.3) — delegates request
    /// exports, they do not record ceremonies.
    pub recorded_by: ExportIdentity,
}

/// Resolved status of one agreement, folded from the event log **by store
/// sequence** (never evidence timestamps).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgreementStatus {
    Active,
    Revoked,
    Superseded,
}

/// A matched agreement — everything the gate needs to construct the
/// authorization and the self-contained ledger row.
#[derive(Debug, Clone)]
pub struct MatchedAgreement {
    pub agreement_id: String,
    pub authority_of_record: String,
    /// The product class this agreement authorizes (recorded term, §3.2)
    /// — carried into the ceremony row so the ledger is self-contained.
    pub product_class: String,
    pub evidence: ConsentBasis,
    pub conditions: Conditions,
    /// The store's monotonic head sequence at match time (design §10:
    /// snapshot at authorization, revalidate at the publication point).
    pub store_sequence: i64,
}

/// GOVERNANCE outcomes of a match attempt that do not authorize — each
/// maps to `Declined { reason }` (never to an infrastructure failure).
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum MatchRefusal {
    #[error("no recorded agreement covers the witnessed source set")]
    NoAgreement,
    #[error("agreement '{0}' covering the source set is expired (expiry is enforced fail-closed)")]
    Expired(String),
    #[error("agreement '{0}' covering the source set is revoked — a revoked lineage head suspends its lineage; there is no fallback to ancestors")]
    Revoked(String),
    #[error("agreement '{0}' covering the source set is superseded — only the active lineage head can authorize")]
    Superseded(String),
    #[error("agreement '{0}' does not bind the requesting identity (wrong requester)")]
    WrongRequester(String),
    #[error("agreement '{agreement_id}' authorizes product class '{recorded}', not the requested '{requested}'")]
    WrongProductClass {
        agreement_id: String,
        recorded: String,
        requested: String,
    },
    #[error("independent agreements ({0}) each fully cover the source set — refused until the operator records how they relate or withdraws one (no unions in 1.0)")]
    DuplicateCoverage(String),
    #[error("agreement '{0}' is recorded but evidence-incomplete: {1} — row presence alone never authorizes")]
    EvidenceIncomplete(String, String),
}

/// Store failures — INFRASTRUCTURE, never governance (design §5.3): the
/// gate maps every variant to HTTP 503, never to `Declined`.
#[derive(Debug, thiserror::Error)]
pub enum ConsentStoreError {
    #[error("consent store unavailable: {0}")]
    Store(#[from] GpkgError),
    #[error(transparent)]
    Encryption(#[from] EncryptionRefused),
    #[error("consent store corrupt: {0}")]
    Corrupt(String),
    #[error("consent store clock: {0}")]
    Clock(String),
    #[error("consent store refuses the write: {0}")]
    InvalidRecord(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// The open consent store. All writes go through this handle so the
/// invariants (LocalOperator-only recording, T2-only scope, kind/evidence
/// agreement, append-only) hold in one place.
pub struct ConsentStore {
    gpkg: GeoPackage,
}

impl std::fmt::Debug for ConsentStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConsentStore")
            .field("path", &self.gpkg.path())
            .finish()
    }
}

impl ConsentStore {
    /// Open (or create + T3-tag) the consent store in `dir`. The store is
    /// a **T3 artifact**: its at-rest write is authorized through `cipher`
    /// BEFORE any bytes land — a fail-closed node refuses here, and a
    /// dev-plaintext store is permanently poison-stamped.
    pub fn open_or_create(
        dir: &Path,
        tsdf_version: &str,
        tsdf_origin: &str,
        cipher: &dyn AtRestCipher,
    ) -> Result<Self, ConsentStoreError> {
        let protection = cipher.authorize_at_rest(Tier::T3)?;
        std::fs::create_dir_all(dir)?;
        let path = dir.join(RESERVED_CONSENT_STORE_NAME);
        let gpkg = if path.is_file() {
            GeoPackage::open(&path)?
        } else {
            let gpkg = GeoPackage::create(&path)?;
            let mut extras = serde_json::Map::new();
            extras.insert(
                "classification_basis".into(),
                serde_json::Value::String(
                    "node-local consent store — never leaves the node".into(),
                ),
            );
            if protection == AtRestProtection::UnencryptedDev {
                extras.insert(
                    "at_rest".into(),
                    serde_json::Value::String(crate::cipher::UNENCRYPTED_DEV_STAMP.into()),
                );
            }
            gpkg.write_tsdf_tag(&TsdfTag {
                table: None,
                tier: Tier::T3,
                tsdf_version: tsdf_version.to_string(),
                tsdf_source_origin: tsdf_origin.to_string(),
                classified_by: "geobase-node".into(),
                extras,
            })?;
            gpkg
        };
        gpkg.conn()
            .execute_batch(CONSENT_DDL)
            .map_err(GpkgError::from)?;
        Ok(Self { gpkg })
    }

    /// The store's path (for diagnostics; never served).
    pub fn path(&self) -> PathBuf {
        self.gpkg.path().to_path_buf()
    }

    /// The monotonic head sequence (0 = no events yet).
    pub fn head_sequence(&self) -> Result<i64, ConsentStoreError> {
        head_sequence_of(self.gpkg.conn())
    }

    /// Acquire the store's **publication lock** (design §10, review B3
    /// F3): a held `BEGIN IMMEDIATE` transaction on a dedicated
    /// connection. While the returned guard lives, NO consent write — in
    /// this process or any other (the `record-consent` CLI included) —
    /// can commit, so the state revalidation observed cannot change
    /// between the publication-point check and the ledger seal. The guard
    /// never writes; dropping it rolls the empty transaction back and
    /// releases the lock. Cross-resource ACID with the export ledger is
    /// impossible by design — this serializes through SQLite file locking
    /// instead.
    pub fn lock_for_publication(&self) -> Result<ConsentStoreLock, ConsentStoreError> {
        let conn = rusqlite::Connection::open(self.gpkg.path()).map_err(GpkgError::from)?;
        // A bounded wait lets an in-flight consent write finish; after it
        // commits, the revalidation under this lock observes it.
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(GpkgError::from)?;
        conn.execute_batch("BEGIN IMMEDIATE")
            .map_err(GpkgError::from)?;
        Ok(ConsentStoreLock { _conn: conn })
    }

    /// Record one agreement (§3.3): a LocalOperator act; active the moment
    /// it is recorded evidence-complete. `supersedes` names the explicit
    /// predecessors this record supersedes (a new head may resolve several
    /// independent duplicates in one lineage act, §5.2 — lineage is only
    /// ever something a human recorded); `correction` marks the
    /// supersession as a correction — correction *is* supersession,
    /// annotated.
    pub fn record_agreement(
        &self,
        record: &AgreementRecord,
        supersedes: &[&str],
        correction: bool,
    ) -> Result<i64, ConsentStoreError> {
        // LocalOperator-only recording — a sovereignty rule, not a
        // permission default (§3.3).
        if !matches!(record.recorded_by, ExportIdentity::LocalOperator { .. }) {
            return Err(ConsentStoreError::InvalidRecord(
                "consent may only be recorded by the enrolled local operator — \
                 delegates request exports, they do not record ceremonies"
                    .into(),
            ));
        }
        let id = record.agreement_id.trim();
        if id.is_empty() {
            return Err(ConsentStoreError::InvalidRecord(
                "agreement_id must be non-empty".into(),
            ));
        }
        if record.source_scope.is_empty() || record.source_scope.iter().any(|s| s.trim().is_empty())
        {
            return Err(ConsentStoreError::InvalidRecord(
                "source_scope must be a non-empty set of pack ids".into(),
            ));
        }
        // Pack ids are stored and matched EXACTLY (catalog identity is the
        // raw file stem — vault.rs). A whitespace-padded id would be stored
        // padded and never match the gate's exact coverage check (silent
        // non-authorization). Refuse it loudly rather than trim: no ratified
        // pack-id grammar says surrounding whitespace is non-identity
        // padding, and canonicalizing here could broaden or redirect
        // authority (review B3 post-merge T-A).
        if let Some(padded) = record.source_scope.iter().find(|s| s.as_str() != s.trim()) {
            return Err(ConsentStoreError::InvalidRecord(format!(
                "source_scope id '{padded}' has surrounding whitespace — pack ids are matched \
                 exactly; record the id without padding"
            )));
        }
        if record.authority_of_record.trim().is_empty() {
            return Err(ConsentStoreError::InvalidRecord(
                "authority_of_record must be non-empty (the anti-echo property lives here)".into(),
            ));
        }
        if record.product_class.trim().is_empty() {
            return Err(ConsentStoreError::InvalidRecord(
                "product_class must be non-empty".into(),
            ));
        }
        // Kind must agree with the evidence variant — a tribal agreement
        // evidenced by verbal witnesses (or vice versa) is a recording
        // error, refused loudly.
        let kind_matches = matches!(
            (record.kind, &record.evidence),
            (
                AgreementKind::TribalSigned,
                ConsentBasis::SignedAgreement { .. }
            ) | (
                AgreementKind::IndividualWitnessed,
                ConsentBasis::WitnessedVerbal { .. }
            )
        );
        if !kind_matches {
            return Err(ConsentStoreError::InvalidRecord(format!(
                "agreement kind '{}' does not match its evidence variant",
                record.kind.code()
            )));
        }
        for predecessor in supersedes {
            if *predecessor == id {
                return Err(ConsentStoreError::InvalidRecord(
                    "an agreement cannot supersede itself".into(),
                ));
            }
            let exists: bool = self
                .gpkg
                .conn()
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM consent_agreements WHERE agreement_id = ?1)",
                    [predecessor],
                    |r| r.get(0),
                )
                .map_err(GpkgError::from)?;
            if !exists {
                return Err(ConsentStoreError::InvalidRecord(format!(
                    "supersedes names unknown agreement '{predecessor}' — precedence is only \
                     ever something a human recorded, against a record that exists"
                )));
            }
        }
        let recorded_at = UtcInstant::now()
            .map_err(|e| ConsentStoreError::Clock(e.to_string()))?
            .to_rfc3339();

        // Proof-core vs evidence-detail split (§3.2/§9).
        let (evidence_hash, acknowledged_at, document_ref, witnesses, attestation) =
            match &record.evidence {
                ConsentBasis::SignedAgreement {
                    document_ref,
                    document_hash,
                    acknowledged_at,
                } => (
                    Some(document_hash.to_hex()),
                    Some(acknowledged_at.to_rfc3339()),
                    Some(document_ref.clone()),
                    None,
                    None,
                ),
                ConsentBasis::WitnessedVerbal {
                    witnesses,
                    verification_attestation,
                } => {
                    let witnesses_json = serde_json::to_string(
                        &witnesses.iter().map(Witness::as_str).collect::<Vec<_>>(),
                    )
                    .map_err(GpkgError::from)?;
                    // §9 proof-core: commit a hash over the canonical
                    // witnessed detail so a future compaction that removes
                    // the identifying detail still proves what was carried.
                    let hash = witnessed_commitment_hex(&witnesses_json, verification_attestation);
                    (
                        Some(hash),
                        None,
                        None,
                        Some(witnesses_json),
                        Some(verification_attestation.clone()),
                    )
                }
            };

        let source_scope_json =
            serde_json::to_string(&record.source_scope).map_err(GpkgError::from)?;

        // One transaction: agreement proof-core + evidence detail + the
        // lineage events. All-or-nothing — a half-recorded agreement is
        // exactly the "row presence alone" state matching refuses anyway.
        let tx = self
            .gpkg
            .conn()
            .unchecked_transaction()
            .map_err(GpkgError::from)?;
        // A duplicate agreement_id is an OPERATOR INPUT error, not an
        // infrastructure fault: classify it as `InvalidRecord` (refused
        // write), never `Store` ("store unavailable"). `ON CONFLICT DO
        // NOTHING` + affected-row check is race-safe (no TOCTOU window a
        // select-before-insert would open) and narrow — only the named
        // primary-key conflict is reclassified; locks, I/O, other
        // constraints, and corruption stay infrastructure (review B3
        // post-merge F6). Refuse BEFORE the evidence/event inserts.
        let inserted = tx
            .execute(
                "INSERT INTO consent_agreements (agreement_id, kind, source_scope, product_class, \
                 product_tier, authority_of_record, requester_binding, expires_at, purpose_limit, \
                 geography_limit, evidence_hash, acknowledged_at, recorded_by) \
                 VALUES (?1, ?2, ?3, ?4, 'T2', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12) \
                 ON CONFLICT(agreement_id) DO NOTHING",
                rusqlite::params![
                    id,
                    record.kind.code(),
                    source_scope_json,
                    record.product_class.trim(),
                    record.authority_of_record.trim(),
                    record.requester_binding.audit_string(),
                    record
                        .conditions
                        .expires_at
                        .as_ref()
                        .map(UtcInstant::to_rfc3339),
                    record.conditions.purpose_limit,
                    record.conditions.geography_limit,
                    evidence_hash,
                    acknowledged_at,
                    record.recorded_by.audit_string(),
                ],
            )
            .map_err(GpkgError::from)?;
        if inserted == 0 {
            return Err(ConsentStoreError::InvalidRecord(format!(
                "agreement_id '{id}' already exists — recording is append-only; supersede or \
                 correct the existing agreement instead of re-recording its id"
            )));
        }
        tx.execute(
            "INSERT INTO consent_evidence (agreement_id, document_ref, witnesses, \
             verification_attestation) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![id, document_ref, witnesses, attestation],
        )
        .map_err(GpkgError::from)?;
        // The `recorded` event marks the new head active. Supersession of
        // each predecessor is carried by its OWN explicit event below, so
        // this event's related_agreement stays NULL (plural predecessors
        // cannot fit one column — review B3 F7).
        tx.execute(
            "INSERT INTO consent_events (event_id, agreement_id, event_kind, recorded_at, \
             related_agreement) VALUES (?1, ?2, 'recorded', ?3, NULL)",
            rusqlite::params![new_event_id()?, id, recorded_at],
        )
        .map_err(GpkgError::from)?;
        for predecessor in supersedes {
            // Each predecessor's lineage carries its own explicit event —
            // its history shows WHAT superseded it, not just that it was.
            let kind = if correction {
                "corrected_by"
            } else {
                "superseded_by"
            };
            tx.execute(
                "INSERT INTO consent_events (event_id, agreement_id, event_kind, recorded_at, \
                 related_agreement) VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![new_event_id()?, predecessor, kind, recorded_at, id],
            )
            .map_err(GpkgError::from)?;
        }
        tx.commit().map_err(GpkgError::from)?;
        self.head_sequence()
    }

    /// Revoke an agreement — an append, never a mutation (§3.3). Revoking
    /// a lineage head SUSPENDS the lineage: ancestors stay superseded, so
    /// there is never automatic fallback. Effect applies at the next
    /// authorization check.
    pub fn revoke(
        &self,
        agreement_id: &str,
        recorded_by: &ExportIdentity,
    ) -> Result<i64, ConsentStoreError> {
        if !matches!(recorded_by, ExportIdentity::LocalOperator { .. }) {
            return Err(ConsentStoreError::InvalidRecord(
                "revocation is a LocalOperator act".into(),
            ));
        }
        let exists: bool = self
            .gpkg
            .conn()
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM consent_agreements WHERE agreement_id = ?1)",
                [agreement_id],
                |r| r.get(0),
            )
            .map_err(GpkgError::from)?;
        if !exists {
            return Err(ConsentStoreError::InvalidRecord(format!(
                "cannot revoke unknown agreement '{agreement_id}'"
            )));
        }
        let recorded_at = UtcInstant::now()
            .map_err(|e| ConsentStoreError::Clock(e.to_string()))?
            .to_rfc3339();
        self.gpkg
            .conn()
            .execute(
                "INSERT INTO consent_events (event_id, agreement_id, event_kind, recorded_at, \
                 related_agreement) VALUES (?1, ?2, 'revoked', ?3, NULL)",
                rusqlite::params![new_event_id()?, agreement_id, recorded_at],
            )
            .map_err(GpkgError::from)?;
        self.head_sequence()
    }

    /// Fold the event log into per-agreement statuses, **by store
    /// sequence** (§3.1). Later events win; a revocation is terminal for
    /// its subject (a superseding record does not un-revoke anything).
    pub fn statuses(
        &self,
    ) -> Result<std::collections::BTreeMap<String, AgreementStatus>, ConsentStoreError> {
        fold_statuses(self.gpkg.conn())
    }

    /// Match the node-witnessed source set against the store (§5.2):
    /// ID-scoped subset match; expiry filtering BEFORE multiplicity;
    /// **multiplicity BEFORE requester binding** (independent duplicate
    /// full coverage refuses regardless of which requester each binds —
    /// review B3 F7); the sole active lineage head must bind the requester
    /// AND authorize the requested `product_class`. `Ok(Err(refusal))` is
    /// a GOVERNANCE outcome; `Err(_)` is INFRASTRUCTURE — never mixed
    /// (§5.3).
    ///
    /// All reads run inside ONE deferred transaction so the folded
    /// statuses, the agreement rows, and the returned `store_sequence` are
    /// a single coherent snapshot — a revocation committing mid-match
    /// cannot be observed as Active by the fold and simultaneously present
    /// in the sequence (review B3 F3).
    pub fn match_agreement(
        &self,
        source_set: &[String],
        requester: &ExportIdentity,
        product_class: &str,
        observed_at: UtcInstant,
    ) -> Result<Result<MatchedAgreement, MatchRefusal>, ConsentStoreError> {
        let tx = self
            .gpkg
            .conn()
            .unchecked_transaction()
            .map_err(GpkgError::from)?;
        let statuses = fold_statuses(&tx)?;
        let rows = read_agreements(&tx)?;
        let snapshot_sequence = head_sequence_of(&tx)?;
        // Read-only: commit releases the snapshot without writing.
        tx.commit().map_err(GpkgError::from)?;

        // 1. Coverage: which agreements' source_scope ⊇ the witnessed set.
        let mut covering: Vec<&StoredAgreement> = Vec::new();
        for row in &rows {
            let scope: Vec<String> = serde_json::from_str(&row.source_scope).map_err(|e| {
                ConsentStoreError::Corrupt(format!(
                    "agreement '{}' has unreadable source_scope: {e}",
                    row.agreement_id
                ))
            })?;
            if source_set.iter().all(|pack| scope.contains(pack)) {
                covering.push(row);
            }
        }
        if covering.is_empty() {
            return Ok(Err(MatchRefusal::NoAgreement));
        }

        // 2. Status: only active lineage heads survive. Track the best
        //    near-miss so the refusal names the strongest blocking fact.
        let mut active: Vec<&StoredAgreement> = Vec::new();
        let mut near_miss: Option<MatchRefusal> = None;
        for row in covering {
            match statuses.get(&row.agreement_id) {
                Some(AgreementStatus::Active) => active.push(row),
                Some(AgreementStatus::Revoked) => {
                    near_miss = Some(MatchRefusal::Revoked(row.agreement_id.clone()));
                }
                Some(AgreementStatus::Superseded) => {
                    if !matches!(near_miss, Some(MatchRefusal::Revoked(_))) {
                        near_miss = Some(MatchRefusal::Superseded(row.agreement_id.clone()));
                    }
                }
                None => {
                    return Err(ConsentStoreError::Corrupt(format!(
                        "agreement '{}' exists with no recorded event",
                        row.agreement_id
                    )));
                }
            }
        }

        // 3. Expiry filtering BEFORE multiplicity (§5.1 step 4): an
        //    expired head neither authorizes nor counts as a duplicate.
        let mut unexpired: Vec<&StoredAgreement> = Vec::new();
        for row in active {
            match &row.expires_at {
                Some(expiry_text) => {
                    let expiry = UtcInstant::parse_rfc3339(expiry_text).map_err(|e| {
                        ConsentStoreError::Corrupt(format!(
                            "agreement '{}' has unreadable expires_at: {e}",
                            row.agreement_id
                        ))
                    })?;
                    if observed_at >= expiry {
                        if near_miss.is_none() {
                            near_miss = Some(MatchRefusal::Expired(row.agreement_id.clone()));
                        }
                    } else {
                        unexpired.push(row);
                    }
                }
                None => unexpired.push(row),
            }
        }

        // 4. Multiplicity BEFORE requester AND before product class
        //    (review B3 F7; disposition B3 post-merge T-B): more than one
        //    active, unexpired agreement fully covering the set is
        //    ambiguous — refuse regardless of requester binding OR product
        //    class until the operator records the lineage relationship.
        //    This is deliberate: design §5.2 says independent duplicate
        //    coverage refuses until related, and the ratified §5.1 order
        //    evaluates multiplicity on the covering active-head set as a
        //    whole. Two heads that differ ONLY in product class are still
        //    two independent covering heads — filtering by class here would
        //    be an availability-expanding governance change, not a fix.
        let head = match unexpired.len() {
            0 => return Ok(Err(near_miss.unwrap_or(MatchRefusal::NoAgreement))),
            1 => unexpired[0],
            _ => {
                let ids: Vec<&str> = unexpired.iter().map(|r| r.agreement_id.as_str()).collect();
                return Ok(Err(MatchRefusal::DuplicateCoverage(ids.join(", "))));
            }
        };

        // 5. The sole head must bind THIS requester and authorize the
        //    requested product class (recorded agreement term, §3.2).
        if head.requester_binding != requester.audit_string() {
            return Ok(Err(MatchRefusal::WrongRequester(head.agreement_id.clone())));
        }
        if head.product_class != product_class {
            return Ok(Err(MatchRefusal::WrongProductClass {
                agreement_id: head.agreement_id.clone(),
                recorded: head.product_class.clone(),
                requested: product_class.to_string(),
            }));
        }

        // 6. Reconstruct evidence through the validating constructors — a
        //    store-side incomplete record refuses here.
        match rebuild_evidence(head, observed_at) {
            Ok(evidence) => Ok(Ok(MatchedAgreement {
                agreement_id: head.agreement_id.clone(),
                authority_of_record: head.authority_of_record.clone(),
                product_class: head.product_class.clone(),
                evidence,
                conditions: rebuild_conditions(head)?,
                store_sequence: snapshot_sequence,
            })),
            Err(reason) => Ok(Err(MatchRefusal::EvidenceIncomplete(
                head.agreement_id.clone(),
                reason,
            ))),
        }
    }
}

/// Fold the event log (by store sequence) using `conn` — shared by the
/// pub `statuses` method and the transactional `match_agreement` snapshot.
fn fold_statuses(
    conn: &rusqlite::Connection,
) -> Result<std::collections::BTreeMap<String, AgreementStatus>, ConsentStoreError> {
    let mut stmt = conn
        .prepare(
            "SELECT agreement_id, event_kind, related_agreement FROM consent_events ORDER BY seq",
        )
        .map_err(GpkgError::from)?;
    let events: Vec<(String, String, Option<String>)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(GpkgError::from)?
        .collect::<Result<_, _>>()
        .map_err(GpkgError::from)?;

    let mut statuses = std::collections::BTreeMap::new();
    for (subject, kind, related) in events {
        match kind.as_str() {
            "recorded" => {
                // A `recorded` event ACTIVATES a subject only if the subject
                // has no status yet. The honest writer emits exactly one
                // `recorded` per agreement, first; a later `recorded` for the
                // same subject (only reachable through raw SQL) must never
                // un-revoke or un-supersede it (review B3 F5 — no
                // resurrection by replay).
                statuses
                    .entry(subject.clone())
                    .or_insert(AgreementStatus::Active);
                if let Some(predecessor) = related {
                    statuses
                        .entry(predecessor)
                        .and_modify(|s| {
                            if *s == AgreementStatus::Active {
                                *s = AgreementStatus::Superseded;
                            }
                        })
                        .or_insert(AgreementStatus::Superseded);
                }
            }
            "revoked" => {
                statuses.insert(subject, AgreementStatus::Revoked);
            }
            "superseded_by" | "corrected_by" => {
                statuses
                    .entry(subject)
                    .and_modify(|s| {
                        if *s == AgreementStatus::Active {
                            *s = AgreementStatus::Superseded;
                        }
                    })
                    .or_insert(AgreementStatus::Superseded);
            }
            other => {
                return Err(ConsentStoreError::Corrupt(format!(
                    "unknown event_kind '{other}' in consent_events"
                )));
            }
        }
    }
    Ok(statuses)
}

fn head_sequence_of(conn: &rusqlite::Connection) -> Result<i64, ConsentStoreError> {
    let head: Option<i64> = conn
        .query_row("SELECT MAX(seq) FROM consent_events", [], |r| r.get(0))
        .map_err(GpkgError::from)?;
    Ok(head.unwrap_or(0))
}

fn read_agreements(conn: &rusqlite::Connection) -> Result<Vec<StoredAgreement>, ConsentStoreError> {
    let mut stmt = conn
        .prepare(
            "SELECT a.agreement_id, a.kind, a.source_scope, a.product_class, \
                    a.authority_of_record, a.requester_binding, a.expires_at, \
                    a.purpose_limit, a.geography_limit, a.evidence_hash, a.acknowledged_at, \
                    e.document_ref, e.witnesses, e.verification_attestation \
             FROM consent_agreements a \
             LEFT JOIN consent_evidence e ON e.agreement_id = a.agreement_id \
             ORDER BY a.agreement_id",
        )
        .map_err(GpkgError::from)?;
    let rows = stmt
        .query_map([], |r| {
            Ok(StoredAgreement {
                agreement_id: r.get(0)?,
                kind: r.get(1)?,
                source_scope: r.get(2)?,
                product_class: r.get(3)?,
                authority_of_record: r.get(4)?,
                requester_binding: r.get(5)?,
                expires_at: r.get(6)?,
                purpose_limit: r.get(7)?,
                geography_limit: r.get(8)?,
                evidence_hash: r.get(9)?,
                acknowledged_at: r.get(10)?,
                document_ref: r.get(11)?,
                witnesses: r.get(12)?,
                verification_attestation: r.get(13)?,
            })
        })
        .map_err(GpkgError::from)?
        .collect::<Result<_, _>>()
        .map_err(GpkgError::from)?;
    Ok(rows)
}

/// One agreement row as stored (proof-core + joined evidence detail).
struct StoredAgreement {
    agreement_id: String,
    kind: String,
    source_scope: String,
    product_class: String,
    authority_of_record: String,
    requester_binding: String,
    expires_at: Option<String>,
    purpose_limit: Option<String>,
    geography_limit: Option<String>,
    evidence_hash: Option<String>,
    acknowledged_at: Option<String>,
    document_ref: Option<String>,
    witnesses: Option<String>,
    verification_attestation: Option<String>,
}

/// Rebuild typed evidence from stored fields THROUGH the validating
/// constructors — a store-side incomplete or malformed record fails here
/// and is refused (row presence alone never authorizes).
fn rebuild_evidence(row: &StoredAgreement, now: UtcInstant) -> Result<ConsentBasis, String> {
    match row.kind.as_str() {
        "tribal_signed" => {
            let document_ref = row.document_ref.as_deref().ok_or("missing document_ref")?;
            let hash_hex = row
                .evidence_hash
                .as_deref()
                .ok_or("missing evidence_hash")?;
            let acknowledged = row
                .acknowledged_at
                .as_deref()
                .ok_or("missing acknowledged_at")?;
            let digest = Sha256Digest::from_hex(hash_hex).map_err(|e| e.to_string())?;
            let acknowledged_at =
                UtcInstant::parse_rfc3339(acknowledged).map_err(|e| e.to_string())?;
            ConsentBasis::signed_agreement(document_ref, digest, acknowledged_at, now)
                .map_err(|e| e.to_string())
        }
        "individual_witnessed" => {
            let witnesses_json = row.witnesses.as_deref().ok_or("missing witnesses")?;
            let attestation = row
                .verification_attestation
                .as_deref()
                .ok_or("missing verification_attestation")?;
            // §9 binding, enforced on the authorization READ path (review
            // B3 F8): the retained proof-core hash must equal the
            // commitment recomputed over the stored detail. This is an
            // INTEGRITY check, not writer authentication (review B3-r3
            // F2): a record whose hash does not bind its detail —
            // corruption, or detail edited out from under the hash —
            // never authorizes; a raw-SQL forger who computes the correct
            // unkeyed digest over fabricated detail passes it (the
            // documented raw-SQL residual, closed by B4's sealed store).
            let stored_hash = row
                .evidence_hash
                .as_deref()
                .ok_or("missing evidence_hash")?;
            let recomputed = witnessed_commitment_hex(witnesses_json, attestation);
            if stored_hash != recomputed {
                return Err(
                    "evidence_hash does not match the witnessed-verbal commitment recomputed \
                     over the stored detail — the proof-core hash must bind the evidence"
                        .into(),
                );
            }
            let names: Vec<String> =
                serde_json::from_str(witnesses_json).map_err(|e| e.to_string())?;
            let witnesses = names
                .iter()
                .map(|n| Witness::new(n))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            ConsentBasis::witnessed_verbal(witnesses, attestation).map_err(|e| e.to_string())
        }
        other => Err(format!("unknown agreement kind '{other}'")),
    }
}

fn rebuild_conditions(row: &StoredAgreement) -> Result<Conditions, ConsentStoreError> {
    let expires_at = row
        .expires_at
        .as_deref()
        .map(UtcInstant::parse_rfc3339)
        .transpose()
        .map_err(|e| {
            ConsentStoreError::Corrupt(format!(
                "agreement '{}' has unreadable expires_at: {e}",
                row.agreement_id
            ))
        })?;
    Ok(Conditions {
        expires_at,
        purpose_limit: row.purpose_limit.clone(),
        geography_limit: row.geography_limit.clone(),
    })
}

/// A held publication lock on the consent store — see
/// [`ConsentStore::lock_for_publication`]. Holds an open `BEGIN
/// IMMEDIATE` transaction; dropping the connection rolls it back
/// (releasing the lock) — the guard performs no writes, ever.
pub struct ConsentStoreLock {
    _conn: rusqlite::Connection,
}

impl std::fmt::Debug for ConsentStoreLock {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConsentStoreLock").finish_non_exhaustive()
    }
}

/// The §9 witnessed-verbal proof-core commitment: a domain-separated hash
/// over the stored witnesses serialization + attestation. ONE definition,
/// used by the writer (to retain) and by the authorization read path (to
/// enforce — review B3 F8). UNKEYED by design honesty (review B3-r3 F2):
/// it proves detail/hash consistency (integrity, compaction), never who
/// wrote the row — writer authentication is B4's sealed store.
fn witnessed_commitment_hex(witnesses_json: &str, attestation: &str) -> String {
    let commitment = format!("witnessed-verbal-v1\n{witnesses_json}\n{attestation}");
    Sha256Digest::of_bytes(commitment.as_bytes()).to_hex()
}

/// An unforgeable event id from the OS CSPRNG.
fn new_event_id() -> Result<String, ConsentStoreError> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes)
        .map_err(|e| ConsentStoreError::Corrupt(format!("csprng unavailable: {e}")))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cipher::DevPlaintextCipher;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("geobase-consent-{name}-{nonce}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn store(dir: &Path) -> ConsentStore {
        ConsentStore::open_or_create(dir, "0.9.4", "vendored:test", &DevPlaintextCipher::new())
            .unwrap()
    }

    fn operator() -> ExportIdentity {
        ExportIdentity::local_operator("op-1").unwrap()
    }

    fn t(s: &str) -> UtcInstant {
        UtcInstant::parse_rfc3339(s).unwrap()
    }

    fn signed_evidence() -> ConsentBasis {
        ConsentBasis::signed_agreement(
            "agreements/test.pdf",
            Sha256Digest::from_hex(&"ab".repeat(32)).unwrap(),
            t("2026-07-01T00:00:00Z"),
            t("2026-07-16T00:00:00Z"),
        )
        .unwrap()
    }

    fn agreement(id: &str, scope: &[&str]) -> AgreementRecord {
        AgreementRecord {
            agreement_id: id.into(),
            kind: AgreementKind::TribalSigned,
            source_scope: scope.iter().map(|s| s.to_string()).collect(),
            product_class: "painted-opportunity-shapefile".into(),
            evidence: signed_evidence(),
            authority_of_record: "Example Signatory, Example Nation".into(),
            requester_binding: operator(),
            conditions: Conditions::default(),
            recorded_by: operator(),
        }
    }

    fn now() -> UtcInstant {
        t("2026-07-16T12:00:00Z")
    }

    fn set(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn store_is_t3_tagged_reserved_named_and_poison_stamped_in_dev() {
        let dir = temp_dir("t3tag");
        let s = store(&dir);
        assert!(s.path().ends_with(RESERVED_CONSENT_STORE_NAME));
        let gpkg = GeoPackage::open(&s.path()).unwrap();
        assert_eq!(gpkg.geopackage_tier().unwrap(), Some(Tier::T3));
        let tags = gpkg.read_tsdf_tags().unwrap();
        let tag = tags.iter().find(|t| t.scope == "geopackage").unwrap();
        assert_eq!(tag.payload["at_rest"], crate::cipher::UNENCRYPTED_DEV_STAMP);
    }

    #[test]
    fn fail_closed_cipher_refuses_store_creation() {
        let dir = temp_dir("failclosed");
        let err = ConsentStore::open_or_create(
            &dir,
            "0.9.4",
            "vendored:test",
            &crate::cipher::FailClosedCipher,
        )
        .unwrap_err();
        assert!(matches!(err, ConsentStoreError::Encryption(_)));
        assert!(!dir.join(RESERVED_CONSENT_STORE_NAME).exists());
    }

    #[test]
    fn record_and_match_happy_path_both_kinds() {
        let dir = temp_dir("happy");
        let s = store(&dir);
        s.record_agreement(&agreement("a-tribal", &["dem", "landcover"]), &[], false)
            .unwrap();
        let mut individual = agreement("a-individual", &["interviews"]);
        individual.kind = AgreementKind::IndividualWitnessed;
        individual.evidence = ConsentBasis::witnessed_verbal(
            vec![
                Witness::new("Witness A").unwrap(),
                Witness::new("Witness B").unwrap(),
            ],
            "operator verified both witnesses in person",
        )
        .unwrap();
        s.record_agreement(&individual, &[], false).unwrap();

        let matched = s
            .match_agreement(
                &set(&["dem"]),
                &operator(),
                "painted-opportunity-shapefile",
                now(),
            )
            .unwrap()
            .unwrap();
        assert_eq!(matched.agreement_id, "a-tribal");
        assert_eq!(
            matched.authority_of_record,
            "Example Signatory, Example Nation"
        );
        assert!(matches!(
            matched.evidence,
            ConsentBasis::SignedAgreement { .. }
        ));
        assert!(matched.store_sequence > 0);

        let matched = s
            .match_agreement(
                &set(&["interviews"]),
                &operator(),
                "painted-opportunity-shapefile",
                now(),
            )
            .unwrap()
            .unwrap();
        assert!(matches!(
            matched.evidence,
            ConsentBasis::WitnessedVerbal { .. }
        ));
    }

    #[test]
    fn subset_match_is_id_scoped_and_wrong_scope_refuses() {
        let dir = temp_dir("scope");
        let s = store(&dir);
        s.record_agreement(&agreement("a1", &["dem", "landcover"]), &[], false)
            .unwrap();
        // Full coverage of a subset: authorized.
        assert!(s
            .match_agreement(
                &set(&["dem", "landcover"]),
                &operator(),
                "painted-opportunity-shapefile",
                now()
            )
            .unwrap()
            .is_ok());
        // A pack outside the scope: refused, no agreement covers.
        let refusal = s
            .match_agreement(
                &set(&["dem", "flood"]),
                &operator(),
                "painted-opportunity-shapefile",
                now(),
            )
            .unwrap()
            .unwrap_err();
        assert_eq!(refusal, MatchRefusal::NoAgreement);
    }

    #[test]
    fn revoked_head_suspends_lineage_no_ancestor_fallback() {
        let dir = temp_dir("lineage");
        let s = store(&dir);
        s.record_agreement(&agreement("v1", &["dem"]), &[], false)
            .unwrap();
        s.record_agreement(&agreement("v2", &["dem"]), &["v1"], false)
            .unwrap();
        // v2 is the head; v1 superseded.
        let matched = s
            .match_agreement(
                &set(&["dem"]),
                &operator(),
                "painted-opportunity-shapefile",
                now(),
            )
            .unwrap()
            .unwrap();
        assert_eq!(matched.agreement_id, "v2");
        // Revoke the head: the lineage is SUSPENDED — v1 must NOT come back.
        s.revoke("v2", &operator()).unwrap();
        let refusal = s
            .match_agreement(
                &set(&["dem"]),
                &operator(),
                "painted-opportunity-shapefile",
                now(),
            )
            .unwrap()
            .unwrap_err();
        assert_eq!(refusal, MatchRefusal::Revoked("v2".into()));
    }

    #[test]
    fn supersession_never_resurrects_a_revoked_predecessor() {
        let dir = temp_dir("norez");
        let s = store(&dir);
        s.record_agreement(&agreement("v1", &["dem"]), &[], false)
            .unwrap();
        s.revoke("v1", &operator()).unwrap();
        s.record_agreement(&agreement("v2", &["dem"]), &["v1"], false)
            .unwrap();
        let statuses = s.statuses().unwrap();
        assert_eq!(statuses["v1"], AgreementStatus::Revoked);
        assert_eq!(statuses["v2"], AgreementStatus::Active);
    }

    #[test]
    fn independent_duplicate_full_coverage_refuses_until_related() {
        let dir = temp_dir("dup");
        let s = store(&dir);
        s.record_agreement(&agreement("a1", &["dem"]), &[], false)
            .unwrap();
        s.record_agreement(&agreement("a2", &["dem", "landcover"]), &[], false)
            .unwrap();
        let refusal = s
            .match_agreement(
                &set(&["dem"]),
                &operator(),
                "painted-opportunity-shapefile",
                now(),
            )
            .unwrap()
            .unwrap_err();
        assert!(matches!(refusal, MatchRefusal::DuplicateCoverage(_)));
        // The operator records the relationship: a2 supersedes a1 → resolved.
        s.record_agreement(&agreement("a3", &["dem", "landcover"]), &["a1"], false)
            .unwrap();
        // Still duplicate: a2 and a3 both active… withdraw a2.
        s.revoke("a2", &operator()).unwrap();
        let matched = s
            .match_agreement(
                &set(&["dem"]),
                &operator(),
                "painted-opportunity-shapefile",
                now(),
            )
            .unwrap()
            .unwrap();
        assert_eq!(matched.agreement_id, "a3");
    }

    // Row counts across the three consent tables — for "appends nothing"
    // assertions on refused writes (review B3 post-merge F6/T-A).
    fn table_counts(s: &ConsentStore) -> (i64, i64, i64) {
        let gpkg = GeoPackage::open(&s.path()).unwrap();
        let c = |t: &str| -> i64 {
            gpkg.conn()
                .query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r.get(0))
                .unwrap()
        };
        (
            c("consent_agreements"),
            c("consent_evidence"),
            c("consent_events"),
        )
    }

    /// Review B3 post-merge F6: re-recording an existing agreement_id is an
    /// operator INPUT error (`InvalidRecord`), never an infrastructure fault
    /// (`Store` / "store unavailable"), and it appends NOTHING — no evidence
    /// or event row leaks from the aborted transaction.
    #[test]
    fn duplicate_agreement_id_is_invalid_record_and_appends_nothing() {
        let dir = temp_dir("dup-id");
        let s = store(&dir);
        s.record_agreement(&agreement("a1", &["dem"]), &[], false)
            .unwrap();
        let before = table_counts(&s);
        let seq_before = s.head_sequence().unwrap();

        let err = s
            .record_agreement(&agreement("a1", &["dem", "landcover"]), &[], false)
            .unwrap_err();
        match err {
            ConsentStoreError::InvalidRecord(msg) => {
                assert!(msg.contains("already exists"), "{msg}");
            }
            other => panic!("expected InvalidRecord for a duplicate id, got: {other:?}"),
        }
        assert_eq!(
            table_counts(&s),
            before,
            "a refused duplicate appends nothing"
        );
        assert_eq!(s.head_sequence().unwrap(), seq_before);
        // The original is intact and still authorizes.
        assert!(s
            .match_agreement(
                &set(&["dem"]),
                &operator(),
                "painted-opportunity-shapefile",
                now()
            )
            .unwrap()
            .is_ok());
    }

    /// Review B3 post-merge T-A: a whitespace-padded source id is refused
    /// (`InvalidRecord`) rather than silently stored padded — pack ids are
    /// matched exactly, so storing padding would be silent non-authorization.
    /// The exact id records and matches normally.
    #[test]
    fn padded_source_scope_is_invalid_and_appends_nothing() {
        let dir = temp_dir("padded-scope");
        let s = store(&dir);
        let before = table_counts(&s);

        let err = s
            .record_agreement(&agreement("a-pad", &[" dem "]), &[], false)
            .unwrap_err();
        assert!(
            matches!(err, ConsentStoreError::InvalidRecord(ref m) if m.contains("whitespace")),
            "expected InvalidRecord naming whitespace, got: {err:?}"
        );
        assert_eq!(
            table_counts(&s),
            before,
            "a refused padded id appends nothing"
        );

        // The exact (unpadded) id records and matches.
        s.record_agreement(&agreement("a-exact", &["dem"]), &[], false)
            .unwrap();
        assert!(s
            .match_agreement(
                &set(&["dem"]),
                &operator(),
                "painted-opportunity-shapefile",
                now()
            )
            .unwrap()
            .is_ok());
    }

    /// Review B3 post-merge T-B (regression pin, NOT a behavior change):
    /// two active, unexpired, same-scope agreements that differ ONLY in
    /// product class are still two independent covering heads —
    /// multiplicity refuses them as `DuplicateCoverage` BEFORE product class
    /// is considered. This is the ratified §5.2 independent-duplicate rule;
    /// filtering by class here would be an availability-expanding governance
    /// change. Pinned so a future "optimization" cannot silently expand it.
    #[test]
    fn different_product_classes_still_count_as_duplicate_source_coverage() {
        let dir = temp_dir("dup-class");
        let s = store(&dir);
        s.record_agreement(&agreement("a-classA", &["dem"]), &[], false)
            .unwrap();
        let mut other_class = agreement("a-classB", &["dem"]);
        other_class.product_class = "some-other-product-class".into();
        s.record_agreement(&other_class, &[], false).unwrap();

        // Matching EITHER class still refuses as duplicate coverage — the
        // ambiguity is over the covering active-head set, not the class.
        let refusal = s
            .match_agreement(
                &set(&["dem"]),
                &operator(),
                "painted-opportunity-shapefile",
                now(),
            )
            .unwrap()
            .unwrap_err();
        assert!(
            matches!(refusal, MatchRefusal::DuplicateCoverage(_)),
            "two heads differing only in product class are still duplicate coverage: {refusal:?}"
        );
    }

    #[test]
    fn expiry_is_enforced_fail_closed_and_filtered_before_multiplicity() {
        let dir = temp_dir("expiry");
        let s = store(&dir);
        let mut expiring = agreement("a-expiring", &["dem"]);
        expiring.conditions.expires_at = Some(t("2026-07-10T00:00:00Z"));
        s.record_agreement(&expiring, &[], false).unwrap();
        // Before expiry: authorizes.
        assert!(s
            .match_agreement(
                &set(&["dem"]),
                &operator(),
                "painted-opportunity-shapefile",
                t("2026-07-09T00:00:00Z")
            )
            .unwrap()
            .is_ok());
        // At/after expiry: refused (>= is expired — fail-closed boundary).
        let refusal = s
            .match_agreement(
                &set(&["dem"]),
                &operator(),
                "painted-opportunity-shapefile",
                t("2026-07-10T00:00:00Z"),
            )
            .unwrap()
            .unwrap_err();
        assert_eq!(refusal, MatchRefusal::Expired("a-expiring".into()));
        // Expiry BEFORE multiplicity: an expired head plus one live head is
        // a single match, not a duplicate.
        s.record_agreement(&agreement("a-live", &["dem"]), &[], false)
            .unwrap();
        let matched = s
            .match_agreement(
                &set(&["dem"]),
                &operator(),
                "painted-opportunity-shapefile",
                now(),
            )
            .unwrap()
            .unwrap();
        assert_eq!(matched.agreement_id, "a-live");
    }

    #[test]
    fn superseded_only_coverage_names_supersession_as_the_reason() {
        let dir = temp_dir("superseded-reason");
        let s = store(&dir);
        s.record_agreement(&agreement("v1", &["dem", "flood"]), &[], false)
            .unwrap();
        // v2 supersedes v1 but covers a NARROWER scope: for the wider set
        // the only covering agreement is the superseded v1.
        s.record_agreement(&agreement("v2", &["dem"]), &["v1"], false)
            .unwrap();
        let refusal = s
            .match_agreement(
                &set(&["dem", "flood"]),
                &operator(),
                "painted-opportunity-shapefile",
                now(),
            )
            .unwrap()
            .unwrap_err();
        assert_eq!(refusal, MatchRefusal::Superseded("v1".into()));
    }

    #[test]
    fn wrong_requester_refuses() {
        let dir = temp_dir("requester");
        let s = store(&dir);
        s.record_agreement(&agreement("a1", &["dem"]), &[], false)
            .unwrap();
        let other = ExportIdentity::local_operator("someone-else").unwrap();
        let refusal = s
            .match_agreement(
                &set(&["dem"]),
                &other,
                "painted-opportunity-shapefile",
                now(),
            )
            .unwrap()
            .unwrap_err();
        assert_eq!(refusal, MatchRefusal::WrongRequester("a1".into()));
    }

    #[test]
    fn delegates_cannot_record_or_revoke() {
        let dir = temp_dir("delegate");
        let s = store(&dir);
        let mut rec = agreement("a1", &["dem"]);
        rec.recorded_by = ExportIdentity::TribalDelegate {
            token: crate::consent::DelegateToken::test_only("t"),
        };
        assert!(matches!(
            s.record_agreement(&rec, &[], false),
            Err(ConsentStoreError::InvalidRecord(_))
        ));
        s.record_agreement(&agreement("a2", &["dem"]), &[], false)
            .unwrap();
        let delegate = ExportIdentity::TribalDelegate {
            token: crate::consent::DelegateToken::test_only("t"),
        };
        assert!(matches!(
            s.revoke("a2", &delegate),
            Err(ConsentStoreError::InvalidRecord(_))
        ));
    }

    #[test]
    fn store_is_append_only_by_trigger() {
        let dir = temp_dir("appendonly");
        let s = store(&dir);
        s.record_agreement(&agreement("a1", &["dem"]), &[], false)
            .unwrap();
        let gpkg = GeoPackage::open(&s.path()).unwrap();
        for sql in [
            "UPDATE consent_agreements SET authority_of_record = 'tampered'",
            "DELETE FROM consent_agreements",
            "UPDATE consent_events SET event_kind = 'revoked'",
            "DELETE FROM consent_events",
            "UPDATE consent_evidence SET document_ref = 'tampered'",
            "DELETE FROM consent_evidence",
        ] {
            assert!(gpkg.conn().execute(sql, []).is_err(), "{sql}");
        }
    }

    /// Review B3 F5: a forged agreement inserted through the public
    /// `GeoPackage::conn()` SQL surface — bypassing the typed constructors
    /// — must not become authorizable. The insert-time triggers reject a
    /// thin agreement (no evidence row / no proof hash) and a `recorded`
    /// event that lacks its proof, so the forgery cannot even land.
    #[test]
    fn raw_sql_forgery_is_rejected_by_insert_triggers() {
        let dir = temp_dir("forge");
        let s = store(&dir);
        s.record_agreement(&agreement("a1", &["dem"]), &[], false)
            .unwrap();
        let gpkg = GeoPackage::open(&s.path()).unwrap();

        // (a) A thin agreement with no proof hash: agreement insert is
        // allowed (proof-core hash is nullable at column level) but the
        // `recorded` event that would activate it is refused.
        gpkg.conn()
            .execute(
                "INSERT INTO consent_agreements (agreement_id, kind, source_scope, \
                 product_class, product_tier, authority_of_record, requester_binding, \
                 recorded_by) VALUES ('thin', 'tribal_signed', '[\"flood\"]', 'x', 'T2', \
                 'someone', ?1, ?1)",
                [operator().audit_string()],
            )
            .unwrap();
        let recorded = gpkg.conn().execute(
            "INSERT INTO consent_events (event_id, agreement_id, event_kind, recorded_at) \
             VALUES ('deadbeef', 'thin', 'recorded', '2026-07-16T00:00:00Z')",
            [],
        );
        assert!(
            recorded.is_err(),
            "a recorded event without proof/evidence must be rejected by the trigger"
        );

        // (b) A non-operator recorder is refused at agreement insert.
        let bad_recorder = gpkg.conn().execute(
            "INSERT INTO consent_agreements (agreement_id, kind, source_scope, product_class, \
             product_tier, authority_of_record, requester_binding, recorded_by) \
             VALUES ('forged', 'tribal_signed', '[\"dem\"]', 'x', 'T2', 'a', 'b', 'attacker')",
            [],
        );
        assert!(
            bad_recorder.is_err(),
            "recorded_by must be a local operator"
        );

        // (c) A thin evidence row (signed kind, no document_ref) is refused.
        gpkg.conn()
            .execute(
                "INSERT INTO consent_agreements (agreement_id, kind, source_scope, product_class, \
                 product_tier, authority_of_record, requester_binding, evidence_hash, recorded_by) \
                 VALUES ('t2', 'tribal_signed', '[\"dem\"]', 'x', 'T2', 'auth', ?1, 'abc', ?1)",
                [operator().audit_string()],
            )
            .unwrap();
        let thin_evidence = gpkg.conn().execute(
            "INSERT INTO consent_evidence (agreement_id, document_ref) VALUES ('t2', '')",
            [],
        );
        assert!(
            thin_evidence.is_err(),
            "empty evidence for a signed agreement must be refused"
        );
    }

    /// Review B3 F5 (resurrection): a raw-SQL `recorded` event appended
    /// AFTER a revocation must not restore the agreement to Active — the
    /// insert trigger allows it (the agreement genuinely has proof and
    /// evidence), so the status fold itself must refuse to resurrect.
    #[test]
    fn forged_recorded_replay_after_revoke_does_not_resurrect() {
        let dir = temp_dir("replay");
        let s = store(&dir);
        s.record_agreement(&agreement("a1", &["dem"]), &[], false)
            .unwrap();
        s.revoke("a1", &operator()).unwrap();
        let gpkg = GeoPackage::open(&s.path()).unwrap();
        gpkg.conn()
            .execute(
                "INSERT INTO consent_events (event_id, agreement_id, event_kind, recorded_at) \
                 VALUES ('feedc0de', 'a1', 'recorded', '2026-07-16T01:00:00Z')",
                [],
            )
            .unwrap();
        assert_eq!(
            s.statuses().unwrap()["a1"],
            AgreementStatus::Revoked,
            "a recorded replay must never un-revoke"
        );
        let refusal = s
            .match_agreement(
                &set(&["dem"]),
                &operator(),
                "painted-opportunity-shapefile",
                now(),
            )
            .unwrap()
            .unwrap_err();
        assert_eq!(refusal, MatchRefusal::Revoked("a1".into()));
    }

    /// Review B3 F5/F8 — the INTEGRITY half of the §9 commitment: a
    /// raw-SQL row whose stored hash does NOT bind its stored detail
    /// (plausible 64-hex value, detail fabricated separately) refuses at
    /// match time. This proves detail/hash binding — corruption and
    /// detail-edited-under-the-hash can never authorize. It does NOT
    /// prove forgery resistance: the companion test below shows a forger
    /// who computes the correct unkeyed digest authorizes (the documented
    /// raw-SQL residual, review B3-r3 F2 — B4 seals the channel).
    #[test]
    fn well_shaped_witnessed_forgery_refuses_on_commitment_mismatch() {
        let dir = temp_dir("wellshaped");
        let s = store(&dir);
        let gpkg = GeoPackage::open(&s.path()).unwrap();
        gpkg.conn()
            .execute(
                "INSERT INTO consent_agreements (agreement_id, kind, source_scope, \
                 product_class, product_tier, authority_of_record, requester_binding, \
                 evidence_hash, recorded_by) \
                 VALUES ('forged', 'individual_witnessed', '[\"forged-pack\"]', \
                 'painted-opportunity-shapefile', 'T2', 'Fabricated Authority', ?1, ?2, \
                 'local-operator:forged')",
                rusqlite::params![operator().audit_string(), "ab".repeat(32)],
            )
            .unwrap();
        gpkg.conn()
            .execute(
                "INSERT INTO consent_evidence (agreement_id, witnesses, \
                 verification_attestation) \
                 VALUES ('forged', '[\"Fake Witness A\",\"Fake Witness B\"]', \
                 'fabricated attestation text')",
                [],
            )
            .unwrap();
        gpkg.conn()
            .execute(
                "INSERT INTO consent_events (event_id, agreement_id, event_kind, recorded_at) \
                 VALUES ('f0f0f0f0', 'forged', 'recorded', '2026-07-16T00:00:00Z')",
                [],
            )
            .unwrap();
        let refusal = s
            .match_agreement(
                &set(&["forged-pack"]),
                &operator(),
                "painted-opportunity-shapefile",
                now(),
            )
            .unwrap()
            .unwrap_err();
        match refusal {
            MatchRefusal::EvidenceIncomplete(id, reason) => {
                assert_eq!(id, "forged");
                assert!(
                    reason.contains("commitment"),
                    "the refusal must name the commitment mismatch: {reason}"
                );
            }
            other => panic!("expected EvidenceIncomplete on commitment mismatch, got: {other:?}"),
        }
    }

    /// Review B3-r3 F2 — the HONEST RESIDUAL, pinned as a test so it can
    /// never silently be mistaken for a closed hole: a raw-SQL forger who
    /// controls witnesses, attestation, AND evidence_hash computes the
    /// publicly computable §9 commitment over fabricated detail — and the
    /// record AUTHORIZES. The unkeyed commitment is integrity, not writer
    /// authentication; the raw-write channel itself is what B4's sealed
    /// store closes. **B4 must flip this assertion** — when raw writes
    /// can no longer reach an authorizable store, this test's forgery
    /// must refuse, and this test must be rewritten to prove that.
    #[test]
    fn honest_residual_a_correctly_hashed_witnessed_forgery_authorizes_until_b4() {
        let dir = temp_dir("honest-residual");
        let s = store(&dir);
        let gpkg = GeoPackage::open(&s.path()).unwrap();
        let witnesses_json = "[\"Fake Witness A\",\"Fake Witness B\"]";
        let attestation = "fabricated attestation text";
        // The commitment is UNKEYED — anyone with the schema can compute
        // it. That is exactly why it cannot authenticate the writer.
        let correct_hash = super::witnessed_commitment_hex(witnesses_json, attestation);
        gpkg.conn()
            .execute(
                "INSERT INTO consent_agreements (agreement_id, kind, source_scope, \
                 product_class, product_tier, authority_of_record, requester_binding, \
                 evidence_hash, recorded_by) \
                 VALUES ('forged-well', 'individual_witnessed', '[\"forged-pack\"]', \
                 'painted-opportunity-shapefile', 'T2', 'Fabricated Authority', ?1, ?2, \
                 'local-operator:forged')",
                rusqlite::params![operator().audit_string(), correct_hash],
            )
            .unwrap();
        gpkg.conn()
            .execute(
                "INSERT INTO consent_evidence (agreement_id, witnesses, \
                 verification_attestation) \
                 VALUES ('forged-well', ?1, ?2)",
                rusqlite::params![witnesses_json, attestation],
            )
            .unwrap();
        gpkg.conn()
            .execute(
                "INSERT INTO consent_events (event_id, agreement_id, event_kind, recorded_at) \
                 VALUES ('f1f1f1f1', 'forged-well', 'recorded', '2026-07-16T00:00:00Z')",
                [],
            )
            .unwrap();
        let matched = s
            .match_agreement(
                &set(&["forged-pack"]),
                &operator(),
                "painted-opportunity-shapefile",
                now(),
            )
            .unwrap()
            .expect(
                "DOCUMENTED RESIDUAL (B3): a correctly hashed raw-SQL witnessed forgery \
                 authorizes until B4 seals the store — if this now REFUSES, B4 machinery \
                 has landed and this test must be rewritten to prove the closure",
            );
        assert_eq!(matched.agreement_id, "forged-well");
    }

    /// A store-side record whose evidence became unreadable AFTER a valid
    /// `recorded` event (e.g. corruption) still refuses at match time —
    /// row presence alone never authorizes (design §5.2). Simulated by
    /// matching against a genuine record whose evidence we then can't
    /// reconstruct is covered by the rebuild path; here we assert the
    /// positive record authorizes and its evidence rebuilds.
    #[test]
    fn genuine_record_authorizes_and_rebuilds_evidence() {
        let dir = temp_dir("genuine");
        let s = store(&dir);
        s.record_agreement(&agreement("a1", &["dem"]), &[], false)
            .unwrap();
        let matched = s
            .match_agreement(
                &set(&["dem"]),
                &operator(),
                "painted-opportunity-shapefile",
                now(),
            )
            .unwrap()
            .unwrap();
        assert!(matches!(
            matched.evidence,
            ConsentBasis::SignedAgreement { .. }
        ));
    }

    /// Review B3 F7: product-class mismatch is a governance refusal — an
    /// agreement recorded for one class does not authorize another.
    #[test]
    fn wrong_product_class_refuses() {
        let dir = temp_dir("class");
        let s = store(&dir);
        s.record_agreement(&agreement("a1", &["dem"]), &[], false)
            .unwrap();
        let refusal = s
            .match_agreement(&set(&["dem"]), &operator(), "some-other-class", now())
            .unwrap()
            .unwrap_err();
        assert!(matches!(refusal, MatchRefusal::WrongProductClass { .. }));
    }

    /// Review B3 F7: a new head may supersede SEVERAL predecessors in one
    /// lineage act, resolving independent duplicate coverage.
    #[test]
    fn one_head_supersedes_multiple_predecessors() {
        let dir = temp_dir("multisup");
        let s = store(&dir);
        s.record_agreement(&agreement("a1", &["dem"]), &[], false)
            .unwrap();
        s.record_agreement(&agreement("a2", &["dem", "landcover"]), &[], false)
            .unwrap();
        // a1 and a2 both cover {dem}: duplicate coverage.
        let refusal = s
            .match_agreement(
                &set(&["dem"]),
                &operator(),
                "painted-opportunity-shapefile",
                now(),
            )
            .unwrap()
            .unwrap_err();
        assert!(matches!(refusal, MatchRefusal::DuplicateCoverage(_)));
        // One composite head supersedes BOTH: resolved to a single head.
        s.record_agreement(
            &agreement("a3", &["dem", "landcover"]),
            &["a1", "a2"],
            false,
        )
        .unwrap();
        let matched = s
            .match_agreement(
                &set(&["dem"]),
                &operator(),
                "painted-opportunity-shapefile",
                now(),
            )
            .unwrap()
            .unwrap();
        assert_eq!(matched.agreement_id, "a3");
        let statuses = s.statuses().unwrap();
        assert_eq!(statuses["a1"], AgreementStatus::Superseded);
        assert_eq!(statuses["a2"], AgreementStatus::Superseded);
    }

    #[test]
    fn store_rejects_non_t2_scope_by_check_constraint() {
        let dir = temp_dir("t2only");
        let s = store(&dir);
        let gpkg = GeoPackage::open(&s.path()).unwrap();
        let err = gpkg.conn().execute(
            "INSERT INTO consent_agreements (agreement_id, kind, source_scope, product_class, \
             product_tier, authority_of_record, requester_binding, recorded_by) \
             VALUES ('t3', 'tribal_signed', '[]', 'x', 'T3', 'a', 'b', 'c')",
            [],
        );
        assert!(err.is_err(), "the store must reject non-T2 records");
    }

    #[test]
    fn kind_must_match_evidence_variant() {
        let dir = temp_dir("kindmatch");
        let s = store(&dir);
        let mut rec = agreement("a1", &["dem"]);
        rec.kind = AgreementKind::IndividualWitnessed; // evidence is SignedAgreement
        assert!(matches!(
            s.record_agreement(&rec, &[], false),
            Err(ConsentStoreError::InvalidRecord(_))
        ));
    }

    #[test]
    fn supersedes_must_name_an_existing_agreement() {
        let dir = temp_dir("ghost");
        let s = store(&dir);
        assert!(matches!(
            s.record_agreement(&agreement("a1", &["dem"]), &["ghost"], false),
            Err(ConsentStoreError::InvalidRecord(_))
        ));
    }

    #[test]
    fn correction_is_supersession_annotated() {
        let dir = temp_dir("correction");
        let s = store(&dir);
        s.record_agreement(&agreement("v1", &["dem"]), &[], false)
            .unwrap();
        s.record_agreement(&agreement("v1-corrected", &["dem"]), &["v1"], true)
            .unwrap();
        let gpkg = GeoPackage::open(&s.path()).unwrap();
        let kind: String = gpkg
            .conn()
            .query_row(
                "SELECT event_kind FROM consent_events WHERE agreement_id = 'v1' AND \
                 event_kind != 'recorded'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(kind, "corrected_by");
        let statuses = s.statuses().unwrap();
        assert_eq!(statuses["v1"], AgreementStatus::Superseded);
    }

    /// Design §10 / review B3 F3: while the publication lock is held, a
    /// concurrent consent write (here: a revocation through a second
    /// store handle, standing in for the `record-consent` CLI process)
    /// CANNOT commit; after the guard drops it can.
    #[test]
    fn publication_lock_blocks_concurrent_writes_until_dropped() {
        let dir = temp_dir("publock");
        let s = store(&dir);
        s.record_agreement(&agreement("a1", &["dem"]), &[], false)
            .unwrap();
        // A second, independent handle (its own connection) — opened
        // BEFORE the lock so its writes contend on the lock, not on open.
        let other = store(&dir);
        let lock = s.lock_for_publication().unwrap();
        let blocked = other.revoke("a1", &operator());
        assert!(
            blocked.is_err(),
            "a revocation must not commit while the publication lock is held"
        );
        // The subject is still Active — nothing committed.
        assert_eq!(s.statuses().unwrap()["a1"], AgreementStatus::Active);
        drop(lock);
        other.revoke("a1", &operator()).unwrap();
        assert_eq!(s.statuses().unwrap()["a1"], AgreementStatus::Revoked);
    }

    #[test]
    fn head_sequence_is_monotonic() {
        let dir = temp_dir("seq");
        let s = store(&dir);
        assert_eq!(s.head_sequence().unwrap(), 0);
        let s1 = s
            .record_agreement(&agreement("a1", &["dem"]), &[], false)
            .unwrap();
        let s2 = s.revoke("a1", &operator()).unwrap();
        assert!(s2 > s1);
        assert!(s1 > 0);
    }
}
