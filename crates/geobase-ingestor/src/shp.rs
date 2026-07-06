//! Shapefile reader — the vector half of the GeoPack ingest pipeline.
//!
//! **Deliberately narrow** (docs/DECISIONS.md, 2026-07-06): accepts the six
//! common geometry types (Point, MultiPoint, LineString, MultiLineString,
//! Polygon, MultiPolygon — Z/M variants reject), DBF attribute types that
//! map onto GPKG SQL types (Character→TEXT, Numeric/Float/Double→REAL or
//! INTEGER, Logical→INTEGER, Date→TEXT ISO-8601), and resolves CRS through
//! [`crate::crs_id`] with the operator-declaration escape hatch.
//!
//! Geometry encoding: GeoPackage geometry BLOBs produced by `geozero`
//! (`WkbDialect::Geopackage`) with the little-endian envelope header —
//! never hand-rolled WKB (adversarial review advisory, 2026-07-06).
//!
//! Every feature's geometry contributes to layer bounds; after CRS
//! resolution the bounds get the CRS-discipline sanity check (geographic ⇒
//! lon/lat ranges).

use std::path::Path;

use geo_types::Geometry;
use geozero::wkb::{WkbDialect, WkbWriter};
use geozero::GeozeroGeometry;
use shapefile::dbase::{FieldValue, Record};
use shapefile::{Reader, Shape};

use crate::crs_id::{identify_prj, CrsIdentification};

/// GPKG geometry type name for the layer (uppercase, as stored in
/// `gpkg_geometry_columns.geometry_type_name`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GeometryType {
    Point,
    MultiPoint,
    LineString,
    MultiLineString,
    Polygon,
    MultiPolygon,
}

impl GeometryType {
    pub fn gpkg_name(&self) -> &'static str {
        match self {
            GeometryType::Point => "POINT",
            GeometryType::MultiPoint => "MULTIPOINT",
            GeometryType::LineString => "LINESTRING",
            GeometryType::MultiLineString => "MULTILINESTRING",
            GeometryType::Polygon => "POLYGON",
            GeometryType::MultiPolygon => "MULTIPOLYGON",
        }
    }
}

/// A GPKG-typed attribute column.
#[derive(Debug, Clone)]
pub struct FieldDef {
    pub name: String,
    /// GPKG SQL type: "TEXT", "INTEGER", or "REAL".
    pub sql_type: &'static str,
}

/// One attribute value, aligned with `FieldDef` order.
#[derive(Debug, Clone, PartialEq)]
pub enum AttrValue {
    Null,
    Text(String),
    Integer(i64),
    Real(f64),
}

/// One feature: encoded GPKG geometry blob + attribute row.
#[derive(Debug, Clone)]
pub struct Feature {
    /// GeoPackage geometry BLOB (GP header + envelope + WKB), ready to insert.
    pub geom: Vec<u8>,
    pub attrs: Vec<AttrValue>,
}

/// How the layer's CRS was established — feeds the audit record verbatim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CrsResolution {
    /// Identified from the `.prj` (authority node or curated match).
    Identified { epsg: u32, method: &'static str },
    /// Operator explicitly declared it (`.prj` absent or unidentifiable).
    /// This is never chosen by code — it must come from the IngestRequest.
    OperatorDeclared { epsg: u32 },
}

impl CrsResolution {
    pub fn epsg(&self) -> u32 {
        match self {
            CrsResolution::Identified { epsg, .. } => *epsg,
            CrsResolution::OperatorDeclared { epsg } => *epsg,
        }
    }
}

/// A decoded, validated vector layer ready for GPKG writing.
#[derive(Debug, Clone)]
pub struct VectorLayer {
    pub geometry_type: GeometryType,
    pub fields: Vec<FieldDef>,
    pub features: Vec<Feature>,
    pub crs: CrsResolution,
    /// Raw `.prj` WKT when present (stored as the srs definition).
    pub prj_wkt: Option<String>,
    /// (min_x, min_y, max_x, max_y) across all features.
    pub bounds: (f64, f64, f64, f64),
}

/// Errors from shapefile reading.
#[derive(Debug, thiserror::Error)]
pub enum ShpError {
    #[error("io error reading {path}: {source}")]
    Io {
        path: String,
        source: std::io::Error,
    },
    #[error("shapefile decode error in {path}: {detail}")]
    Decode { path: String, detail: String },
    #[error("unsupported shapefile ({path}): {detail} — Phase 0.3 accepts Point/MultiPoint/LineString/MultiLineString/Polygon/MultiPolygon (no Z/M)")]
    Unsupported { path: String, detail: String },
    #[error("CRS for {path} is {found}; ingest requires an identifiable .prj or an operator-declared CRS recorded in the audit trail — refusing to assume")]
    CrsUnresolved { path: String, found: String },
    #[error("geometry encoding failed for feature {index} in {path}: {detail}")]
    Encode {
        path: String,
        index: usize,
        detail: String,
    },
}

/// Read and validate `path` (a `.shp`; sidecars located by extension swap).
///
/// `declared_epsg` is the operator's explicit CRS declaration from the
/// `IngestRequest`, used **only** when the `.prj` is absent or resolves to
/// [`CrsIdentification::Unknown`]. An identifiable `.prj` that *conflicts*
/// with a declaration is an error (declaration is an escape hatch, not an
/// override).
pub fn read_shapefile(path: &Path, declared_epsg: Option<u32>) -> Result<VectorLayer, ShpError> {
    let path_label = path.display().to_string();
    let prj_path = path.with_extension("prj");
    let prj_wkt = match std::fs::read_to_string(&prj_path) {
        Ok(wkt) => Some(wkt),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
        Err(source) => {
            return Err(ShpError::Io {
                path: prj_path.display().to_string(),
                source,
            });
        }
    };
    let crs = resolve_crs(&path_label, prj_wkt.as_deref(), declared_epsg)?;

    let mut reader = Reader::from_path(path).map_err(|e| ShpError::Decode {
        path: path_label.clone(),
        detail: e.to_string(),
    })?;
    let mut field_names: Option<Vec<String>> = None;
    let mut fields: Option<Vec<FieldDef>> = None;
    let mut geometry_type: Option<GeometryType> = None;
    let mut features = Vec::new();
    let mut bounds: Option<(f64, f64, f64, f64)> = None;

    for (index, item) in reader.iter_shapes_and_records().enumerate() {
        let (shape, record) = item.map_err(|e| ShpError::Decode {
            path: path_label.clone(),
            detail: e.to_string(),
        })?;
        // Column order is frozen from the FIRST record; every record's
        // values are then extracted BY NAME. Iterating a record directly
        // is order-nondeterministic and scrambles columns across features.
        if field_names.is_none() {
            let names = field_names_of(&record);
            fields = Some(fields_for(&names, &record));
            field_names = Some(names);
        }
        let names = field_names.as_deref().unwrap_or(&[]);
        let attr_count = record.clone().into_iter().count();
        if attr_count != names.len() {
            return Err(ShpError::Decode {
                path: path_label,
                detail: format!(
                    "feature {index} has {attr_count} attributes but first feature had {}",
                    names.len()
                ),
            });
        }
        let attrs = attrs_in_order(names, &record);

        reject_unsupported_shape(&shape, &path_label)?;
        let geometry: Geometry<f64> = shape.try_into().map_err(|e| ShpError::Unsupported {
            path: path_label.clone(),
            detail: format!("feature {index}: {e}"),
        })?;
        let this_type = geometry_type_of(&geometry, &path_label)?;
        match geometry_type {
            Some(expected) if expected != this_type => {
                return Err(ShpError::Unsupported {
                    path: path_label,
                    detail: format!(
                        "mixed geometry types: first layer is {}, feature {index} is {}",
                        expected.gpkg_name(),
                        this_type.gpkg_name()
                    ),
                });
            }
            None => geometry_type = Some(this_type),
            _ => {}
        }
        let mut blob = Vec::new();
        {
            let mut writer = WkbWriter::new(&mut blob, WkbDialect::Geopackage);
            geometry
                .process_geom(&mut writer)
                .map_err(|e| ShpError::Encode {
                    path: path_label.clone(),
                    index,
                    detail: e.to_string(),
                })?;
        }
        update_bounds(&mut bounds, &geometry);
        features.push(Feature { geom: blob, attrs });
    }

    let geometry_type = geometry_type.ok_or_else(|| ShpError::Decode {
        path: path_label.clone(),
        detail: "shapefile contains no features".into(),
    })?;
    let fields = fields.unwrap_or_default();
    let bounds = bounds.ok_or_else(|| ShpError::Decode {
        path: path_label.clone(),
        detail: "shapefile contains no feature bounds".into(),
    })?;
    validate_bounds(&path_label, crs.epsg(), bounds)?;
    Ok(VectorLayer {
        geometry_type,
        fields,
        features,
        crs,
        prj_wkt,
        bounds,
    })
}

fn resolve_crs(
    path: &str,
    prj_wkt: Option<&str>,
    declared_epsg: Option<u32>,
) -> Result<CrsResolution, ShpError> {
    match prj_wkt.map(identify_prj) {
        Some(CrsIdentification::AuthorityNode(epsg) | CrsIdentification::CuratedMatch(epsg)) => {
            if let Some(declared) = declared_epsg {
                if declared != epsg {
                    return Err(ShpError::CrsUnresolved {
                        path: path.to_string(),
                        found: format!(
                            "identified as EPSG:{epsg} but operator declared EPSG:{declared}"
                        ),
                    });
                }
            }
            let method = identify_prj(prj_wkt.unwrap()).method();
            Ok(CrsResolution::Identified { epsg, method })
        }
        Some(CrsIdentification::Unknown) => declared_epsg
            .map(|epsg| CrsResolution::OperatorDeclared { epsg })
            .ok_or_else(|| ShpError::CrsUnresolved {
                path: path.to_string(),
                found: "unidentifiable .prj".into(),
            }),
        None => declared_epsg
            .map(|epsg| CrsResolution::OperatorDeclared { epsg })
            .ok_or_else(|| ShpError::CrsUnresolved {
                path: path.to_string(),
                found: "missing .prj".into(),
            }),
    }
}

fn reject_unsupported_shape(shape: &Shape, path: &str) -> Result<(), ShpError> {
    match shape {
        Shape::Point(_) | Shape::Multipoint(_) | Shape::Polyline(_) | Shape::Polygon(_) => Ok(()),
        other => Err(ShpError::Unsupported {
            path: path.to_string(),
            detail: format!("shape type {}", other.shapetype()),
        }),
    }
}

fn geometry_type_of(geometry: &Geometry<f64>, path: &str) -> Result<GeometryType, ShpError> {
    match geometry {
        Geometry::Point(_) => Ok(GeometryType::Point),
        Geometry::MultiPoint(_) => Ok(GeometryType::MultiPoint),
        Geometry::LineString(_) => Ok(GeometryType::LineString),
        Geometry::MultiLineString(_) => Ok(GeometryType::MultiLineString),
        Geometry::Polygon(_) => Ok(GeometryType::Polygon),
        Geometry::MultiPolygon(_) => Ok(GeometryType::MultiPolygon),
        other => Err(ShpError::Unsupported {
            path: path.to_string(),
            detail: format!("converted geometry type {other:?}"),
        }),
    }
}

/// The layer's canonical attribute order, frozen from the first record.
fn field_names_of(record: &Record) -> Vec<String> {
    record.clone().into_iter().map(|(name, _)| name).collect()
}

fn fields_for(names: &[String], record: &Record) -> Vec<FieldDef> {
    names
        .iter()
        .map(|name| FieldDef {
            name: sql_safe_field_name(name),
            sql_type: record.get(name).map_or("TEXT", sql_type_for),
        })
        .collect()
}

/// Extract a record's values in canonical order, by name — never by map
/// iteration (see the column-scramble note at the read loop).
fn attrs_in_order(names: &[String], record: &Record) -> Vec<AttrValue> {
    names
        .iter()
        .map(|name| record.get(name).map_or(AttrValue::Null, attr_value))
        .collect()
}

fn sql_safe_field_name(name: &str) -> String {
    let mut out: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect();
    if out.trim_matches('_').is_empty() {
        out = "field".into();
    }
    if out.chars().next().is_some_and(|c| c.is_ascii_digit()) {
        out.insert_str(0, "f_");
    }
    out
}

fn sql_type_for(value: &FieldValue) -> &'static str {
    match value {
        FieldValue::Character(_)
        | FieldValue::Date(_)
        | FieldValue::DateTime(_)
        | FieldValue::Memo(_) => "TEXT",
        FieldValue::Logical(_) | FieldValue::Integer(_) => "INTEGER",
        FieldValue::Numeric(Some(n)) if n.fract() == 0.0 => "INTEGER",
        FieldValue::Numeric(_)
        | FieldValue::Float(_)
        | FieldValue::Double(_)
        | FieldValue::Currency(_) => "REAL",
    }
}

fn attr_value(value: &FieldValue) -> AttrValue {
    match value {
        FieldValue::Character(v) => v
            .as_ref()
            .map_or(AttrValue::Null, |s| AttrValue::Text(s.clone())),
        FieldValue::Numeric(v) => v.map_or(AttrValue::Null, |n| {
            if n.fract() == 0.0 {
                AttrValue::Integer(n as i64)
            } else {
                AttrValue::Real(n)
            }
        }),
        FieldValue::Float(v) => v.map_or(AttrValue::Null, |n| AttrValue::Real(f64::from(n))),
        FieldValue::Double(v) => AttrValue::Real(*v),
        FieldValue::Logical(v) => v.map_or(AttrValue::Null, |b| AttrValue::Integer(i64::from(b))),
        FieldValue::Integer(v) => AttrValue::Integer(i64::from(*v)),
        FieldValue::Currency(v) => AttrValue::Real(*v / 10_000.0),
        FieldValue::Date(v) => v
            .as_ref()
            .map_or(AttrValue::Null, |d| AttrValue::Text(d.to_string())),
        FieldValue::DateTime(v) => AttrValue::Text(format!(
            "{}T{:02}:{:02}:{:02}",
            v.date(),
            v.time().hours(),
            v.time().minutes(),
            v.time().seconds()
        )),
        FieldValue::Memo(v) => AttrValue::Text(v.clone()),
    }
}

fn update_bounds(bounds: &mut Option<(f64, f64, f64, f64)>, geometry: &Geometry<f64>) {
    for coord in geometry_coords(geometry) {
        *bounds = Some(match *bounds {
            Some((min_x, min_y, max_x, max_y)) => (
                min_x.min(coord.0),
                min_y.min(coord.1),
                max_x.max(coord.0),
                max_y.max(coord.1),
            ),
            None => (coord.0, coord.1, coord.0, coord.1),
        });
    }
}

fn geometry_coords(geometry: &Geometry<f64>) -> Vec<(f64, f64)> {
    match geometry {
        Geometry::Point(p) => vec![(p.x(), p.y())],
        Geometry::MultiPoint(mp) => mp.iter().map(|p| (p.x(), p.y())).collect(),
        Geometry::LineString(ls) => ls.points().map(|p| (p.x(), p.y())).collect(),
        Geometry::MultiLineString(mls) => mls
            .iter()
            .flat_map(|ls| ls.points().map(|p| (p.x(), p.y())))
            .collect(),
        Geometry::Polygon(poly) => poly
            .exterior()
            .points()
            .chain(poly.interiors().iter().flat_map(|ring| ring.points()))
            .map(|p| (p.x(), p.y()))
            .collect(),
        Geometry::MultiPolygon(mp) => mp
            .iter()
            .flat_map(|poly| {
                poly.exterior()
                    .points()
                    .chain(poly.interiors().iter().flat_map(|ring| ring.points()))
            })
            .map(|p| (p.x(), p.y()))
            .collect(),
        _ => Vec::new(),
    }
}

fn validate_bounds(path: &str, epsg: u32, bounds: (f64, f64, f64, f64)) -> Result<(), ShpError> {
    let (min_x, min_y, max_x, max_y) = bounds;
    if !min_x.is_finite() || !min_y.is_finite() || !max_x.is_finite() || !max_y.is_finite() {
        return Err(ShpError::Decode {
            path: path.to_string(),
            detail: format!("non-finite bounds {bounds:?}"),
        });
    }
    if matches!(epsg, 4326 | 4269)
        && (min_x < -180.0 || max_x > 180.0 || min_y < -90.0 || max_y > 90.0)
    {
        return Err(ShpError::CrsUnresolved {
            path: path.to_string(),
            found: format!("geographic CRS EPSG:{epsg} with out-of-range bounds {bounds:?}"),
        });
    }
    Ok(())
}
