//! Package ingest — **one GeoPack = one layer package** (Phase 1.1a).
//!
//! `geopack package --manifest <pkg.toml> --out <pack.gpkg> [--actor <name>]
//! [--force]` builds a single GeoPack from N declared inputs. The manifest
//! is the package's identity; the CLI supplies only invocation concerns
//! (output path, actor, overwrite).
//!
//! ## Manifest schema (frozen — `pkg.toml`)
//!
//! ```toml
//! [package]
//! id = "landcover-2026"     # required; ^[a-z0-9][a-z0-9_-]*$ — becomes the
//!                           # dataset_id and the /api/packs/{id} URL segment
//! name = "Land cover 2026"  # required; non-empty after trim
//! tier = "T0"               # optional; T0|T1|T2|T3; omitted -> TSDF default (T3)
//! basis = "public source"   # optional; non-empty if present; omitted -> the
//!                           # provisional-basis note is recorded instead
//!
//! [[inputs]]                # one or more; empty list rejects
//! kind = "vector"           # required; "vector" | "raster"
//! path = "landcover.shp"    # required; non-empty; relative paths resolve
//!                           # against the manifest's parent directory
//! table = "landcover"       # optional; ^[a-z_][a-z0-9_]*$; default derives
//!                           # from the file stem via `table_name_from`
//! declare_crs = "EPSG:26910"    # optional; "EPSG:<digits>"; escape hatch for
//!                               # sources with no identifiable CRS — never an
//!                               # override of a CRS the source declares
//! declare_crs_reason = "..."    # required iff declare_crs; non-empty;
//!                               # recorded verbatim in the audit trail
//! ```
//!
//! Validation is **total and loud** (the `place.rs` doctrine): unknown keys
//! reject (`deny_unknown_fields`), every failure names the offending field,
//! and a manifest must never half-load. Additional cross-field rules:
//!
//! - `kind`/extension agreement: `raster` requires `.tif`/`.tiff`, `vector`
//!   requires `.shp` (ASCII case-insensitive) — a mislabeled input rejects
//!   before any file is opened.
//! - Resolved table names must be unique across ALL inputs; a collision
//!   rejects naming both inputs and telling the operator to set `table`.
//! - `declare_crs_reason` without `declare_crs` rejects (a reason with
//!   nothing declared is a manifest bug, not a convenience).
//! - `tier` must parse via `Tier::from_code`; anything else rejects naming
//!   the bad code and the accepted set.
//!
//! ## Pipeline (reuses the `ingest()` hops verbatim)
//!
//! 0. Validate the request (non-empty actor) + manifest; resolve the package
//!    tier via [`crate::resolve_tier`] (omitted tier -> TSDF default, T3).
//! 1. Read + validate EVERY input before writing anything
//!    ([`crate::geotiff::read_geotiff`] / [`crate::shp::read_shapefile`],
//!    with the per-input declaration). Raster CRS resolution mirrors
//!    `ingest()` exactly: GeoKeys/declaration conflict rejects, neither
//!    rejects — a declaration is an escape hatch, never an override.
//! 2. Create a staging artifact (`.ingest-tmp` sibling; removed on error).
//! 3. Write ALL raster coverages first, in manifest order (write-ordering
//!    invariant — `CreateCopy` semantics destroy an existing file), then
//! 4. all vector tables, in manifest order.
//! 5. Tags: one table-scope [`geobase_gpkg::TsdfTag`] per input at the
//!    package tier (extras: `classification_basis`, `source` {file, sha256,
//!    sidecars for vectors}, `native_crs`, `crs_method`, `package_id`,
//!    `package_name`) plus one geopackage-scope roll-up tag (extras: `rule`
//!    — the `geobase_core::LayerPackage::effective_tier` most-restrictive
//!    rule, `package` {id, name, inputs, tables}, and `manifest` {file,
//!    sha256} so the package declaration itself travels with the artifact).
//! 6. Audit: `crs.operator-declared` per declared input (with the input
//!    path), `ingest.raster` / `ingest.vector` per input (same shapes as
//!    `ingest()`, `dataset_id` = package id), and `package.complete` last
//!    (tier, tables, geopack file, manifest sha256).
//! 7. Reopen and verify the COMPLETE staged artifact, then atomically
//!    rename into place: every declared table present in `gpkg_contents`
//!    under its kind's `data_type` and no others, exactly `inputs + 1` TSDF
//!    tags, whole-artifact tier == package tier, audit length >=
//!    `inputs + 1`. A future reorder or dropped hop fails loudly.
//!
//! The effective tier is the existing roll-up semantics: every table is
//! tagged at the package tier, so `GeoPackage::geopackage_tier()` (max over
//! tags) equals the package tier — per-input tier overrides are deliberately
//! deferred until a phase needs mixed-tier packages.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use geobase_gpkg::{
    raster::{write_gridded_coverage, CoverageData, CoverageStats, RasterCoverageSpec},
    vector::{create_feature_table, insert_feature, ColumnDef, FeatureTableSpec},
    AuditEntry, GeoPackage, TsdfTag,
};
use geobase_tsdf::Tier;
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::{
    file_name_of, geotiff, resolve_tier, sha256_hex, shapefile_sidecars, shp, staging_path_for,
    table_name_from, IngestError, RasterCrs,
};

/// A validated package manifest, loaded from `pkg.toml`.
#[derive(Debug, Clone, PartialEq)]
pub struct PackageManifest {
    /// Package id: `^[a-z0-9][a-z0-9_-]*$` — dataset_id + URL segment.
    pub id: String,
    /// Human-readable package name.
    pub name: String,
    /// Requested tier. `None` applies the TSDF default (T3).
    pub tier: Option<Tier>,
    /// Classification basis recorded in every tag; `None` records the
    /// provisional-basis note instead.
    pub basis: Option<String>,
    /// The declared inputs, manifest order, at least one.
    pub inputs: Vec<PackageInput>,
}

/// One validated input declaration.
#[derive(Debug, Clone, PartialEq)]
pub struct PackageInput {
    pub kind: InputKind,
    /// Source path; relative manifest paths are resolved against the
    /// manifest's parent directory at load time.
    pub path: PathBuf,
    /// Resolved table name: the `table` override when present, else derived
    /// via [`crate::table_name_from`]. Unique across the manifest.
    pub table: String,
    /// Operator-declared CRS (EPSG), only for sources with no identifiable
    /// CRS. Requires `declared_crs_reason`.
    pub declared_epsg: Option<u32>,
    /// Why the operator asserts that CRS — recorded verbatim in audit.
    pub declared_crs_reason: Option<String>,
}

/// Input kind, declared explicitly in the manifest (never sniffed).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputKind {
    Raster,
    Vector,
}

impl InputKind {
    /// The `gpkg_contents.data_type` this kind writes.
    pub fn gpkg_data_type(&self) -> &'static str {
        match self {
            InputKind::Raster => "2d-gridded-coverage",
            InputKind::Vector => "features",
        }
    }
}

/// A request to build a layer package from a manifest.
#[derive(Debug, Clone)]
pub struct PackageRequest {
    /// Path to `pkg.toml`.
    pub manifest: PathBuf,
    /// Output GeoPack path (a `.gpkg`).
    pub out: PathBuf,
    /// Who is running the packaging — recorded in every tag and audit row.
    pub actor: String,
    /// Replace `out` if it exists (refuse-to-overwrite otherwise).
    pub overwrite: bool,
}

/// What packaging produced — everything the layer gate needs to verify.
#[derive(Debug)]
pub struct PackageResult {
    pub geopack: PathBuf,
    pub package_id: String,
    pub package_name: String,
    pub tier: Tier,
    pub tsdf_version: String,
    /// Raster tables written, manifest order.
    pub raster_tables: Vec<RasterTableResult>,
    /// Vector tables written, manifest order.
    pub vector_tables: Vec<VectorTableResult>,
}

/// One raster coverage written by the package pipeline.
#[derive(Debug)]
pub struct RasterTableResult {
    pub table: String,
    pub tiles_written: u32,
}

/// One vector table written by the package pipeline.
#[derive(Debug)]
pub struct VectorTableResult {
    pub table: String,
    pub features_written: usize,
}

/// Errors from package manifest loading and the packaging pipeline.
#[derive(Debug, thiserror::Error)]
pub enum PackageError {
    #[error("io error reading {path}: {source}")]
    Io {
        path: String,
        source: std::io::Error,
    },
    #[error("manifest parse error in {path}: {detail}")]
    Parse { path: String, detail: String },
    #[error("manifest invalid ({path}): {detail}")]
    Invalid { path: String, detail: String },
    #[error("package request invalid: {0}")]
    Request(String),
    #[error(transparent)]
    Ingest(#[from] IngestError),
}

/// Load and validate a package manifest per the module contract. Relative
/// input paths are resolved against `path`'s parent directory; every
/// validation failure names the offending field.
pub fn load_manifest(path: &Path) -> Result<PackageManifest, PackageError> {
    let display_path = path.display().to_string();
    let raw = std::fs::read_to_string(path).map_err(|source| PackageError::Io {
        path: display_path.clone(),
        source,
    })?;
    let raw_manifest: RawManifest = toml::from_str(&raw).map_err(|source| PackageError::Parse {
        path: display_path.clone(),
        detail: source.to_string(),
    })?;
    validate_manifest(raw_manifest, path)
}

/// Package `req` into a TSDF-tagged layer-package GeoPack. See the module
/// docs for the hops; on any error the staging artifact is removed and
/// `req.out` is left untouched.
pub fn package(req: &PackageRequest) -> Result<PackageResult, PackageError> {
    if req.actor.trim().is_empty() {
        return Err(PackageError::Request(
            "actor is required — every classification and audit row names who acted".into(),
        ));
    }
    let staging = staging_path_for(&req.out);
    let _ = std::fs::remove_file(&staging);
    if req.out.exists() && !req.overwrite {
        return Err(PackageError::Request(format!(
            "{} already exists (pass overwrite/--force to replace)",
            req.out.display()
        )));
    }

    let result = (|| -> Result<PackageResult, PackageError> {
        let manifest = load_manifest(&req.manifest)?;
        let (tier, tsdf_version, tsdf_origin) = resolve_tier(manifest.tier)?;
        let manifest_sha = sha256_hex(&req.manifest)?;
        let prepared = prepare_inputs(&manifest)?;

        let gpkg = GeoPackage::create(&staging).map_err(IngestError::from)?;
        let mut raster_results = Vec::new();
        let mut vector_results = Vec::new();
        let mut raster_stats: HashMap<String, CoverageStats> = HashMap::new();

        for input in prepared
            .iter()
            .filter(|input| matches!(&input.data, PreparedData::Raster { .. }))
        {
            let PreparedData::Raster { raster, crs } = &input.data else {
                continue;
            };
            let stats = write_gridded_coverage(
                &gpkg,
                &RasterCoverageSpec {
                    table: input.table.clone(),
                    identifier: format!("{} — {}", manifest.id, input.table),
                    srs_epsg: crs.epsg(),
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
            )
            .map_err(IngestError::from)?;
            raster_results.push(RasterTableResult {
                table: input.table.clone(),
                tiles_written: stats.tiles_written,
            });
            raster_stats.insert(input.table.clone(), stats);
        }

        for input in prepared
            .iter()
            .filter(|input| matches!(&input.data, PreparedData::Vector { .. }))
        {
            let PreparedData::Vector { vector, .. } = &input.data else {
                continue;
            };
            create_feature_table(
                &gpkg,
                &FeatureTableSpec {
                    table: input.table.clone(),
                    identifier: format!("{} — {}", manifest.id, input.table),
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
            )
            .map_err(IngestError::from)?;
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
                insert_feature(&gpkg, &input.table, &feature.geom, &attrs)
                    .map_err(IngestError::from)?;
            }
            vector_results.push(VectorTableResult {
                table: input.table.clone(),
                features_written: vector.features.len(),
            });
        }

        let basis = manifest.basis.clone().unwrap_or_else(|| {
            format!(
                "unspecified — TSDF default posture applied (tier {}); \
             no sovereign classification process ran for this ingest",
                tier.code()
            )
        });
        for input in &prepared {
            gpkg.write_tsdf_tag(&TsdfTag {
                table: Some(input.table.clone()),
                tier,
                tsdf_version: tsdf_version.clone(),
                tsdf_source_origin: tsdf_origin.clone(),
                classified_by: req.actor.clone(),
                extras: input.table_extras(&basis, &manifest.id, &manifest.name),
            })
            .map_err(IngestError::from)?;
        }

        let package_inputs: Vec<Value> = prepared
            .iter()
            .map(|input| {
                json!({
                    "kind": input.kind_name(),
                    "path": file_name_of(&input.path),
                    "table": input.table,
                })
            })
            .collect();
        let package_tables: Vec<Value> = prepared
            .iter()
            .map(|input| json!({ "kind": input.kind_name(), "table": input.table }))
            .collect();
        let mut rollup_extras = Map::new();
        rollup_extras.insert(
            "rule".into(),
            json!("most restrictive of table tiers (geobase_core::LayerPackage::effective_tier)"),
        );
        rollup_extras.insert(
            "package".into(),
            json!({
                "id": &manifest.id,
                "name": &manifest.name,
                "inputs": package_inputs,
                "tables": package_tables,
            }),
        );
        rollup_extras.insert(
            "manifest".into(),
            json!({ "file": file_name_of(&req.manifest), "sha256": &manifest_sha }),
        );
        gpkg.write_tsdf_tag(&TsdfTag {
            table: None,
            tier,
            tsdf_version: tsdf_version.clone(),
            tsdf_source_origin: tsdf_origin.clone(),
            classified_by: req.actor.clone(),
            extras: rollup_extras,
        })
        .map_err(IngestError::from)?;

        let audit = |action: &str, details: Value| AuditEntry {
            dataset_id: manifest.id.clone(),
            action: action.to_string(),
            actor: req.actor.clone(),
            tsdf_version: tsdf_version.clone(),
            tsdf_source_origin: tsdf_origin.clone(),
            details,
        };
        for input in &prepared {
            if let Some(epsg) = input.declared_epsg {
                gpkg.append_audit(&audit(
                    "crs.operator-declared",
                    json!({
                        "epsg": epsg,
                        "reason": &input.declared_crs_reason,
                        "path": input.path.display().to_string(),
                    }),
                ))
                .map_err(IngestError::from)?;
            }
        }
        for input in &prepared {
            match &input.data {
                PreparedData::Raster { crs, .. } => {
                    let stats = raster_stats.get(&input.table).ok_or_else(|| {
                        PackageError::Ingest(IngestError::Invalid(format!(
                            "verification failed: raster table '{}' was not written",
                            input.table
                        )))
                    })?;
                    gpkg.append_audit(&audit(
                        "ingest.raster",
                        json!({
                            "table": input.table,
                            "source": { "file": file_name_of(&input.path), "sha256": &input.sha256 },
                            "epsg": crs.epsg(),
                            "crs_method": crs.method(),
                            "tiles": stats.tiles_written,
                            "matrix": [stats.matrix_width, stats.matrix_height],
                            "nodata_cells": stats.nodata_cells,
                        }),
                    ))
                    .map_err(IngestError::from)?;
                }
                PreparedData::Vector {
                    vector,
                    crs_method,
                    sidecars,
                } => {
                    gpkg.append_audit(&audit(
                        "ingest.vector",
                        json!({
                            "table": input.table,
                            "source": {
                                "file": file_name_of(&input.path),
                                "sha256": &input.sha256,
                                "sidecars": sidecars,
                            },
                            "epsg": vector.crs.epsg(),
                            "crs_method": crs_method,
                            "features": vector.features.len(),
                        }),
                    ))
                    .map_err(IngestError::from)?;
                }
            }
        }
        gpkg.append_audit(&audit(
            "package.complete",
            json!({
                "tier": tier.code(),
                "tables": prepared.iter().map(|input| input.table.clone()).collect::<Vec<_>>(),
                "geopack": file_name_of(&req.out),
                "manifest": { "file": file_name_of(&req.manifest), "sha256": &manifest_sha },
            }),
        ))
        .map_err(IngestError::from)?;

        drop(gpkg);
        verify_staged(&staging, &manifest, &prepared, tier)?;
        if req.out.exists() {
            std::fs::remove_file(&req.out).map_err(IngestError::from)?;
        }
        std::fs::rename(&staging, &req.out).map_err(IngestError::from)?;

        Ok(PackageResult {
            geopack: req.out.clone(),
            package_id: manifest.id.clone(),
            package_name: manifest.name.clone(),
            tier,
            tsdf_version,
            raster_tables: raster_results,
            vector_tables: vector_results,
        })
    })();

    if result.is_err() {
        let _ = std::fs::remove_file(&staging);
    }
    result
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawManifest {
    package: RawPackage,
    inputs: Vec<RawInput>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawPackage {
    id: String,
    name: String,
    tier: Option<String>,
    basis: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawInput {
    kind: String,
    path: String,
    table: Option<String>,
    declare_crs: Option<String>,
    declare_crs_reason: Option<String>,
}

fn validate_manifest(raw: RawManifest, path: &Path) -> Result<PackageManifest, PackageError> {
    let display_path = path.display().to_string();
    validate_package_id(&raw.package.id, &display_path)?;
    validate_non_empty(&raw.package.name, "package.name", &display_path)?;
    let tier = raw
        .package
        .tier
        .as_deref()
        .map(|code| {
            Tier::from_code(code).ok_or_else(|| PackageError::Invalid {
                path: display_path.clone(),
                detail: format!("package.tier '{code}' is not one of T0, T1, T2, T3"),
            })
        })
        .transpose()?;
    if raw
        .package
        .basis
        .as_deref()
        .is_some_and(|basis| basis.trim().is_empty())
    {
        return Err(PackageError::Invalid {
            path: display_path,
            detail: "package.basis must be non-empty when present".into(),
        });
    }
    let display_path = path.display().to_string();
    if raw.inputs.is_empty() {
        return Err(PackageError::Invalid {
            path: display_path,
            detail: "inputs must contain at least one input".into(),
        });
    }

    let base = path.parent().unwrap_or_else(|| Path::new(""));
    let mut inputs = Vec::with_capacity(raw.inputs.len());
    let mut tables: HashMap<String, usize> = HashMap::new();
    for (idx, raw_input) in raw.inputs.into_iter().enumerate() {
        let field_prefix = format!("inputs[{idx}]");
        let kind = validate_kind(&raw_input.kind, &field_prefix, &display_path)?;
        validate_non_empty(
            &raw_input.path,
            &format!("{field_prefix}.path"),
            &display_path,
        )?;
        validate_kind_extension(kind, &raw_input.path, &field_prefix, &display_path)?;
        let source_path = resolve_manifest_path(base, &raw_input.path);
        let table = match raw_input.table {
            Some(table) => {
                validate_table_name(&table, &format!("{field_prefix}.table"), &display_path)?;
                table
            }
            None => table_name_from(
                &source_path,
                match kind {
                    InputKind::Raster => "raster",
                    InputKind::Vector => "features",
                },
            ),
        };
        if let Some(first_idx) = tables.insert(table.clone(), idx) {
            return Err(PackageError::Invalid {
                path: display_path,
                detail: format!(
                    "resolved table name collision: inputs[{first_idx}] and inputs[{idx}] both use table '{table}'; set table explicitly"
                ),
            });
        }
        let declared_epsg = validate_declared_crs(
            raw_input.declare_crs.as_deref(),
            &field_prefix,
            &display_path,
        )?;
        let reason = raw_input.declare_crs_reason;
        if declared_epsg.is_some() && reason.as_deref().map(str::trim).unwrap_or("").is_empty() {
            return Err(PackageError::Invalid {
                path: display_path,
                detail: format!(
                    "{field_prefix}.declare_crs_reason is required when declare_crs is present"
                ),
            });
        }
        if declared_epsg.is_none() && reason.is_some() {
            return Err(PackageError::Invalid {
                path: display_path,
                detail: format!("{field_prefix}.declare_crs_reason requires declare_crs"),
            });
        }
        if let Some(reason) = reason.as_deref() {
            if reason.trim().is_empty() {
                return Err(PackageError::Invalid {
                    path: display_path,
                    detail: format!("{field_prefix}.declare_crs_reason must be non-empty"),
                });
            }
        }
        inputs.push(PackageInput {
            kind,
            path: source_path,
            table,
            declared_epsg,
            declared_crs_reason: reason,
        });
    }

    Ok(PackageManifest {
        id: raw.package.id,
        name: raw.package.name,
        tier,
        basis: raw.package.basis,
        inputs,
    })
}

fn validate_non_empty(value: &str, field: &str, path: &str) -> Result<(), PackageError> {
    if value.trim().is_empty() {
        return Err(PackageError::Invalid {
            path: path.to_string(),
            detail: format!("{field} must be non-empty"),
        });
    }
    Ok(())
}

fn validate_package_id(id: &str, path: &str) -> Result<(), PackageError> {
    validate_non_empty(id, "package.id", path)?;
    let mut chars = id.chars();
    let Some(first) = chars.next() else {
        return Err(PackageError::Invalid {
            path: path.to_string(),
            detail: "package.id must be non-empty".into(),
        });
    };
    if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
        return Err(PackageError::Invalid {
            path: path.to_string(),
            detail: "package.id must match ^[a-z0-9][a-z0-9_-]*$".into(),
        });
    }
    if !chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-') {
        return Err(PackageError::Invalid {
            path: path.to_string(),
            detail: "package.id must match ^[a-z0-9][a-z0-9_-]*$".into(),
        });
    }
    Ok(())
}

fn validate_kind(kind: &str, field: &str, path: &str) -> Result<InputKind, PackageError> {
    match kind {
        "raster" => Ok(InputKind::Raster),
        "vector" => Ok(InputKind::Vector),
        other => Err(PackageError::Invalid {
            path: path.to_string(),
            detail: format!("{field}.kind '{other}' is not one of raster, vector"),
        }),
    }
}

fn validate_kind_extension(
    kind: InputKind,
    raw_path: &str,
    field: &str,
    path: &str,
) -> Result<(), PackageError> {
    let ext = Path::new(raw_path)
        .extension()
        .map(|ext| ext.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    let ok = match kind {
        InputKind::Raster => matches!(ext.as_str(), "tif" | "tiff"),
        InputKind::Vector => ext == "shp",
    };
    if !ok {
        return Err(PackageError::Invalid {
            path: path.to_string(),
            detail: format!(
                "{field}.kind/{field}.path extension mismatch: {} requires {}",
                match kind {
                    InputKind::Raster => "raster",
                    InputKind::Vector => "vector",
                },
                match kind {
                    InputKind::Raster => ".tif/.tiff",
                    InputKind::Vector => ".shp",
                }
            ),
        });
    }
    Ok(())
}

fn validate_table_name(table: &str, field: &str, path: &str) -> Result<(), PackageError> {
    let mut chars = table.chars();
    let Some(first) = chars.next() else {
        return Err(PackageError::Invalid {
            path: path.to_string(),
            detail: format!("{field} must match ^[a-z_][a-z0-9_]*$"),
        });
    };
    if !first.is_ascii_lowercase() && first != '_' {
        return Err(PackageError::Invalid {
            path: path.to_string(),
            detail: format!("{field} must match ^[a-z_][a-z0-9_]*$"),
        });
    }
    if !chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_') {
        return Err(PackageError::Invalid {
            path: path.to_string(),
            detail: format!("{field} must match ^[a-z_][a-z0-9_]*$"),
        });
    }
    Ok(())
}

fn validate_declared_crs(
    declared: Option<&str>,
    field: &str,
    path: &str,
) -> Result<Option<u32>, PackageError> {
    let Some(value) = declared else {
        return Ok(None);
    };
    let suffix = value.strip_prefix("EPSG:").unwrap_or("");
    if suffix.is_empty() || !suffix.chars().all(|c| c.is_ascii_digit()) {
        return Err(PackageError::Invalid {
            path: path.to_string(),
            detail: format!("{field}.declare_crs must match EPSG:<digits>"),
        });
    }
    suffix
        .parse::<u32>()
        .map(Some)
        .map_err(|_| PackageError::Invalid {
            path: path.to_string(),
            detail: format!("{field}.declare_crs must match EPSG:<digits>"),
        })
}

fn resolve_manifest_path(base: &Path, raw_path: &str) -> PathBuf {
    let source = PathBuf::from(raw_path);
    if source.is_absolute() {
        source
    } else {
        base.join(source)
    }
}

struct PreparedInput {
    path: PathBuf,
    table: String,
    declared_epsg: Option<u32>,
    declared_crs_reason: Option<String>,
    sha256: String,
    data: PreparedData,
}

enum PreparedData {
    Raster {
        raster: geotiff::RasterBand,
        crs: RasterCrs,
    },
    Vector {
        vector: shp::VectorLayer,
        crs_method: &'static str,
        sidecars: Map<String, Value>,
    },
}

impl PreparedInput {
    fn kind_name(&self) -> &'static str {
        match &self.data {
            PreparedData::Raster { .. } => "raster",
            PreparedData::Vector { .. } => "vector",
        }
    }

    fn table_extras(
        &self,
        basis: &str,
        package_id: &str,
        package_name: &str,
    ) -> Map<String, Value> {
        let mut extras = Map::new();
        extras.insert("classification_basis".into(), json!(basis));
        extras.insert("package_id".into(), json!(package_id));
        extras.insert("package_name".into(), json!(package_name));
        match &self.data {
            PreparedData::Raster { crs, .. } => {
                extras.insert(
                    "source".into(),
                    json!({ "file": file_name_of(&self.path), "sha256": &self.sha256 }),
                );
                extras.insert("native_crs".into(), json!(format!("EPSG:{}", crs.epsg())));
                extras.insert("crs_method".into(), json!(crs.method()));
            }
            PreparedData::Vector {
                vector,
                crs_method,
                sidecars,
            } => {
                extras.insert(
                    "source".into(),
                    json!({
                        "file": file_name_of(&self.path),
                        "sha256": &self.sha256,
                        "sidecars": sidecars,
                    }),
                );
                extras.insert(
                    "native_crs".into(),
                    json!(format!("EPSG:{}", vector.crs.epsg())),
                );
                extras.insert("crs_method".into(), json!(crs_method));
            }
        }
        extras
    }
}

fn prepare_inputs(manifest: &PackageManifest) -> Result<Vec<PreparedInput>, PackageError> {
    let mut prepared = Vec::with_capacity(manifest.inputs.len());
    for input in &manifest.inputs {
        let sha256 = sha256_hex(&input.path)?;
        let data = match input.kind {
            InputKind::Raster => {
                let raster = geotiff::read_geotiff(&input.path).map_err(IngestError::from)?;
                let crs = match (raster.epsg, input.declared_epsg) {
                    (Some(found), Some(declared)) if found != declared => {
                        return Err(PackageError::Ingest(IngestError::Invalid(format!(
                            "GeoTIFF declares EPSG:{found} but the operator declared EPSG:{declared}; \
                 a declaration is an escape hatch for missing CRSs, not an override — \
                 fix the declaration or re-export the source"
                        ))));
                    }
                    (Some(found), _) => RasterCrs::FromGeoKeys(found),
                    (None, Some(declared)) => RasterCrs::OperatorDeclared(declared),
                    (None, None) => {
                        return Err(PackageError::Ingest(IngestError::Invalid(format!(
                            "{}: no CRS in GeoKeys and no operator declaration — refusing to assume \
                 (declare one explicitly with declare_crs + declare_crs_reason)",
                            input.path.display()
                        ))));
                    }
                };
                PreparedData::Raster { raster, crs }
            }
            InputKind::Vector => {
                let vector = shp::read_shapefile(&input.path, input.declared_epsg)
                    .map_err(IngestError::from)?;
                let crs_method = match &vector.crs {
                    shp::CrsResolution::Identified { method, .. } => *method,
                    shp::CrsResolution::OperatorDeclared { .. } => "operator-declared",
                };
                let sidecars = shapefile_sidecars(&input.path)?;
                PreparedData::Vector {
                    vector,
                    crs_method,
                    sidecars,
                }
            }
        };
        prepared.push(PreparedInput {
            path: input.path.clone(),
            table: input.table.clone(),
            declared_epsg: input.declared_epsg,
            declared_crs_reason: input.declared_crs_reason.clone(),
            sha256,
            data,
        });
    }
    Ok(prepared)
}

fn verify_staged(
    staging: &Path,
    manifest: &PackageManifest,
    prepared: &[PreparedInput],
    tier: Tier,
) -> Result<(), PackageError> {
    let check = GeoPackage::open(staging).map_err(IngestError::from)?;
    let mut stmt = check
        .conn()
        .prepare(
            "SELECT table_name, data_type FROM gpkg_contents \
             WHERE data_type IN ('2d-gridded-coverage','features')",
        )
        .map_err(geobase_gpkg::GpkgError::from)
        .map_err(IngestError::from)?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(geobase_gpkg::GpkgError::from)
        .map_err(IngestError::from)?;
    let mut found = HashMap::new();
    for row in rows {
        let (table, data_type) = row
            .map_err(geobase_gpkg::GpkgError::from)
            .map_err(IngestError::from)?;
        found.insert(table, data_type);
    }
    if found.len() != manifest.inputs.len() {
        return Err(PackageError::Ingest(IngestError::Invalid(format!(
            "verification failed: expected {} content tables, found {}",
            manifest.inputs.len(),
            found.len()
        ))));
    }
    let expected_tables: HashSet<&str> =
        prepared.iter().map(|input| input.table.as_str()).collect();
    for input in prepared {
        match found.get(&input.table) {
            Some(data_type) if data_type == input_data_type(input) => {}
            Some(data_type) => {
                return Err(PackageError::Ingest(IngestError::Invalid(format!(
                    "verification failed: table '{}' has data_type '{data_type}', expected '{}'",
                    input.table,
                    input_data_type(input)
                ))));
            }
            None => {
                return Err(PackageError::Ingest(IngestError::Invalid(format!(
                    "verification failed: table '{}' missing from gpkg_contents",
                    input.table
                ))));
            }
        }
    }
    if found
        .keys()
        .any(|table| !expected_tables.contains(table.as_str()))
    {
        return Err(PackageError::Ingest(IngestError::Invalid(
            "verification failed: gpkg_contents has unexpected package data tables".into(),
        )));
    }
    let tags = check.read_tsdf_tags().map_err(IngestError::from)?;
    if tags.len() != manifest.inputs.len() + 1 {
        return Err(PackageError::Ingest(IngestError::Invalid(format!(
            "verification failed: expected {} TSDF tags, found {}",
            manifest.inputs.len() + 1,
            tags.len()
        ))));
    }
    if check.geopackage_tier().map_err(IngestError::from)? != Some(tier) {
        return Err(PackageError::Ingest(IngestError::Invalid(
            "verification failed: whole-artifact tier does not match the package tier".into(),
        )));
    }
    let trail = check.audit_trail().map_err(IngestError::from)?;
    if trail.len() < manifest.inputs.len() + 1 {
        return Err(PackageError::Ingest(IngestError::Invalid(format!(
            "verification failed: expected >= {} audit records, found {}",
            manifest.inputs.len() + 1,
            trail.len()
        ))));
    }
    Ok(())
}

fn input_data_type(input: &PreparedInput) -> &'static str {
    match &input.data {
        PreparedData::Raster { .. } => InputKind::Raster.gpkg_data_type(),
        PreparedData::Vector { .. } => InputKind::Vector.gpkg_data_type(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn rejects_missing_package_id() {
        assert_invalid(
            r#"
[package]
name = "Package"

[[inputs]]
kind = "vector"
path = "parcels.shp"
"#,
            "id",
        );
    }

    #[test]
    fn rejects_empty_package_id() {
        assert_invalid(
            r#"
[package]
id = " "
name = "Package"

[[inputs]]
kind = "vector"
path = "parcels.shp"
"#,
            "package.id",
        );
    }

    #[test]
    fn rejects_uppercase_package_id() {
        assert_invalid(
            base_manifest("Bad_id", "Package", "vector", "parcels.shp"),
            "package.id",
        );
    }

    #[test]
    fn rejects_leading_dash_package_id() {
        assert_invalid(
            base_manifest("-bad", "Package", "vector", "parcels.shp"),
            "package.id",
        );
    }

    #[test]
    fn rejects_missing_package_name() {
        assert_invalid(
            r#"
[package]
id = "pkg"

[[inputs]]
kind = "vector"
path = "parcels.shp"
"#,
            "name",
        );
    }

    #[test]
    fn rejects_unknown_tier_code() {
        assert_invalid(
            r#"
[package]
id = "pkg"
name = "Package"
tier = "T9"

[[inputs]]
kind = "vector"
path = "parcels.shp"
"#,
            "tier",
        );
    }

    #[test]
    fn rejects_empty_basis_when_present() {
        assert_invalid(
            r#"
[package]
id = "pkg"
name = "Package"
basis = " "

[[inputs]]
kind = "vector"
path = "parcels.shp"
"#,
            "basis",
        );
    }

    #[test]
    fn rejects_empty_inputs() {
        assert_invalid(
            r#"
inputs = []

[package]
id = "pkg"
name = "Package"
"#,
            "inputs",
        );
    }

    #[test]
    fn rejects_unknown_top_level_key() {
        assert_invalid(
            r#"
extra = "typo"

[package]
id = "pkg"
name = "Package"

[[inputs]]
kind = "vector"
path = "parcels.shp"
"#,
            "extra",
        );
    }

    #[test]
    fn rejects_unknown_input_key() {
        assert_invalid(
            r#"
[package]
id = "pkg"
name = "Package"

[[inputs]]
kind = "vector"
path = "parcels.shp"
extra = "typo"
"#,
            "extra",
        );
    }

    #[test]
    fn rejects_raster_kind_with_vector_extension() {
        assert_invalid(
            base_manifest("pkg", "Package", "raster", "parcels.shp"),
            "extension",
        );
    }

    #[test]
    fn rejects_vector_kind_with_raster_extension() {
        assert_invalid(
            base_manifest("pkg", "Package", "vector", "dem.tif"),
            "extension",
        );
    }

    #[test]
    fn rejects_explicit_table_collision() {
        assert_invalid(
            r#"
[package]
id = "pkg"
name = "Package"

[[inputs]]
kind = "vector"
path = "a.shp"
table = "same"

[[inputs]]
kind = "vector"
path = "b.shp"
table = "same"
"#,
            "collision",
        );
    }

    #[test]
    fn rejects_derived_table_collision_from_same_stem() {
        assert_invalid(
            r#"
[package]
id = "pkg"
name = "Package"

[[inputs]]
kind = "vector"
path = "one/parcels-small.shp"

[[inputs]]
kind = "vector"
path = "two/parcels small.shp"
"#,
            "collision",
        );
    }

    #[test]
    fn rejects_declared_crs_reason_without_declared_crs() {
        assert_invalid(
            r#"
[package]
id = "pkg"
name = "Package"

[[inputs]]
kind = "vector"
path = "parcels.shp"
declare_crs_reason = "operator knows"
"#,
            "declare_crs_reason",
        );
    }

    #[test]
    fn rejects_declared_crs_without_reason() {
        assert_invalid(
            r#"
[package]
id = "pkg"
name = "Package"

[[inputs]]
kind = "vector"
path = "parcels.shp"
declare_crs = "EPSG:26910"
"#,
            "declare_crs_reason",
        );
    }

    #[test]
    fn rejects_declared_crs_not_matching_epsg_digits() {
        assert_invalid(
            r#"
[package]
id = "pkg"
name = "Package"

[[inputs]]
kind = "vector"
path = "parcels.shp"
declare_crs = "EPSG:abc"
declare_crs_reason = "operator knows"
"#,
            "declare_crs",
        );
    }

    #[test]
    fn relative_input_path_resolves_against_manifest_parent() {
        let dir = temp_dir("manifest-relative");
        let manifest_path = dir.join("pkg.toml");
        fs::write(
            &manifest_path,
            base_manifest("pkg", "Package", "vector", "layers/parcels.shp"),
        )
        .unwrap();

        let manifest = load_manifest(&manifest_path).unwrap();

        assert_eq!(manifest.inputs[0].path, dir.join("layers/parcels.shp"));
    }

    #[test]
    fn package_two_vector_inputs_tags_and_rollup_metadata() {
        let dir = temp_dir("two-vector");
        let manifest_path = write_manifest(
            &dir,
            r#"
[package]
id = "vector-pack"
name = "Vector Pack"
tier = "T0"
basis = "fixture public"

[[inputs]]
kind = "vector"
path = "__PARCELS__"
table = "parcels_a"

[[inputs]]
kind = "vector"
path = "__PARCELS__"
table = "parcels_b"
"#,
        );
        let out = dir.join("pack.gpkg");

        let result = package(&PackageRequest {
            manifest: manifest_path,
            out: out.clone(),
            actor: "test".into(),
            overwrite: false,
        })
        .unwrap();

        assert_eq!(result.package_id, "vector-pack");
        assert_eq!(result.tier, Tier::T0);
        assert!(result.raster_tables.is_empty());
        assert_eq!(
            result
                .vector_tables
                .iter()
                .map(|table| table.table.as_str())
                .collect::<Vec<_>>(),
            vec!["parcels_a", "parcels_b"]
        );
        let gpkg = GeoPackage::open(&out).unwrap();
        let features: i64 = gpkg
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM gpkg_contents WHERE data_type = 'features'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(features, 2);
        let tags = gpkg.read_tsdf_tags().unwrap();
        assert_eq!(tags.len(), 3);
        assert_eq!(gpkg.geopackage_tier().unwrap(), Some(Tier::T0));
        assert!(gpkg.audit_trail().unwrap().len() >= 3);
        let rollup = tags
            .iter()
            .find(|tag| tag.scope == "geopackage")
            .expect("roll-up tag");
        assert_eq!(rollup.payload["package"]["id"], "vector-pack");
        assert_eq!(rollup.payload["package"]["name"], "Vector Pack");
        assert!(rollup.payload["manifest"]["sha256"].as_str().is_some());
    }

    #[test]
    fn package_mixed_raster_vector_preserves_write_order_and_counts() {
        let dir = temp_dir("mixed");
        let manifest_path = write_manifest(
            &dir,
            r#"
[package]
id = "mixed-pack"
name = "Mixed Pack"
tier = "T0"
basis = "fixture public"

[[inputs]]
kind = "vector"
path = "__PARCELS__"
table = "parcels"

[[inputs]]
kind = "raster"
path = "__DEM__"
table = "dem"
"#,
        );
        let out = dir.join("pack.gpkg");

        let result = package(&PackageRequest {
            manifest: manifest_path,
            out: out.clone(),
            actor: "test".into(),
            overwrite: false,
        })
        .unwrap();

        assert_eq!(result.raster_tables.len(), 1);
        assert_eq!(result.vector_tables.len(), 1);
        let gpkg = GeoPackage::open(&out).unwrap();
        let data_types = content_data_types(&gpkg);
        assert!(data_types.contains(&"2d-gridded-coverage".to_string()));
        assert!(data_types.contains(&"features".to_string()));
        let raster_rowid = content_rowid(&gpkg, "dem");
        let vector_rowid = content_rowid(&gpkg, "parcels");
        assert!(
            raster_rowid < vector_rowid,
            "raster content row must precede vector content row"
        );
        assert_eq!(gpkg.read_tsdf_tags().unwrap().len(), 3);
        assert_eq!(gpkg.audit_trail().unwrap().len(), 3);
    }

    #[test]
    fn package_omitted_tier_defaults_whole_artifact_to_t3() {
        let dir = temp_dir("default-tier");
        let manifest_path = write_manifest(
            &dir,
            r#"
[package]
id = "default-tier"
name = "Default Tier"

[[inputs]]
kind = "vector"
path = "__PARCELS__"
table = "parcels"
"#,
        );
        let out = dir.join("pack.gpkg");

        let result = package(&PackageRequest {
            manifest: manifest_path,
            out: out.clone(),
            actor: "test".into(),
            overwrite: false,
        })
        .unwrap();

        assert_eq!(result.tier, Tier::T3);
        let gpkg = GeoPackage::open(&out).unwrap();
        assert_eq!(gpkg.geopackage_tier().unwrap(), Some(Tier::T3));
    }

    #[test]
    fn package_refuses_overwrite_unless_forced() {
        let dir = temp_dir("overwrite");
        let manifest_path = write_manifest(
            &dir,
            r#"
[package]
id = "overwrite-pack"
name = "Overwrite Pack"
tier = "T0"
basis = "fixture public"

[[inputs]]
kind = "vector"
path = "__PARCELS__"
table = "parcels"
"#,
        );
        let out = dir.join("pack.gpkg");
        fs::write(&out, b"old").unwrap();

        let err = package(&PackageRequest {
            manifest: manifest_path.clone(),
            out: out.clone(),
            actor: "test".into(),
            overwrite: false,
        })
        .unwrap_err()
        .to_string();
        assert!(err.contains("overwrite") || err.contains("force"));
        assert_eq!(fs::read(&out).unwrap(), b"old");

        let result = package(&PackageRequest {
            manifest: manifest_path,
            out: out.clone(),
            actor: "test".into(),
            overwrite: true,
        })
        .unwrap();
        assert_eq!(result.package_id, "overwrite-pack");
        assert!(GeoPackage::open(&out).is_ok());
    }

    #[test]
    fn package_nonexistent_input_removes_staging_and_leaves_out_untouched() {
        let dir = temp_dir("missing-input");
        let manifest_path = dir.join("pkg.toml");
        fs::write(
            &manifest_path,
            r#"
[package]
id = "missing-input"
name = "Missing Input"
tier = "T0"
basis = "fixture public"

[[inputs]]
kind = "vector"
path = "missing.shp"
table = "missing"
"#,
        )
        .unwrap();
        let out = dir.join("pack.gpkg");
        fs::write(&out, b"old").unwrap();

        let err = package(&PackageRequest {
            manifest: manifest_path,
            out: out.clone(),
            actor: "test".into(),
            overwrite: true,
        })
        .unwrap_err()
        .to_string();

        assert!(err.contains("missing.shp") || err.contains("No such"));
        assert!(!staging_path_for(&out).exists());
        assert_eq!(fs::read(&out).unwrap(), b"old");
    }

    fn assert_invalid(raw: impl AsRef<str>, expected: &str) {
        let dir = temp_dir("manifest-invalid");
        let path = dir.join("pkg.toml");
        fs::write(&path, raw.as_ref()).unwrap();
        let err = load_manifest(&path).unwrap_err().to_string();
        assert!(
            err.contains(expected),
            "expected error containing {expected:?}, got {err:?}"
        );
    }

    fn base_manifest(id: &str, name: &str, kind: &str, input_path: &str) -> String {
        format!(
            r#"
[package]
id = "{id}"
name = "{name}"

[[inputs]]
kind = "{kind}"
path = "{input_path}"
"#
        )
    }

    fn write_manifest(dir: &Path, raw: &str) -> PathBuf {
        let manifest = raw
            .replace("__PARCELS__", &toml_path(&fixture("parcels_small.shp")))
            .replace("__DEM__", &toml_path(&fixture("dem_small.tif")));
        let path = dir.join("pkg.toml");
        fs::write(&path, manifest).unwrap();
        path
    }

    fn fixture(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../data/fixtures/geopack")
            .join(name)
    }

    fn toml_path(path: &Path) -> String {
        path.display().to_string().replace('\\', "/")
    }

    fn temp_dir(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("geobase-package-{label}-{nonce}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn content_data_types(gpkg: &GeoPackage) -> Vec<String> {
        let mut stmt = gpkg
            .conn()
            .prepare("SELECT data_type FROM gpkg_contents ORDER BY rowid")
            .unwrap();
        stmt.query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(|row| row.unwrap())
            .collect()
    }

    fn content_rowid(gpkg: &GeoPackage, table: &str) -> i64 {
        gpkg.conn()
            .query_row(
                "SELECT rowid FROM gpkg_contents WHERE table_name = ?1",
                [table],
                |r| r.get(0),
            )
            .unwrap()
    }
}
