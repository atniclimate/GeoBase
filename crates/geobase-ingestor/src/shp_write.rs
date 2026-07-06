//! Narrow shapefile WRITER — Phase 1.3a. Exists for one purpose: the
//! zero-source-disclosure export (`export_product`, 1.3b) writes painted
//! product polygons as a shapefile others can open. The narrow-writer
//! doctrine from Phase 0.3 applies (docs/DECISIONS.md): a deliberately
//! small, conformance-tested surface; everything outside it rejects
//! loudly. NOT a general shapefile writer.
//!
//! ## Accepted surface (frozen)
//!
//! - Geometry: `Polygon` / `MultiPolygon` only (2D, finite coordinates).
//!   Ring winding per the shapefile spec: outer rings clockwise, holes
//!   counter-clockwise — the writer enforces winding itself so callers
//!   can pass `geo-types` geometry as-is.
//! - Attributes: DBF `TEXT` (width 1..=254), `INTEGER` (DBF `N`, width
//!   sized to the column), `REAL` (DBF `N` with decimals). Field names
//!   are 1..=10 ASCII alphanumeric/underscore bytes (the DBF limit) —
//!   anything else rejects naming the field, never truncates silently.
//! - CRS: `.prj` written from [`geobase_gpkg::known_epsg_wkt`]; an EPSG
//!   outside the curated table rejects (a `.prj` downstream tools cannot
//!   resolve would be a silent-CRS handoff).
//! - Sidecars always written together: `.shp`, `.shx`, `.dbf`, `.prj`.
//!   Refuse-to-overwrite unless `overwrite`.
//!
//! Implementation rides the `shapefile` crate's writer (the same vetted
//! dep the reader uses — never hand-roll what it already does), with the
//! validation above OURS and loud. Round-trip is proven in tests against
//! [`crate::shp::read_shapefile`] (geometry, field names, value-for-value
//! attributes incl. NULL); the RStep gate (1.3d) adds pyogrio as the
//! cross-implementation oracle.

use std::convert::TryFrom;
use std::path::{Path, PathBuf};

use geo_types::{Coord, LineString};
use geobase_gpkg::known_epsg_wkt;
use shapefile::dbase::{FieldName, FieldValue, Record, TableWriterBuilder};
use shapefile::{Point, Polygon, PolygonRing, Writer};

const REAL_FIELD_WIDTH: u8 = 20;
const REAL_FIELD_DECIMALS: u8 = 12;

/// A field declaration for the product DBF.
#[derive(Debug, Clone, PartialEq)]
pub struct ProductField {
    /// 1..=10 ASCII alphanumeric/underscore bytes (DBF limit, validated).
    pub name: String,
    pub kind: ProductFieldKind,
}

/// The three DBF value kinds the narrow writer accepts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProductFieldKind {
    /// DBF character field of the given width (1..=254).
    Text { width: u8 },
    /// DBF numeric field, integral values.
    Integer,
    /// DBF numeric field with decimal places.
    Real,
}

/// One attribute value; must match its column's kind (validated).
#[derive(Debug, Clone, PartialEq)]
pub enum ProductValue {
    Null,
    Text(String),
    Integer(i64),
    Real(f64),
}

/// Product geometry: the narrow surface.
#[derive(Debug, Clone, PartialEq)]
pub enum ProductGeometry {
    Polygon(geo_types::Polygon<f64>),
    MultiPolygon(geo_types::MultiPolygon<f64>),
}

/// A complete product layer to write.
#[derive(Debug, Clone)]
pub struct ProductLayer {
    /// EPSG for the `.prj`; must be in the curated table.
    pub epsg: u32,
    pub fields: Vec<ProductField>,
    /// Features in output order; every row's values must match `fields`
    /// in arity and kind.
    pub features: Vec<(ProductGeometry, Vec<ProductValue>)>,
}

/// What was written — everything the export pipeline audits.
#[derive(Debug)]
pub struct WrittenShapefile {
    pub shp: PathBuf,
    pub features_written: usize,
    /// The sidecar paths actually written (.shp, .shx, .dbf, .prj).
    pub files: Vec<PathBuf>,
}

/// Errors from the narrow writer. Total and loud; every rejection names
/// what was refused.
#[derive(Debug, thiserror::Error)]
pub enum ShpWriteError {
    #[error("shapefile write refused: {0}")]
    Invalid(String),
    #[error("io error writing {path}: {source}")]
    Io {
        path: String,
        source: std::io::Error,
    },
    #[error("shapefile encode error in {path}: {detail}")]
    Encode { path: String, detail: String },
}

/// Write `layer` as `shp_path` (+ .shx/.dbf/.prj). See the module doc
/// for the accepted surface; everything outside it rejects loudly.
pub fn write_shapefile(
    shp_path: &Path,
    layer: &ProductLayer,
    overwrite: bool,
) -> Result<WrittenShapefile, ShpWriteError> {
    let files = sidecars(shp_path);
    let prj_wkt = validate_layer(shp_path, layer, overwrite, &files)?;

    match write_checked(shp_path, layer, &files, &prj_wkt) {
        Ok(()) => Ok(WrittenShapefile {
            shp: shp_path.to_path_buf(),
            features_written: layer.features.len(),
            files,
        }),
        Err(err) => {
            cleanup_sidecars(&files);
            Err(err)
        }
    }
}

fn write_checked(
    shp_path: &Path,
    layer: &ProductLayer,
    files: &[PathBuf],
    prj_wkt: &str,
) -> Result<(), ShpWriteError> {
    {
        let table_builder = table_builder(layer)?;
        let mut writer =
            Writer::from_path(shp_path, table_builder).map_err(|e| ShpWriteError::Encode {
                path: shp_path.display().to_string(),
                detail: e.to_string(),
            })?;

        for (geometry, values) in &layer.features {
            let shape = shape_for_geometry(geometry)?;
            let record = record_for_values(&layer.fields, values);
            writer
                .write_shape_and_record(&shape, &record)
                .map_err(|e| ShpWriteError::Encode {
                    path: shp_path.display().to_string(),
                    detail: e.to_string(),
                })?;
        }
    }

    let prj_path = files[3].clone();
    std::fs::write(&prj_path, prj_wkt).map_err(|source| ShpWriteError::Io {
        path: prj_path.display().to_string(),
        source,
    })
}

fn validate_layer(
    shp_path: &Path,
    layer: &ProductLayer,
    overwrite: bool,
    files: &[PathBuf],
) -> Result<String, ShpWriteError> {
    if layer.features.is_empty() {
        return Err(ShpWriteError::Invalid(
            "layer contains no features".to_string(),
        ));
    }
    if !overwrite {
        for path in files {
            if path.exists() {
                return Err(ShpWriteError::Invalid(format!(
                    "output sidecar already exists: {}",
                    path.display()
                )));
            }
        }
    }

    let prj_wkt = known_epsg_wkt(layer.epsg)
        .ok_or_else(|| ShpWriteError::Invalid(format!("unknown EPSG:{}", layer.epsg)))?;

    for field in &layer.fields {
        validate_field(field)?;
    }
    for (feature_index, (geometry, values)) in layer.features.iter().enumerate() {
        validate_geometry(feature_index, geometry)?;
        validate_values(feature_index, &layer.fields, values)?;
    }

    if shp_path.extension().and_then(|s| s.to_str()) != Some("shp") {
        return Err(ShpWriteError::Invalid(format!(
            "output path must end with .shp: {}",
            shp_path.display()
        )));
    }
    Ok(prj_wkt)
}

fn validate_field(field: &ProductField) -> Result<(), ShpWriteError> {
    if field.name.is_empty()
        || field.name.len() > 10
        || !field
            .name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_')
    {
        return Err(ShpWriteError::Invalid(format!(
            "invalid field name '{}': expected 1..=10 ASCII alphanumeric/underscore bytes",
            field.name
        )));
    }
    if let ProductFieldKind::Text { width } = field.kind {
        if !(1..=254).contains(&width) {
            return Err(ShpWriteError::Invalid(format!(
                "field '{}' has invalid TEXT width {}; expected 1..=254",
                field.name, width
            )));
        }
    }
    Ok(())
}

fn validate_values(
    feature_index: usize,
    fields: &[ProductField],
    values: &[ProductValue],
) -> Result<(), ShpWriteError> {
    if values.len() != fields.len() {
        return Err(ShpWriteError::Invalid(format!(
            "feature {feature_index} has {} values but {} fields",
            values.len(),
            fields.len()
        )));
    }
    for (field, value) in fields.iter().zip(values) {
        match (&field.kind, value) {
            (_, ProductValue::Null) => {}
            (ProductFieldKind::Text { width }, ProductValue::Text(text)) => {
                if text.len() > usize::from(*width) {
                    return Err(ShpWriteError::Invalid(format!(
                        "feature {feature_index} field '{}' text length {} exceeds width {}",
                        field.name,
                        text.len(),
                        width
                    )));
                }
            }
            (ProductFieldKind::Integer, ProductValue::Integer(_)) => {}
            (ProductFieldKind::Real, ProductValue::Real(value)) if value.is_finite() => {}
            (ProductFieldKind::Real, ProductValue::Real(_)) => {
                return Err(ShpWriteError::Invalid(format!(
                    "feature {feature_index} field '{}' has non-finite REAL value",
                    field.name
                )));
            }
            (expected, found) => {
                return Err(ShpWriteError::Invalid(format!(
                    "feature {feature_index} field '{}' value {:?} does not match {:?}",
                    field.name, found, expected
                )));
            }
        }
    }
    Ok(())
}

fn validate_geometry(index: usize, geometry: &ProductGeometry) -> Result<(), ShpWriteError> {
    match geometry {
        ProductGeometry::Polygon(poly) => validate_polygon(index, poly),
        ProductGeometry::MultiPolygon(multi) => {
            if multi.0.is_empty() {
                return Err(ShpWriteError::Invalid(format!(
                    "feature {index} multipolygon contains no polygons"
                )));
            }
            for poly in &multi.0 {
                validate_polygon(index, poly)?;
            }
            Ok(())
        }
    }
}

fn validate_polygon(index: usize, poly: &geo_types::Polygon<f64>) -> Result<(), ShpWriteError> {
    validate_ring(index, "outer", poly.exterior())?;
    for ring in poly.interiors() {
        validate_ring(index, "hole", ring)?;
    }
    Ok(())
}

fn validate_ring(index: usize, label: &str, ring: &LineString<f64>) -> Result<(), ShpWriteError> {
    let coords = closed_coords(ring);
    if coords.len() < 4 {
        return Err(ShpWriteError::Invalid(format!(
            "feature {index} {label} ring has fewer than 4 coordinates"
        )));
    }
    for coord in &coords {
        if !coord.x.is_finite() || !coord.y.is_finite() {
            return Err(ShpWriteError::Invalid(format!(
                "feature {index} {label} ring has non-finite coordinate ({}, {})",
                coord.x, coord.y
            )));
        }
    }
    Ok(())
}

fn table_builder(layer: &ProductLayer) -> Result<TableWriterBuilder, ShpWriteError> {
    let mut builder = TableWriterBuilder::new();
    for (field_index, field) in layer.fields.iter().enumerate() {
        let name = FieldName::try_from(field.name.as_str()).map_err(|e| {
            ShpWriteError::Invalid(format!("invalid field name '{}': {e}", field.name))
        })?;
        builder = match field.kind {
            ProductFieldKind::Text { width } => builder.add_character_field(name, width),
            ProductFieldKind::Integer => {
                builder.add_numeric_field(name, integer_width(layer, field_index), 0)
            }
            ProductFieldKind::Real => {
                builder.add_numeric_field(name, REAL_FIELD_WIDTH, REAL_FIELD_DECIMALS)
            }
        };
    }
    Ok(builder)
}

fn integer_width(layer: &ProductLayer, field_index: usize) -> u8 {
    layer
        .features
        .iter()
        .filter_map(|(_, values)| match values.get(field_index) {
            Some(ProductValue::Integer(value)) => Some(value.to_string().len()),
            _ => None,
        })
        .max()
        .unwrap_or(1)
        .try_into()
        .unwrap_or(20)
}

fn record_for_values(fields: &[ProductField], values: &[ProductValue]) -> Record {
    let mut record = Record::default();
    for (field, value) in fields.iter().zip(values) {
        let field_value = match (&field.kind, value) {
            (_, ProductValue::Null) => null_value_for(field.kind),
            (ProductFieldKind::Text { .. }, ProductValue::Text(text)) => {
                FieldValue::Character(Some(text.clone()))
            }
            (ProductFieldKind::Integer, ProductValue::Integer(value)) => {
                FieldValue::Numeric(Some(*value as f64))
            }
            (ProductFieldKind::Real, ProductValue::Real(value)) => {
                FieldValue::Numeric(Some(*value))
            }
            _ => FieldValue::Character(None),
        };
        record.insert(field.name.clone(), field_value);
    }
    record
}

fn null_value_for(kind: ProductFieldKind) -> FieldValue {
    match kind {
        ProductFieldKind::Text { .. } => FieldValue::Character(None),
        ProductFieldKind::Integer | ProductFieldKind::Real => FieldValue::Numeric(None),
    }
}

fn shape_for_geometry(geometry: &ProductGeometry) -> Result<Polygon, ShpWriteError> {
    let mut rings = Vec::new();
    match geometry {
        ProductGeometry::Polygon(poly) => append_polygon_rings(poly, &mut rings),
        ProductGeometry::MultiPolygon(multi) => {
            for poly in &multi.0 {
                append_polygon_rings(poly, &mut rings);
            }
        }
    }
    Ok(Polygon::with_rings(rings))
}

fn append_polygon_rings(poly: &geo_types::Polygon<f64>, rings: &mut Vec<PolygonRing<Point>>) {
    rings.push(PolygonRing::Outer(points_for_ring(
        poly.exterior(),
        Winding::Clockwise,
    )));
    for hole in poly.interiors() {
        rings.push(PolygonRing::Inner(points_for_ring(
            hole,
            Winding::CounterClockwise,
        )));
    }
}

fn points_for_ring(ring: &LineString<f64>, winding: Winding) -> Vec<Point> {
    let mut coords = closed_coords(ring);
    let signed_area = signed_area(&coords);
    match winding {
        Winding::Clockwise if signed_area > 0.0 => coords.reverse(),
        Winding::CounterClockwise if signed_area < 0.0 => coords.reverse(),
        _ => {}
    }
    coords
        .into_iter()
        .map(|coord| Point::new(coord.x, coord.y))
        .collect()
}

fn closed_coords(ring: &LineString<f64>) -> Vec<Coord<f64>> {
    let mut coords = ring.0.clone();
    if let (Some(first), Some(last)) = (coords.first().copied(), coords.last().copied()) {
        if first != last {
            coords.push(first);
        }
    }
    coords
}

fn signed_area(coords: &[Coord<f64>]) -> f64 {
    coords
        .windows(2)
        .map(|pair| pair[0].x * pair[1].y - pair[1].x * pair[0].y)
        .sum::<f64>()
        / 2.0
}

#[derive(Debug, Clone, Copy)]
enum Winding {
    Clockwise,
    CounterClockwise,
}

fn sidecars(shp_path: &Path) -> Vec<PathBuf> {
    ["shp", "shx", "dbf", "prj"]
        .iter()
        .map(|extension| shp_path.with_extension(extension))
        .collect()
}

fn cleanup_sidecars(files: &[PathBuf]) {
    for path in files {
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shp::{read_shapefile, AttrValue, GeometryType};
    use geo_types::{coord, line_string, polygon, MultiPolygon};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn round_trip_polygons_multipolygon_attrs_and_crs() {
        let dir = temp_dir("round_trip");
        let shp = dir.join("product.shp");
        let layer = sample_layer(32610);

        let written = write_shapefile(&shp, &layer, false).expect("write succeeds");
        assert_eq!(written.features_written, 3);
        assert_eq!(written.files.len(), 4);
        for path in &written.files {
            assert!(path.exists(), "{} should exist", path.display());
        }

        let read = read_shapefile(&shp, None).expect("read succeeds");
        assert!(matches!(
            read.geometry_type,
            GeometryType::Polygon | GeometryType::MultiPolygon
        ));
        assert_eq!(read.features.len(), 3);
        assert_eq!(read.crs.epsg(), 32610);
        assert_eq!(
            read.fields
                .iter()
                .map(|field| field.name.as_str())
                .collect::<Vec<_>>(),
            vec!["name", "zone", "score"]
        );
        assert_eq!(
            read.features[0].attrs,
            vec![
                AttrValue::Text("alpha".to_string()),
                AttrValue::Integer(10),
                AttrValue::Real(1.25)
            ]
        );
        assert_eq!(
            read.features[1].attrs,
            vec![
                AttrValue::Text("bravo".to_string()),
                AttrValue::Null,
                AttrValue::Real(2.5)
            ]
        );
        assert_eq!(
            read.features[2].attrs,
            vec![
                AttrValue::Text("charlie".to_string()),
                AttrValue::Integer(-7),
                AttrValue::Real(3.75)
            ]
        );
    }

    #[test]
    fn rewinds_ccw_outer_ring_to_raw_shapefile_cw() {
        let dir = temp_dir("winding");
        let shp = dir.join("product.shp");
        let ccw = polygon![
            (x: 0.0, y: 0.0),
            (x: 1.0, y: 0.0),
            (x: 1.0, y: 1.0),
            (x: 0.0, y: 1.0),
            (x: 0.0, y: 0.0),
        ];
        assert!(signed_area(&closed_coords(ccw.exterior())) > 0.0);
        let layer = ProductLayer {
            epsg: 4326,
            fields: Vec::new(),
            features: vec![(ProductGeometry::Polygon(ccw), Vec::new())],
        };

        write_shapefile(&shp, &layer, false).expect("write succeeds");
        let read = read_shapefile(&shp, None).expect("read succeeds");
        assert_eq!(read.features.len(), 1);
        assert_eq!(read.bounds, (0.0, 0.0, 1.0, 1.0));

        let shapes = shapefile::read_shapes(&shp).expect("raw shapes read");
        let shapefile::Shape::Polygon(poly) = &shapes[0] else {
            panic!("expected polygon");
        };
        let first_ring = poly.rings().first().expect("outer ring exists");
        assert!(signed_area_points(first_ring.points()) < 0.0);
    }

    #[test]
    fn rejects_empty_features_naming_offender() {
        let err = write_shapefile(
            &temp_dir("empty").join("product.shp"),
            &ProductLayer {
                epsg: 4326,
                fields: Vec::new(),
                features: Vec::new(),
            },
            false,
        )
        .expect_err("empty layer rejects");
        assert!(err.to_string().contains("no features"));
    }

    #[test]
    fn rejects_field_name_too_long_and_bad_charset_naming_offender() {
        let mut layer = sample_layer(4326);
        layer.fields[0].name = "name_is_too_long".to_string();
        let err = write_shapefile(&temp_dir("long_name").join("product.shp"), &layer, false)
            .expect_err("long field rejects");
        assert!(err.to_string().contains("name_is_too_long"));

        let mut layer = sample_layer(4326);
        layer.fields[0].name = "bad-name".to_string();
        let err = write_shapefile(&temp_dir("bad_name").join("product.shp"), &layer, false)
            .expect_err("bad field rejects");
        assert!(err.to_string().contains("bad-name"));
    }

    #[test]
    fn rejects_text_width_zero_naming_offender() {
        let mut layer = sample_layer(4326);
        layer.fields[0].kind = ProductFieldKind::Text { width: 0 };
        let err = write_shapefile(&temp_dir("width_zero").join("product.shp"), &layer, false)
            .expect_err("zero text width rejects");
        assert!(err.to_string().contains("name"));
        assert!(err.to_string().contains("width 0"));
    }

    #[test]
    fn rejects_value_kind_mismatch_naming_offender() {
        let mut layer = sample_layer(4326);
        layer.features[0].1[1] = ProductValue::Text("wrong".to_string());
        let err = write_shapefile(
            &temp_dir("kind_mismatch").join("product.shp"),
            &layer,
            false,
        )
        .expect_err("kind mismatch rejects");
        assert!(err.to_string().contains("zone"));
        assert!(err.to_string().contains("does not match"));
    }

    #[test]
    fn rejects_non_finite_coordinate_naming_offender() {
        let mut layer = sample_layer(4326);
        layer.features[0].0 = ProductGeometry::Polygon(polygon![
            (x: 0.0, y: 0.0),
            (x: f64::NAN, y: 0.0),
            (x: 1.0, y: 1.0),
            (x: 0.0, y: 0.0),
        ]);
        let err = write_shapefile(&temp_dir("non_finite").join("product.shp"), &layer, false)
            .expect_err("non-finite coordinate rejects");
        assert!(err.to_string().contains("non-finite coordinate"));
    }

    #[test]
    fn rejects_unknown_epsg_naming_offender() {
        let layer = sample_layer(999_999);
        let err = write_shapefile(&temp_dir("unknown_epsg").join("product.shp"), &layer, false)
            .expect_err("unknown epsg rejects");
        assert!(err.to_string().contains("EPSG:999999"));
    }

    #[test]
    fn rejects_existing_output_without_overwrite_naming_offender() {
        let dir = temp_dir("existing");
        let shp = dir.join("product.shp");
        std::fs::write(&shp, b"exists").expect("seed existing sidecar");
        let err =
            write_shapefile(&shp, &sample_layer(4326), false).expect_err("existing output rejects");
        assert!(err.to_string().contains("already exists"));
        assert!(err.to_string().contains("product.shp"));
    }

    #[test]
    fn cleanup_removes_torn_set_when_prj_write_fails() {
        let dir = temp_dir("cleanup");
        let shp = dir.join("product.shp");
        let prj = shp.with_extension("prj");
        std::fs::create_dir(&prj).expect("directory blocks prj file write");

        let err =
            write_shapefile(&shp, &sample_layer(4326), true).expect_err("prj write should fail");
        assert!(err.to_string().contains("product.prj"));
        assert!(!shp.exists());
        assert!(!shp.with_extension("shx").exists());
        assert!(!shp.with_extension("dbf").exists());
        std::fs::remove_dir(prj).expect("remove blocking directory");
    }

    fn sample_layer(epsg: u32) -> ProductLayer {
        ProductLayer {
            epsg,
            fields: vec![
                ProductField {
                    name: "name".to_string(),
                    kind: ProductFieldKind::Text { width: 16 },
                },
                ProductField {
                    name: "zone".to_string(),
                    kind: ProductFieldKind::Integer,
                },
                ProductField {
                    name: "score".to_string(),
                    kind: ProductFieldKind::Real,
                },
            ],
            features: vec![
                (
                    ProductGeometry::Polygon(square(0.0, 0.0, 1.0, 1.0)),
                    vec![
                        ProductValue::Text("alpha".to_string()),
                        ProductValue::Integer(10),
                        ProductValue::Real(1.25),
                    ],
                ),
                (
                    ProductGeometry::Polygon(square(2.0, 0.0, 3.0, 1.0)),
                    vec![
                        ProductValue::Text("bravo".to_string()),
                        ProductValue::Null,
                        ProductValue::Real(2.5),
                    ],
                ),
                (
                    ProductGeometry::MultiPolygon(MultiPolygon(vec![
                        square(4.0, 0.0, 5.0, 1.0),
                        square(6.0, 0.0, 7.0, 1.0),
                    ])),
                    vec![
                        ProductValue::Text("charlie".to_string()),
                        ProductValue::Integer(-7),
                        ProductValue::Real(3.75),
                    ],
                ),
            ],
        }
    }

    fn square(min_x: f64, min_y: f64, max_x: f64, max_y: f64) -> geo_types::Polygon<f64> {
        geo_types::Polygon::new(
            line_string![
                coord! { x: min_x, y: min_y },
                coord! { x: min_x, y: max_y },
                coord! { x: max_x, y: max_y },
                coord! { x: max_x, y: min_y },
                coord! { x: min_x, y: min_y },
            ],
            Vec::new(),
        )
    }

    fn temp_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time after epoch")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "geobase_shp_write_{label}_{}_{}",
            std::process::id(),
            nanos
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn signed_area_points(points: &[Point]) -> f64 {
        points
            .windows(2)
            .map(|pair| pair[0].x * pair[1].y - pair[1].x * pair[0].y)
            .sum::<f64>()
            / 2.0
    }
}
