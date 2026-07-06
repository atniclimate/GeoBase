//! # geobase-gpkg
//!
//! **Secure GeoPackage** handling — GeoBase's on-disk container for datasets.
//!
//! A GeoPackage is a SQLite database. GeoBase extends it with:
//! - TSDF classification in standard `gpkg_metadata` tables (tier, framework
//!   version, provenance) so **classification travels with the artifact**,
//! - an **append-only audit trail** (`geobase_audit`), enforced by SQLite
//!   triggers — mechanism, not convention,
//! - (Phase 1.2) at-rest encryption for T3 (`.sgpkg`), providing the
//!   *architectural egress guarantee* that T3 data cannot be read off-node.
//!
//! The TSDF tag payload schema is shared with `scripts/make_t0_baseline.py`
//! (the Phase 0.2 sketch): artifacts written by either implementation read
//! identically from both. `TSDF_METADATA_URI` is the discriminator.

pub mod ceremony;
pub mod raster;
pub mod vector;

use std::path::{Path, PathBuf};

use geobase_tsdf::Tier;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// `md_standard_uri` identifying TSDF classification rows in `gpkg_metadata`.
/// Must match `scripts/make_t0_baseline.py::TSDF_URI` — one schema, two writers.
pub const TSDF_METADATA_URI: &str = "https://github.com/atniclimate/TieredSovereignDataFramework";

/// GeoPackage `PRAGMA application_id` magic: "GPKG".
const GPKG_APPLICATION_ID: u32 = 0x4750_4B47;
/// Legacy magics ("GP10"/"GP11") still accepted on open.
const GPKG_LEGACY_IDS: [u32; 2] = [0x4750_3130, 0x4750_3131];
/// GeoPackage 1.2.0 `PRAGMA user_version` for files we create.
const GPKG_USER_VERSION: u32 = 10200;

/// Core tables every GeoPackage must carry (spec Req. 10/13) plus the two
/// required `gpkg_spatial_ref_sys` fallbacks and WGS 84.
const GPKG_BASE_DDL: &str = "
CREATE TABLE IF NOT EXISTS gpkg_spatial_ref_sys (
  srs_name TEXT NOT NULL,
  srs_id INTEGER PRIMARY KEY,
  organization TEXT NOT NULL,
  organization_coordsys_id INTEGER NOT NULL,
  definition TEXT NOT NULL,
  description TEXT
);
CREATE TABLE IF NOT EXISTS gpkg_contents (
  table_name TEXT NOT NULL PRIMARY KEY,
  data_type TEXT NOT NULL,
  identifier TEXT UNIQUE,
  description TEXT DEFAULT '',
  last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE,
  srs_id INTEGER,
  CONSTRAINT fk_gc_r_srs_id FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id)
);
INSERT OR IGNORE INTO gpkg_spatial_ref_sys VALUES
 ('Undefined Cartesian SRS', -1, 'NONE', -1, 'undefined',
  'undefined Cartesian coordinate reference system'),
 ('Undefined geographic SRS', 0, 'NONE', 0, 'undefined',
  'undefined geographic coordinate reference system'),
 ('WGS 84 geodetic', 4326, 'EPSG', 4326,
  'GEOGCS[\"WGS 84\",DATUM[\"WGS_1984\",SPHEROID[\"WGS 84\",6378137,298.257223563,AUTHORITY[\"EPSG\",\"7030\"]],AUTHORITY[\"EPSG\",\"6326\"]],PRIMEM[\"Greenwich\",0,AUTHORITY[\"EPSG\",\"8901\"]],UNIT[\"degree\",0.0174532925199433,AUTHORITY[\"EPSG\",\"9122\"]],AUTHORITY[\"EPSG\",\"4326\"]]',
  'longitude/latitude coordinates in decimal degrees on the WGS 84 spheroid');
";

/// Metadata extension tables — byte-for-byte the schema written by
/// `make_t0_baseline.py::METADATA_DDL`, plus the GeoBase audit table.
/// The audit trail is append-only **by trigger**: UPDATE and DELETE abort.
const GEOBASE_EXT_DDL: &str = "
CREATE TABLE IF NOT EXISTS gpkg_metadata (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  md_scope TEXT NOT NULL DEFAULT 'dataset',
  md_standard_uri TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'text/xml',
  metadata TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS gpkg_metadata_reference (
  reference_scope TEXT NOT NULL,
  table_name TEXT,
  column_name TEXT,
  row_id_value INTEGER,
  timestamp DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  md_file_id INTEGER NOT NULL,
  md_parent_id INTEGER,
  CONSTRAINT crmr_mfi_fk FOREIGN KEY (md_file_id) REFERENCES gpkg_metadata(id),
  CONSTRAINT crmr_mpi_fk FOREIGN KEY (md_parent_id) REFERENCES gpkg_metadata(id)
);
CREATE TABLE IF NOT EXISTS gpkg_extensions (
  table_name TEXT,
  column_name TEXT,
  extension_name TEXT NOT NULL,
  definition TEXT NOT NULL,
  scope TEXT NOT NULL,
  CONSTRAINT ge_tce UNIQUE (table_name, column_name, extension_name)
);
CREATE TABLE IF NOT EXISTS geobase_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  tsdf_version TEXT NOT NULL,
  tsdf_source_origin TEXT NOT NULL,
  timestamp DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  details TEXT NOT NULL DEFAULT '{}'
);
CREATE TRIGGER IF NOT EXISTS geobase_audit_no_update
BEFORE UPDATE ON geobase_audit
BEGIN SELECT RAISE(ABORT, 'geobase_audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS geobase_audit_no_delete
BEFORE DELETE ON geobase_audit
BEGIN SELECT RAISE(ABORT, 'geobase_audit is append-only'); END;
";

/// An open GeoPackage. Wraps the SQLite connection; all TSDF tagging and
/// audit writes go through this handle so the invariants hold in one place.
pub struct GeoPackage {
    conn: Connection,
    path: PathBuf,
}

/// A TSDF classification to attach to a table (or to the whole artifact).
#[derive(Debug, Clone)]
pub struct TsdfTag {
    /// `Some(table)` tags one table; `None` tags the whole GeoPackage
    /// (the roll-up scope — by convention the most restrictive tier present).
    pub table: Option<String>,
    pub tier: Tier,
    /// TSDF framework version in force at classification time.
    pub tsdf_version: String,
    /// Origin of the tier model, e.g. `"vendored:embedded"` (see `TsdfSource::origin`).
    pub tsdf_source_origin: String,
    /// Who (or what process) classified — recorded verbatim in the artifact.
    pub classified_by: String,
    /// Additional payload fields (classification_basis, source hash, native_crs…).
    pub extras: Map<String, Value>,
}

/// A TSDF tag read back from an artifact.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredTsdfTag {
    /// `"geopackage"` or `"table"`.
    pub scope: String,
    /// Table the tag applies to; `None` for geopackage scope.
    pub table: Option<String>,
    pub tier: Tier,
    pub tsdf_version: String,
    /// The full JSON payload as written (all fields, including extras).
    pub payload: Value,
}

/// One audit action to record. `timestamp` and `id` are assigned by the store.
#[derive(Debug, Clone)]
pub struct AuditEntry {
    pub dataset_id: String,
    pub action: String,
    pub actor: String,
    pub tsdf_version: String,
    pub tsdf_source_origin: String,
    pub details: Value,
}

/// A committed audit record, as read back from the trail.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditRecord {
    pub id: i64,
    pub dataset_id: String,
    pub action: String,
    pub actor: String,
    pub tsdf_version: String,
    pub tsdf_source_origin: String,
    pub timestamp: String,
    pub details: Value,
}

/// Whether data at `tier` must be encrypted at rest (`.sgpkg`). T3's
/// architectural egress guarantee begins here (mechanism lands Phase 1.2).
pub fn requires_encryption(tier: Tier) -> bool {
    matches!(tier, Tier::T3)
}

impl GeoPackage {
    /// Create a new, empty, spec-conformant GeoPackage. Fails if `path`
    /// already exists — callers decide explicitly whether to replace.
    pub fn create(path: &Path) -> Result<GeoPackage, GpkgError> {
        if path.exists() {
            return Err(GpkgError::AlreadyExists(path.display().to_string()));
        }
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
            }
        }
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "application_id", GPKG_APPLICATION_ID)?;
        conn.pragma_update(None, "user_version", GPKG_USER_VERSION)?;
        conn.execute_batch(GPKG_BASE_DDL)?;
        let gpkg = GeoPackage {
            conn,
            path: path.to_path_buf(),
        };
        gpkg.ensure_geobase_tables()?;
        Ok(gpkg)
    }

    /// Open an existing GeoPackage, verifying it actually is one
    /// (application_id magic + `gpkg_contents` present). Never assumes.
    pub fn open(path: &Path) -> Result<GeoPackage, GpkgError> {
        if !path.is_file() {
            return Err(GpkgError::NotAGeoPackage {
                path: path.display().to_string(),
                detail: "file does not exist".into(),
            });
        }
        let conn = Connection::open(path)?;
        let app_id: u32 =
            conn.query_row("SELECT * FROM pragma_application_id()", [], |r| r.get(0))?;
        if app_id != GPKG_APPLICATION_ID && !GPKG_LEGACY_IDS.contains(&app_id) {
            return Err(GpkgError::NotAGeoPackage {
                path: path.display().to_string(),
                detail: format!("application_id 0x{app_id:08X} is not a GeoPackage magic"),
            });
        }
        let has_contents: Option<String> = conn
            .query_row(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='gpkg_contents'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        if has_contents.is_none() {
            return Err(GpkgError::NotAGeoPackage {
                path: path.display().to_string(),
                detail: "missing required table gpkg_contents".into(),
            });
        }
        Ok(GeoPackage {
            conn,
            path: path.to_path_buf(),
        })
    }

    /// Path this GeoPackage was opened from.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Low-level access for writers that add feature/tile tables (the
    /// ingestor). Invariant-relevant writes (tags, audit) must still go
    /// through the typed methods on this handle.
    pub fn conn(&self) -> &Connection {
        &self.conn
    }

    /// Create the metadata-extension tables, extension registrations, and the
    /// audit table if absent. Idempotent; safe on artifacts written by GDAL.
    pub fn ensure_geobase_tables(&self) -> Result<(), GpkgError> {
        self.conn.execute_batch(GEOBASE_EXT_DDL)?;
        for table in ["gpkg_metadata", "gpkg_metadata_reference"] {
            // NOT EXISTS instead of INSERT OR IGNORE: column_name is NULL
            // here, and SQLite treats NULLs as distinct in UNIQUE
            // constraints, so OR IGNORE would duplicate on every call.
            self.conn.execute(
                "INSERT INTO gpkg_extensions \
                 (table_name, column_name, extension_name, definition, scope) \
                 SELECT ?1, NULL, 'gpkg_metadata', \
                 'http://www.geopackage.org/spec121/#extension_metadata', 'read-write' \
                 WHERE NOT EXISTS (SELECT 1 FROM gpkg_extensions \
                 WHERE table_name = ?1 AND column_name IS NULL \
                 AND extension_name = 'gpkg_metadata')",
                [table],
            )?;
        }
        Ok(())
    }

    /// Register an SRS in `gpkg_spatial_ref_sys` (INSERT OR IGNORE — the
    /// spec-required rows and any previously registered SRS are preserved).
    /// `definition` should be the source WKT when available; otherwise the
    /// curated [`known_epsg_wkt`] table is consulted, and an SRS that is in
    /// neither is refused — a definition the viewer stack can't parse would
    /// violate the CRS-discipline invariant downstream, not here.
    pub fn ensure_srs(&self, epsg: u32, definition: Option<&str>) -> Result<(), GpkgError> {
        let wkt = match definition {
            Some(d) if !d.trim().is_empty() => d.to_string(),
            _ => known_epsg_wkt(epsg).ok_or_else(|| {
                GpkgError::Invalid(format!(
                    "EPSG:{epsg} has no source WKT and is not in the curated SRS table — \
                     cannot write a definition the viewer stack can parse"
                ))
            })?,
        };
        self.conn.execute(
            "INSERT OR IGNORE INTO gpkg_spatial_ref_sys \
             (srs_name, srs_id, organization, organization_coordsys_id, definition) \
             VALUES (?1, ?2, 'EPSG', ?2, ?3)",
            rusqlite::params![format!("EPSG:{epsg}"), epsg, wkt],
        )?;
        Ok(())
    }

    /// UTC now in ISO-8601 (seconds precision), from SQLite — one clock for
    /// everything written into the artifact, no extra time dependency.
    pub fn utc_now(&self) -> Result<String, GpkgError> {
        Ok(self
            .conn
            .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now')", [], |r| {
                r.get(0)
            })?)
    }

    /// Write one TSDF classification tag. Returns the `gpkg_metadata` row id.
    ///
    /// Payload schema is shared with the Python sketch: `tier`,
    /// `tsdf_version`, `tsdf_source_origin`, `classified_on`, `classified_by`,
    /// then extras. A `table` tag uses reference scope `"table"`; a whole-
    /// artifact tag uses `"geopackage"` with NULL table.
    pub fn write_tsdf_tag(&self, tag: &TsdfTag) -> Result<i64, GpkgError> {
        self.ensure_geobase_tables()?;
        if tag.table.is_some() {
            let basis = tag
                .extras
                .get("classification_basis")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            if basis.is_empty() {
                return Err(GpkgError::Invalid(
                    "table-scope TSDF tag missing non-empty classification_basis".into(),
                ));
            }
            let sha256 = tag
                .extras
                .get("source")
                .and_then(Value::as_object)
                .and_then(|source| source.get("sha256"))
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            if sha256.is_empty() {
                return Err(GpkgError::Invalid(
                    "table-scope TSDF tag missing source.sha256".into(),
                ));
            }
        }
        let mut payload = Map::new();
        payload.insert("tier".into(), Value::String(tag.tier.code().to_string()));
        payload.insert(
            "tsdf_version".into(),
            Value::String(tag.tsdf_version.clone()),
        );
        payload.insert(
            "tsdf_source_origin".into(),
            Value::String(tag.tsdf_source_origin.clone()),
        );
        payload.insert("classified_on".into(), Value::String(self.utc_now()?));
        payload.insert(
            "classified_by".into(),
            Value::String(tag.classified_by.clone()),
        );
        for (k, v) in &tag.extras {
            payload.insert(k.clone(), v.clone());
        }
        self.conn.execute(
            "INSERT INTO gpkg_metadata (md_scope, md_standard_uri, mime_type, metadata) \
             VALUES ('dataset', ?1, 'application/json', ?2)",
            rusqlite::params![TSDF_METADATA_URI, Value::Object(payload).to_string()],
        )?;
        let md_id = self.conn.last_insert_rowid();
        let scope = if tag.table.is_none() {
            "geopackage"
        } else {
            "table"
        };
        self.conn.execute(
            "INSERT INTO gpkg_metadata_reference (reference_scope, table_name, md_file_id) \
             VALUES (?1, ?2, ?3)",
            rusqlite::params![scope, tag.table, md_id],
        )?;
        Ok(md_id)
    }

    /// Read every TSDF tag in the artifact (any writer — Rust or Python).
    pub fn read_tsdf_tags(&self) -> Result<Vec<StoredTsdfTag>, GpkgError> {
        let mut stmt = self.conn.prepare(
            "SELECT r.reference_scope, r.table_name, m.metadata \
             FROM gpkg_metadata m \
             JOIN gpkg_metadata_reference r ON r.md_file_id = m.id \
             WHERE m.md_standard_uri = ?1 \
             ORDER BY m.id",
        )?;
        let rows = stmt.query_map([TSDF_METADATA_URI], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        let mut tags = Vec::new();
        for row in rows {
            let (scope, table, raw) = row?;
            let payload: Value = serde_json::from_str(&raw)?;
            let tier_code = payload
                .get("tier")
                .and_then(Value::as_str)
                .ok_or_else(|| GpkgError::Invalid("TSDF tag payload missing 'tier'".into()))?;
            let tier = Tier::from_code(tier_code).ok_or_else(|| {
                GpkgError::Invalid(format!("TSDF tag has unknown tier code '{tier_code}'"))
            })?;
            let tsdf_version = payload
                .get("tsdf_version")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    GpkgError::Invalid("TSDF tag payload missing 'tsdf_version'".into())
                })?
                .to_string();
            tags.push(StoredTsdfTag {
                scope,
                table,
                tier,
                tsdf_version,
                payload,
            });
        }
        Ok(tags)
    }

    /// The whole-artifact tier: the most restrictive tier across all TSDF tags.
    /// A geopackage-scope roll-up tag may raise the effective tier, never lower
    /// it below a more restrictive table tag.
    pub fn geopackage_tier(&self) -> Result<Option<Tier>, GpkgError> {
        let tags = self.read_tsdf_tags()?;
        Ok(tags.iter().map(|t| t.tier).max())
    }

    /// Append one audit record. The trail is append-only by trigger; the
    /// returned id is the committed row.
    pub fn append_audit(&self, entry: &AuditEntry) -> Result<i64, GpkgError> {
        self.ensure_geobase_tables()?;
        self.conn.execute(
            "INSERT INTO geobase_audit \
             (dataset_id, action, actor, tsdf_version, tsdf_source_origin, details) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                entry.dataset_id,
                entry.action,
                entry.actor,
                entry.tsdf_version,
                entry.tsdf_source_origin,
                entry.details.to_string(),
            ],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    /// The full audit trail, oldest first.
    pub fn audit_trail(&self) -> Result<Vec<AuditRecord>, GpkgError> {
        let has_table: Option<String> = self
            .conn
            .query_row(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='geobase_audit'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        if has_table.is_none() {
            return Ok(Vec::new());
        }
        let mut stmt = self.conn.prepare(
            "SELECT id, dataset_id, action, actor, tsdf_version, tsdf_source_origin, \
             timestamp, details FROM geobase_audit ORDER BY id",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, String>(7)?,
            ))
        })?;
        let mut records = Vec::new();
        for row in rows {
            let (
                id,
                dataset_id,
                action,
                actor,
                tsdf_version,
                tsdf_source_origin,
                timestamp,
                raw_details,
            ) = row?;
            let details = serde_json::from_str(&raw_details).map_err(|e| {
                GpkgError::Invalid(format!("audit row id {id} has corrupt details JSON: {e}"))
            })?;
            records.push(AuditRecord {
                id,
                dataset_id,
                action,
                actor,
                tsdf_version,
                tsdf_source_origin,
                timestamp,
                details,
            });
        }
        Ok(records)
    }
}

const WGS84_GEOGCS: &str = r#"GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4326"]]"#;

const NAD83_GEOGCS: &str = r#"GEOGCS["NAD83",DATUM["North_American_Datum_1983",SPHEROID["GRS 1980",6378137,298.257222101,AUTHORITY["EPSG","7019"]],AUTHORITY["EPSG","6269"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4269"]]"#;

/// WKT1 definition for the curated set of EPSG codes GeoBase writes without
/// a source WKT: the geographic bases (4326, 4269), web mercator (3857),
/// and northern-hemisphere UTM zones on NAD83 (26901–26923) and WGS 84
/// (32601–32660). Every string carries its root AUTHORITY node so GDAL/
/// pyproj resolve it to the exact EPSG code (semantic CRS equality in the
/// CI oracle depends on this). Anything else returns `None` — callers must
/// supply source WKT or reject.
pub fn known_epsg_wkt(epsg: u32) -> Option<String> {
    fn utm_north(geogcs: &str, datum_label: &str, zone: u32, epsg: u32) -> String {
        let central_meridian = zone as i32 * 6 - 183;
        format!(
            r#"PROJCS["{datum_label} / UTM zone {zone}N",{geogcs},PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",{central_meridian}],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",0],UNIT["metre",1,AUTHORITY["EPSG","9001"]],AXIS["Easting",EAST],AXIS["Northing",NORTH],AUTHORITY["EPSG","{epsg}"]]"#
        )
    }
    match epsg {
        4326 => Some(WGS84_GEOGCS.to_string()),
        4269 => Some(NAD83_GEOGCS.to_string()),
        3857 => Some(format!(
            r#"PROJCS["WGS 84 / Pseudo-Mercator",{WGS84_GEOGCS},PROJECTION["Mercator_1SP"],PARAMETER["central_meridian",0],PARAMETER["scale_factor",1],PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1,AUTHORITY["EPSG","9001"]],AXIS["Easting",EAST],AXIS["Northing",NORTH],EXTENSION["PROJ4","+proj=merc +a=6378137 +b=6378137 +lat_ts=0.0 +lon_0=0.0 +x_0=0.0 +y_0=0 +k=1.0 +units=m +nadgrids=@null +wktext +no_defs"],AUTHORITY["EPSG","3857"]]"#
        )),
        26901..=26923 => Some(utm_north(NAD83_GEOGCS, "NAD83", epsg - 26900, epsg)),
        32601..=32660 => Some(utm_north(WGS84_GEOGCS, "WGS 84", epsg - 32600, epsg)),
        _ => None,
    }
}

/// Errors from secure GeoPackage operations.
#[derive(Debug, thiserror::Error)]
pub enum GpkgError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("metadata payload error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("refusing to overwrite existing file: {0}")]
    AlreadyExists(String),
    #[error("not a GeoPackage: {path}: {detail}")]
    NotAGeoPackage { path: String, detail: String },
    #[error("invalid artifact: {0}")]
    Invalid(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_gpkg(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("geobase-gpkg-tests");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        let _ = std::fs::remove_file(&path);
        path
    }

    fn t0_tag(table: Option<&str>) -> TsdfTag {
        TsdfTag {
            table: table.map(String::from),
            tier: Tier::T0,
            tsdf_version: "0.9.4".into(),
            tsdf_source_origin: "vendored:embedded".into(),
            classified_by: "test".into(),
            extras: Map::new(),
        }
    }

    fn compliant_table_extras() -> Map<String, Value> {
        let mut extras = Map::new();
        extras.insert(
            "classification_basis".into(),
            Value::String("test basis".into()),
        );
        extras.insert(
            "source".into(),
            serde_json::json!({"file": "fixture", "sha256": "abc123"}),
        );
        extras
    }

    #[test]
    fn create_then_open_roundtrip() {
        let path = temp_gpkg("roundtrip.gpkg");
        GeoPackage::create(&path).unwrap();
        let gpkg = GeoPackage::open(&path).unwrap();
        assert_eq!(gpkg.path(), path);
    }

    #[test]
    fn create_refuses_to_overwrite() {
        let path = temp_gpkg("no-overwrite.gpkg");
        GeoPackage::create(&path).unwrap();
        assert!(matches!(
            GeoPackage::create(&path),
            Err(GpkgError::AlreadyExists(_))
        ));
    }

    #[test]
    fn open_rejects_non_gpkg_sqlite() {
        let path = temp_gpkg("plain.sqlite");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE t (x)").unwrap();
        drop(conn);
        assert!(matches!(
            GeoPackage::open(&path),
            Err(GpkgError::NotAGeoPackage { .. })
        ));
    }

    #[test]
    fn tsdf_tag_write_read_roundtrip_matches_python_schema() {
        let path = temp_gpkg("tags.gpkg");
        let gpkg = GeoPackage::create(&path).unwrap();
        let mut extras = compliant_table_extras();
        extras.insert("native_crs".into(), Value::String("EPSG:26910".into()));
        gpkg.write_tsdf_tag(&TsdfTag {
            table: Some("dem".into()),
            tier: Tier::T2,
            extras,
            ..t0_tag(None)
        })
        .unwrap();
        gpkg.write_tsdf_tag(&t0_tag(None)).unwrap();

        let tags = gpkg.read_tsdf_tags().unwrap();
        assert_eq!(tags.len(), 2);
        let table_tag = &tags[0];
        assert_eq!(table_tag.scope, "table");
        assert_eq!(table_tag.table.as_deref(), Some("dem"));
        assert_eq!(table_tag.tier, Tier::T2);
        // Exactly the Python payload schema.
        for key in [
            "tier",
            "tsdf_version",
            "tsdf_source_origin",
            "classified_on",
            "classified_by",
            "classification_basis",
            "native_crs",
            "source",
        ] {
            assert!(table_tag.payload.get(key).is_some(), "missing key {key}");
        }
        assert_eq!(tags[1].scope, "geopackage");
    }

    #[test]
    fn table_scope_tsdf_tag_requires_provenance() {
        let path = temp_gpkg("tag-provenance.gpkg");
        let gpkg = GeoPackage::create(&path).unwrap();
        let err = gpkg
            .write_tsdf_tag(&TsdfTag {
                table: Some("dem".into()),
                tier: Tier::T1,
                ..t0_tag(None)
            })
            .unwrap_err();
        assert!(err.to_string().contains("classification_basis"));

        let mut extras = Map::new();
        extras.insert("classification_basis".into(), Value::String("basis".into()));
        let err = gpkg
            .write_tsdf_tag(&TsdfTag {
                table: Some("dem".into()),
                tier: Tier::T1,
                extras,
                ..t0_tag(None)
            })
            .unwrap_err();
        assert!(err.to_string().contains("source.sha256"));
    }

    #[test]
    fn geopackage_tier_is_most_restrictive_across_all_tags() {
        let path = temp_gpkg("tier.gpkg");
        let gpkg = GeoPackage::create(&path).unwrap();
        assert_eq!(gpkg.geopackage_tier().unwrap(), None);

        gpkg.write_tsdf_tag(&TsdfTag {
            table: Some("a".into()),
            tier: Tier::T3,
            extras: compliant_table_extras(),
            ..t0_tag(None)
        })
        .unwrap();
        gpkg.write_tsdf_tag(&TsdfTag {
            tier: Tier::T2,
            ..t0_tag(None)
        })
        .unwrap();
        // Roll-up T2 may not lower a table-scope T3.
        assert_eq!(gpkg.geopackage_tier().unwrap(), Some(Tier::T3));

        let path = temp_gpkg("tier-rollup-raises.gpkg");
        let gpkg = GeoPackage::create(&path).unwrap();
        gpkg.write_tsdf_tag(&TsdfTag {
            table: Some("a".into()),
            tier: Tier::T0,
            extras: compliant_table_extras(),
            ..t0_tag(None)
        })
        .unwrap();
        gpkg.write_tsdf_tag(&TsdfTag {
            table: Some("b".into()),
            tier: Tier::T0,
            extras: compliant_table_extras(),
            ..t0_tag(None)
        })
        .unwrap();
        gpkg.write_tsdf_tag(&TsdfTag {
            tier: Tier::T3,
            ..t0_tag(None)
        })
        .unwrap();
        // Roll-up T3 raises the package above T0 tables.
        assert_eq!(gpkg.geopackage_tier().unwrap(), Some(Tier::T3));
    }

    #[test]
    fn audit_trail_appends_and_reads_back() {
        let path = temp_gpkg("audit.gpkg");
        let gpkg = GeoPackage::create(&path).unwrap();
        let id = gpkg
            .append_audit(&AuditEntry {
                dataset_id: "demo".into(),
                action: "ingest".into(),
                actor: "test".into(),
                tsdf_version: "0.9.4".into(),
                tsdf_source_origin: "vendored:embedded".into(),
                details: serde_json::json!({"source": "fixture.shp"}),
            })
            .unwrap();
        assert_eq!(id, 1);
        let trail = gpkg.audit_trail().unwrap();
        assert_eq!(trail.len(), 1);
        assert_eq!(trail[0].action, "ingest");
        assert_eq!(trail[0].details["source"], "fixture.shp");
        assert!(!trail[0].timestamp.is_empty());
    }

    #[test]
    fn audit_trail_is_append_only_by_trigger() {
        let path = temp_gpkg("append-only.gpkg");
        let gpkg = GeoPackage::create(&path).unwrap();
        gpkg.append_audit(&AuditEntry {
            dataset_id: "demo".into(),
            action: "ingest".into(),
            actor: "test".into(),
            tsdf_version: "0.9.4".into(),
            tsdf_source_origin: "vendored:embedded".into(),
            details: Value::Null,
        })
        .unwrap();
        let update = gpkg
            .conn()
            .execute("UPDATE geobase_audit SET action='tampered' WHERE id=1", []);
        assert!(update.is_err(), "UPDATE must be rejected by trigger");
        let delete = gpkg.conn().execute("DELETE FROM geobase_audit", []);
        assert!(delete.is_err(), "DELETE must be rejected by trigger");
    }

    #[test]
    fn audit_trail_rejects_corrupt_details_json() {
        let path = temp_gpkg("audit-corrupt.gpkg");
        let gpkg = GeoPackage::create(&path).unwrap();
        gpkg.conn()
            .execute(
                "INSERT INTO geobase_audit
                 (dataset_id, action, actor, tsdf_version, tsdf_source_origin, details)
                 VALUES ('demo', 'ingest', 'test', '0.9.4', 'vendored:embedded', '{')",
                [],
            )
            .unwrap();
        let err = gpkg.audit_trail().unwrap_err();
        assert!(err.to_string().contains("audit row id 1"));
    }

    #[test]
    fn t3_requires_encryption_at_rest() {
        assert!(requires_encryption(Tier::T3));
        assert!(!requires_encryption(Tier::T0));
        assert!(!requires_encryption(Tier::T2));
    }
}
