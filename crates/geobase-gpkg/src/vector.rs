//! GPKG **feature table** writer.
//!
//! Takes pre-encoded GeoPackage geometry BLOBs (the ingestor encodes via
//! `geozero`; this module never touches WKB internals) and writes a
//! spec-conformant vector layer:
//!
//! - `gpkg_spatial_ref_sys` row for the layer SRS (INSERT OR IGNORE;
//!   definition = the source's WKT when available, else `EPSG:<code>`
//!   placeholder text),
//! - `gpkg_geometry_columns` (created if absent; z = 0, m = 0),
//! - `gpkg_contents` row with `data_type = 'features'` and layer bounds,
//! - the feature table itself: `id INTEGER PRIMARY KEY AUTOINCREMENT`,
//!   `geom BLOB`, then attribute columns in declared order.
//!
//! Table names are validated against `^[A-Za-z_][A-Za-z0-9_]*$` before any
//! SQL interpolation (identifiers can't be bound as parameters).

use rusqlite::params_from_iter;
use rusqlite::types::Value as SqlValue;
use rusqlite::OptionalExtension;

use crate::{GeoPackage, GpkgError};

/// Declaration of one attribute column.
#[derive(Debug, Clone)]
pub struct ColumnDef {
    pub name: String,
    /// GPKG SQL type: "TEXT", "INTEGER", or "REAL".
    pub sql_type: &'static str,
}

/// Everything needed to create a conformant feature table.
#[derive(Debug, Clone)]
pub struct FeatureTableSpec {
    pub table: String,
    /// `gpkg_contents.identifier` (human-readable).
    pub identifier: String,
    /// EPSG code; becomes `srs_id` and `organization_coordsys_id`.
    pub srs_epsg: u32,
    /// SRS definition WKT (source `.prj` when available).
    pub srs_definition: Option<String>,
    /// Uppercase GPKG geometry type name (e.g. "POLYGON").
    pub geometry_type: String,
    pub columns: Vec<ColumnDef>,
    /// (min_x, min_y, max_x, max_y) for `gpkg_contents`.
    pub bounds: (f64, f64, f64, f64),
}

/// Create the feature table and all registry rows. Fails if the table
/// already exists (GeoPacks are built from scratch; no silent merging).
pub fn create_feature_table(gpkg: &GeoPackage, spec: &FeatureTableSpec) -> Result<(), GpkgError> {
    validate_identifier(&spec.table)?;
    validate_identifier("geom")?;
    for column in &spec.columns {
        validate_identifier(&column.name)?;
        validate_sql_type(column.sql_type)?;
    }
    if spec
        .columns
        .iter()
        .any(|c| c.name == "id" || c.name == "geom")
    {
        return Err(GpkgError::Invalid(
            "feature attribute columns may not be named 'id' or 'geom'".into(),
        ));
    }
    if !spec.bounds.0.is_finite()
        || !spec.bounds.1.is_finite()
        || !spec.bounds.2.is_finite()
        || !spec.bounds.3.is_finite()
        || spec.bounds.0 > spec.bounds.2
        || spec.bounds.1 > spec.bounds.3
    {
        return Err(GpkgError::Invalid(format!(
            "feature table '{}': invalid bounds {:?}",
            spec.table, spec.bounds
        )));
    }

    let conn = gpkg.conn();
    let existing: Option<String> = conn
        .query_row(
            "SELECT name FROM sqlite_master WHERE type='table' AND name = ?1",
            [&spec.table],
            |r| r.get(0),
        )
        .optional()?;
    if existing.is_some() {
        return Err(GpkgError::Invalid(format!(
            "table '{}' already exists in this GeoPackage - GeoPacks build from scratch",
            spec.table
        )));
    }

    let wkt = match spec.srs_definition.as_deref() {
        Some(d) if !d.trim().is_empty() => d.to_string(),
        _ => crate::known_epsg_wkt(spec.srs_epsg).ok_or_else(|| {
            GpkgError::Invalid(format!(
                "EPSG:{} has no source WKT and is not in the curated SRS table — \
                 cannot write a definition the viewer stack can parse",
                spec.srs_epsg
            ))
        })?,
    };
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT OR IGNORE INTO gpkg_spatial_ref_sys
         (srs_name, srs_id, organization, organization_coordsys_id, definition)
         VALUES (?1, ?2, 'EPSG', ?2, ?3)",
        rusqlite::params![format!("EPSG:{}", spec.srs_epsg), spec.srs_epsg, wkt],
    )?;
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS gpkg_geometry_columns (
           table_name TEXT NOT NULL,
           column_name TEXT NOT NULL,
           geometry_type_name TEXT NOT NULL,
           srs_id INTEGER NOT NULL,
           z TINYINT NOT NULL,
           m TINYINT NOT NULL,
           CONSTRAINT pk_geom_cols PRIMARY KEY (table_name, column_name),
           CONSTRAINT uk_gc_table_name UNIQUE (table_name),
           CONSTRAINT fk_gc_tn FOREIGN KEY (table_name) REFERENCES gpkg_contents(table_name),
           CONSTRAINT fk_gc_srs FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id)
         );",
    )?;

    let mut column_sql = String::new();
    for column in &spec.columns {
        column_sql.push_str(&format!(", \"{}\" {}", column.name, column.sql_type));
    }
    tx.execute(
        &format!(
            "CREATE TABLE \"{}\" (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               geom BLOB NOT NULL{}
             )",
            spec.table, column_sql
        ),
        [],
    )?;
    tx.execute(
        "INSERT INTO gpkg_contents
         (table_name, data_type, identifier, min_x, min_y, max_x, max_y, srs_id)
         VALUES (?1, 'features', ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![
            spec.table,
            spec.identifier,
            spec.bounds.0,
            spec.bounds.1,
            spec.bounds.2,
            spec.bounds.3,
            i64::from(spec.srs_epsg),
        ],
    )?;
    tx.execute(
        "INSERT INTO gpkg_geometry_columns
         (table_name, column_name, geometry_type_name, srs_id, z, m)
         VALUES (?1, 'geom', ?2, ?3, 0, 0)",
        rusqlite::params![spec.table, spec.geometry_type, i64::from(spec.srs_epsg)],
    )?;
    tx.commit()?;
    Ok(())
}

/// Insert one feature (pre-encoded GPKG geometry BLOB + attributes in
/// `spec.columns` order). Returns the new row id.
pub fn insert_feature(
    gpkg: &GeoPackage,
    table: &str,
    geom_blob: &[u8],
    attrs: &[SqlValue],
) -> Result<i64, GpkgError> {
    validate_identifier(table)?;
    let conn = gpkg.conn();
    let columns = feature_columns(conn, table)?;
    if columns.len() != attrs.len() {
        return Err(GpkgError::Invalid(format!(
            "feature insert into '{table}' has {} attributes but table declares {}",
            attrs.len(),
            columns.len()
        )));
    }
    let mut names = String::from("geom");
    let mut placeholders = String::from("?1");
    for (idx, column) in columns.iter().enumerate() {
        names.push_str(&format!(", \"{column}\""));
        placeholders.push_str(&format!(", ?{}", idx + 2));
    }
    let mut values = Vec::with_capacity(attrs.len() + 1);
    values.push(SqlValue::Blob(geom_blob.to_vec()));
    values.extend_from_slice(attrs);
    conn.execute(
        &format!("INSERT INTO \"{table}\" ({names}) VALUES ({placeholders})"),
        params_from_iter(values),
    )?;
    Ok(conn.last_insert_rowid())
}

fn feature_columns(conn: &rusqlite::Connection, table: &str) -> Result<Vec<String>, GpkgError> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info(\"{table}\")"))?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?;
    let mut columns = Vec::new();
    for row in rows {
        let (name, ty) = row?;
        if name != "id" && name != "geom" {
            validate_identifier(&name)?;
            validate_sql_type(&ty)?;
            columns.push(name);
        }
    }
    Ok(columns)
}

fn validate_identifier(identifier: &str) -> Result<(), GpkgError> {
    let mut chars = identifier.chars();
    let Some(first) = chars.next() else {
        return Err(GpkgError::Invalid("empty SQL identifier".into()));
    };
    if !(first == '_' || first.is_ascii_alphabetic())
        || !chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
    {
        return Err(GpkgError::Invalid(format!(
            "invalid SQL identifier '{identifier}'"
        )));
    }
    Ok(())
}

fn validate_sql_type(sql_type: &str) -> Result<(), GpkgError> {
    match sql_type {
        "TEXT" | "INTEGER" | "REAL" => Ok(()),
        other => Err(GpkgError::Invalid(format!(
            "unsupported feature column SQL type '{other}'"
        ))),
    }
}
