//! Zero-source-disclosure export — Phase 1.3b contract, B3 sovereign
//! rework (`docs/CEREMONY-DESIGN.md` §2.4, §5.3, §6).
//!
//! `export_product()` turns **painted opportunity polygons** into a
//! T2-stamped shapefile product. The sovereignty guarantee — *the export
//! contains only the product, never the sources* — is a **verifier, not
//! a promise**: after writing, the pipeline re-opens its own output and
//! refuses to release it unless every check below passes. The RStep gate
//! (1.3d) re-proves the same properties with pyogrio from outside.
//!
//! ## The guarantee checks (frozen — never weaken, only add)
//!
//! Re-open the written shapefile via [`geobase_ingestor::shp::read_shapefile`]:
//! 1. Feature count == painted polygon count, exactly.
//! 2. DBF fields are EXACTLY the product whitelist [`PRODUCT_FIELDS`]
//!    (`id`, `area_m2`, `score`) — no source attribute name can appear
//!    because nothing outside the whitelist can be written.
//! 3. Every output geometry's coordinate multiset equals its painted
//!    input's — the product is what was painted, nothing else.
//! 4. NO output geometry coordinate-equals any geometry in any source
//!    pack's feature tables — a painted polygon that traces a source
//!    feature exactly is refused (that would republish the source).
//!
//! ## Ceremony seam (B3: the sovereign boundary)
//!
//! Every export passes [`geobase_gpkg::ceremony::CeremonyGate`] BEFORE
//! any file is written. The source set is **node-witnessed** (export
//! sessions, design §4) — `sources` comes from the node's own session
//! record resolved against the catalog, never from the request. The
//! requester is the **authenticated** [`ExportIdentity`] — free-text
//! identity was replaced at B3 (breaking seam change, recorded).
//!
//! Refusals split by design §5.3: governance denials
//! ([`ExportError::Refused`], HTTP 403, exactly one `export.refused` row
//! carrying the `observed_at` the decision used) vs infrastructure
//! failures ([`ExportError::Infrastructure`], HTTP 503, an
//! `export.infrastructure` row *attempted* — if the ledger itself is
//! down, the response says no durable row was possible).
//!
//! ## Recoverable atomic publication (design §6 — NOT cross-resource ACID)
//!
//! One SQLite transaction cannot atomically publish multi-file products,
//! so publication is a **recoverable state machine** in which every crash
//! point has a defined, truthful meaning:
//!
//! 1. Append an `export.intent` row (publication id).
//! 2. Write and verify the product bundle in `.staging/<publication-id>/`
//!    on the same volume.
//! 3. Revalidate consent at the publication point (§10 linearization),
//!    then in ONE SQLite transaction append exactly one `export.ceremony`
//!    and one `export.t2`, both `state: "prepared"`, carrying product
//!    hashes + the publication id; the ledger runs `synchronous=FULL` so
//!    the commit is a durable seal.
//! 4. ONE atomic namespace operation: rename the staging directory to
//!    `exports_dir/<product>/`.
//! 5. Append `export.published` (finalize). The HTTP success response
//!    occurs ONLY after finalization.
//! 6. [`recover_publications`] at startup finds prepared-but-unfinalized
//!    publications, re-verifies hashes, and either finalizes or appends
//!    an `export.aborted` — every crash state resolves truthfully.
//!
//! ## Export ledger + tier stamping
//!
//! Audit rows land in `exports_dir/node-audit.gpkg` — whole-artifact T3
//! ("node-local export ledger — never leaves the node"), fail-closed
//! through the cipher seam, never catalogued (reserved name). The
//! consent store (`node-consent.gpkg`) lives alongside it with the same
//! posture. A shapefile has no in-band metadata channel, so the T2 stamp
//! travels as (a) the ledger rows, (b) the API response, and (c) a
//! `<stem>.tsdf.json` sidecar in the bundle.
//!
//! ## Route: `POST /api/export`
//!
//! B3 request JSON (BREAKING — the old `source_packs`/`requester` body
//! is refused by `deny_unknown_fields`):
//!   `{ "product": "<name>", "session": "<export session id>",
//!      "purpose": "<text, optional>", "features": [...] }`
//! The source set is the session's node-witnessed record; identity is
//! the authenticated operator (interim A1 token until B5). Statuses:
//! 400 invalid, 403 governance refusal, 404 unknown session pack (cannot
//! happen — witnessed packs resolve or floor-refuse), 409 exists,
//! 503 infrastructure/fail-closed. Success is T2-stamped, fully audited,
//! and returned only after publication finalizes.

use std::path::{Path, PathBuf};

use geobase_gpkg::ceremony::{
    CeremonyError, CeremonyGate, CeremonyRecord, ExportAuthorization, SourcePackWitness,
};
use geobase_gpkg::consent::ExportIdentity;
use geobase_tsdf::Tier;

/// The ONLY DBF fields an exported product may carry, in order.
pub const PRODUCT_FIELDS: [&str; 3] = ["id", "area_m2", "score"];

/// The product tier every export is stamped with.
pub const PRODUCT_TIER: Tier = Tier::T2;

/// The class of derived product this pipeline emits (a recorded agreement
/// term, design §3.2): the matched consent agreement must authorize THIS
/// class. Fixed for the 1.3 painted-opportunity flow.
pub const PRODUCT_CLASS: &str = "painted-opportunity-shapefile";

/// The hidden staging area for in-flight publications (same volume as the
/// final bundles, so the publish rename is atomic).
const STAGING_DIR: &str = ".staging";

/// One painted feature: geometry (EPSG:4326) + the painter's score.
#[derive(Debug, Clone)]
pub struct PaintedFeature {
    pub geometry: PaintedGeometry,
    /// Finite; recorded verbatim in the product's `score` column.
    pub score: f64,
}

/// Painted geometry — the narrow paint surface.
#[derive(Debug, Clone)]
pub enum PaintedGeometry {
    Polygon(geo_types::Polygon<f64>),
    MultiPolygon(geo_types::MultiPolygon<f64>),
}

/// A validated export request (the route builds this from JSON). B3: no
/// `source_packs` (node-witnessed sessions produce the source set) and no
/// `requester` (identity is authenticated, not claimed).
#[derive(Debug, Clone)]
pub struct ExportRequest {
    /// Product name: `^[a-z0-9][a-z0-9_-]*$`, becomes the bundle dir +
    /// file stem.
    pub product: String,
    pub purpose: Option<String>,
    /// Painted features, >= 1.
    pub features: Vec<PaintedFeature>,
}

/// A source pack as resolved BY THE NODE from the export session's
/// witnessed record against the catalog (id + open path + effective
/// tier). Never request-supplied.
#[derive(Debug, Clone)]
pub struct SourcePack {
    pub id: String,
    /// `None` when the witnessed pack no longer resolves in the catalog —
    /// the tier is then T3 and the floor refuses before any path is used.
    pub path: Option<PathBuf>,
    pub tier: Tier,
}

/// What an export produced — everything the route serializes.
#[derive(Debug)]
pub struct ExportOutcome {
    pub product: String,
    pub tier: Tier,
    pub features_written: usize,
    /// (file name, sha256) for every written file incl. the sidecar.
    pub files: Vec<(String, String)>,
    pub area_m2_total: f64,
    pub ceremony: CeremonyRecord,
    pub publication_id: String,
    /// Ledger row ids (export.ceremony, export.t2), in write order.
    pub audit_ids: Vec<i64>,
}

/// Errors from the export pipeline. The route maps these onto statuses
/// (Refused→403, Invalid→400, Exists→409, Encryption/Infrastructure→503,
/// others→500).
#[derive(Debug, thiserror::Error)]
pub enum ExportError {
    #[error(transparent)]
    Refused(#[from] geobase_gpkg::ceremony::ExportRefused),
    /// Ceremony infrastructure failure (design §5.3): store unavailable/
    /// corrupt, invalid clock. HTTP 503; never a governance denial.
    #[error("{0}")]
    Infrastructure(String),
    /// The node cannot write the T3 export ledger without configured
    /// at-rest encryption (fail-closed). The route maps this to 503.
    #[error(transparent)]
    Encryption(#[from] geobase_gpkg::cipher::EncryptionRefused),
    #[error("export request invalid: {0}")]
    Invalid(String),
    #[error("export already exists: {0} (pick a new product name)")]
    Exists(String),
    #[error("export verification failed: {0} — output withheld")]
    Verification(String),
    #[error(transparent)]
    Write(#[from] geobase_ingestor::shp_write::ShpWriteError),
    #[error("ledger error: {0}")]
    Ledger(#[from] geobase_gpkg::GpkgError),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    /// Test-only simulated process death inside the publication state
    /// machine. Deliberately performs NO cleanup — recovery must handle
    /// the crash state truthfully. Never constructed in release paths.
    #[error("simulated crash at publication state '{0}' (test-only)")]
    SimulatedCrash(&'static str),
}

/// Crash-injection points for the §6 failure-injection tests. Threaded
/// through the internal pipeline; the public API always passes `None`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CrashPoint {
    Intent,
    Staged,
    Prepared,
    Renamed,
}

/// Append a GENERIC `export.refused` audit row for a request that failed
/// the interim operator token guard (A1) — refused BEFORE the request body
/// was parsed, so there is no trusted product/requester to record and none
/// is invented. Fail-closed posture preserved: no cipher → `Encryption`.
pub fn record_unauthenticated_refusal(
    cipher: &dyn geobase_gpkg::cipher::AtRestCipher,
    exports_dir: &Path,
) -> Result<(), ExportError> {
    let (tsdf_version, tsdf_origin) = tsdf_info()?;
    let ledger = open_ledger(exports_dir, &tsdf_version, &tsdf_origin, cipher)?;
    ledger.append_audit(&geobase_gpkg::AuditEntry {
        dataset_id: "(unauthenticated export attempt)".into(),
        action: "export.refused".into(),
        actor: "(unverified — no valid export token)".into(),
        tsdf_version,
        tsdf_source_origin: tsdf_origin,
        details: serde_json::json!({
            "reason": "missing or invalid export token (interim operator \
                       guard — Phase A A1; refused before the request body was \
                       read, so no product/requester is attributed; the ceremony \
                       seam was never consulted)",
            // The node-clock instant this refusal was decided at (review
            // B3 F6): every governance refusal carries when it happened,
            // even pre-gate ones.
            "observed_at": refusal_observed_at()?,
        }),
    })?;
    Ok(())
}

/// The checked node-clock instant a pre-gate governance refusal was
/// decided at. An implausible clock is an INFRASTRUCTURE failure (design
/// §5.3, review B3 F6): the node never records a governance denial whose
/// decision instant it cannot state — the route answers 503, not a 403
/// with a null timestamp.
fn refusal_observed_at() -> Result<String, ExportError> {
    geobase_gpkg::consent::UtcInstant::now()
        .map(|t| t.to_rfc3339())
        .map_err(|e| {
            ExportError::Infrastructure(format!(
                "node clock implausible — cannot stamp the refusal's decision instant: {e}"
            ))
        })
}

/// Append an `export.refused` row for a governance refusal decided BEFORE
/// the ceremony seam ran (B3: an absent/invalid/unwitnessed export
/// session, design §4 — "no valid session → refuse"). Same fail-closed
/// posture as every T3 ledger write.
pub fn record_declined_refusal(
    cipher: &dyn geobase_gpkg::cipher::AtRestCipher,
    exports_dir: &Path,
    product: &str,
    requester: &ExportIdentity,
    reason: &str,
) -> Result<(), ExportError> {
    let (tsdf_version, tsdf_origin) = tsdf_info()?;
    let ledger = open_ledger(exports_dir, &tsdf_version, &tsdf_origin, cipher)?;
    ledger.append_audit(&geobase_gpkg::AuditEntry {
        dataset_id: product.to_string(),
        action: "export.refused".into(),
        actor: requester.audit_string(),
        tsdf_version,
        tsdf_source_origin: tsdf_origin,
        details: serde_json::json!({ "reason": reason, "observed_at": refusal_observed_at()? }),
    })?;
    Ok(())
}

/// Export `request` as a T2 product bundle into `exports_dir/<product>/`,
/// authorized through `gate` against the node-witnessed `sources`,
/// verified per the module contract, published via the recoverable
/// protocol, audited in the ledger. On ANY failure nothing is released.
///
/// `pub(crate)` on purpose (review B3 F1a): the ONLY composition point for
/// a ceremony gate is `server.rs::router()` — a downstream release caller
/// must not be able to drive the export pipeline with an arbitrary
/// (allow-all) `CeremonyGate` of its own.
pub(crate) fn export_product(
    gate: &dyn CeremonyGate,
    cipher: &dyn geobase_gpkg::cipher::AtRestCipher,
    exports_dir: &Path,
    request: &ExportRequest,
    sources: &[SourcePack],
    requester: &ExportIdentity,
) -> Result<ExportOutcome, ExportError> {
    export_product_inner(gate, cipher, exports_dir, request, sources, requester, None)
}

pub(crate) fn export_product_inner(
    gate: &dyn CeremonyGate,
    cipher: &dyn geobase_gpkg::cipher::AtRestCipher,
    exports_dir: &Path,
    request: &ExportRequest,
    sources: &[SourcePack],
    requester: &ExportIdentity,
    crash: Option<CrashPoint>,
) -> Result<ExportOutcome, ExportError> {
    validate_request(request)?;
    // Fail FAST and fail CLOSED: the export writes a T3 ledger, so if this
    // node cannot store it encrypted, refuse BEFORE any product bytes are
    // written. (The ledger's own `open_ledger` re-authorizes at the true
    // write chokepoint; this early check is the fast path.)
    cipher.authorize_at_rest(Tier::T3)?;
    let (tsdf_version, tsdf_origin) = tsdf_info()?;

    // The node-witnessed authorization input (design §4): ids + tiers from
    // the session-resolved sources. The tier is RE-RESOLVED FROM THE
    // ARTIFACT ON DISK here (review B3 F1) — the caller-supplied
    // `SourcePack.tier` is advisory and cannot forge a low tier; a pack
    // with no resolvable artifact is T3. An empty set resolves to T3
    // inside the authorization type and the floor refuses.
    let witnesses: Vec<SourcePackWitness> = sources
        .iter()
        .map(|s| SourcePackWitness {
            id: s.id.clone(),
            tier: match &s.path {
                Some(path) => crate::vault::current_effective_tier(path),
                None => Tier::T3,
            },
        })
        .collect();
    let auth = ExportAuthorization {
        product: &request.product,
        source_packs: &witnesses,
        product_tier: PRODUCT_TIER,
        product_class: PRODUCT_CLASS,
        requester,
        purpose: request.purpose.as_deref(),
    };

    let record = match gate.authorize_export(&auth) {
        Ok(record) => record,
        Err(ceremony_error) => {
            return Err(record_gate_failure(
                cipher,
                exports_dir,
                &tsdf_version,
                &tsdf_origin,
                request,
                &auth,
                ceremony_error,
            ));
        }
    };

    // === Recoverable atomic publication (design §6) ===
    let publication_id = new_publication_id()?;
    let bundle_dir = exports_dir.join(&request.product);
    let staging_dir = exports_dir.join(STAGING_DIR).join(&publication_id);
    if bundle_dir.exists() {
        return Err(ExportError::Exists(bundle_dir.display().to_string()));
    }

    // Step 1 — intent row.
    let ledger = open_ledger(exports_dir, &tsdf_version, &tsdf_origin, cipher)?;
    ledger.append_audit(&geobase_gpkg::AuditEntry {
        dataset_id: request.product.clone(),
        action: "export.intent".into(),
        actor: requester.audit_string(),
        tsdf_version: tsdf_version.clone(),
        tsdf_source_origin: tsdf_origin.clone(),
        details: serde_json::json!({
            "publication_id": publication_id,
            "product": request.product,
        }),
    })?;
    if crash == Some(CrashPoint::Intent) {
        return Err(ExportError::SimulatedCrash("intent"));
    }

    // Steps 2–5, with staging cleaned up on any non-crash failure.
    let result = publish(
        gate,
        cipher,
        &ledger,
        &tsdf_version,
        &tsdf_origin,
        exports_dir,
        &bundle_dir,
        &staging_dir,
        &publication_id,
        request,
        sources,
        requester,
        &auth,
        record,
        crash,
    );
    match &result {
        Err(err) if !matches!(err, ExportError::SimulatedCrash(_)) => {
            // A failed (not crashed) publication leaves no staging behind;
            // the intent row without a published row is the truthful
            // record that an attempt started and did not complete.
            let _ = std::fs::remove_dir_all(&staging_dir);
        }
        _ => {}
    }
    result
}

/// Steps 2–5 of the publication protocol.
#[allow(clippy::too_many_arguments)]
fn publish(
    gate: &dyn CeremonyGate,
    cipher: &dyn geobase_gpkg::cipher::AtRestCipher,
    ledger: &geobase_gpkg::GeoPackage,
    tsdf_version: &str,
    tsdf_origin: &str,
    exports_dir: &Path,
    bundle_dir: &Path,
    staging_dir: &Path,
    publication_id: &str,
    request: &ExportRequest,
    sources: &[SourcePack],
    requester: &ExportIdentity,
    auth: &ExportAuthorization<'_>,
    record: CeremonyRecord,
    crash: Option<CrashPoint>,
) -> Result<ExportOutcome, ExportError> {
    // Step 2 — write + verify the bundle in staging (same volume).
    std::fs::create_dir_all(staging_dir)?;
    let shp_path = staging_dir.join(format!("{}.shp", request.product));
    let tsdf_json_path = staging_dir.join(format!("{}.tsdf.json", request.product));

    let areas: Vec<f64> = request.features.iter().map(feature_area_m2).collect();
    let layer = geobase_ingestor::shp_write::ProductLayer {
        epsg: 4326,
        fields: vec![
            geobase_ingestor::shp_write::ProductField {
                name: "id".into(),
                kind: geobase_ingestor::shp_write::ProductFieldKind::Integer,
            },
            geobase_ingestor::shp_write::ProductField {
                name: "area_m2".into(),
                kind: geobase_ingestor::shp_write::ProductFieldKind::Real,
            },
            geobase_ingestor::shp_write::ProductField {
                name: "score".into(),
                kind: geobase_ingestor::shp_write::ProductFieldKind::Real,
            },
        ],
        features: request
            .features
            .iter()
            .zip(&areas)
            .enumerate()
            .map(|(index, (feature, area))| {
                (
                    product_geometry(&feature.geometry),
                    vec![
                        geobase_ingestor::shp_write::ProductValue::Integer(index as i64 + 1),
                        geobase_ingestor::shp_write::ProductValue::Real(*area),
                        geobase_ingestor::shp_write::ProductValue::Real(feature.score),
                    ],
                )
            })
            .collect(),
    };
    let written = geobase_ingestor::shp_write::write_shapefile(&shp_path, &layer, false)?;

    let mut files: Vec<(String, String)> = Vec::new();
    for path in &written.files {
        files.push((file_name_of(path), sha256_hex(path)?));
    }
    // Export-time resolved source identities (design §4): hashed under a
    // field name distinct from agreement-time evidence hashes.
    let mut resolved_source_hashes: Vec<(String, String)> = Vec::new();
    for source in sources {
        let sha = match &source.path {
            Some(path) => sha256_hex(path)?,
            None => "(unresolved — pack not in catalog)".into(),
        };
        resolved_source_hashes.push((source.id.clone(), sha));
    }
    let sidecar = serde_json::json!({
        "tier": PRODUCT_TIER.code(),
        "tsdf_version": tsdf_version,
        "tsdf_source_origin": tsdf_origin,
        "basis": record.basis,
        "process": record.process,
        "product": request.product,
        "publication_id": publication_id,
        "features": request.features.len(),
        // Node-authoritative re-resolved tiers (review B3 N1): the sidecar
        // is the product's classification carrier and must agree with the
        // sealed T2 ledger row — never the caller/boot-cached tier hint.
        "source_packs": auth.source_packs.iter().zip(&resolved_source_hashes).map(|(p, (_, sha))| {
            serde_json::json!({"id": p.id, "tier": p.tier.code(), "sha256": sha})
        }).collect::<Vec<_>>(),
        "files": files.iter().cloned().collect::<std::collections::BTreeMap<_, _>>(),
    });
    std::fs::write(
        &tsdf_json_path,
        serde_json::to_string_pretty(&sidecar).map_err(geobase_gpkg::GpkgError::from)?,
    )?;
    files.push((file_name_of(&tsdf_json_path), sha256_hex(&tsdf_json_path)?));

    verify_product(&shp_path, request, sources)?;
    if crash == Some(CrashPoint::Staged) {
        return Err(ExportError::SimulatedCrash("staged"));
    }

    // Step 3 — revalidate consent at the publication point (§10), then
    // seal exactly one ceremony + one t2 row, `prepared`, in ONE txn. The
    // returned guard HOLDS the consent store's publication lock (review
    // B3 F3): no consent write can commit between this snapshot and the
    // durable seal below — the guard is dropped only after `tx.commit()`.
    let publication_guard = match gate.revalidate_for_publication(auth, &record) {
        Ok(guard) => guard,
        Err(ceremony_error) => {
            return Err(record_gate_failure(
                cipher,
                exports_dir,
                tsdf_version,
                tsdf_origin,
                request,
                auth,
                ceremony_error,
            ));
        }
    };
    let revalidated_sequence = publication_guard.sequence;
    let area_m2_total: f64 = areas.iter().sum();
    let tx = ledger
        .conn()
        .unchecked_transaction()
        .map_err(geobase_gpkg::GpkgError::from)?;
    let mut ceremony_details = record.audit_details(auth, &resolved_source_hashes);
    ceremony_details["publication_id"] = serde_json::json!(publication_id);
    ceremony_details["state"] = serde_json::json!("prepared");
    // Record the consent-store sequence observed AT THE PUBLICATION POINT
    // (design §10 linearization, review B3 F3) — the sealed row reflects
    // the revalidated snapshot, not the authorization-time one.
    if let Some(sequence) = revalidated_sequence {
        ceremony_details["consent_store_sequence"] = serde_json::json!(sequence);
        ceremony_details["consent_store_sequence_at_authorization"] =
            record.audit_details(auth, &resolved_source_hashes)["consent_store_sequence"].clone();
    }
    let ceremony_id = ledger.append_audit(&geobase_gpkg::AuditEntry {
        dataset_id: request.product.clone(),
        action: "export.ceremony".into(),
        actor: requester.audit_string(),
        tsdf_version: tsdf_version.to_string(),
        tsdf_source_origin: tsdf_origin.to_string(),
        details: ceremony_details,
    })?;
    let t2_id = ledger.append_audit(&geobase_gpkg::AuditEntry {
        dataset_id: request.product.clone(),
        action: "export.t2".into(),
        actor: requester.audit_string(),
        tsdf_version: tsdf_version.to_string(),
        tsdf_source_origin: tsdf_origin.to_string(),
        details: serde_json::json!({
            "publication_id": publication_id,
            "state": "prepared",
            "product": request.product,
            "tier": PRODUCT_TIER.code(),
            "features": request.features.len(),
            "area_m2_total": area_m2_total,
            "files": files.iter().cloned().collect::<std::collections::BTreeMap<_, _>>(),
            // Re-resolved (node-authoritative) tiers, not the caller hint.
            "source_packs": auth.source_packs.iter().map(|p| {
                serde_json::json!({"id": p.id, "tier": p.tier.code()})
            }).collect::<Vec<_>>(),
        }),
    })?;
    // Durable seal: the ledger connection runs synchronous=FULL (set at
    // open), so this commit is the §6 step-3 seal.
    tx.commit().map_err(geobase_gpkg::GpkgError::from)?;
    // The seal is durable — release the consent store's publication lock
    // (design §10, review B3 F3). A revocation may commit from here on;
    // it governs the NEXT export, and this one's sealed row records the
    // exact sequence it published under.
    drop(publication_guard);
    if crash == Some(CrashPoint::Prepared) {
        return Err(ExportError::SimulatedCrash("prepared"));
    }

    // Step 4 — ONE atomic namespace operation publishes the bundle.
    std::fs::rename(staging_dir, bundle_dir)?;
    if crash == Some(CrashPoint::Renamed) {
        return Err(ExportError::SimulatedCrash("renamed"));
    }

    // Step 5 — finalize. Success is reported ONLY after this row lands.
    ledger.append_audit(&geobase_gpkg::AuditEntry {
        dataset_id: request.product.clone(),
        action: "export.published".into(),
        actor: requester.audit_string(),
        tsdf_version: tsdf_version.to_string(),
        tsdf_source_origin: tsdf_origin.to_string(),
        details: serde_json::json!({
            "publication_id": publication_id,
            "product": request.product,
            "state": "published",
        }),
    })?;

    Ok(ExportOutcome {
        product: request.product.clone(),
        tier: PRODUCT_TIER,
        features_written: written.features_written,
        files,
        area_m2_total,
        ceremony: record,
        publication_id: publication_id.to_string(),
        audit_ids: vec![ceremony_id, t2_id],
    })
}

/// Write the truthful audit row for a gate failure and map it to the
/// right `ExportError`. Governance denial → one `export.refused` row
/// (carrying `observed_at` when the decision reached the clock);
/// infrastructure → an `export.infrastructure` row *attempted* (a ledger
/// that is itself down cannot promise a row, and the error says so).
fn record_gate_failure(
    cipher: &dyn geobase_gpkg::cipher::AtRestCipher,
    exports_dir: &Path,
    tsdf_version: &str,
    tsdf_origin: &str,
    request: &ExportRequest,
    auth: &ExportAuthorization<'_>,
    ceremony_error: CeremonyError,
) -> ExportError {
    let sources_json: Vec<serde_json::Value> = auth
        .source_packs
        .iter()
        .map(|p| serde_json::json!({"id": p.id, "tier": p.tier.code()}))
        .collect();
    match ceremony_error {
        CeremonyError::Refused(refused) => {
            let observed_at = match &refused {
                geobase_gpkg::ceremony::ExportRefused::Declined { observed_at, .. } => {
                    observed_at.map(|t| t.to_rfc3339())
                }
                geobase_gpkg::ceremony::ExportRefused::TierNeverExports { .. } => None,
            };
            let append = || -> Result<(), ExportError> {
                let ledger = open_ledger(exports_dir, tsdf_version, tsdf_origin, cipher)?;
                ledger.append_audit(&geobase_gpkg::AuditEntry {
                    dataset_id: request.product.clone(),
                    action: "export.refused".into(),
                    actor: auth.requester.audit_string(),
                    tsdf_version: tsdf_version.to_string(),
                    tsdf_source_origin: tsdf_origin.to_string(),
                    details: serde_json::json!({
                        "reason": refused.to_string(),
                        "observed_at": observed_at,
                        "effective_source_tier": auth.effective_source_tier().code(),
                        "product_tier": auth.product_tier.code(),
                        "resolved_sources": sources_json,
                        "purpose": request.purpose,
                    }),
                })?;
                Ok(())
            };
            match append() {
                Ok(()) => ExportError::Refused(refused),
                // Fail-closed node: the refusal itself cannot be recorded.
                Err(err) => err,
            }
        }
        ref infrastructure @ CeremonyError::Infrastructure { ref reason } => {
            // Surface the FULL taxonomy sentence (a technical outage is
            // never attributed to the sovereign ceremony); the audit row
            // keeps the bare reason.
            let display = infrastructure.to_string();
            let reason = reason.clone();
            // ATTEMPT the infra row; if the ledger is down too, the
            // returned error is the honest statement that no durable row
            // was possible.
            let attempted = (|| -> Result<(), ExportError> {
                let ledger = open_ledger(exports_dir, tsdf_version, tsdf_origin, cipher)?;
                ledger.append_audit(&geobase_gpkg::AuditEntry {
                    dataset_id: request.product.clone(),
                    action: "export.infrastructure".into(),
                    actor: auth.requester.audit_string(),
                    tsdf_version: tsdf_version.to_string(),
                    tsdf_source_origin: tsdf_origin.to_string(),
                    details: serde_json::json!({
                        "reason": reason,
                        "resolved_sources": sources_json,
                    }),
                })?;
                Ok(())
            })();
            match attempted {
                Ok(()) => ExportError::Infrastructure(display),
                Err(_) => ExportError::Infrastructure(format!(
                    "{display} — AND no durable audit row was possible (the export \
                     ledger is itself unavailable)"
                )),
            }
        }
    }
}

/// The outcome of recovering one in-flight publication at startup.
#[derive(Debug, PartialEq, Eq)]
pub enum RecoveryAction {
    /// Prepared + staged bundle verified → published (finalized late).
    Finalized { publication_id: String },
    /// Prepared + bundle already renamed but never finalized → finalized.
    FinalizedAfterRename { publication_id: String },
    /// Unrecoverable state → aborted, staging removed.
    Aborted {
        publication_id: String,
        reason: String,
    },
}

/// Startup recovery (design §6 step 6): every prepared-but-unfinalized
/// publication either finalizes (hashes verify) or aborts — truthfully,
/// with a ledger row either way. Intent-only publications (crash before
/// staging completed) abort. Call before serving.
pub fn recover_publications(
    cipher: &dyn geobase_gpkg::cipher::AtRestCipher,
    exports_dir: &Path,
) -> Result<Vec<RecoveryAction>, ExportError> {
    let ledger_path = exports_dir.join("node-audit.gpkg");
    if !ledger_path.is_file() {
        return Ok(Vec::new()); // no ledger, nothing in flight
    }
    let (tsdf_version, tsdf_origin) = tsdf_info()?;
    let ledger = open_ledger(exports_dir, &tsdf_version, &tsdf_origin, cipher)?;
    let trail = ledger.audit_trail()?;

    // Fold the trail per publication id, counting rows so a malformed or
    // duplicated protocol trail can be REFUSED rather than trusted (review
    // B3 F4). A publication only finalizes with EXACTLY one intent, one
    // prepared ceremony, and one prepared t2 — all naming the same
    // product.
    #[derive(Default)]
    struct PubState {
        product: String,
        datasets: std::collections::BTreeSet<String>,
        intent: u32,
        ceremony_prepared: u32,
        t2_prepared: u32,
        prepared_files: Option<serde_json::Map<String, serde_json::Value>>,
        t2_count: u32,
        ceremony_count: u32,
        published: bool,
        aborted: bool,
    }
    let mut publications: std::collections::BTreeMap<String, PubState> = Default::default();
    for row in &trail {
        let Some(pub_id) = row.details.get("publication_id").and_then(|v| v.as_str()) else {
            continue;
        };
        let state = publications.entry(pub_id.to_string()).or_default();
        let prepared = row.details.get("state").and_then(|v| v.as_str()) == Some("prepared");
        match row.action.as_str() {
            "export.intent" => {
                state.intent += 1;
                state.product = row.dataset_id.clone();
                state.datasets.insert(row.dataset_id.clone());
            }
            "export.ceremony" => {
                state.ceremony_count += 1;
                state.datasets.insert(row.dataset_id.clone());
                if prepared {
                    state.ceremony_prepared += 1;
                }
            }
            "export.t2" => {
                state.t2_count += 1;
                state.product = row.dataset_id.clone();
                state.datasets.insert(row.dataset_id.clone());
                if prepared {
                    state.t2_prepared += 1;
                    state.prepared_files = row
                        .details
                        .get("files")
                        .and_then(|f| f.as_object())
                        .cloned();
                }
            }
            "export.published" => state.published = true,
            "export.aborted" => state.aborted = true,
            _ => {}
        }
    }

    let mut actions = Vec::new();
    for (publication_id, state) in publications {
        if state.published || state.aborted {
            continue; // terminal — nothing to recover
        }
        let staging_dir = exports_dir.join(STAGING_DIR).join(&publication_id);
        let bundle_dir = exports_dir.join(&state.product);

        // A well-formed sealed publication: exactly one intent + one
        // prepared ceremony + one prepared t2, all naming ONE product,
        // with a files manifest. Anything else is malformed → abort.
        let sealed_ok = state.intent == 1
            && state.ceremony_prepared == 1
            && state.ceremony_count == 1
            && state.t2_prepared == 1
            && state.t2_count == 1
            && state.datasets.len() == 1;

        let action = match &state.prepared_files {
            Some(files) if sealed_ok => {
                if bundle_dir.is_dir() && bundle_exact_match(&bundle_dir, files) {
                    // Crash was between rename and finalize.
                    append_recovery_row(
                        &ledger,
                        &tsdf_version,
                        &tsdf_origin,
                        &state.product,
                        "export.published",
                        &publication_id,
                        "recovered: finalized after rename (crash before finalize row)",
                    )?;
                    let _ = std::fs::remove_dir_all(&staging_dir);
                    RecoveryAction::FinalizedAfterRename { publication_id }
                } else if staging_dir.is_dir() && bundle_exact_match(&staging_dir, files) {
                    // Crash was between seal and rename: complete step 4+5.
                    std::fs::rename(&staging_dir, &bundle_dir)?;
                    append_recovery_row(
                        &ledger,
                        &tsdf_version,
                        &tsdf_origin,
                        &state.product,
                        "export.published",
                        &publication_id,
                        "recovered: staged bundle verified and published at startup",
                    )?;
                    RecoveryAction::FinalizedAfterRename { publication_id }
                } else {
                    let reason = "prepared publication has no verifiable bundle \
                                  (staging missing, hashes differ, or extra/missing files) — aborted"
                        .to_string();
                    append_recovery_row(
                        &ledger,
                        &tsdf_version,
                        &tsdf_origin,
                        &state.product,
                        "export.aborted",
                        &publication_id,
                        &reason,
                    )?;
                    let _ = std::fs::remove_dir_all(&staging_dir);
                    RecoveryAction::Aborted {
                        publication_id,
                        reason,
                    }
                }
            }
            // Sealed rows present but the protocol trail is malformed
            // (missing ceremony, duplicated rows, mismatched product): the
            // node cannot prove which ceremony sealed this bundle → abort,
            // never publish an unverifiable pairing.
            Some(_) => {
                let reason = format!(
                    "malformed publication trail (intents={}, ceremony_prepared={}, \
                     t2_prepared={}, distinct_products={}) — cannot prove a single \
                     sealed ceremony/t2 pair; aborted",
                    state.intent,
                    state.ceremony_prepared,
                    state.t2_prepared,
                    state.datasets.len()
                );
                append_recovery_row(
                    &ledger,
                    &tsdf_version,
                    &tsdf_origin,
                    &state.product,
                    "export.aborted",
                    &publication_id,
                    &reason,
                )?;
                let _ = std::fs::remove_dir_all(&staging_dir);
                RecoveryAction::Aborted {
                    publication_id,
                    reason,
                }
            }
            // Intent (or partial) only, no seal: nothing was published.
            None if state.intent >= 1 || state.ceremony_count >= 1 || state.t2_count >= 1 => {
                let reason = "publication crashed before the ceremony seal — nothing was published"
                    .to_string();
                append_recovery_row(
                    &ledger,
                    &tsdf_version,
                    &tsdf_origin,
                    &state.product,
                    "export.aborted",
                    &publication_id,
                    &reason,
                )?;
                let _ = std::fs::remove_dir_all(&staging_dir);
                RecoveryAction::Aborted {
                    publication_id,
                    reason,
                }
            }
            None => continue,
        };
        actions.push(action);
    }
    Ok(actions)
}

fn append_recovery_row(
    ledger: &geobase_gpkg::GeoPackage,
    tsdf_version: &str,
    tsdf_origin: &str,
    product: &str,
    action: &str,
    publication_id: &str,
    note: &str,
) -> Result<(), ExportError> {
    ledger.append_audit(&geobase_gpkg::AuditEntry {
        dataset_id: product.to_string(),
        action: action.to_string(),
        actor: "geobase-node (startup recovery)".into(),
        tsdf_version: tsdf_version.to_string(),
        tsdf_source_origin: tsdf_origin.to_string(),
        details: serde_json::json!({
            "publication_id": publication_id,
            "product": product,
            "state": if action == "export.published" { "published" } else { "aborted" },
            "recovery": note,
        }),
    })?;
    Ok(())
}

/// Verify the directory's file set EXACTLY equals the sealed manifest —
/// every named file present with the recorded hash, and **no extra files**
/// (review B3 F4: a subset check would let an unsealed file, even T3, ride
/// along into a published bundle). The recovery decision is evidence-based
/// and exact, never hopeful.
fn bundle_exact_match(dir: &Path, files: &serde_json::Map<String, serde_json::Value>) -> bool {
    if files.is_empty() {
        return false;
    }
    // Every sealed file present with the recorded hash.
    for (name, expected) in files {
        let Some(expected) = expected.as_str() else {
            return false;
        };
        match sha256_hex(&dir.join(name)) {
            Ok(actual) if actual == expected => {}
            _ => return false,
        }
    }
    // No EXTRA files: enumerate the directory and require its file set to
    // be exactly the sealed set (a directory we cannot read is a fail).
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    let mut on_disk = 0usize;
    for entry in entries {
        let Ok(entry) = entry else { return false };
        // Only regular files count; a stray subdirectory is also "extra".
        let name = entry.file_name().to_string_lossy().into_owned();
        if !files.contains_key(&name) {
            return false; // an unsealed file is present — refuse
        }
        on_disk += 1;
    }
    on_disk == files.len()
}

/// Request validation — total and loud, naming the offender.
fn validate_request(request: &ExportRequest) -> Result<(), ExportError> {
    let name_ok = !request.product.is_empty()
        && request
            .product
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && request
            .product
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_');
    if !name_ok {
        return Err(ExportError::Invalid(format!(
            "product name '{}' must match ^[a-z0-9][a-z0-9_-]*$",
            request.product
        )));
    }
    if request.product == STAGING_DIR.trim_start_matches('.') {
        return Err(ExportError::Invalid(
            "product name collides with the staging area".into(),
        ));
    }
    if request.features.is_empty() {
        return Err(ExportError::Invalid(
            "at least one painted feature is required".into(),
        ));
    }
    for (index, feature) in request.features.iter().enumerate() {
        if !feature.score.is_finite() {
            return Err(ExportError::Invalid(format!(
                "feature {index}: score is not finite"
            )));
        }
        for (ring_index, ring) in rings_of(&feature.geometry).into_iter().enumerate() {
            if ring.coords().any(|c| !c.x.is_finite() || !c.y.is_finite()) {
                return Err(ExportError::Invalid(format!(
                    "feature {index} ring {ring_index}: non-finite coordinate"
                )));
            }
            // The paint surface is EPSG:4326 by contract — assert the
            // range, never assume.
            if ring.coords().any(|c| c.x.abs() > 180.0 || c.y.abs() > 90.0) {
                return Err(ExportError::Invalid(format!(
                    "feature {index} ring {ring_index}: coordinates outside EPSG:4326 \
                     lon/lat range — the paint surface is 4326 and nothing else"
                )));
            }
            let distinct: std::collections::BTreeSet<(u64, u64)> = ring
                .coords()
                .map(|c| (c.x.to_bits(), c.y.to_bits()))
                .collect();
            if distinct.len() < 3 {
                return Err(ExportError::Invalid(format!(
                    "feature {index} ring {ring_index}: fewer than 3 distinct vertices"
                )));
            }
        }
    }
    Ok(())
}

/// The module-contract verifier — re-open our own output and refuse to
/// release it unless every guarantee holds.
fn verify_product(
    shp_path: &Path,
    request: &ExportRequest,
    sources: &[SourcePack],
) -> Result<(), ExportError> {
    let layer = geobase_ingestor::shp::read_shapefile(shp_path, None)
        .map_err(|e| ExportError::Verification(format!("re-open failed: {e}")))?;

    // 1. Exact feature count.
    if layer.features.len() != request.features.len() {
        return Err(ExportError::Verification(format!(
            "feature count {} != painted count {}",
            layer.features.len(),
            request.features.len()
        )));
    }
    // 2. Exact ordered field whitelist.
    let field_names: Vec<&str> = layer.fields.iter().map(|f| f.name.as_str()).collect();
    if field_names != PRODUCT_FIELDS {
        return Err(ExportError::Verification(format!(
            "fields {field_names:?} != product whitelist {PRODUCT_FIELDS:?}"
        )));
    }
    // 3. Output geometry == painted geometry (coordinate multisets, per
    //    feature, order preserved by the writer).
    let painted: Vec<Vec<(u64, u64)>> = request
        .features
        .iter()
        .map(|f| coord_multiset_of_geometry(&f.geometry))
        .collect();
    let mut output: Vec<Vec<(u64, u64)>> = Vec::with_capacity(layer.features.len());
    for feature in &layer.features {
        output.push(coord_multiset_of_gpkg_blob(&feature.geom).map_err(ExportError::Verification)?);
    }
    for (index, (a, b)) in painted.iter().zip(&output).enumerate() {
        if a != b {
            return Err(ExportError::Verification(format!(
                "feature {index}: output geometry does not equal the painted geometry"
            )));
        }
    }
    // 4. No output geometry equals any SOURCE geometry — tracing a source
    //    feature exactly would republish it.
    for source in sources {
        let Some(source_path) = &source.path else {
            // A witnessed pack with no resolvable artifact cannot be
            // compared — but it is T3 by construction and the floor
            // refused before any bytes were written, so reaching here
            // with an unresolved pack is an internal error.
            return Err(ExportError::Verification(format!(
                "source pack '{}' has no resolvable artifact for the republish check",
                source.id
            )));
        };
        let gpkg = geobase_gpkg::GeoPackage::open(source_path)?;
        // The geometry column name comes from gpkg_geometry_columns — the
        // GPKG contract, not a local naming convention.
        let mut stmt = gpkg
            .conn()
            .prepare(
                "SELECT c.table_name, g.column_name FROM gpkg_contents c \
                 JOIN gpkg_geometry_columns g ON g.table_name = c.table_name \
                 WHERE c.data_type = 'features'",
            )
            .map_err(geobase_gpkg::GpkgError::from)?;
        let tables: Vec<(String, String)> = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(geobase_gpkg::GpkgError::from)?
            .collect::<Result<_, _>>()
            .map_err(geobase_gpkg::GpkgError::from)?;
        drop(stmt);
        for (table, geom_column) in tables {
            let identifier_ok = |s: &str| s.chars().all(|c| c == '_' || c.is_ascii_alphanumeric());
            if !identifier_ok(&table) || !identifier_ok(&geom_column) {
                return Err(ExportError::Verification(format!(
                    "source pack '{}' has a non-identifier table or geometry column name",
                    source.id
                )));
            }
            let mut stmt = gpkg
                .conn()
                .prepare(&format!("SELECT \"{geom_column}\" FROM \"{table}\""))
                .map_err(geobase_gpkg::GpkgError::from)?;
            let blobs: Vec<Vec<u8>> = stmt
                .query_map([], |r| r.get::<_, Vec<u8>>(0))
                .map_err(geobase_gpkg::GpkgError::from)?
                .collect::<Result<_, _>>()
                .map_err(geobase_gpkg::GpkgError::from)?;
            for blob in blobs {
                let source_coords = coord_multiset_of_gpkg_blob(&blob)
                    .map_err(|e| ExportError::Verification(format!("source geometry: {e}")))?;
                if let Some(index) = output.iter().position(|o| *o == source_coords) {
                    return Err(ExportError::Verification(format!(
                        "output feature {index} coordinate-equals a source geometry in \
                         pack '{}' table '{table}' — the product must never republish a source",
                        source.id
                    )));
                }
            }
        }
    }
    Ok(())
}

/// Open (or create + T3-tag) the export ledger — fail-closed through the
/// cipher seam, poison-stamped under the dev cipher, `synchronous=FULL`
/// so prepared-state commits are durable seals (§6 step 3).
fn open_ledger(
    exports_dir: &Path,
    tsdf_version: &str,
    tsdf_origin: &str,
    cipher: &dyn geobase_gpkg::cipher::AtRestCipher,
) -> Result<geobase_gpkg::GeoPackage, ExportError> {
    use geobase_gpkg::cipher::AtRestProtection;
    let protection = cipher.authorize_at_rest(Tier::T3)?;
    std::fs::create_dir_all(exports_dir)?;
    let path = exports_dir.join("node-audit.gpkg");
    let ledger = if path.is_file() {
        geobase_gpkg::GeoPackage::open(&path)?
    } else {
        let ledger = geobase_gpkg::GeoPackage::create(&path)?;
        let mut extras = serde_json::Map::new();
        extras.insert(
            "classification_basis".into(),
            serde_json::Value::String("node-local export ledger — never leaves the node".into()),
        );
        // The poison stamp travels with the artifact: a dev-plaintext
        // ledger is permanently marked non-production.
        if protection == AtRestProtection::UnencryptedDev {
            extras.insert(
                "at_rest".into(),
                serde_json::Value::String(geobase_gpkg::cipher::UNENCRYPTED_DEV_STAMP.into()),
            );
        }
        ledger.write_tsdf_tag(&geobase_gpkg::TsdfTag {
            table: None,
            tier: Tier::T3,
            tsdf_version: tsdf_version.to_string(),
            tsdf_source_origin: tsdf_origin.to_string(),
            classified_by: "geobase-node".into(),
            extras,
        })?;
        ledger
    };
    ledger
        .conn()
        .pragma_update(None, "synchronous", "FULL")
        .map_err(geobase_gpkg::GpkgError::from)?;
    Ok(ledger)
}

fn tsdf_info() -> Result<(String, String), ExportError> {
    use geobase_tsdf::TsdfSource;
    let source = geobase_tsdf::VendoredSource::embedded();
    let spec = source
        .load()
        .map_err(|e| ExportError::Invalid(format!("tsdf source: {e}")))?;
    Ok((spec.version, source.origin()))
}

/// An unforgeable publication id from the OS CSPRNG.
fn new_publication_id() -> Result<String, ExportError> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes)
        .map_err(|e| ExportError::Infrastructure(format!("csprng unavailable: {e}")))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn feature_area_m2(feature: &PaintedFeature) -> f64 {
    use geo::ChamberlainDuquetteArea;
    match &feature.geometry {
        PaintedGeometry::Polygon(p) => p.chamberlain_duquette_unsigned_area(),
        PaintedGeometry::MultiPolygon(m) => m.chamberlain_duquette_unsigned_area(),
    }
}

fn product_geometry(g: &PaintedGeometry) -> geobase_ingestor::shp_write::ProductGeometry {
    match g {
        PaintedGeometry::Polygon(p) => {
            geobase_ingestor::shp_write::ProductGeometry::Polygon(p.clone())
        }
        PaintedGeometry::MultiPolygon(m) => {
            geobase_ingestor::shp_write::ProductGeometry::MultiPolygon(m.clone())
        }
    }
}

fn rings_of(g: &PaintedGeometry) -> Vec<&geo_types::LineString<f64>> {
    let mut rings = Vec::new();
    match g {
        PaintedGeometry::Polygon(p) => {
            rings.push(p.exterior());
            rings.extend(p.interiors());
        }
        PaintedGeometry::MultiPolygon(m) => {
            for p in &m.0 {
                rings.push(p.exterior());
                rings.extend(p.interiors());
            }
        }
    }
    rings
}

/// Sorted coordinate multiset of painted geometry (f64 bit patterns).
fn coord_multiset_of_geometry(g: &PaintedGeometry) -> Vec<(u64, u64)> {
    let mut coords: Vec<(u64, u64)> = rings_of(g)
        .iter()
        .flat_map(|ring| ring.coords())
        .map(|c| (c.x.to_bits(), c.y.to_bits()))
        .collect();
    coords.sort_unstable();
    coords
}

/// Sorted coordinate multiset of a GPKG-WKB geometry blob, via the same
/// geozero path the server uses to serve features.
fn coord_multiset_of_gpkg_blob(blob: &[u8]) -> Result<Vec<(u64, u64)>, String> {
    let mut geojson = Vec::new();
    let mut writer = geozero::geojson::GeoJsonWriter::new(&mut geojson);
    geozero::wkb::process_gpkg_geom(&mut std::io::Cursor::new(blob), &mut writer)
        .map_err(|e| e.to_string())?;
    let value: serde_json::Value = serde_json::from_slice(&geojson).map_err(|e| e.to_string())?;
    let mut coords = Vec::new();
    collect_positions(&value["coordinates"], &mut coords)?;
    coords.sort_unstable();
    Ok(coords)
}

/// Recursively collect `[x, y]` leaves from nested GeoJSON coordinates.
fn collect_positions(value: &serde_json::Value, out: &mut Vec<(u64, u64)>) -> Result<(), String> {
    let arr = value.as_array().ok_or("coordinates are not an array")?;
    if arr.len() >= 2 && arr[0].is_number() && arr[1].is_number() {
        let (Some(x), Some(y)) = (arr[0].as_f64(), arr[1].as_f64()) else {
            return Err("non-numeric position".into());
        };
        out.push((x.to_bits(), y.to_bits()));
        return Ok(());
    }
    for item in arr {
        collect_positions(item, out)?;
    }
    Ok(())
}

fn file_name_of(path: &Path) -> String {
    path.file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.display().to_string())
}

fn sha256_hex(path: &Path) -> Result<String, ExportError> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    // Streaming: export success must not depend on whole-file allocation
    // (source packs can be large).
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use geobase_gpkg::ceremony::ProvisionalDevGate;
    use geobase_gpkg::vector::{create_feature_table, FeatureTableSpec};
    use geobase_gpkg::GeoPackage;
    use geobase_tsdf::Tier;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("geobase-export-{name}-{nonce}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn operator() -> ExportIdentity {
        ExportIdentity::local_operator("test-operator").unwrap()
    }

    /// GPKG geometry blob: GP header (LE, no envelope) + LE WKB polygon.
    fn gpkg_polygon_blob(ring: &[(f64, f64)]) -> Vec<u8> {
        let mut blob = Vec::new();
        blob.extend_from_slice(b"GP");
        blob.push(0); // version
        blob.push(1); // flags: little-endian, no envelope
        blob.extend_from_slice(&4326_i32.to_le_bytes());
        blob.push(1); // WKB little-endian
        blob.extend_from_slice(&3_u32.to_le_bytes()); // polygon
        blob.extend_from_slice(&1_u32.to_le_bytes()); // one ring
        blob.extend_from_slice(&(ring.len() as u32).to_le_bytes());
        for (x, y) in ring {
            blob.extend_from_slice(&x.to_le_bytes());
            blob.extend_from_slice(&y.to_le_bytes());
        }
        blob
    }

    fn source_pack(dir: &Path, name: &str, tier: Tier, ring: &[(f64, f64)]) -> SourcePack {
        let path = dir.join(format!("{name}.gpkg"));
        let gpkg = GeoPackage::create(&path).unwrap();
        create_feature_table(
            &gpkg,
            &FeatureTableSpec {
                table: "src".into(),
                identifier: format!("{name} src"),
                srs_epsg: 4326,
                srs_definition: None,
                geometry_type: "POLYGON".into(),
                columns: Vec::new(),
                bounds: (0.0, 0.0, 1.0, 1.0),
            },
        )
        .unwrap();
        gpkg.conn()
            .execute(
                "INSERT INTO src (geom) VALUES (?1)",
                [gpkg_polygon_blob(ring)],
            )
            .unwrap();
        // Write a real TSDF tag so the export pipeline's fresh-tier
        // re-resolution (review B3 F1) reads the intended tier from the
        // artifact — an untagged pack now resolves to T3 by design.
        gpkg.write_tsdf_tag(&geobase_gpkg::TsdfTag {
            table: None,
            tier,
            tsdf_version: "0.9.4".into(),
            tsdf_source_origin: "vendored:test".into(),
            classified_by: "test".into(),
            extras: serde_json::Map::new(),
        })
        .unwrap();
        drop(gpkg);
        SourcePack {
            id: name.into(),
            path: Some(path),
            tier,
        }
    }

    fn square(origin: (f64, f64), size: f64) -> geo_types::Polygon<f64> {
        let (x, y) = origin;
        geo_types::Polygon::new(
            geo_types::LineString::from(vec![
                (x, y),
                (x + size, y),
                (x + size, y + size),
                (x, y + size),
                (x, y),
            ]),
            vec![],
        )
    }

    fn request(product: &str, polygons: Vec<geo_types::Polygon<f64>>) -> ExportRequest {
        ExportRequest {
            product: product.into(),
            purpose: Some("unit test".into()),
            features: polygons
                .into_iter()
                .map(|p| PaintedFeature {
                    geometry: PaintedGeometry::Polygon(p),
                    score: 0.9,
                })
                .collect(),
        }
    }

    fn source_ring() -> Vec<(f64, f64)> {
        vec![(0.5, 0.5), (0.6, 0.5), (0.6, 0.6), (0.5, 0.6), (0.5, 0.5)]
    }

    fn dev_cipher() -> geobase_gpkg::cipher::DevPlaintextCipher {
        geobase_gpkg::cipher::DevPlaintextCipher::new()
    }

    fn trail(exports: &Path) -> Vec<geobase_gpkg::AuditRecord> {
        GeoPackage::open(&exports.join("node-audit.gpkg"))
            .unwrap()
            .audit_trail()
            .unwrap()
    }

    #[test]
    fn happy_path_publishes_bundle_with_full_protocol_trail() {
        let dir = temp_dir("happy");
        let exports = dir.join("exports");
        let source = source_pack(&dir, "capacity", Tier::T1, &source_ring());

        let req = request(
            "wind-north",
            vec![square((0.0, 0.0), 0.001), square((0.01, 0.0), 0.002)],
        );
        let outcome = export_product(
            &ProvisionalDevGate,
            &dev_cipher(),
            &exports,
            &req,
            &[source],
            &operator(),
        )
        .unwrap();

        assert_eq!(outcome.tier, Tier::T2);
        assert_eq!(outcome.features_written, 2);
        assert!(outcome.area_m2_total > 0.0);
        assert_eq!(outcome.files.len(), 5, "shp, shx, dbf, prj, tsdf.json");
        // The bundle is a DIRECTORY published atomically; staging is gone.
        let bundle = exports.join("wind-north");
        assert!(bundle.is_dir());
        assert!(!exports
            .join(STAGING_DIR)
            .join(&outcome.publication_id)
            .exists());
        for (name, sha) in &outcome.files {
            let bytes = std::fs::read(bundle.join(name)).unwrap();
            use sha2::{Digest, Sha256};
            assert_eq!(*sha, format!("{:x}", Sha256::digest(bytes)), "{name}");
        }

        // Full protocol trail: intent → ceremony(prepared) → t2(prepared)
        // → published, one publication id throughout.
        let trail = trail(&exports);
        let actions: Vec<&str> = trail.iter().map(|r| r.action.as_str()).collect();
        assert_eq!(
            actions,
            [
                "export.intent",
                "export.ceremony",
                "export.t2",
                "export.published"
            ]
        );
        for row in &trail {
            assert_eq!(
                row.details["publication_id"], outcome.publication_id,
                "{}",
                row.action
            );
        }
        assert_eq!(trail[1].details["state"], "prepared");
        assert_eq!(
            trail[1].details["authorized_by"],
            "local-operator:test-operator"
        );
        assert!(trail[1].details["observed_at"].is_string());
        assert_eq!(trail[2].details["tier"], "T2");
        assert_eq!(outcome.audit_ids, vec![trail[1].id, trail[2].id]);
    }

    // === ADVERSARIAL EGRESS GATE (ledger half) — see server.rs for A1–A6. ===

    /// [EGRESS-GATE A7] Fail-closed: a node with the default cipher CANNOT
    /// write the T3 ledger. No plaintext sovereign bytes ever hit disk, and
    /// no product is released either.
    #[test]
    fn egress_gate_a7_fail_closed_refuses_ledger_and_writes_nothing() {
        let dir = temp_dir("a7-failclosed");
        let exports = dir.join("exports");
        let source = source_pack(&dir, "capacity", Tier::T0, &source_ring());
        let err = export_product(
            &ProvisionalDevGate,
            &geobase_gpkg::cipher::FailClosedCipher,
            &exports,
            &request("blocked", vec![square((0.0, 0.0), 0.001)]),
            std::slice::from_ref(&source),
            &operator(),
        )
        .unwrap_err();
        assert!(matches!(err, ExportError::Encryption(_)));
        assert!(err.to_string().contains("fail-closed"));
        assert!(!exports.join("node-audit.gpkg").exists());
        assert!(!exports.join("blocked").exists());
        assert!(!exports.join(STAGING_DIR).exists());
    }

    /// [EGRESS-GATE A7] The dev-plaintext ledger is permanently
    /// poison-stamped UNENCRYPTED-DEV.
    #[test]
    fn egress_gate_a7_dev_plaintext_ledger_is_poison_stamped() {
        let dir = temp_dir("a7-devstamp");
        let exports = dir.join("exports");
        let source = source_pack(&dir, "capacity", Tier::T1, &source_ring());
        export_product(
            &ProvisionalDevGate,
            &dev_cipher(),
            &exports,
            &request("stamped", vec![square((0.0, 0.0), 0.001)]),
            std::slice::from_ref(&source),
            &operator(),
        )
        .unwrap();
        let ledger = GeoPackage::open(&exports.join("node-audit.gpkg")).unwrap();
        let tags = ledger.read_tsdf_tags().unwrap();
        let geopackage_tag = tags
            .iter()
            .find(|t| t.scope == "geopackage")
            .expect("ledger carries a geopackage-scope tag");
        assert_eq!(
            geopackage_tag.payload["at_rest"],
            geobase_gpkg::cipher::UNENCRYPTED_DEV_STAMP,
        );
    }

    /// [EGRESS-GATE A8] KNOWN GAP (ignored). `verify_product` check #4 uses
    /// EXACT coordinate equality, so a 1-ULP near-trace escapes. Tolerance
    /// band tracked as a scoped follow-on; un-`ignore` when it lands.
    #[test]
    #[ignore = "known gap: 1-ULP near-trace escapes exact-equality verify_product #4 (scoped follow-on)"]
    fn egress_gate_a8_near_trace_is_refused() {
        let dir = temp_dir("a8-neartrace");
        let exports = dir.join("exports");
        let ring = source_ring();
        let source = source_pack(&dir, "capacity", Tier::T1, &ring);
        let nudged = geo_types::Polygon::new(
            geo_types::LineString::from(
                ring.iter()
                    .map(|&(x, y)| {
                        (
                            f64::from_bits(x.to_bits() + 1),
                            f64::from_bits(y.to_bits() + 1),
                        )
                    })
                    .collect::<Vec<_>>(),
            ),
            vec![],
        );
        let result = export_product(
            &ProvisionalDevGate,
            &dev_cipher(),
            &exports,
            &request("neartrace", vec![nudged]),
            std::slice::from_ref(&source),
            &operator(),
        );
        assert!(
            matches!(result, Err(ExportError::Verification(_))),
            "near-trace of a source must be refused"
        );
    }

    #[test]
    fn t3_source_pack_is_refused_with_only_refusal_ledger() {
        let dir = temp_dir("t3");
        let exports = dir.join("exports");
        let source = source_pack(&dir, "capacity", Tier::T3, &source_ring());

        let err = export_product(
            &ProvisionalDevGate,
            &dev_cipher(),
            &exports,
            &request("secret", vec![square((0.0, 0.0), 0.001)]),
            &[source],
            &operator(),
        )
        .unwrap_err();
        assert!(matches!(err, ExportError::Refused(_)));

        let entries: Vec<String> = std::fs::read_dir(&exports)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(entries, vec!["node-audit.gpkg"], "only the ledger exists");
        let trail = trail(&exports);
        assert_eq!(trail.len(), 1);
        assert_eq!(trail[0].action, "export.refused");
        assert!(trail[0].details["reason"]
            .as_str()
            .unwrap()
            .contains("never leaves the node"));
        // A floor refusal precedes the clock capture — observed_at is
        // honestly null, never invented.
        assert!(trail[0].details["observed_at"].is_null());
    }

    #[test]
    fn empty_witnessed_source_set_is_refused_as_t3() {
        let dir = temp_dir("emptyset");
        let exports = dir.join("exports");
        let err = export_product(
            &ProvisionalDevGate,
            &dev_cipher(),
            &exports,
            &request("nothing", vec![square((0.0, 0.0), 0.001)]),
            &[],
            &operator(),
        )
        .unwrap_err();
        assert!(matches!(err, ExportError::Refused(_)));
        assert!(err.to_string().contains("never leaves the node"));
    }

    #[test]
    fn painted_geometry_equal_to_source_feature_is_withheld() {
        let dir = temp_dir("trace");
        let exports = dir.join("exports");
        let ring = source_ring();
        let source = source_pack(&dir, "capacity", Tier::T1, &ring);

        let traced = geo_types::Polygon::new(
            geo_types::LineString::from(ring.iter().map(|&(x, y)| (x, y)).collect::<Vec<_>>()),
            vec![],
        );
        let err = export_product(
            &ProvisionalDevGate,
            &dev_cipher(),
            &exports,
            &request("traced", vec![traced]),
            &[source],
            &operator(),
        )
        .unwrap_err();
        assert!(matches!(err, ExportError::Verification(_)));
        assert!(err.to_string().contains("republish"));
        // Nothing published, staging cleaned.
        assert!(!exports.join("traced").exists());
        let staging = exports.join(STAGING_DIR);
        if staging.exists() {
            assert_eq!(std::fs::read_dir(&staging).unwrap().count(), 0);
        }
    }

    #[test]
    fn duplicate_product_name_returns_exists() {
        let dir = temp_dir("dup");
        let exports = dir.join("exports");
        let source = source_pack(&dir, "capacity", Tier::T0, &source_ring());

        export_product(
            &ProvisionalDevGate,
            &dev_cipher(),
            &exports,
            &request("site", vec![square((0.0, 0.0), 0.001)]),
            std::slice::from_ref(&source),
            &operator(),
        )
        .unwrap();
        let err = export_product(
            &ProvisionalDevGate,
            &dev_cipher(),
            &exports,
            &request("site", vec![square((0.02, 0.0), 0.001)]),
            &[source],
            &operator(),
        )
        .unwrap_err();
        assert!(matches!(err, ExportError::Exists(_)));
    }

    #[test]
    fn invalid_requests_name_the_offender() {
        let dir = temp_dir("invalid");
        let exports = dir.join("exports");
        let source = source_pack(&dir, "capacity", Tier::T0, &source_ring());

        let bad_name = export_product(
            &ProvisionalDevGate,
            &dev_cipher(),
            &exports,
            &request("Bad Name", vec![square((0.0, 0.0), 0.001)]),
            std::slice::from_ref(&source),
            &operator(),
        )
        .unwrap_err();
        assert!(bad_name.to_string().contains("product name"));

        let empty = export_product(
            &ProvisionalDevGate,
            &dev_cipher(),
            &exports,
            &request("empty", vec![]),
            std::slice::from_ref(&source),
            &operator(),
        )
        .unwrap_err();
        assert!(empty.to_string().contains("at least one painted feature"));

        let mut nan_score = request("nan", vec![square((0.0, 0.0), 0.001)]);
        nan_score.features[0].score = f64::NAN;
        let err = export_product(
            &ProvisionalDevGate,
            &dev_cipher(),
            &exports,
            &nan_score,
            std::slice::from_ref(&source),
            &operator(),
        )
        .unwrap_err();
        assert!(err.to_string().contains("score is not finite"));

        // EPSG:26910-style coordinates must be refused, not stamped 4326.
        let projected = request("projected", vec![square((523000.0, 5215000.0), 100.0)]);
        let err = export_product(
            &ProvisionalDevGate,
            &dev_cipher(),
            &exports,
            &projected,
            std::slice::from_ref(&source),
            &operator(),
        )
        .unwrap_err();
        assert!(err.to_string().contains("EPSG:4326"));

        let degenerate = ExportRequest {
            features: vec![PaintedFeature {
                geometry: PaintedGeometry::Polygon(geo_types::Polygon::new(
                    geo_types::LineString::from(vec![(0.0, 0.0), (0.1, 0.1), (0.0, 0.0)]),
                    vec![],
                )),
                score: 1.0,
            }],
            ..request("degenerate", vec![])
        };
        let err = export_product(
            &ProvisionalDevGate,
            &dev_cipher(),
            &exports,
            &degenerate,
            &[source],
            &operator(),
        )
        .unwrap_err();
        assert!(err.to_string().contains("distinct vertices"));
    }

    /// §11: the expired-refusal `export.refused` row carries the SAME
    /// `observed_at` instant the expiry comparison used — the trail proves
    /// WHICH time made the decision, on the refusal path too. Runs the
    /// real sovereign gate against a store holding an expired agreement.
    #[test]
    fn expired_refusal_row_carries_observed_at() {
        use geobase_gpkg::consent::{
            Conditions, ConsentBasis, ExportIdentity as Id, Sha256Digest, UtcInstant,
        };
        use geobase_gpkg::consent_gate::RecordedConsentGate;
        use geobase_gpkg::consent_store::{AgreementKind, AgreementRecord, ConsentStore};

        let dir = temp_dir("expired-row");
        let exports = dir.join("exports");
        std::fs::create_dir_all(&exports).unwrap();
        let requester = Id::local_operator("test-operator").unwrap();
        let store = ConsentStore::open_or_create(&exports, "0.9.4", "vendored:test", &dev_cipher())
            .unwrap();
        let now = UtcInstant::now().unwrap();
        let evidence = ConsentBasis::signed_agreement(
            "agreements/x.pdf",
            Sha256Digest::from_hex(&"ab".repeat(32)).unwrap(),
            now,
            now,
        )
        .unwrap();
        store
            .record_agreement(
                &AgreementRecord {
                    agreement_id: "expired".into(),
                    kind: AgreementKind::TribalSigned,
                    source_scope: vec!["capacity".into()],
                    product_class: "x".into(),
                    evidence,
                    authority_of_record: "Example Signatory".into(),
                    requester_binding: requester.clone(),
                    conditions: Conditions {
                        expires_at: Some(
                            UtcInstant::parse_rfc3339("2026-01-02T00:00:00Z").unwrap(),
                        ),
                        purpose_limit: None,
                        geography_limit: None,
                    },
                    recorded_by: requester.clone(),
                },
                &[],
                false,
            )
            .unwrap();
        drop(store);

        let gate = RecordedConsentGate::new(
            exports.clone(),
            "0.9.4",
            "vendored:test",
            std::sync::Arc::new(dev_cipher()),
        );
        let source = source_pack(&dir, "capacity", Tier::T1, &source_ring());
        let err = export_product(
            &gate,
            &dev_cipher(),
            &exports,
            &request("blocked-expired", vec![square((0.0, 0.0), 0.001)]),
            &[source],
            &requester,
        )
        .unwrap_err();
        // EXACT assertion (review B3 F9): the refusal error carries the
        // instant the expiry comparison used…
        let ExportError::Refused(geobase_gpkg::ceremony::ExportRefused::Declined {
            reason,
            observed_at: Some(decision_instant),
        }) = &err
        else {
            panic!("expected Declined with an observed_at instant, got: {err}");
        };
        assert!(reason.contains("expired"));

        let trail = trail(&exports);
        let refused: Vec<_> = trail
            .iter()
            .filter(|r| r.action == "export.refused")
            .collect();
        assert_eq!(refused.len(), 1, "exactly one refusal row");
        // …and the audit row's observed_at EQUALS that instant — the
        // trail proves WHICH time made the decision, not merely that a
        // time was written.
        assert_eq!(
            refused[0].details["observed_at"].as_str().unwrap(),
            decision_instant.to_rfc3339(),
            "the refusal row must carry the exact instant the expiry comparison used"
        );
    }

    /// Review B3 F1: a pack reclassified UP while the node runs (a
    /// table-scope T3 tag added after creation raises the artifact's
    /// effective tier) is refused at export — the pipeline re-resolves the
    /// tier from disk, not from a cached hint.
    #[test]
    fn stale_tier_reclassified_pack_is_refused() {
        let dir = temp_dir("stale");
        let exports = dir.join("exports");
        // Created and tagged T1.
        let source = source_pack(&dir, "capacity", Tier::T1, &source_ring());
        // Reclassify UP: add a table-scope T3 tag so the geopackage
        // roll-up tier becomes T3 (most-restrictive-wins).
        {
            let gpkg = GeoPackage::open(source.path.as_ref().unwrap()).unwrap();
            gpkg.write_tsdf_tag(&geobase_gpkg::TsdfTag {
                table: None, // geopackage-scope reclassification, raised to T3
                tier: Tier::T3,
                tsdf_version: "0.9.4".into(),
                tsdf_source_origin: "vendored:test".into(),
                classified_by: "reclassification".into(),
                extras: {
                    let mut m = serde_json::Map::new();
                    m.insert(
                        "classification_basis".into(),
                        serde_json::json!("raised to sovereign"),
                    );
                    m
                },
            })
            .unwrap();
        }
        // The caller still passes the STALE T1 hint — but re-resolution
        // reads T3 and the floor refuses.
        let err = export_product(
            &ProvisionalDevGate,
            &dev_cipher(),
            &exports,
            &request("blocked", vec![square((0.0, 0.0), 0.001)]),
            std::slice::from_ref(&source),
            &operator(),
        )
        .unwrap_err();
        assert!(matches!(err, ExportError::Refused(_)));
        assert!(err.to_string().contains("never leaves the node"));
        assert!(!exports.join("blocked").exists());
    }

    /// Review B3 F1: a witnessed pack whose artifact no longer resolves
    /// (path missing) is T3 and refused — never silently downgraded.
    #[test]
    fn unresolvable_source_is_t3_and_refused() {
        let dir = temp_dir("unresolvable");
        let exports = dir.join("exports");
        let ghost = SourcePack {
            id: "ghost".into(),
            path: None,     // no artifact
            tier: Tier::T0, // stale hint ignored
        };
        let err = export_product(
            &ProvisionalDevGate,
            &dev_cipher(),
            &exports,
            &request("blocked", vec![square((0.0, 0.0), 0.001)]),
            &[ghost],
            &operator(),
        )
        .unwrap_err();
        assert!(matches!(err, ExportError::Refused(_)));
        assert!(err.to_string().contains("never leaves the node"));
    }

    /// Review B3 F9: on the authorized path `observed_at` on the sealed
    /// ceremony row equals the instant the record carries (the one the
    /// authorization used) — the trail proves WHICH time decided.
    #[test]
    fn observed_at_on_ceremony_row_equals_the_record_instant() {
        let dir = temp_dir("observed");
        let exports = dir.join("exports");
        let source = source_pack(&dir, "capacity", Tier::T1, &source_ring());
        let outcome = export_product(
            &ProvisionalDevGate,
            &dev_cipher(),
            &exports,
            &request("obs", vec![square((0.0, 0.0), 0.001)]),
            std::slice::from_ref(&source),
            &operator(),
        )
        .unwrap();
        let trail = trail(&exports);
        let ceremony = trail
            .iter()
            .find(|r| r.action == "export.ceremony")
            .unwrap();
        assert_eq!(
            ceremony.details["observed_at"].as_str().unwrap(),
            outcome.ceremony.observed_at.to_rfc3339(),
            "the row's observed_at must equal the instant the record used"
        );
    }

    // === PUBLICATION FAILURE INJECTION (design §6 — every crash point) ===

    fn crash_at(exports: &Path, dir: &Path, product: &str, crash: CrashPoint) -> ExportError {
        let source = source_pack(dir, &format!("src-{product}"), Tier::T1, &source_ring());
        export_product_inner(
            &ProvisionalDevGate,
            &dev_cipher(),
            exports,
            &request(product, vec![square((0.0, 0.0), 0.001)]),
            &[source],
            &operator(),
            Some(crash),
        )
        .unwrap_err()
    }

    #[test]
    fn crash_after_intent_recovers_to_abort() {
        let dir = temp_dir("crash-intent");
        let exports = dir.join("exports");
        let err = crash_at(&exports, &dir, "p1", CrashPoint::Intent);
        assert!(matches!(err, ExportError::SimulatedCrash("intent")));
        let actions = recover_publications(&dev_cipher(), &exports).unwrap();
        assert_eq!(actions.len(), 1);
        assert!(matches!(actions[0], RecoveryAction::Aborted { .. }));
        let trail = trail(&exports);
        assert_eq!(trail.last().unwrap().action, "export.aborted");
        assert!(!exports.join("p1").exists(), "nothing published");
        // Recovery is idempotent: a second pass finds nothing in flight.
        assert!(recover_publications(&dev_cipher(), &exports)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn crash_after_staging_before_seal_recovers_to_abort() {
        let dir = temp_dir("crash-staged");
        let exports = dir.join("exports");
        let err = crash_at(&exports, &dir, "p2", CrashPoint::Staged);
        assert!(matches!(err, ExportError::SimulatedCrash("staged")));
        // The staged bundle exists but was never sealed.
        let actions = recover_publications(&dev_cipher(), &exports).unwrap();
        assert_eq!(actions.len(), 1);
        assert!(matches!(actions[0], RecoveryAction::Aborted { .. }));
        assert!(
            !exports.join("p2").exists(),
            "an unsealed bundle must not publish"
        );
        // Staging was removed by recovery.
        let staging = exports.join(STAGING_DIR);
        if staging.exists() {
            assert_eq!(std::fs::read_dir(&staging).unwrap().count(), 0);
        }
    }

    #[test]
    fn crash_after_seal_recovers_to_publish() {
        let dir = temp_dir("crash-prepared");
        let exports = dir.join("exports");
        let err = crash_at(&exports, &dir, "p3", CrashPoint::Prepared);
        assert!(matches!(err, ExportError::SimulatedCrash("prepared")));
        // Sealed but never renamed: recovery verifies the staged hashes
        // and completes the publication truthfully.
        let actions = recover_publications(&dev_cipher(), &exports).unwrap();
        assert_eq!(actions.len(), 1);
        assert!(matches!(
            actions[0],
            RecoveryAction::FinalizedAfterRename { .. }
        ));
        assert!(exports.join("p3").is_dir(), "the sealed bundle publishes");
        let trail = trail(&exports);
        assert_eq!(trail.last().unwrap().action, "export.published");
        assert!(trail.last().unwrap().details["recovery"].is_string());
    }

    #[test]
    fn crash_after_rename_before_finalize_recovers_to_publish() {
        let dir = temp_dir("crash-renamed");
        let exports = dir.join("exports");
        let err = crash_at(&exports, &dir, "p4", CrashPoint::Renamed);
        assert!(matches!(err, ExportError::SimulatedCrash("renamed")));
        assert!(exports.join("p4").is_dir(), "rename already happened");
        let actions = recover_publications(&dev_cipher(), &exports).unwrap();
        assert_eq!(actions.len(), 1);
        assert!(matches!(
            actions[0],
            RecoveryAction::FinalizedAfterRename { .. }
        ));
        let trail = trail(&exports);
        assert_eq!(trail.last().unwrap().action, "export.published");
    }

    #[test]
    fn recovery_aborts_a_tampered_staged_bundle() {
        let dir = temp_dir("crash-tampered");
        let exports = dir.join("exports");
        let err = crash_at(&exports, &dir, "p5", CrashPoint::Prepared);
        assert!(matches!(err, ExportError::SimulatedCrash("prepared")));
        // Tamper with the staged product before recovery runs.
        let staging_root = exports.join(STAGING_DIR);
        let staged = std::fs::read_dir(&staging_root)
            .unwrap()
            .next()
            .unwrap()
            .unwrap();
        std::fs::write(staged.path().join("p5.dbf"), b"tampered").unwrap();
        let actions = recover_publications(&dev_cipher(), &exports).unwrap();
        assert_eq!(actions.len(), 1);
        assert!(matches!(actions[0], RecoveryAction::Aborted { .. }));
        assert!(
            !exports.join("p5").exists(),
            "a bundle whose hashes do not match the seal must never publish"
        );
    }

    /// Review B3 F4: an EXTRA (unsealed) file in the staged bundle — even
    /// one carrying sovereign data — must abort recovery, never ride along
    /// into a published bundle. The subset-only check this replaces would
    /// have published it.
    #[test]
    fn recovery_aborts_a_bundle_with_an_extra_unsealed_file() {
        let dir = temp_dir("crash-extra");
        let exports = dir.join("exports");
        let err = crash_at(&exports, &dir, "p6", CrashPoint::Prepared);
        assert!(matches!(err, ExportError::SimulatedCrash("prepared")));
        // Drop an extra file next to the sealed set (e.g. a leaked source).
        let staging_root = exports.join(STAGING_DIR);
        let staged = std::fs::read_dir(&staging_root)
            .unwrap()
            .next()
            .unwrap()
            .unwrap();
        std::fs::write(staged.path().join("leaked-source.gpkg"), b"T3 bytes").unwrap();
        let actions = recover_publications(&dev_cipher(), &exports).unwrap();
        assert_eq!(actions.len(), 1);
        assert!(
            matches!(actions[0], RecoveryAction::Aborted { .. }),
            "an extra unsealed file must abort recovery"
        );
        assert!(!exports.join("p6").exists());
    }
}
