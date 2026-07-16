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
        let head: Option<i64> = self
            .gpkg
            .conn()
            .query_row("SELECT MAX(seq) FROM consent_events", [], |r| r.get(0))
            .map_err(GpkgError::from)?;
        Ok(head.unwrap_or(0))
    }

    /// Record one agreement (§3.3): a LocalOperator act; active the moment
    /// it is recorded evidence-complete. `supersedes` names an explicit
    /// predecessor (lineage is only ever something a human recorded);
    /// `correction` marks the supersession as a correction — correction
    /// *is* supersession, annotated.
    pub fn record_agreement(
        &self,
        record: &AgreementRecord,
        supersedes: Option<&str>,
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
        if record.source_scope.is_empty()
            || record.source_scope.iter().any(|s| s.trim().is_empty())
        {
            return Err(ConsentStoreError::InvalidRecord(
                "source_scope must be a non-empty set of pack ids".into(),
            ));
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
            (AgreementKind::TribalSigned, ConsentBasis::SignedAgreement { .. })
                | (
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
        if let Some(predecessor) = supersedes {
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
                } => (
                    None,
                    None,
                    None,
                    Some(
                        serde_json::to_string(
                            &witnesses.iter().map(Witness::as_str).collect::<Vec<_>>(),
                        )
                        .map_err(GpkgError::from)?,
                    ),
                    Some(verification_attestation.clone()),
                ),
            };

        let source_scope_json = serde_json::to_string(&record.source_scope)
            .map_err(GpkgError::from)?;

        // One transaction: agreement proof-core + evidence detail + the
        // lineage events. All-or-nothing — a half-recorded agreement is
        // exactly the "row presence alone" state matching refuses anyway.
        let tx = self
            .gpkg
            .conn()
            .unchecked_transaction()
            .map_err(GpkgError::from)?;
        tx.execute(
            "INSERT INTO consent_agreements (agreement_id, kind, source_scope, product_class, \
             product_tier, authority_of_record, requester_binding, expires_at, purpose_limit, \
             geography_limit, evidence_hash, acknowledged_at, recorded_by) \
             VALUES (?1, ?2, ?3, ?4, 'T2', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            rusqlite::params![
                id,
                record.kind.code(),
                source_scope_json,
                record.product_class.trim(),
                record.authority_of_record.trim(),
                record.requester_binding.audit_string(),
                record.conditions.expires_at.as_ref().map(UtcInstant::to_rfc3339),
                record.conditions.purpose_limit,
                record.conditions.geography_limit,
                evidence_hash,
                acknowledged_at,
                record.recorded_by.audit_string(),
            ],
        )
        .map_err(GpkgError::from)?;
        tx.execute(
            "INSERT INTO consent_evidence (agreement_id, document_ref, witnesses, \
             verification_attestation) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![id, document_ref, witnesses, attestation],
        )
        .map_err(GpkgError::from)?;
        tx.execute(
            "INSERT INTO consent_events (event_id, agreement_id, event_kind, recorded_at, \
             related_agreement) VALUES (?1, ?2, 'recorded', ?3, ?4)",
            rusqlite::params![new_event_id()?, id, recorded_at, supersedes],
        )
        .map_err(GpkgError::from)?;
        if let Some(predecessor) = supersedes {
            // The predecessor's lineage carries its own explicit event —
            // its history shows WHAT superseded it, not just that it was.
            let kind = if correction { "corrected_by" } else { "superseded_by" };
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
        let mut stmt = self
            .gpkg
            .conn()
            .prepare(
                "SELECT agreement_id, event_kind, related_agreement FROM consent_events \
                 ORDER BY seq",
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
                    statuses.insert(subject.clone(), AgreementStatus::Active);
                    if let Some(predecessor) = related {
                        // Supersession never resurrects a revoked record.
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

    /// Match the node-witnessed source set against the store (§5.2):
    /// ID-scoped subset match; expiry filtering BEFORE multiplicity;
    /// exactly one active lineage head must fully cover the set; no
    /// unions; independent duplicate coverage refuses; wrong requester
    /// refuses. `Ok(Err(refusal))` is a GOVERNANCE outcome; `Err(_)` is
    /// INFRASTRUCTURE — the two never mix (§5.3).
    pub fn match_agreement(
        &self,
        source_set: &[String],
        requester: &ExportIdentity,
        observed_at: UtcInstant,
    ) -> Result<Result<MatchedAgreement, MatchRefusal>, ConsentStoreError> {
        let statuses = self.statuses()?;
        let mut stmt = self
            .gpkg
            .conn()
            .prepare(
                "SELECT a.agreement_id, a.kind, a.source_scope, a.authority_of_record, \
                        a.requester_binding, a.expires_at, a.purpose_limit, a.geography_limit, \
                        a.evidence_hash, a.acknowledged_at, \
                        e.document_ref, e.witnesses, e.verification_attestation \
                 FROM consent_agreements a \
                 LEFT JOIN consent_evidence e ON e.agreement_id = a.agreement_id \
                 ORDER BY a.agreement_id",
            )
            .map_err(GpkgError::from)?;
        let rows: Vec<StoredAgreement> = stmt
            .query_map([], |r| {
                Ok(StoredAgreement {
                    agreement_id: r.get(0)?,
                    kind: r.get(1)?,
                    source_scope: r.get(2)?,
                    authority_of_record: r.get(3)?,
                    requester_binding: r.get(4)?,
                    expires_at: r.get(5)?,
                    purpose_limit: r.get(6)?,
                    geography_limit: r.get(7)?,
                    evidence_hash: r.get(8)?,
                    acknowledged_at: r.get(9)?,
                    document_ref: r.get(10)?,
                    witnesses: r.get(11)?,
                    verification_attestation: r.get(12)?,
                })
            })
            .map_err(GpkgError::from)?
            .collect::<Result<_, _>>()
            .map_err(GpkgError::from)?;

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

        // 2. Status: only the active lineage head can authorize. Track the
        //    best near-miss so the refusal reason names what actually
        //    blocked (revoked beats superseded beats expired in
        //    explanatory value — the operator needs the strongest fact).
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

        // 4. Requester binding.
        let requester_string = requester.audit_string();
        let mut bound: Vec<&StoredAgreement> = Vec::new();
        for row in unexpired {
            if row.requester_binding == requester_string {
                bound.push(row);
            } else if near_miss.is_none() {
                near_miss = Some(MatchRefusal::WrongRequester(row.agreement_id.clone()));
            }
        }

        // 5. Multiplicity: exactly one active lineage head.
        match bound.len() {
            0 => Ok(Err(near_miss.unwrap_or(MatchRefusal::NoAgreement))),
            1 => {
                let row = bound[0];
                match rebuild_evidence(row, observed_at) {
                    Ok(evidence) => Ok(Ok(MatchedAgreement {
                        agreement_id: row.agreement_id.clone(),
                        authority_of_record: row.authority_of_record.clone(),
                        evidence,
                        conditions: rebuild_conditions(row)?,
                        store_sequence: self.head_sequence()?,
                    })),
                    Err(reason) => Ok(Err(MatchRefusal::EvidenceIncomplete(
                        row.agreement_id.clone(),
                        reason,
                    ))),
                }
            }
            _ => {
                let ids: Vec<&str> = bound.iter().map(|r| r.agreement_id.as_str()).collect();
                Ok(Err(MatchRefusal::DuplicateCoverage(ids.join(", "))))
            }
        }
    }
}

/// One agreement row as stored (proof-core + joined evidence detail).
struct StoredAgreement {
    agreement_id: String,
    kind: String,
    source_scope: String,
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
            let hash_hex = row.evidence_hash.as_deref().ok_or("missing evidence_hash")?;
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
        assert_eq!(
            tag.payload["at_rest"],
            crate::cipher::UNENCRYPTED_DEV_STAMP
        );
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
        s.record_agreement(&agreement("a-tribal", &["dem", "landcover"]), None, false)
            .unwrap();
        let mut individual = agreement("a-individual", &["interviews"]);
        individual.kind = AgreementKind::IndividualWitnessed;
        individual.evidence = ConsentBasis::witnessed_verbal(
            vec![Witness::new("Witness A").unwrap(), Witness::new("Witness B").unwrap()],
            "operator verified both witnesses in person",
        )
        .unwrap();
        s.record_agreement(&individual, None, false).unwrap();

        let matched = s
            .match_agreement(&set(&["dem"]), &operator(), now())
            .unwrap()
            .unwrap();
        assert_eq!(matched.agreement_id, "a-tribal");
        assert_eq!(matched.authority_of_record, "Example Signatory, Example Nation");
        assert!(matches!(matched.evidence, ConsentBasis::SignedAgreement { .. }));
        assert!(matched.store_sequence > 0);

        let matched = s
            .match_agreement(&set(&["interviews"]), &operator(), now())
            .unwrap()
            .unwrap();
        assert!(matches!(matched.evidence, ConsentBasis::WitnessedVerbal { .. }));
    }

    #[test]
    fn subset_match_is_id_scoped_and_wrong_scope_refuses() {
        let dir = temp_dir("scope");
        let s = store(&dir);
        s.record_agreement(&agreement("a1", &["dem", "landcover"]), None, false)
            .unwrap();
        // Full coverage of a subset: authorized.
        assert!(s
            .match_agreement(&set(&["dem", "landcover"]), &operator(), now())
            .unwrap()
            .is_ok());
        // A pack outside the scope: refused, no agreement covers.
        let refusal = s
            .match_agreement(&set(&["dem", "flood"]), &operator(), now())
            .unwrap()
            .unwrap_err();
        assert_eq!(refusal, MatchRefusal::NoAgreement);
    }

    #[test]
    fn revoked_head_suspends_lineage_no_ancestor_fallback() {
        let dir = temp_dir("lineage");
        let s = store(&dir);
        s.record_agreement(&agreement("v1", &["dem"]), None, false)
            .unwrap();
        s.record_agreement(&agreement("v2", &["dem"]), Some("v1"), false)
            .unwrap();
        // v2 is the head; v1 superseded.
        let matched = s
            .match_agreement(&set(&["dem"]), &operator(), now())
            .unwrap()
            .unwrap();
        assert_eq!(matched.agreement_id, "v2");
        // Revoke the head: the lineage is SUSPENDED — v1 must NOT come back.
        s.revoke("v2", &operator()).unwrap();
        let refusal = s
            .match_agreement(&set(&["dem"]), &operator(), now())
            .unwrap()
            .unwrap_err();
        assert_eq!(refusal, MatchRefusal::Revoked("v2".into()));
    }

    #[test]
    fn supersession_never_resurrects_a_revoked_predecessor() {
        let dir = temp_dir("norez");
        let s = store(&dir);
        s.record_agreement(&agreement("v1", &["dem"]), None, false)
            .unwrap();
        s.revoke("v1", &operator()).unwrap();
        s.record_agreement(&agreement("v2", &["dem"]), Some("v1"), false)
            .unwrap();
        let statuses = s.statuses().unwrap();
        assert_eq!(statuses["v1"], AgreementStatus::Revoked);
        assert_eq!(statuses["v2"], AgreementStatus::Active);
    }

    #[test]
    fn independent_duplicate_full_coverage_refuses_until_related() {
        let dir = temp_dir("dup");
        let s = store(&dir);
        s.record_agreement(&agreement("a1", &["dem"]), None, false)
            .unwrap();
        s.record_agreement(&agreement("a2", &["dem", "landcover"]), None, false)
            .unwrap();
        let refusal = s
            .match_agreement(&set(&["dem"]), &operator(), now())
            .unwrap()
            .unwrap_err();
        assert!(matches!(refusal, MatchRefusal::DuplicateCoverage(_)));
        // The operator records the relationship: a2 supersedes a1 → resolved.
        s.record_agreement(&agreement("a3", &["dem", "landcover"]), Some("a1"), false)
            .unwrap();
        // Still duplicate: a2 and a3 both active… withdraw a2.
        s.revoke("a2", &operator()).unwrap();
        let matched = s
            .match_agreement(&set(&["dem"]), &operator(), now())
            .unwrap()
            .unwrap();
        assert_eq!(matched.agreement_id, "a3");
    }

    #[test]
    fn expiry_is_enforced_fail_closed_and_filtered_before_multiplicity() {
        let dir = temp_dir("expiry");
        let s = store(&dir);
        let mut expiring = agreement("a-expiring", &["dem"]);
        expiring.conditions.expires_at = Some(t("2026-07-10T00:00:00Z"));
        s.record_agreement(&expiring, None, false).unwrap();
        // Before expiry: authorizes.
        assert!(s
            .match_agreement(&set(&["dem"]), &operator(), t("2026-07-09T00:00:00Z"))
            .unwrap()
            .is_ok());
        // At/after expiry: refused (>= is expired — fail-closed boundary).
        let refusal = s
            .match_agreement(&set(&["dem"]), &operator(), t("2026-07-10T00:00:00Z"))
            .unwrap()
            .unwrap_err();
        assert_eq!(refusal, MatchRefusal::Expired("a-expiring".into()));
        // Expiry BEFORE multiplicity: an expired head plus one live head is
        // a single match, not a duplicate.
        s.record_agreement(&agreement("a-live", &["dem"]), None, false)
            .unwrap();
        let matched = s
            .match_agreement(&set(&["dem"]), &operator(), now())
            .unwrap()
            .unwrap();
        assert_eq!(matched.agreement_id, "a-live");
    }

    #[test]
    fn wrong_requester_refuses() {
        let dir = temp_dir("requester");
        let s = store(&dir);
        s.record_agreement(&agreement("a1", &["dem"]), None, false)
            .unwrap();
        let other = ExportIdentity::local_operator("someone-else").unwrap();
        let refusal = s
            .match_agreement(&set(&["dem"]), &other, now())
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
            s.record_agreement(&rec, None, false),
            Err(ConsentStoreError::InvalidRecord(_))
        ));
        s.record_agreement(&agreement("a2", &["dem"]), None, false)
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
        s.record_agreement(&agreement("a1", &["dem"]), None, false)
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

    #[test]
    fn evidence_incomplete_store_record_refuses_not_authorizes() {
        let dir = temp_dir("thin");
        let s = store(&dir);
        s.record_agreement(&agreement("a1", &["dem"]), None, false)
            .unwrap();
        // Simulate a store-side thin record by inserting one directly
        // (bypassing the typed write path, as corruption or an old tool
        // might). Row presence alone must never authorize.
        let gpkg = GeoPackage::open(&s.path()).unwrap();
        gpkg.conn()
            .execute(
                "INSERT INTO consent_agreements (agreement_id, kind, source_scope, \
                 product_class, product_tier, authority_of_record, requester_binding, \
                 recorded_by) VALUES ('thin', 'tribal_signed', '[\"flood\"]', 'x', 'T2', \
                 'someone', ?1, ?1)",
                [operator().audit_string()],
            )
            .unwrap();
        gpkg.conn()
            .execute(
                "INSERT INTO consent_events (event_id, agreement_id, event_kind, recorded_at) \
                 VALUES ('deadbeef', 'thin', 'recorded', '2026-07-16T00:00:00Z')",
                [],
            )
            .unwrap();
        drop(gpkg);
        let refusal = s
            .match_agreement(&set(&["flood"]), &operator(), now())
            .unwrap()
            .unwrap_err();
        assert!(matches!(refusal, MatchRefusal::EvidenceIncomplete(_, _)));
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
            s.record_agreement(&rec, None, false),
            Err(ConsentStoreError::InvalidRecord(_))
        ));
    }

    #[test]
    fn supersedes_must_name_an_existing_agreement() {
        let dir = temp_dir("ghost");
        let s = store(&dir);
        assert!(matches!(
            s.record_agreement(&agreement("a1", &["dem"]), Some("ghost"), false),
            Err(ConsentStoreError::InvalidRecord(_))
        ));
    }

    #[test]
    fn correction_is_supersession_annotated() {
        let dir = temp_dir("correction");
        let s = store(&dir);
        s.record_agreement(&agreement("v1", &["dem"]), None, false)
            .unwrap();
        s.record_agreement(&agreement("v1-corrected", &["dem"]), Some("v1"), true)
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

    #[test]
    fn head_sequence_is_monotonic() {
        let dir = temp_dir("seq");
        let s = store(&dir);
        assert_eq!(s.head_sequence().unwrap(), 0);
        let s1 = s
            .record_agreement(&agreement("a1", &["dem"]), None, false)
            .unwrap();
        let s2 = s.revoke("a1", &operator()).unwrap();
        assert!(s2 > s1);
        assert!(s1 > 0);
    }
}
