//! Zero-source-disclosure export — Phase 1.3b. FROZEN CONTRACT.
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
//! ## Ceremony seam (Phase 1.2 boundary)
//!
//! Every export passes [`geobase_gpkg::ceremony::CeremonyGate`] BEFORE
//! any file is written. `source_tier` = the most restrictive effective
//! tier across `source_packs`; `product_tier` = **T2 always** in 1.3.
//! The returned record is written to the ledger as `export.ceremony`
//! alongside `export.t2` — same connection, before the response returns.
//! Refusal (including the unconditional T3 refusal) aborts with nothing
//! written.
//!
//! ## Export ledger + tier stamping
//!
//! Audit rows land in `exports_dir/node-audit.gpkg` — a GeoPackage
//! carrying ONLY the audit trail, whole-artifact-tagged **T3** with basis
//! "node-local export ledger — never leaves the node" (it is node
//! history; the TSDF default posture is exactly right for it). It lives
//! in `exports_dir`, which the vault scanner never reads, so it can not
//! appear in the catalog. Created on first export.
//!
//! A shapefile has no in-band metadata channel (a known format tension
//! with invariant §4): the T2 stamp travels as (a) the ledger rows,
//! (b) the API response, and (c) a `<stem>.tsdf.json` sidecar written
//! next to the shapefile (tier, tsdf_version, basis, source pack ids +
//! artifact hashes, ceremony process). The sidecar is best-effort
//! provenance for humans; the LEDGER is the record.
//!
//! ## Route: `POST /api/export` (first mutating endpoint)
//!
//! - Loopback guard applies (router middleware). No exports_dir → 503
//!   `{"reason": "exports_dir is not configured for this node"}`.
//! - Request JSON:
//!   `{ "product": "<name>", "source_packs": ["<id>", …],
//!      "requester": "<actor>", "purpose": "<text, optional>",
//!      "features": [{ "geometry": <GeoJSON Polygon|MultiPolygon in
//!      EPSG:4326>, "score": <finite number> }, …] }`
//!   - `product` matches `^[a-z0-9][a-z0-9_-]*$` (file stem; anything
//!     else 400). At least one feature; at least one source pack.
//!   - Geometry MUST be EPSG:4326 lon/lat (the paint surface); rings
//!     validated finite + closed. Anything else 400, naming the feature
//!     index. (Narrow doctrine: other CRSs arrive with reprojection.)
//! - Tier gating: unknown source pack → 404; ceremony refusal → 403
//!   with the refusal text (T3 sources can never export — the seam
//!   enforces it; the route just surfaces it).
//! - Output exists → 409 (no overwrite through the API; pick a new
//!   product name).
//! - 200: `{ "product", "tier": "T2", "features": N, "files":
//!   {"shp"|"shx"|"dbf"|"prj"|"tsdf_json": {"name", "sha256"}},
//!   "area_m2_total", "ceremony": {"process", "basis"}, "audit_ids":
//!   [ledger row ids] }`.
//! - `x-geobase-tier: T2` and `cache-control: no-store` on every
//!   response that reaches tier logic.
//!
//! `area_m2` per feature is the unsigned Chamberlain–Duquette spherical
//! area (`geo` crate) of the 4326 geometry — descriptive product
//! metadata, deterministic and dependency-light.

use std::path::{Path, PathBuf};

use geobase_gpkg::ceremony::{CeremonyGate, CeremonyRecord};
use geobase_tsdf::Tier;

/// The ONLY DBF fields an exported product may carry, in order.
pub const PRODUCT_FIELDS: [&str; 3] = ["id", "area_m2", "score"];

/// The product tier every 1.3 export is stamped with.
pub const PRODUCT_TIER: Tier = Tier::T2;

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

/// A validated export request (the route builds this from JSON).
#[derive(Debug, Clone)]
pub struct ExportRequest {
    /// Product name: `^[a-z0-9][a-z0-9_-]*$`, becomes the file stem.
    pub product: String,
    /// Source pack ids the product derives from (catalog ids, >= 1).
    pub source_packs: Vec<String>,
    pub requester: String,
    pub purpose: Option<String>,
    /// Painted features, >= 1.
    pub features: Vec<PaintedFeature>,
}

/// A source pack resolved by the caller (id + open path + effective tier).
#[derive(Debug, Clone)]
pub struct SourcePack {
    pub id: String,
    pub path: PathBuf,
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
    /// Ledger row ids (export.ceremony, export.t2), in write order.
    pub audit_ids: Vec<i64>,
}

/// Errors from the export pipeline. The route maps these onto statuses
/// (Refused→403, Invalid→400, Exists→409, others→500).
#[derive(Debug, thiserror::Error)]
pub enum ExportError {
    #[error(transparent)]
    Refused(#[from] geobase_gpkg::ceremony::ExportRefused),
    /// The node cannot write the T3 export ledger without configured
    /// at-rest encryption (fail-closed). The route maps this to 503 —
    /// the node is not provisioned to store sovereign history safely.
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
}

/// Append an `export.refused` audit row for a request that failed the
/// interim operator token guard (Phase A, A1) — refused BEFORE the
/// ceremony seam ran, so no ceremony record exists and none is implied.
/// Same ledger, same fail-closed posture as every other T3 write: a node
/// with no configured cipher refuses to write this row (the caller
/// tolerates exactly that refusal — such a node cannot export at all).
pub fn record_token_refusal(
    cipher: &dyn geobase_gpkg::cipher::AtRestCipher,
    exports_dir: &Path,
    product: &str,
    requester: &str,
    source_packs: &[String],
    purpose: Option<&str>,
) -> Result<(), ExportError> {
    let (tsdf_version, tsdf_origin) = tsdf_info()?;
    let ledger = open_ledger(exports_dir, &tsdf_version, &tsdf_origin, cipher)?;
    ledger.append_audit(&geobase_gpkg::AuditEntry {
        dataset_id: product.to_string(),
        action: "export.refused".into(),
        actor: requester.to_string(),
        tsdf_version,
        tsdf_source_origin: tsdf_origin,
        details: serde_json::json!({
            "reason": "missing or invalid export token (interim operator \
                       guard — Phase A A1; the ceremony seam was never consulted)",
            "source_packs": source_packs,
            "purpose": purpose,
        }),
    })?;
    Ok(())
}

/// Export `request` as a T2 product shapefile into `exports_dir`,
/// authorized through `gate`, verified per the module contract, audited
/// in the ledger. On ANY failure nothing is released: partial outputs
/// are removed and no success rows are written.
pub fn export_product(
    gate: &dyn CeremonyGate,
    cipher: &dyn geobase_gpkg::cipher::AtRestCipher,
    exports_dir: &Path,
    request: &ExportRequest,
    sources: &[SourcePack],
) -> Result<ExportOutcome, ExportError> {
    validate_request(request, sources)?;
    // Fail FAST and fail CLOSED: the export writes a T3 ledger, so if this
    // node cannot store it encrypted, refuse BEFORE any product bytes are
    // written — no plaintext product is left on disk by a node that then
    // can't audit it. (The ledger's own `open_ledger` re-authorizes at the
    // true write chokepoint; this early check is the fast path.)
    cipher.authorize_at_rest(geobase_tsdf::Tier::T3)?;
    let (tsdf_version, tsdf_origin) = tsdf_info()?;

    let source_tier = sources
        .iter()
        .map(|s| s.tier)
        .max()
        .unwrap_or(geobase_tsdf::Tier::T3);
    let auth = geobase_gpkg::ceremony::ExportAuthorization {
        pack_id: &request.product,
        source_tier,
        product_tier: PRODUCT_TIER,
        requester: &request.requester,
        purpose: request.purpose.as_deref(),
    };

    let record = match gate.authorize_export(&auth) {
        Ok(record) => record,
        Err(refused) => {
            // Refusals are audited too — nothing PRODUCT-related is
            // written, but the ledger records that the ask happened. (On a
            // fail-closed node the ledger write itself refuses first, so a
            // node with no cipher cannot export at all — correct posture.)
            let ledger = open_ledger(exports_dir, &tsdf_version, &tsdf_origin, cipher)?;
            ledger.append_audit(&geobase_gpkg::AuditEntry {
                dataset_id: request.product.clone(),
                action: "export.refused".into(),
                actor: request.requester.clone(),
                tsdf_version: tsdf_version.clone(),
                tsdf_source_origin: tsdf_origin.clone(),
                details: serde_json::json!({
                    "reason": refused.to_string(),
                    "source_tier": source_tier.code(),
                    "product_tier": PRODUCT_TIER.code(),
                    "source_packs": sources.iter().map(|s| s.id.clone()).collect::<Vec<_>>(),
                    "purpose": request.purpose,
                }),
            })?;
            return Err(ExportError::Refused(refused));
        }
    };

    std::fs::create_dir_all(exports_dir)?;
    let shp_path = exports_dir.join(format!("{}.shp", request.product));
    let tsdf_json_path = exports_dir.join(format!("{}.tsdf.json", request.product));
    let mut all_outputs: Vec<PathBuf> = ["shp", "shx", "dbf", "prj"]
        .iter()
        .map(|ext| shp_path.with_extension(ext))
        .collect();
    all_outputs.push(tsdf_json_path.clone());
    for path in &all_outputs {
        if path.exists() {
            return Err(ExportError::Exists(path.display().to_string()));
        }
    }

    // Build + write the product layer, then verify; remove everything on
    // any failure past this point — no torn or unaudited export survives.
    let result = (|| -> Result<ExportOutcome, ExportError> {
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
        let source_meta: Vec<serde_json::Value> = sources
            .iter()
            .map(|s| {
                Ok(serde_json::json!({
                    "id": s.id,
                    "tier": s.tier.code(),
                    "sha256": sha256_hex(&s.path)?,
                }))
            })
            .collect::<Result<_, ExportError>>()?;
        let sidecar = serde_json::json!({
            "tier": PRODUCT_TIER.code(),
            "tsdf_version": tsdf_version,
            "tsdf_source_origin": tsdf_origin,
            "basis": record.basis,
            "process": record.process,
            "product": request.product,
            "features": request.features.len(),
            "source_packs": source_meta,
            "files": files.iter().cloned().collect::<std::collections::BTreeMap<_, _>>(),
        });
        std::fs::write(
            &tsdf_json_path,
            serde_json::to_string_pretty(&sidecar).map_err(geobase_gpkg::GpkgError::from)?,
        )?;
        files.push((file_name_of(&tsdf_json_path), sha256_hex(&tsdf_json_path)?));

        verify_product(&shp_path, request, sources)?;

        // Audit AFTER verification: the rows attest to a verified export.
        let ledger = open_ledger(exports_dir, &tsdf_version, &tsdf_origin, cipher)?;
        let ceremony_id = ledger.append_audit(&geobase_gpkg::AuditEntry {
            dataset_id: request.product.clone(),
            action: "export.ceremony".into(),
            actor: request.requester.clone(),
            tsdf_version: tsdf_version.clone(),
            tsdf_source_origin: tsdf_origin.clone(),
            details: record.audit_details(&auth),
        })?;
        let area_m2_total: f64 = areas.iter().sum();
        let t2_id = ledger.append_audit(&geobase_gpkg::AuditEntry {
            dataset_id: request.product.clone(),
            action: "export.t2".into(),
            actor: request.requester.clone(),
            tsdf_version: tsdf_version.clone(),
            tsdf_source_origin: tsdf_origin.clone(),
            details: serde_json::json!({
                "product": request.product,
                "tier": PRODUCT_TIER.code(),
                "features": request.features.len(),
                "area_m2_total": area_m2_total,
                "files": files.iter().cloned().collect::<std::collections::BTreeMap<_, _>>(),
                "source_packs": sources.iter().map(|s| {
                    serde_json::json!({"id": s.id, "tier": s.tier.code()})
                }).collect::<Vec<_>>(),
            }),
        })?;

        Ok(ExportOutcome {
            product: request.product.clone(),
            tier: PRODUCT_TIER,
            features_written: written.features_written,
            files,
            area_m2_total,
            ceremony: record.clone(),
            audit_ids: vec![ceremony_id, t2_id],
        })
    })();

    if result.is_err() {
        for path in &all_outputs {
            let _ = std::fs::remove_file(path);
        }
    }
    result
}

/// Request validation — total and loud, naming the offender.
fn validate_request(request: &ExportRequest, sources: &[SourcePack]) -> Result<(), ExportError> {
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
    if request.requester.trim().is_empty() {
        return Err(ExportError::Invalid(
            "requester is required — every export names who asked".into(),
        ));
    }
    if sources.is_empty() {
        return Err(ExportError::Invalid(
            "at least one source pack is required".into(),
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
            // range, never assume (coordinates from another CRS must not
            // be stamped 4326).
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
        let gpkg = geobase_gpkg::GeoPackage::open(&source.path)?;
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

/// Open (or create + T3-tag) the export ledger.
///
/// The ledger is a **T3 artifact** (node history that never leaves the
/// node), so its at-rest write is authorized through `cipher` BEFORE any
/// bytes land. A fail-closed node refuses here — no plaintext ledger is
/// ever created — which is what closes the plaintext-ledger hole. A
/// dev-plaintext ledger is permanently stamped `UNENCRYPTED-DEV`.
fn open_ledger(
    exports_dir: &Path,
    tsdf_version: &str,
    tsdf_origin: &str,
    cipher: &dyn geobase_gpkg::cipher::AtRestCipher,
) -> Result<geobase_gpkg::GeoPackage, ExportError> {
    use geobase_gpkg::cipher::AtRestProtection;
    let protection = cipher.authorize_at_rest(geobase_tsdf::Tier::T3)?;
    std::fs::create_dir_all(exports_dir)?;
    let path = exports_dir.join("node-audit.gpkg");
    if path.is_file() {
        return Ok(geobase_gpkg::GeoPackage::open(&path)?);
    }
    let ledger = geobase_gpkg::GeoPackage::create(&path)?;
    let mut extras = serde_json::Map::new();
    extras.insert(
        "classification_basis".into(),
        serde_json::Value::String("node-local export ledger — never leaves the node".into()),
    );
    // The poison stamp travels with the artifact: a dev-plaintext ledger is
    // permanently marked non-production so a real node can refuse it. (There
    // is no "encrypted" stamp path here yet — the Phase 1.2 cipher impl adds
    // real encryption + a truthful stamp; until then the only protections are
    // "fail-closed refuse" and "dev-plaintext, stamped".)
    if protection == AtRestProtection::UnencryptedDev {
        extras.insert(
            "at_rest".into(),
            serde_json::Value::String(geobase_gpkg::cipher::UNENCRYPTED_DEV_STAMP.into()),
        );
    }
    ledger.write_tsdf_tag(&geobase_gpkg::TsdfTag {
        table: None,
        tier: geobase_tsdf::Tier::T3,
        tsdf_version: tsdf_version.to_string(),
        tsdf_source_origin: tsdf_origin.to_string(),
        classified_by: "geobase-node".into(),
        extras,
    })?;
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
        drop(gpkg);
        SourcePack {
            id: name.into(),
            path,
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
            source_packs: vec!["capacity".into()],
            requester: "test".into(),
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

    #[test]
    fn happy_path_writes_t2_product_sidecar_hashes_and_ledger_rows() {
        let dir = temp_dir("happy");
        let exports = dir.join("exports");
        let source = source_pack(&dir, "capacity", Tier::T1, &source_ring());

        let req = request(
            "wind-north",
            vec![square((0.0, 0.0), 0.001), square((0.01, 0.0), 0.002)],
        );
        let outcome = export_product(
            &ProvisionalDevGate,
            &geobase_gpkg::cipher::DevPlaintextCipher::new(),
            &exports,
            &req,
            &[source],
        )
        .unwrap();

        assert_eq!(outcome.tier, Tier::T2);
        assert_eq!(outcome.features_written, 2);
        assert!(outcome.area_m2_total > 0.0);
        assert_eq!(
            outcome.ceremony.basis,
            geobase_gpkg::ceremony::PROVISIONAL_BASIS
        );
        assert_eq!(outcome.files.len(), 5, "shp, shx, dbf, prj, tsdf.json");
        for (name, sha) in &outcome.files {
            let bytes = std::fs::read(exports.join(name)).unwrap();
            use sha2::{Digest, Sha256};
            assert_eq!(*sha, format!("{:x}", Sha256::digest(bytes)), "{name}");
        }

        let ledger = GeoPackage::open(&exports.join("node-audit.gpkg")).unwrap();
        assert_eq!(ledger.geopackage_tier().unwrap(), Some(Tier::T3));
        let trail = ledger.audit_trail().unwrap();
        assert_eq!(trail.len(), 2);
        assert_eq!(trail[0].action, "export.ceremony");
        assert_eq!(
            trail[0].details["basis"],
            geobase_gpkg::ceremony::PROVISIONAL_BASIS
        );
        assert_eq!(trail[1].action, "export.t2");
        assert_eq!(trail[1].details["tier"], "T2");
        assert_eq!(outcome.audit_ids, vec![trail[0].id, trail[1].id]);
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
        )
        .unwrap_err();
        assert!(matches!(err, ExportError::Encryption(_)));
        assert!(err.to_string().contains("fail-closed"));
        // The ledger was never created, and NO product artifact of any kind
        // is left on disk (fail-fast happens before the product is written;
        // belt-and-suspenders: assert every sidecar extension is absent).
        assert!(!exports.join("node-audit.gpkg").exists());
        for ext in ["shp", "shx", "dbf", "prj", "tsdf.json"] {
            assert!(
                !exports.join(format!("blocked.{ext}")).exists(),
                "no blocked.{ext} may survive a fail-closed refusal"
            );
        }
    }

    /// [EGRESS-GATE A7] The dev-plaintext ledger is permanently poison-stamped
    /// UNENCRYPTED-DEV so a production node can refuse to treat it as valid.
    #[test]
    fn egress_gate_a7_dev_plaintext_ledger_is_poison_stamped() {
        let dir = temp_dir("a7-devstamp");
        let exports = dir.join("exports");
        let source = source_pack(&dir, "capacity", Tier::T1, &source_ring());
        export_product(
            &ProvisionalDevGate,
            &geobase_gpkg::cipher::DevPlaintextCipher::new(),
            &exports,
            &request("stamped", vec![square((0.0, 0.0), 0.001)]),
            std::slice::from_ref(&source),
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
            "the dev-plaintext ledger must carry the poison stamp"
        );
    }

    /// [EGRESS-GATE A8] KNOWN GAP (ignored). `verify_product` check #4 uses
    /// EXACT coordinate equality (`coord_multiset` over `f64::to_bits`), so a
    /// source geometry offset by a single ULP is not recognised as a trace
    /// and WOULD be republished in the product. The fix is a tolerance /
    /// minimum-distance band in check #4 (ADD to the exact check, never weaken
    /// it), tracked as a scoped follow-on. Un-`ignore` when that lands.
    #[test]
    #[ignore = "known gap: 1-ULP near-trace escapes exact-equality verify_product #4 (scoped follow-on)"]
    fn egress_gate_a8_near_trace_is_refused() {
        let dir = temp_dir("a8-neartrace");
        let exports = dir.join("exports");
        let ring = source_ring();
        let source = source_pack(&dir, "capacity", Tier::T1, &ring);
        // Trace the source ring but nudge every coordinate by one ULP.
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
            &geobase_gpkg::cipher::DevPlaintextCipher::new(),
            &exports,
            &request("neartrace", vec![nudged]),
            std::slice::from_ref(&source),
        );
        // DESIRED (fails today → ignored): a near-trace is refused like an
        // exact trace.
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
            &geobase_gpkg::cipher::DevPlaintextCipher::new(),
            &exports,
            &request("secret", vec![square((0.0, 0.0), 0.001)]),
            &[source],
        )
        .unwrap_err();
        assert!(matches!(err, ExportError::Refused(_)));

        let entries: Vec<String> = std::fs::read_dir(&exports)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(entries, vec!["node-audit.gpkg"], "only the ledger exists");
        let ledger = GeoPackage::open(&exports.join("node-audit.gpkg")).unwrap();
        let trail = ledger.audit_trail().unwrap();
        assert_eq!(trail.len(), 1);
        assert_eq!(trail[0].action, "export.refused");
        assert!(trail[0].details["reason"]
            .as_str()
            .unwrap()
            .contains("never leaves the node"));
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
            &geobase_gpkg::cipher::DevPlaintextCipher::new(),
            &exports,
            &request("traced", vec![traced]),
            &[source],
        )
        .unwrap_err();
        assert!(matches!(err, ExportError::Verification(_)));
        assert!(err.to_string().contains("republish"));
        for ext in ["shp", "shx", "dbf", "prj"] {
            assert!(
                !exports.join(format!("traced.{ext}")).exists(),
                "{ext} must be removed"
            );
        }
        assert!(!exports.join("traced.tsdf.json").exists());
    }

    #[test]
    fn duplicate_product_name_returns_exists() {
        let dir = temp_dir("dup");
        let exports = dir.join("exports");
        let source = source_pack(&dir, "capacity", Tier::T0, &source_ring());

        export_product(
            &ProvisionalDevGate,
            &geobase_gpkg::cipher::DevPlaintextCipher::new(),
            &exports,
            &request("site", vec![square((0.0, 0.0), 0.001)]),
            std::slice::from_ref(&source),
        )
        .unwrap();
        let err = export_product(
            &ProvisionalDevGate,
            &geobase_gpkg::cipher::DevPlaintextCipher::new(),
            &exports,
            &request("site", vec![square((0.02, 0.0), 0.001)]),
            &[source],
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
            &geobase_gpkg::cipher::DevPlaintextCipher::new(),
            &exports,
            &request("Bad Name", vec![square((0.0, 0.0), 0.001)]),
            std::slice::from_ref(&source),
        )
        .unwrap_err();
        assert!(bad_name.to_string().contains("product name"));

        let empty = export_product(
            &ProvisionalDevGate,
            &geobase_gpkg::cipher::DevPlaintextCipher::new(),
            &exports,
            &request("empty", vec![]),
            std::slice::from_ref(&source),
        )
        .unwrap_err();
        assert!(empty.to_string().contains("at least one painted feature"));

        let mut nan_score = request("nan", vec![square((0.0, 0.0), 0.001)]);
        nan_score.features[0].score = f64::NAN;
        let err = export_product(
            &ProvisionalDevGate,
            &geobase_gpkg::cipher::DevPlaintextCipher::new(),
            &exports,
            &nan_score,
            std::slice::from_ref(&source),
        )
        .unwrap_err();
        assert!(err.to_string().contains("score is not finite"));

        // EPSG:26910-style coordinates must be refused, not stamped 4326.
        let projected = request("projected", vec![square((523000.0, 5215000.0), 100.0)]);
        let err = export_product(
            &ProvisionalDevGate,
            &geobase_gpkg::cipher::DevPlaintextCipher::new(),
            &exports,
            &projected,
            std::slice::from_ref(&source),
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
            &geobase_gpkg::cipher::DevPlaintextCipher::new(),
            &exports,
            &degenerate,
            &[source],
        )
        .unwrap_err();
        assert!(err.to_string().contains("distinct vertices"));
    }
}
