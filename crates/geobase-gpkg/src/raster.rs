//! GPKG **2d-gridded-coverage** writer — the conformance-critical center of
//! the GeoPack pipeline (OGC 17-066r1). Every rule below came out of the
//! 2026-07-06 adversarial design review (docs/DECISIONS.md) and is load-
//! bearing; deviations are exactly the historical interop breakages.
//!
//! ## Structure written (all inside one transaction)
//!
//! 1. `gpkg_spatial_ref_sys` row via [`GeoPackage::ensure_srs`].
//! 2. `gpkg_contents`: `data_type = '2d-gridded-coverage'` (never `tiles`),
//!    bounds = the **data** extent, srs_id = the layer SRS.
//! 3. `gpkg_tile_matrix_set`: bounds = the **tile-aligned** extent —
//!    anchored at (`origin.x`, `origin.y`) upper-left, padded on the
//!    right/bottom to whole tiles. The spec equation must hold *exactly*:
//!    `max_x - min_x == matrix_width * tile_width * pixel_x_size` (same in
//!    Y). Contents bounds ⊆ tile-matrix-set bounds is what makes partial
//!    edge tiles legal.
//! 4. `gpkg_tile_matrix`: one row, `zoom_level = 0`, matrix/tile sizes and
//!    the pixel sizes (native resolution only — no overview pyramid in
//!    Phase 0.3; adding zoom levels later must follow power-of-two or
//!    register `gpkg_zoom_other`).
//! 5. The tile pyramid table `(id, zoom_level, tile_column, tile_row,
//!    tile_data, UNIQUE(zoom_level, tile_column, tile_row))`; `tile_row 0`
//!    is the **top** row (tile (0,0) sits at (`min_x`, `max_y`)).
//! 6. `gpkg_2d_gridded_coverage_ancillary`: one row — `datatype = 'float'`,
//!    `scale = 1.0` and `offset = 0.0` **exactly** (conformance tests fail
//!    otherwise), `data_null = spec.data_null`,
//!    `grid_cell_encoding = 'grid-value-is-area'` (matches corner-anchored
//!    origin math and GeoTIFF PixelIsArea).
//! 7. `gpkg_2d_gridded_tile_ancillary`: one row **per tile**, `tpudt_name` =
//!    the tile table, `tpudt_id` = that tile's actual row id, per-tile
//!    min/max computed **excluding** `data_null` (NULL when the tile is all
//!    null).
//! 8. Three `gpkg_extensions` rows, extension_name
//!    `gpkg_2d_gridded_coverage`, definition
//!    `http://docs.opengeospatial.org/is/17-066r1/17-066r1.html`, scope
//!    `read-write`: for `gpkg_2d_gridded_coverage_ancillary`,
//!    `gpkg_2d_gridded_tile_ancillary`, and (`<table>`, column
//!    `tile_data`).
//!
//! ## Tile blob encoding
//!
//! Each `tile_data` BLOB is a complete little-endian TIFF: **one image,
//! one sample per pixel, Float32, strip-organized (no internal TIFF
//! tiling), uncompressed** (`tiff` crate `Gray32Float`). `Int16` input is
//! widened losslessly to `f32` so there is exactly one encoder path
//! (`datatype` stays `'float'`). Missing cells — NoData in the source and
//! all padding in partial edge tiles — are written as `data_null`, **never
//! NaN/Inf** (the extension forbids special float values). If the source
//! contains NoData/NaN or any edge tile needs padding and `data_null` is
//! `None`, the write must fail with a message telling the operator to
//! supply one.
//!
//! Table names are validated (`^[A-Za-z_][A-Za-z0-9_]*$`) before SQL
//! interpolation; an existing table of the same name is an error (GeoPacks
//! build from scratch — no silent merging).

use rusqlite::{params, OptionalExtension};

use crate::{GeoPackage, GpkgError};

/// OGC 17-066r1 `gpkg_extensions.extension_name` for gridded coverages.
const EXTENSION_NAME: &str = "gpkg_2d_gridded_coverage";

/// OGC 17-066r1 `gpkg_extensions.definition` for gridded coverages.
const EXTENSION_DEFINITION: &str = "http://docs.opengeospatial.org/is/17-066r1/17-066r1.html";

/// Shared (create-if-absent) DDL: `gpkg_extensions` (byte-identical to the
/// lib.rs schema), the tile-matrix core tables (GeoPackage 1.2 Annex C), and
/// the two OGC 17-066r1 ancillary tables. `"offset"` is quoted because
/// OFFSET is an SQL keyword; the stored column name is identical either way.
const COVERAGE_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS gpkg_extensions (
  table_name TEXT,
  column_name TEXT,
  extension_name TEXT NOT NULL,
  definition TEXT NOT NULL,
  scope TEXT NOT NULL,
  CONSTRAINT ge_tce UNIQUE (table_name, column_name, extension_name)
);
CREATE TABLE IF NOT EXISTS gpkg_tile_matrix_set (
  table_name TEXT NOT NULL PRIMARY KEY,
  srs_id INTEGER NOT NULL,
  min_x DOUBLE NOT NULL,
  min_y DOUBLE NOT NULL,
  max_x DOUBLE NOT NULL,
  max_y DOUBLE NOT NULL,
  CONSTRAINT fk_gtms_table_name FOREIGN KEY (table_name) REFERENCES gpkg_contents(table_name),
  CONSTRAINT fk_gtms_srs FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id)
);
CREATE TABLE IF NOT EXISTS gpkg_tile_matrix (
  table_name TEXT NOT NULL,
  zoom_level INTEGER NOT NULL,
  matrix_width INTEGER NOT NULL,
  matrix_height INTEGER NOT NULL,
  tile_width INTEGER NOT NULL,
  tile_height INTEGER NOT NULL,
  pixel_x_size DOUBLE NOT NULL,
  pixel_y_size DOUBLE NOT NULL,
  CONSTRAINT pk_ttm PRIMARY KEY (table_name, zoom_level),
  CONSTRAINT fk_tmm_table_name FOREIGN KEY (table_name) REFERENCES gpkg_contents(table_name)
);
CREATE TABLE IF NOT EXISTS gpkg_2d_gridded_coverage_ancillary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tile_matrix_set_name TEXT NOT NULL UNIQUE,
  datatype TEXT NOT NULL DEFAULT 'integer',
  scale REAL NOT NULL DEFAULT 1.0,
  "offset" REAL NOT NULL DEFAULT 0.0,
  precision REAL DEFAULT 1.0,
  data_null REAL,
  grid_cell_encoding TEXT DEFAULT 'grid-value-is-center',
  uom TEXT,
  field_name TEXT DEFAULT 'Height',
  quantity_definition TEXT DEFAULT 'Height',
  CONSTRAINT fk_g2dgtct_name FOREIGN KEY (tile_matrix_set_name)
    REFERENCES gpkg_tile_matrix_set(table_name)
);
CREATE TABLE IF NOT EXISTS gpkg_2d_gridded_tile_ancillary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tpudt_name TEXT NOT NULL,
  tpudt_id INTEGER NOT NULL,
  scale REAL NOT NULL DEFAULT 1.0,
  "offset" REAL NOT NULL DEFAULT 0.0,
  min REAL,
  max REAL,
  mean REAL,
  std_dev REAL,
  CONSTRAINT fk_g2dgtat_name FOREIGN KEY (tpudt_name) REFERENCES gpkg_contents(table_name),
  UNIQUE (tpudt_name, tpudt_id)
);
"#;

/// Declaration of a gridded coverage to write.
#[derive(Debug, Clone)]
pub struct RasterCoverageSpec {
    pub table: String,
    /// `gpkg_contents.identifier` (human-readable).
    pub identifier: String,
    /// EPSG code for the native CRS.
    pub srs_epsg: u32,
    /// Source WKT if the reader had one (else the curated table serves).
    pub srs_definition: Option<String>,
    pub width: u32,
    pub height: u32,
    /// (x, y) pixel size in CRS units, both positive (north-up).
    pub pixel_size: (f64, f64),
    /// Upper-left corner of the upper-left pixel.
    pub origin: (f64, f64),
    /// Tile edge in pixels (256 in production; small in tests).
    pub tile_size: u16,
    /// Value written for missing cells (source NoData and edge padding).
    /// Required whenever any cell is missing or any padding occurs.
    pub data_null: Option<f64>,
}

/// Source samples, row-major, top-left origin, `width * height` long.
#[derive(Debug, Clone, Copy)]
pub enum CoverageData<'a> {
    F32(&'a [f32]),
    I16(&'a [i16]),
}

/// What was written — consumed by ingest verification and audit details.
#[derive(Debug, Clone, PartialEq)]
pub struct CoverageStats {
    pub tiles_written: u32,
    pub matrix_width: u32,
    pub matrix_height: u32,
    /// Tile-aligned extent written to `gpkg_tile_matrix_set`, as
    /// `(min_x, min_y, max_x, max_y)`.
    pub tile_matrix_bounds: (f64, f64, f64, f64),
    /// Data extent written to `gpkg_contents`, as
    /// `(min_x, min_y, max_x, max_y)`.
    pub data_bounds: (f64, f64, f64, f64),
    /// Min/max across valid (non-null) cells; `None` if all cells null.
    pub min: Option<f64>,
    pub max: Option<f64>,
    /// Cells that carried the NoData value (source NoData; excludes padding).
    /// NaN source cells are treated as missing, substituted with `data_null`
    /// in the tiles, and included in this count — so the count equals the
    /// number of non-padding `data_null` cells verification will find.
    pub nodata_cells: u64,
}

/// Write one gridded coverage per the module contract. All-or-nothing:
/// runs in a transaction; any failure leaves the GeoPackage unchanged.
pub fn write_gridded_coverage(
    gpkg: &GeoPackage,
    spec: &RasterCoverageSpec,
    data: CoverageData<'_>,
) -> Result<CoverageStats, GpkgError> {
    validate_spec(spec, data)?;

    let conn = gpkg.conn();
    let existing: Option<String> = conn
        .query_row(
            "SELECT name FROM sqlite_master WHERE name = ?1",
            [&spec.table],
            |r| r.get(0),
        )
        .optional()?;
    if existing.is_some() {
        return Err(GpkgError::Invalid(format!(
            "table '{}' already exists in this GeoPackage — GeoPacks build from \
             scratch, refusing to merge into or replace an existing table",
            spec.table
        )));
    }

    // Grid geometry — everything in f64, exactly as the module docs state.
    let tile_span = u32::from(spec.tile_size);
    let matrix_width = spec.width.div_ceil(tile_span);
    let matrix_height = spec.height.div_ceil(tile_span);
    let tiles_written = matrix_width.checked_mul(matrix_height).ok_or_else(|| {
        GpkgError::Invalid(format!(
            "coverage '{}': tile matrix {matrix_width}x{matrix_height} overflows",
            spec.table
        ))
    })?;
    let (px, py) = spec.pixel_size;
    let data_min_x = spec.origin.0;
    let data_max_y = spec.origin.1;
    let data_max_x = data_min_x + f64::from(spec.width) * px;
    let data_min_y = data_max_y - f64::from(spec.height) * py;
    // Tile-aligned extent: anchored at the origin (upper-left), padded on
    // the right/bottom so `max_x - min_x == matrix_width * tile_width * px`.
    let tms_max_x = data_min_x + f64::from(matrix_width) * f64::from(spec.tile_size) * px;
    let tms_min_y = data_max_y - f64::from(matrix_height) * f64::from(spec.tile_size) * py;
    let data_bounds = (data_min_x, data_min_y, data_max_x, data_max_y);
    let tile_matrix_bounds = (data_min_x, tms_min_y, tms_max_x, data_max_y);

    // One transaction for everything, DDL included (DDL is transactional in
    // SQLite): any error below rolls back to an untouched GeoPackage.
    let tx = conn.unchecked_transaction()?;
    gpkg.ensure_srs(spec.srs_epsg, spec.srs_definition.as_deref())?;
    tx.execute_batch(COVERAGE_DDL)?;
    tx.execute(
        &format!(
            "CREATE TABLE \"{}\" (\
               id INTEGER PRIMARY KEY AUTOINCREMENT, \
               zoom_level INTEGER NOT NULL, \
               tile_column INTEGER NOT NULL, \
               tile_row INTEGER NOT NULL, \
               tile_data BLOB NOT NULL, \
               UNIQUE (zoom_level, tile_column, tile_row))",
            spec.table
        ),
        [],
    )?;
    tx.execute(
        "INSERT INTO gpkg_contents \
         (table_name, data_type, identifier, min_x, min_y, max_x, max_y, srs_id) \
         VALUES (?1, '2d-gridded-coverage', ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            spec.table,
            spec.identifier,
            data_min_x,
            data_min_y,
            data_max_x,
            data_max_y,
            i64::from(spec.srs_epsg),
        ],
    )?;
    tx.execute(
        "INSERT INTO gpkg_tile_matrix_set (table_name, srs_id, min_x, min_y, max_x, max_y) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            spec.table,
            i64::from(spec.srs_epsg),
            data_min_x,
            tms_min_y,
            tms_max_x,
            data_max_y,
        ],
    )?;
    tx.execute(
        "INSERT INTO gpkg_tile_matrix \
         (table_name, zoom_level, matrix_width, matrix_height, tile_width, tile_height, \
          pixel_x_size, pixel_y_size) \
         VALUES (?1, 0, ?2, ?3, ?4, ?4, ?5, ?6)",
        params![
            spec.table,
            i64::from(matrix_width),
            i64::from(matrix_height),
            i64::from(spec.tile_size),
            px,
            py,
        ],
    )?;
    tx.execute(
        "INSERT INTO gpkg_2d_gridded_coverage_ancillary \
         (tile_matrix_set_name, datatype, scale, \"offset\", data_null, grid_cell_encoding) \
         VALUES (?1, 'float', 1.0, 0.0, ?2, 'grid-value-is-area')",
        params![spec.table, spec.data_null],
    )?;
    for ancillary_table in [
        "gpkg_2d_gridded_coverage_ancillary",
        "gpkg_2d_gridded_tile_ancillary",
    ] {
        // NOT EXISTS, not OR IGNORE: column_name is NULL and SQLite treats
        // NULLs as distinct in UNIQUE constraints, so OR IGNORE would
        // duplicate these rows when a pack carries a second coverage.
        tx.execute(
            "INSERT INTO gpkg_extensions \
             (table_name, column_name, extension_name, definition, scope) \
             SELECT ?1, NULL, ?2, ?3, 'read-write' \
             WHERE NOT EXISTS (SELECT 1 FROM gpkg_extensions \
             WHERE table_name = ?1 AND column_name IS NULL AND extension_name = ?2)",
            params![ancillary_table, EXTENSION_NAME, EXTENSION_DEFINITION],
        )?;
    }
    tx.execute(
        "INSERT INTO gpkg_extensions \
         (table_name, column_name, extension_name, definition, scope) \
         VALUES (?1, 'tile_data', ?2, ?3, 'read-write')",
        params![spec.table, EXTENSION_NAME, EXTENSION_DEFINITION],
    )?;

    let mut nodata_cells = 0u64;
    let mut coverage_min: Option<f64> = None;
    let mut coverage_max: Option<f64> = None;
    {
        let mut tile_stmt = tx.prepare(&format!(
            "INSERT INTO \"{}\" (zoom_level, tile_column, tile_row, tile_data) \
             VALUES (0, ?1, ?2, ?3)",
            spec.table
        ))?;
        let mut ancillary_stmt = tx.prepare(
            "INSERT INTO gpkg_2d_gridded_tile_ancillary \
             (tpudt_name, tpudt_id, scale, \"offset\", min, max, mean, std_dev) \
             VALUES (?1, ?2, 1.0, 0.0, ?3, ?4, NULL, NULL)",
        )?;
        // tile_row 0 is the TOP row: tile (0,0) sits at (min_x, max_y).
        for tile_row in 0..matrix_height {
            for tile_col in 0..matrix_width {
                let tile = fill_tile(spec, data, tile_col, tile_row)?;
                nodata_cells += tile.nodata;
                coverage_min = fold_extreme(coverage_min, tile.min, f64::min);
                coverage_max = fold_extreme(coverage_max, tile.max, f64::max);
                let blob = encode_tile(&tile.cells, spec.tile_size)?;
                // tpudt_id must be the actual rowid from the tile INSERT.
                let tile_id =
                    tile_stmt.insert(params![i64::from(tile_col), i64::from(tile_row), blob])?;
                ancillary_stmt.execute(params![spec.table, tile_id, tile.min, tile.max])?;
            }
        }
    }
    tx.commit()?;

    Ok(CoverageStats {
        tiles_written,
        matrix_width,
        matrix_height,
        tile_matrix_bounds,
        data_bounds,
        min: coverage_min,
        max: coverage_max,
        nodata_cells,
    })
}

/// Reject structurally invalid specs before touching the database.
fn validate_spec(spec: &RasterCoverageSpec, data: CoverageData<'_>) -> Result<(), GpkgError> {
    if !is_valid_table_name(&spec.table) {
        return Err(GpkgError::Invalid(format!(
            "table name '{}' is invalid — must match ^[A-Za-z_][A-Za-z0-9_]*$",
            spec.table
        )));
    }
    if spec.width == 0 || spec.height == 0 {
        return Err(GpkgError::Invalid(format!(
            "coverage '{}': width and height must be non-zero (got {}x{})",
            spec.table, spec.width, spec.height
        )));
    }
    if spec.tile_size == 0 {
        return Err(GpkgError::Invalid(format!(
            "coverage '{}': tile_size must be non-zero",
            spec.table
        )));
    }
    let (px, py) = spec.pixel_size;
    if !px.is_finite() || !py.is_finite() || px <= 0.0 || py <= 0.0 {
        return Err(GpkgError::Invalid(format!(
            "coverage '{}': pixel sizes must be finite and positive (got {px}, {py})",
            spec.table
        )));
    }
    if !spec.origin.0.is_finite() || !spec.origin.1.is_finite() {
        return Err(GpkgError::Invalid(format!(
            "coverage '{}': origin must be finite",
            spec.table
        )));
    }
    if let Some(null) = spec.data_null {
        if !null.is_finite() {
            return Err(GpkgError::Invalid(format!(
                "coverage '{}': data_null must be finite — the 2d-gridded-coverage \
                 extension forbids NaN/Inf",
                spec.table
            )));
        }
    }
    let expected = u64::from(spec.width) * u64::from(spec.height);
    let actual = match data {
        CoverageData::F32(v) => v.len() as u64,
        CoverageData::I16(v) => v.len() as u64,
    };
    if actual != expected {
        return Err(GpkgError::Invalid(format!(
            "coverage '{}': data length {actual} != width*height {expected}",
            spec.table
        )));
    }
    Ok(())
}

/// `^[A-Za-z_][A-Za-z0-9_]*$` — checked before any SQL interpolation.
fn is_valid_table_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// One tile's cell buffer plus its ancillary statistics.
struct TileBuffer {
    /// `tile_size * tile_size` samples, row-major, missing cells already
    /// substituted with `data_null` — never NaN.
    cells: Vec<f32>,
    /// Min over valid cells (excludes `data_null` and padding); `None` if
    /// the tile is all null.
    min: Option<f64>,
    /// Max over valid cells; `None` if the tile is all null.
    max: Option<f64>,
    /// Source cells in this tile that were missing (NoData value or NaN).
    /// Padding cells are not counted.
    nodata: u64,
}

/// Assemble one tile: copy the source window, substitute `data_null` for
/// missing cells (source NoData value, source NaN) and for right/bottom
/// padding, and track valid-cell min/max. Fails if any substitution is
/// needed while `spec.data_null` is `None`.
fn fill_tile(
    spec: &RasterCoverageSpec,
    data: CoverageData<'_>,
    tile_col: u32,
    tile_row: u32,
) -> Result<TileBuffer, GpkgError> {
    let tile_span = usize::from(spec.tile_size);
    let width = spec.width as usize;
    let height = spec.height as usize;
    let x0 = tile_col as usize * tile_span;
    let y0 = tile_row as usize * tile_span;
    let mut cells = vec![0.0f32; tile_span * tile_span];
    let mut min: Option<f64> = None;
    let mut max: Option<f64> = None;
    let mut nodata = 0u64;
    for y in 0..tile_span {
        let src_y = y0 + y;
        for x in 0..tile_span {
            let src_x = x0 + x;
            let value = if src_x < width && src_y < height {
                let v = sample(data, src_y * width + src_x);
                if v.is_nan() {
                    // NaN in the source is missing data; the extension
                    // forbids writing it, so it becomes data_null.
                    nodata += 1;
                    null_value(spec)?
                } else if spec.data_null == Some(f64::from(v)) {
                    nodata += 1;
                    null_value(spec)?
                } else {
                    let vd = f64::from(v);
                    min = Some(min.map_or(vd, |m| m.min(vd)));
                    max = Some(max.map_or(vd, |m| m.max(vd)));
                    v
                }
            } else {
                // Right/bottom padding of a partial edge tile.
                null_value(spec)?
            };
            cells[y * tile_span + x] = value;
        }
    }
    Ok(TileBuffer {
        cells,
        min,
        max,
        nodata,
    })
}

/// One source sample as `f32`; `i16` widens losslessly (every `i16` is
/// exactly representable in `f32`), keeping a single encoder path.
fn sample(data: CoverageData<'_>, index: usize) -> f32 {
    match data {
        CoverageData::F32(v) => v[index],
        CoverageData::I16(v) => f32::from(v[index]),
    }
}

/// The value written for a missing cell — or the contract-mandated error
/// when the operator supplied no `data_null`.
fn null_value(spec: &RasterCoverageSpec) -> Result<f32, GpkgError> {
    match spec.data_null {
        Some(null) => Ok(null as f32),
        None => Err(GpkgError::Invalid(format!(
            "coverage '{}': source NoData/NaN cells or partial edge tiles require a \
             data_null value and none was supplied — set RasterCoverageSpec::data_null \
             (the 2d-gridded-coverage extension forbids NaN/Inf in tile data)",
            spec.table
        ))),
    }
}

/// Fold a per-tile extreme into the coverage-wide accumulator.
fn fold_extreme(acc: Option<f64>, tile: Option<f64>, pick: fn(f64, f64) -> f64) -> Option<f64> {
    match (acc, tile) {
        (Some(a), Some(b)) => Some(pick(a, b)),
        (Some(a), None) => Some(a),
        (None, b) => b,
    }
}

/// Encode one tile as a complete little-endian TIFF blob: one image,
/// Gray32Float, strip-organized (the encoder default — never its tiled
/// layout), uncompressed (the encoder default).
fn encode_tile(cells: &[f32], tile_size: u16) -> Result<Vec<u8>, GpkgError> {
    let mut cursor = std::io::Cursor::new(Vec::new());
    {
        let mut encoder = tiff::encoder::TiffEncoder::new(&mut cursor)
            .map_err(|e| GpkgError::Invalid(format!("tile TIFF encoder init failed: {e}")))?;
        encoder
            .write_image::<tiff::encoder::colortype::Gray32Float>(
                u32::from(tile_size),
                u32::from(tile_size),
                cells,
            )
            .map_err(|e| GpkgError::Invalid(format!("tile TIFF encoding failed: {e}")))?;
    }
    Ok(cursor.into_inner())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn temp_gpkg(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("geobase-gpkg-raster-tests");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        let _ = std::fs::remove_file(&path);
        path
    }

    /// 0.5 CRS-units per pixel, upper-left origin (100, 200), UTM 10N.
    fn spec(table: &str, width: u32, height: u32, data_null: Option<f64>) -> RasterCoverageSpec {
        RasterCoverageSpec {
            table: table.into(),
            identifier: format!("{table} coverage"),
            srs_epsg: 32610,
            srs_definition: None,
            width,
            height,
            pixel_size: (0.5, 0.5),
            origin: (100.0, 200.0),
            tile_size: 4,
            data_null,
        }
    }

    fn decode_tile(blob: &[u8]) -> (u32, u32, Vec<f32>) {
        let mut decoder = tiff::decoder::Decoder::new(std::io::Cursor::new(blob)).unwrap();
        let (w, h) = decoder.dimensions().unwrap();
        assert_eq!(decoder.colortype().unwrap(), tiff::ColorType::Gray(32));
        match decoder.read_image().unwrap() {
            tiff::decoder::DecodingResult::F32(cells) => (w, h, cells),
            _ => panic!("tile did not decode as F32"),
        }
    }

    /// 10x6 F32 source, values 1..=60, with one NaN and five -9999 NoData
    /// cells; tile (2,1) — the bottom-right partial tile — is all null.
    fn fixture_10x6() -> Vec<f32> {
        let mut src: Vec<f32> = (1..=60).map(|v| v as f32).collect();
        src[3] = f32::NAN; // row 0, col 3
        for i in [10usize, 48, 49, 58, 59] {
            src[i] = -9999.0; // row1/col0 plus all four data cells of tile (2,1)
        }
        src
    }

    #[test]
    fn float_coverage_end_to_end() {
        let path = temp_gpkg("float-e2e.gpkg");
        let gpkg = GeoPackage::create(&path).unwrap();
        let src = fixture_10x6();
        let stats = write_gridded_coverage(
            &gpkg,
            &spec("dem", 10, 6, Some(-9999.0)),
            CoverageData::F32(&src),
        )
        .unwrap();

        // Stats written faithfully.
        assert_eq!(stats.matrix_width, 3);
        assert_eq!(stats.matrix_height, 2);
        assert_eq!(stats.tiles_written, 6);
        assert_eq!(stats.data_bounds, (100.0, 197.0, 105.0, 200.0));
        assert_eq!(stats.tile_matrix_bounds, (100.0, 196.0, 106.0, 200.0));
        assert_eq!(stats.min, Some(1.0));
        assert_eq!(stats.max, Some(58.0));
        assert_eq!(stats.nodata_cells, 6); // 5 x -9999 + 1 NaN, padding excluded

        let conn = gpkg.conn();

        // gpkg_contents: 2d-gridded-coverage, bounds == DATA extent.
        let (data_type, min_x, min_y, max_x, max_y, srs_id): (String, f64, f64, f64, f64, i64) =
            conn.query_row(
                "SELECT data_type, min_x, min_y, max_x, max_y, srs_id \
                 FROM gpkg_contents WHERE table_name = 'dem'",
                [],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(data_type, "2d-gridded-coverage");
        assert_eq!((min_x, min_y, max_x, max_y), stats.data_bounds);
        assert_eq!(srs_id, 32610);

        // gpkg_tile_matrix_set: the spec equation holds exactly.
        let (t_min_x, t_min_y, t_max_x, t_max_y): (f64, f64, f64, f64) = conn
            .query_row(
                "SELECT min_x, min_y, max_x, max_y FROM gpkg_tile_matrix_set \
                 WHERE table_name = 'dem'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            (t_min_x, t_min_y, t_max_x, t_max_y),
            stats.tile_matrix_bounds
        );
        assert_eq!(t_max_x - t_min_x, 3.0 * 4.0 * 0.5);
        assert_eq!(t_max_y - t_min_y, 2.0 * 4.0 * 0.5);

        // gpkg_tile_matrix: one zoom-0 row with the native resolution.
        let (mw, mh, tw, th, pxs, pys): (i64, i64, i64, i64, f64, f64) = conn
            .query_row(
                "SELECT matrix_width, matrix_height, tile_width, tile_height, \
                 pixel_x_size, pixel_y_size FROM gpkg_tile_matrix \
                 WHERE table_name = 'dem' AND zoom_level = 0",
                [],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!((mw, mh, tw, th), (3, 2, 4, 4));
        assert_eq!((pxs, pys), (0.5, 0.5));

        // Per-tile ancillary rows join the tile rowids 1:1.
        let tile_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM \"dem\"", [], |r| r.get(0))
            .unwrap();
        assert_eq!(tile_count, 6);
        let joined: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM \"dem\" t \
                 JOIN gpkg_2d_gridded_tile_ancillary a \
                 ON a.tpudt_name = 'dem' AND a.tpudt_id = t.id",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(joined, 6);
        let ancillary_total: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM gpkg_2d_gridded_tile_ancillary",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(ancillary_total, 6);
        // scale/offset exactly 1/0 on every tile row; mean/std_dev NULL.
        let nonconformant: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM gpkg_2d_gridded_tile_ancillary \
                 WHERE scale != 1.0 OR \"offset\" != 0.0 \
                 OR mean IS NOT NULL OR std_dev IS NOT NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(nonconformant, 0);

        // Per-tile min/max exclude data_null; all-null tile stores SQL NULL.
        let (t00_min, t00_max): (Option<f64>, Option<f64>) = conn
            .query_row(
                "SELECT a.min, a.max FROM gpkg_2d_gridded_tile_ancillary a \
                 JOIN \"dem\" t ON t.id = a.tpudt_id \
                 WHERE t.tile_column = 0 AND t.tile_row = 0",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((t00_min, t00_max), (Some(1.0), Some(34.0)));
        let (null_min, null_max): (Option<f64>, Option<f64>) = conn
            .query_row(
                "SELECT a.min, a.max FROM gpkg_2d_gridded_tile_ancillary a \
                 JOIN \"dem\" t ON t.id = a.tpudt_id \
                 WHERE t.tile_column = 2 AND t.tile_row = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((null_min, null_max), (None, None));

        // The three gpkg_extensions rows, exact name/definition/scope.
        let mut ext_stmt = conn
            .prepare(
                "SELECT table_name, column_name, scope FROM gpkg_extensions \
                 WHERE extension_name = ?1 AND definition = ?2 ORDER BY table_name",
            )
            .unwrap();
        let ext_rows: Vec<(String, Option<String>, String)> = ext_stmt
            .query_map(params![EXTENSION_NAME, EXTENSION_DEFINITION], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            ext_rows,
            vec![
                ("dem".into(), Some("tile_data".into()), "read-write".into()),
                (
                    "gpkg_2d_gridded_coverage_ancillary".into(),
                    None,
                    "read-write".into()
                ),
                (
                    "gpkg_2d_gridded_tile_ancillary".into(),
                    None,
                    "read-write".into()
                ),
            ]
        );

        // Coverage ancillary row: the conformance-critical constants.
        let (datatype, scale, offset, data_null, encoding): (
            String,
            f64,
            f64,
            Option<f64>,
            String,
        ) = conn
            .query_row(
                "SELECT datatype, scale, \"offset\", data_null, grid_cell_encoding \
                 FROM gpkg_2d_gridded_coverage_ancillary \
                 WHERE tile_matrix_set_name = 'dem'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap();
        assert_eq!(datatype, "float");
        assert_eq!(scale, 1.0);
        assert_eq!(offset, 0.0);
        assert_eq!(data_null, Some(-9999.0));
        assert_eq!(encoding, "grid-value-is-area");

        // Decode EVERY tile blob: 4x4 f32, padding == -9999, no NaN
        // anywhere, data cells value-for-value against the source.
        let mut tile_stmt = conn
            .prepare("SELECT tile_column, tile_row, tile_data FROM \"dem\" ORDER BY id")
            .unwrap();
        let tiles: Vec<(i64, i64, Vec<u8>)> = tile_stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(tiles.len(), 6);
        for (tile_col, tile_row, blob) in &tiles {
            let (w, h, cells) = decode_tile(blob);
            assert_eq!((w, h), (4, 4));
            for y in 0..4usize {
                for x in 0..4usize {
                    let got = cells[y * 4 + x];
                    assert!(
                        !got.is_nan(),
                        "NaN leaked into tile ({tile_col},{tile_row}) at ({x},{y})"
                    );
                    let src_x = *tile_col as usize * 4 + x;
                    let src_y = *tile_row as usize * 4 + y;
                    let expected = if src_x < 10 && src_y < 6 {
                        let v = src[src_y * 10 + src_x];
                        if v.is_nan() || v == -9999.0 {
                            -9999.0 // missing source cell -> data_null
                        } else {
                            v
                        }
                    } else {
                        -9999.0 // edge padding -> data_null
                    };
                    assert_eq!(got, expected, "tile ({tile_col},{tile_row}) cell ({x},{y})");
                }
            }
        }
    }

    #[test]
    fn i16_input_widens_losslessly() {
        let path = temp_gpkg("i16-widen.gpkg");
        let gpkg = GeoPackage::create(&path).unwrap();
        // 5x3 grid, tile_size 4 -> matrix 2x1 with right+bottom padding.
        let vals: Vec<i16> = vec![
            i16::MIN,
            i16::MAX,
            0,
            -1,
            1234,
            5,
            6,
            7,
            8,
            9,
            10,
            11,
            12,
            13,
            14,
        ];
        let stats = write_gridded_coverage(
            &gpkg,
            &spec("dtm", 5, 3, Some(-9999.0)),
            CoverageData::I16(&vals),
        )
        .unwrap();
        assert_eq!((stats.matrix_width, stats.matrix_height), (2, 1));
        assert_eq!(stats.tiles_written, 2);
        assert_eq!(stats.nodata_cells, 0);
        assert_eq!(stats.min, Some(f64::from(i16::MIN)));
        assert_eq!(stats.max, Some(f64::from(i16::MAX)));

        let conn = gpkg.conn();
        // One encoder path: datatype stays 'float' for Int16 input.
        let datatype: String = conn
            .query_row(
                "SELECT datatype FROM gpkg_2d_gridded_coverage_ancillary \
                 WHERE tile_matrix_set_name = 'dtm'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(datatype, "float");

        // Spot-check widened values, including both i16 extremes.
        let blob: Vec<u8> = conn
            .query_row(
                "SELECT tile_data FROM \"dtm\" WHERE tile_column = 0 AND tile_row = 0",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let (_, _, cells) = decode_tile(&blob);
        assert_eq!(cells[0], -32768.0);
        assert_eq!(cells[1], 32767.0);
        assert_eq!(cells[2], 0.0);
        assert_eq!(cells[3], -1.0);
        assert_eq!(cells[4], 5.0); // row 1, col 0
        assert_eq!(cells[3 * 4], -9999.0); // bottom padding row

        let blob2: Vec<u8> = conn
            .query_row(
                "SELECT tile_data FROM \"dtm\" WHERE tile_column = 1 AND tile_row = 0",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let (_, _, cells2) = decode_tile(&blob2);
        assert_eq!(cells2[0], 1234.0); // source (row 0, col 4)
        assert_eq!(cells2[1], -9999.0); // right padding col
    }

    #[test]
    fn missing_data_null_with_missing_cells_errors() {
        let path = temp_gpkg("no-null-nan.gpkg");
        let gpkg = GeoPackage::create(&path).unwrap();
        // 4x4 with tile_size 4: no padding, so the NaN alone must trip it.
        let mut src: Vec<f32> = (1..=16).map(|v| v as f32).collect();
        src[5] = f32::NAN;
        let err = write_gridded_coverage(&gpkg, &spec("dem", 4, 4, None), CoverageData::F32(&src))
            .unwrap_err();
        assert!(matches!(err, GpkgError::Invalid(_)));
        assert!(err.to_string().contains("data_null"), "got: {err}");
    }

    #[test]
    fn missing_data_null_clean_grid_succeeds_with_null_ancillary() {
        let path = temp_gpkg("clean-no-null.gpkg");
        let gpkg = GeoPackage::create(&path).unwrap();
        // 8x8 with tile_size 4: no padding, no NoData, no NaN.
        let src: Vec<f32> = (1..=64).map(|v| v as f32).collect();
        let stats =
            write_gridded_coverage(&gpkg, &spec("clean", 8, 8, None), CoverageData::F32(&src))
                .unwrap();
        assert_eq!((stats.matrix_width, stats.matrix_height), (2, 2));
        assert_eq!(stats.tiles_written, 4);
        assert_eq!(stats.nodata_cells, 0);
        assert_eq!(stats.min, Some(1.0));
        assert_eq!(stats.max, Some(64.0));
        // Fully tile-aligned: data extent == tile-matrix extent.
        assert_eq!(stats.tile_matrix_bounds, stats.data_bounds);

        let data_null: Option<f64> = gpkg
            .conn()
            .query_row(
                "SELECT data_null FROM gpkg_2d_gridded_coverage_ancillary \
                 WHERE tile_matrix_set_name = 'clean'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(data_null, None);
    }

    #[test]
    fn existing_table_is_rejected() {
        let path = temp_gpkg("existing-table.gpkg");
        let gpkg = GeoPackage::create(&path).unwrap();
        gpkg.conn().execute("CREATE TABLE dem (x)", []).unwrap();
        let src: Vec<f32> = vec![1.0; 16];
        let err = write_gridded_coverage(&gpkg, &spec("dem", 4, 4, None), CoverageData::F32(&src))
            .unwrap_err();
        assert!(matches!(err, GpkgError::Invalid(_)));
        assert!(err.to_string().contains("already exists"), "got: {err}");

        // Writing the same coverage twice is also a rejection, not a merge.
        write_gridded_coverage(&gpkg, &spec("cov", 4, 4, None), CoverageData::F32(&src)).unwrap();
        let err = write_gridded_coverage(&gpkg, &spec("cov", 4, 4, None), CoverageData::F32(&src))
            .unwrap_err();
        assert!(err.to_string().contains("already exists"), "got: {err}");
    }

    #[test]
    fn invalid_table_name_is_rejected() {
        let path = temp_gpkg("bad-name.gpkg");
        let gpkg = GeoPackage::create(&path).unwrap();
        let src: Vec<f32> = vec![1.0; 16];
        for bad in ["bad-name", "1abc", "a;drop", "", "sp ace"] {
            let err =
                write_gridded_coverage(&gpkg, &spec(bad, 4, 4, None), CoverageData::F32(&src))
                    .unwrap_err();
            assert!(matches!(err, GpkgError::Invalid(_)), "accepted '{bad}'");
        }
    }

    #[test]
    fn rollback_on_error_leaves_zero_trace() {
        let path = temp_gpkg("rollback.gpkg");
        let gpkg = GeoPackage::create(&path).unwrap();
        // Clean values but 10x6 with tile_size 4 needs edge padding, and no
        // data_null is supplied: the failure happens deep inside the
        // transaction, after all DDL and metadata rows were written.
        let src: Vec<f32> = (1..=60).map(|v| v as f32).collect();
        let err = write_gridded_coverage(&gpkg, &spec("dem", 10, 6, None), CoverageData::F32(&src))
            .unwrap_err();
        assert!(err.to_string().contains("data_null"), "got: {err}");

        let conn = gpkg.conn();
        let count = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap() };
        // No tile table.
        assert_eq!(
            count("SELECT COUNT(*) FROM sqlite_master WHERE name = 'dem'"),
            0
        );
        // No contents row.
        assert_eq!(count("SELECT COUNT(*) FROM gpkg_contents"), 0);
        // No extension registrations.
        assert_eq!(
            count(
                "SELECT COUNT(*) FROM gpkg_extensions \
                 WHERE extension_name = 'gpkg_2d_gridded_coverage'"
            ),
            0
        );
        // Even the transactional DDL rolled back: none of the tile-matrix or
        // ancillary tables exist on this fresh GeoPackage.
        assert_eq!(
            count(
                "SELECT COUNT(*) FROM sqlite_master WHERE name IN (\
                 'gpkg_tile_matrix_set', 'gpkg_tile_matrix', \
                 'gpkg_2d_gridded_coverage_ancillary', 'gpkg_2d_gridded_tile_ancillary')"
            ),
            0
        );
        // And the SRS row registered inside the transaction is gone too.
        assert_eq!(
            count("SELECT COUNT(*) FROM gpkg_spatial_ref_sys WHERE srs_id = 32610"),
            0
        );
    }

    #[test]
    fn data_length_mismatch_is_rejected() {
        let path = temp_gpkg("bad-len.gpkg");
        let gpkg = GeoPackage::create(&path).unwrap();
        let src: Vec<f32> = vec![1.0; 15]; // 4x4 spec needs 16
        let err = write_gridded_coverage(&gpkg, &spec("dem", 4, 4, None), CoverageData::F32(&src))
            .unwrap_err();
        assert!(matches!(err, GpkgError::Invalid(_)));
    }

    #[test]
    fn non_finite_data_null_is_rejected() {
        let path = temp_gpkg("nan-null.gpkg");
        let gpkg = GeoPackage::create(&path).unwrap();
        let src: Vec<f32> = vec![1.0; 16];
        for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            let err = write_gridded_coverage(
                &gpkg,
                &spec("dem", 4, 4, Some(bad)),
                CoverageData::F32(&src),
            )
            .unwrap_err();
            assert!(matches!(err, GpkgError::Invalid(_)));
        }
    }
}
