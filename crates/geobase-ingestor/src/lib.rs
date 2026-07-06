//! # geobase-ingestor — "GeoPack"
//!
//! The ingestor packages arbitrary inputs — files, documents, imagery,
//! shapefiles, databases — into **GeoPacks**: TSDF-tagged secure GeoPackage
//! bundles, harmonized and sovereignty-compliant at the point of ingest.
//!
//! The name **GeoPack** names the *artifact*, not just the tool: like a zip
//! or an npm package, a GeoPack is a self-describing container — data +
//! documents + tier tags + provenance — that enters GeoBase ready to serve.
//! (Prior codename "Weir"; the selective-gating idea lives on in tier
//! enforcement. Crate id stays `geobase-ingestor` so renaming is cheap.)
//!
//! ## Phase 0.3 pipeline (this crate's MVP)
//!
//! `ingest()` packages **one GeoTIFF + one shapefile** into a GeoPack:
//!
//! 1. Resolve the TSDF tier — unspecified defaults to **T3** ("when in
//!    doubt, classify as T3"), version-stamped from the vendored spec.
//! 2. Read + validate both inputs (narrow acceptance; see [`geotiff`] and
//!    [`shp`] module docs). CRS discipline: identifiable CRS or an
//!    **operator-declared** one recorded in the audit trail — never assumed.
//! 3. Write the GeoPackage: raster coverage first (write-ordering
//!    invariant), then the vector layer, then TSDF tags (per-table +
//!    whole-artifact roll-up) and the append-only audit records.
//! 4. Re-open and verify the complete artifact — the guard that keeps the
//!    ordering invariant and tag completeness unbreakable.

pub mod crs_id;
pub mod geotiff;
pub mod package;
pub mod shp;
pub mod shp_write;

use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};

use geobase_gpkg::{
    raster::{write_gridded_coverage, CoverageData, RasterCoverageSpec},
    vector::{create_feature_table, insert_feature, ColumnDef, FeatureTableSpec},
    AuditEntry, GeoPackage, TsdfTag,
};
use geobase_tsdf::{Tier, TsdfSource, VendoredSource};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

/// A request to package inputs into a GeoPack.
#[derive(Debug, Clone)]
pub struct IngestRequest {
    /// Terrain / elevation / continuous-value raster.
    pub geotiff: PathBuf,
    /// Vector layer (parcels, boundaries, grids, …).
    pub shapefile: PathBuf,
    /// Output GeoPack path (a `.gpkg`).
    pub out: PathBuf,
    /// Identity recorded in tags and audit (e.g. `"demo-fixture-pack"`).
    pub dataset_id: String,
    /// Requested tier. `None` applies the TSDF default (T3).
    pub tier: Option<Tier>,
    /// Operator-declared CRS (EPSG), used **only** when an input's CRS is
    /// missing/unidentifiable. Requires `declared_crs_reason`.
    pub declared_epsg: Option<u32>,
    /// Why the operator asserts that CRS — recorded verbatim in audit.
    pub declared_crs_reason: Option<String>,
    /// Who is running the ingest — recorded in every tag and audit row.
    pub actor: String,
    /// Basis for the classification (e.g. "public federal source"). When
    /// absent a provisional-basis note is recorded instead.
    pub classification_basis: Option<String>,
    /// Replace `out` if it exists (builds are otherwise refuse-to-overwrite).
    pub overwrite: bool,
}

/// What an ingest produced — everything the gate needs to verify.
#[derive(Debug)]
pub struct IngestResult {
    pub geopack: PathBuf,
    pub dataset_id: String,
    pub tier: Tier,
    pub tsdf_version: String,
    pub raster_table: String,
    pub vector_table: String,
    pub tiles_written: u32,
    pub features_written: usize,
}

/// Errors from the ingestor.
#[derive(Debug, thiserror::Error)]
pub enum IngestError {
    #[error("tsdf error: {0}")]
    Tsdf(String),
    #[error(transparent)]
    GeoTiff(#[from] geotiff::GeoTiffError),
    #[error(transparent)]
    Shapefile(#[from] shp::ShpError),
    #[error(transparent)]
    Gpkg(#[from] geobase_gpkg::GpkgError),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid request: {0}")]
    Invalid(String),
}

/// Resolve the effective tier for a request plus the TSDF version and origin
/// in force, honoring the framework default (T3) when unspecified.
pub fn resolve_tier(requested: Option<Tier>) -> Result<(Tier, String, String), IngestError> {
    let source = VendoredSource::embedded();
    let spec = source
        .load()
        .map_err(|e| IngestError::Tsdf(e.to_string()))?;
    let tier = requested.unwrap_or_else(|| spec.default_classification());
    Ok((tier, spec.version, source.origin()))
}

/// Derive a safe SQL table name from a file stem: lowercase alphanumerics
/// and underscores, digit-safe, never empty.
pub fn table_name_from(path: &Path, fallback: &str) -> String {
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut name: String = stem
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect();
    if name.trim_matches('_').is_empty() {
        name = fallback.to_string();
    }
    if name.chars().next().is_some_and(|c| c.is_ascii_digit()) {
        name = format!("t_{name}");
    }
    name
}

fn sha256_hex(path: &Path) -> Result<String, IngestError> {
    // Name the file: a missing/unreadable input must fail loudly enough to
    // act on, not as a bare os-error with no subject.
    let mut file = std::fs::File::open(path)
        .map_err(|e| IngestError::Invalid(format!("{}: {e}", path.display())))?;
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

fn file_name_of(path: &Path) -> String {
    path.file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.display().to_string())
}

fn staging_path_for(path: &Path) -> PathBuf {
    let mut file_name: OsString = path
        .file_name()
        .map(OsString::from)
        .unwrap_or_else(|| OsString::from("geopack"));
    file_name.push(".ingest-tmp");
    path.with_file_name(file_name)
}

fn shapefile_sidecars(path: &Path) -> Result<Map<String, Value>, IngestError> {
    let mut sidecars = Map::new();
    for ext in ["dbf", "shx", "prj", "cpg"] {
        let candidate = path.with_extension(ext);
        if candidate.exists() {
            sidecars.insert(format!(".{ext}"), json!(sha256_hex(&candidate)?));
        }
    }
    Ok(sidecars)
}

/// How the raster CRS was established (vector-side lives in [`shp`]).
enum RasterCrs {
    FromGeoKeys(u32),
    OperatorDeclared(u32),
}

impl RasterCrs {
    fn epsg(&self) -> u32 {
        match self {
            RasterCrs::FromGeoKeys(e) | RasterCrs::OperatorDeclared(e) => *e,
        }
    }
    fn method(&self) -> &'static str {
        match self {
            RasterCrs::FromGeoKeys(_) => "geokeys",
            RasterCrs::OperatorDeclared(_) => "operator-declared",
        }
    }
}

/// Package `req` into a TSDF-tagged GeoPack. See module docs for the hops.
pub fn ingest(req: &IngestRequest) -> Result<IngestResult, IngestError> {
    // Hop 0 — request validation + tier resolution.
    if req.actor.trim().is_empty() {
        return Err(IngestError::Invalid(
            "actor is required — every classification and audit row names who acted".into(),
        ));
    }
    if req.declared_epsg.is_some()
        && req
            .declared_crs_reason
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .is_empty()
    {
        return Err(IngestError::Invalid(
            "an operator-declared CRS requires --declare-crs-reason; the declaration is \
             recorded in the audit trail and must say why the operator asserts it"
                .into(),
        ));
    }
    let (tier, tsdf_version, tsdf_origin) = resolve_tier(req.tier)?;

    // Hop 1 — read + validate inputs (each module asserts its own hops).
    let raster = geotiff::read_geotiff(&req.geotiff)?;
    let raster_crs = match (raster.epsg, req.declared_epsg) {
        (Some(found), Some(declared)) if found != declared => {
            return Err(IngestError::Invalid(format!(
                "GeoTIFF declares EPSG:{found} but the operator declared EPSG:{declared}; \
                 a declaration is an escape hatch for missing CRSs, not an override — \
                 fix the declaration or re-export the source"
            )));
        }
        (Some(found), _) => RasterCrs::FromGeoKeys(found),
        (None, Some(declared)) => RasterCrs::OperatorDeclared(declared),
        (None, None) => {
            return Err(IngestError::Invalid(format!(
                "{}: no CRS in GeoKeys and no operator declaration — refusing to assume \
                 (declare one explicitly with --declare-crs + --declare-crs-reason)",
                req.geotiff.display()
            )));
        }
    };
    let vector = shp::read_shapefile(&req.shapefile, req.declared_epsg)?;

    if req.out.exists() && !req.overwrite {
        return Err(IngestError::Invalid(format!(
            "{} already exists (pass overwrite/--force to replace)",
            req.out.display()
        )));
    }
    let staging = staging_path_for(&req.out);
    let _ = std::fs::remove_file(&staging);

    let result = (|| -> Result<IngestResult, IngestError> {
        // Hop 2 — create the staging artifact.
        let gpkg = GeoPackage::create(&staging)?;

        // Hop 3 — raster coverage FIRST (write-ordering invariant), native CRS.
        let raster_table = table_name_from(&req.geotiff, "raster");
        let mut vector_table = table_name_from(&req.shapefile, "features");
        if vector_table == raster_table {
            vector_table.push_str("_vec");
        }
        let stats = write_gridded_coverage(
            &gpkg,
            &RasterCoverageSpec {
                table: raster_table.clone(),
                identifier: format!("{} — {}", req.dataset_id, raster_table),
                srs_epsg: raster_crs.epsg(),
                srs_definition: None,
                width: raster.width,
                height: raster.height,
                pixel_size: raster.pixel_size,
                origin: raster.origin,
                tile_size: 256,
                data_null: raster.nodata,
            },
            match &raster.data {
                geotiff::RasterData::F32(v) => CoverageData::F32(v),
                geotiff::RasterData::I16(v) => CoverageData::I16(v),
            },
        )?;

        // Hop 4 — vector layer, native CRS.
        create_feature_table(
            &gpkg,
            &FeatureTableSpec {
                table: vector_table.clone(),
                identifier: format!("{} — {}", req.dataset_id, vector_table),
                srs_epsg: vector.crs.epsg(),
                srs_definition: vector.prj_wkt.clone(),
                geometry_type: vector.geometry_type.gpkg_name().to_string(),
                columns: vector
                    .fields
                    .iter()
                    .map(|f| ColumnDef {
                        name: f.name.clone(),
                        sql_type: f.sql_type,
                    })
                    .collect(),
                bounds: vector.bounds,
            },
        )?;
        for feature in &vector.features {
            let attrs: Vec<rusqlite::types::Value> = feature
                .attrs
                .iter()
                .map(|a| match a {
                    shp::AttrValue::Null => rusqlite::types::Value::Null,
                    shp::AttrValue::Text(s) => rusqlite::types::Value::Text(s.clone()),
                    shp::AttrValue::Integer(i) => rusqlite::types::Value::Integer(*i),
                    shp::AttrValue::Real(f) => rusqlite::types::Value::Real(*f),
                })
                .collect();
            insert_feature(&gpkg, &vector_table, &feature.geom, &attrs)?;
        }

        // Hop 5 — classification travels with the artifact.
        let tif_sha = sha256_hex(&req.geotiff)?;
        let shp_sha = sha256_hex(&req.shapefile)?;
        let shp_sidecars = shapefile_sidecars(&req.shapefile)?;
        let basis = req.classification_basis.clone().unwrap_or_else(|| {
            format!(
                "unspecified — TSDF default posture applied (tier {}); \
             no sovereign classification process ran for this ingest",
                tier.code()
            )
        });
        let vector_crs_method = match &vector.crs {
            shp::CrsResolution::Identified { method, .. } => *method,
            shp::CrsResolution::OperatorDeclared { .. } => "operator-declared",
        };
        let mut raster_extras = Map::new();
        raster_extras.insert("classification_basis".into(), json!(basis));
        raster_extras.insert(
            "source".into(),
            json!({ "file": file_name_of(&req.geotiff), "sha256": tif_sha }),
        );
        raster_extras.insert(
            "native_crs".into(),
            json!(format!("EPSG:{}", raster_crs.epsg())),
        );
        raster_extras.insert("crs_method".into(), json!(raster_crs.method()));
        let mut vector_extras = Map::new();
        vector_extras.insert("classification_basis".into(), json!(basis));
        vector_extras.insert(
            "source".into(),
            json!({
                "file": file_name_of(&req.shapefile),
                "sha256": shp_sha,
                "sidecars": shp_sidecars.clone(),
            }),
        );
        vector_extras.insert(
            "native_crs".into(),
            json!(format!("EPSG:{}", vector.crs.epsg())),
        );
        vector_extras.insert("crs_method".into(), json!(vector_crs_method));
        let mut rollup_extras = Map::new();
        rollup_extras.insert(
            "rule".into(),
            json!("most restrictive of table tiers (geobase_core::LayerPackage::effective_tier)"),
        );
        rollup_extras.insert("dataset_id".into(), json!(req.dataset_id));
        for (table, extras) in [
            (Some(raster_table.clone()), raster_extras),
            (Some(vector_table.clone()), vector_extras),
            (None, rollup_extras),
        ] {
            gpkg.write_tsdf_tag(&TsdfTag {
                table,
                tier,
                tsdf_version: tsdf_version.clone(),
                tsdf_source_origin: tsdf_origin.clone(),
                classified_by: req.actor.clone(),
                extras,
            })?;
        }

        // Hop 6 — audit trail (append-only by trigger).
        let audit = |action: &str, details: Value| AuditEntry {
            dataset_id: req.dataset_id.clone(),
            action: action.to_string(),
            actor: req.actor.clone(),
            tsdf_version: tsdf_version.clone(),
            tsdf_source_origin: tsdf_origin.clone(),
            details,
        };
        if matches!(raster_crs, RasterCrs::OperatorDeclared(_))
            || matches!(vector.crs, shp::CrsResolution::OperatorDeclared { .. })
        {
            gpkg.append_audit(&audit(
                "crs.operator-declared",
                json!({
                    "epsg": req.declared_epsg,
                    "reason": req.declared_crs_reason,
                    "applies_to": {
                        "raster": matches!(raster_crs, RasterCrs::OperatorDeclared(_)),
                        "vector": matches!(vector.crs, shp::CrsResolution::OperatorDeclared { .. }),
                    },
                }),
            ))?;
        }
        gpkg.append_audit(&audit(
            "ingest.raster",
            json!({
                "table": raster_table,
                "source": { "file": file_name_of(&req.geotiff), "sha256": tif_sha },
                "epsg": raster_crs.epsg(),
                "crs_method": raster_crs.method(),
                "tiles": stats.tiles_written,
                "matrix": [stats.matrix_width, stats.matrix_height],
                "nodata_cells": stats.nodata_cells,
            }),
        ))?;
        gpkg.append_audit(&audit(
            "ingest.vector",
            json!({
                "table": vector_table,
                "source": {
                    "file": file_name_of(&req.shapefile),
                    "sha256": shp_sha,
                    "sidecars": shp_sidecars,
                },
                "epsg": vector.crs.epsg(),
                "crs_method": vector_crs_method,
                "features": vector.features.len(),
            }),
        ))?;
        gpkg.append_audit(&audit(
            "ingest.complete",
            json!({
                "tier": tier.code(),
                "tables": [raster_table, vector_table],
                "geopack": file_name_of(&req.out),
            }),
        ))?;

        // Hop 7 — artifact-level verification: reopen and check the COMPLETE
        // artifact, so a future reorder or dropped hop fails loudly, not silently.
        drop(gpkg);
        let check = GeoPackage::open(&staging)?;
        let contents: i64 = check.conn().query_row(
        "SELECT COUNT(*) FROM gpkg_contents WHERE data_type IN ('2d-gridded-coverage','features')",
        [],
        |r| r.get(0),
    ).map_err(geobase_gpkg::GpkgError::from)?;
        if contents != 2 {
            return Err(IngestError::Invalid(format!(
            "verification failed: expected 2 content tables (coverage + features), found {contents}"
        )));
        }
        let tags = check.read_tsdf_tags()?;
        if tags.len() != 3 {
            return Err(IngestError::Invalid(format!(
                "verification failed: expected 3 TSDF tags, found {}",
                tags.len()
            )));
        }
        if check.geopackage_tier()? != Some(tier) {
            return Err(IngestError::Invalid(
                "verification failed: whole-artifact tier does not match the requested tier".into(),
            ));
        }
        let trail = check.audit_trail()?;
        if trail.len() < 3 {
            return Err(IngestError::Invalid(format!(
                "verification failed: expected >= 3 audit records, found {}",
                trail.len()
            )));
        }
        drop(check);

        if req.out.exists() {
            std::fs::remove_file(&req.out)?;
        }
        std::fs::rename(&staging, &req.out)?;

        Ok(IngestResult {
            geopack: req.out.clone(),
            dataset_id: req.dataset_id.clone(),
            tier,
            tsdf_version,
            raster_table,
            vector_table,
            tiles_written: stats.tiles_written,
            features_written: vector.features.len(),
        })
    })();

    if result.is_err() {
        let _ = std::fs::remove_file(&staging);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unspecified_tier_defaults_to_t3() {
        let (tier, version, origin) = resolve_tier(None).unwrap();
        assert_eq!(tier, Tier::T3);
        assert_eq!(version, "0.9.4");
        assert_eq!(origin, "vendored:embedded");
    }

    #[test]
    fn explicit_tier_is_honored() {
        let (tier, ..) = resolve_tier(Some(Tier::T0)).unwrap();
        assert_eq!(tier, Tier::T0);
    }

    #[test]
    fn table_names_are_sql_safe() {
        assert_eq!(
            table_name_from(Path::new("DEM Small-2026.tif"), "raster"),
            "dem_small_2026"
        );
        assert_eq!(table_name_from(Path::new("10m.tif"), "raster"), "t_10m");
        assert_eq!(
            table_name_from(Path::new("___.shp"), "features"),
            "features"
        );
    }

    #[test]
    fn declared_crs_requires_reason() {
        let req = IngestRequest {
            geotiff: "a.tif".into(),
            shapefile: "b.shp".into(),
            out: "c.gpkg".into(),
            dataset_id: "d".into(),
            tier: None,
            declared_epsg: Some(26910),
            declared_crs_reason: None,
            actor: "test".into(),
            classification_basis: None,
            overwrite: false,
        };
        let err = ingest(&req).unwrap_err();
        assert!(matches!(err, IngestError::Invalid(_)));
        assert!(err.to_string().contains("declare-crs-reason"));
    }
}
