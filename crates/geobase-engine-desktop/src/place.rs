//! `place.toml` — the node's **grounding**. A GeoBase node is bound to a
//! territory; T2/T3 datasets are pinned to it and never leave. Shape is
//! fixed by `place.example.toml` at the repo root:
//!
//! ```toml
//! [node]      id, territory            # both required, non-empty
//! [grounding] home_crs                 # required, "EPSG:<digits>"
//!             bbox = [w, s, e, n]      # optional, WGS84, w<e, s<n, sane ranges
//! [tsdf]      source = "vendored" | "github" | "local-server"
//!             endpoint = "..."         # required iff source = "local-server"
//! ```
//!
//! Validation is loud and total — a node must never run half-grounded.
//! Unknown TSDF sources, malformed CRS strings, and insane bboxes all
//! reject with a message naming the field (CRS-discipline: never assume).

use std::path::Path;

use geobase_tsdf::SourceKind;
use serde::Deserialize;

/// A validated grounding, loaded from `place.toml`.
#[derive(Debug, Clone, PartialEq)]
pub struct Grounding {
    pub node_id: String,
    pub territory: String,
    /// Home CRS hint (e.g. `"EPSG:3857"`); data stays in native CRS.
    pub home_crs: String,
    /// Optional territory bbox in WGS84: `[west, south, east, north]`.
    pub bbox: Option<[f64; 4]>,
    /// Which TSDF origin this node reads its tier model from.
    pub tsdf: TsdfOrigin,
}

/// TSDF origin selection, as declared in `[tsdf]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TsdfOrigin {
    Vendored,
    GitHub,
    LocalServer(String),
}

impl TsdfOrigin {
    /// Map to the `geobase-tsdf` source selector.
    pub fn source_kind(&self) -> SourceKind {
        match self {
            TsdfOrigin::Vendored => SourceKind::Vendored,
            TsdfOrigin::GitHub => SourceKind::GitHub,
            TsdfOrigin::LocalServer(endpoint) => SourceKind::LocalServer(endpoint.clone()),
        }
    }
}

/// Errors from loading a grounding.
#[derive(Debug, thiserror::Error)]
pub enum PlaceError {
    #[error("io error reading {path}: {source}")]
    Io {
        path: String,
        source: std::io::Error,
    },
    #[error("place.toml parse error in {path}: {detail}")]
    Parse { path: String, detail: String },
    #[error("place.toml invalid ({path}): {detail}")]
    Invalid { path: String, detail: String },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawPlace {
    node: RawNode,
    grounding: RawGrounding,
    tsdf: RawTsdf,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawNode {
    id: String,
    territory: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawGrounding {
    home_crs: String,
    bbox: Option<[f64; 4]>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawTsdf {
    source: String,
    endpoint: Option<String>,
}

/// Load and validate a `place.toml` per the module contract.
pub fn load(path: &Path) -> Result<Grounding, PlaceError> {
    let display_path = path.display().to_string();
    let raw = std::fs::read_to_string(path).map_err(|source| PlaceError::Io {
        path: display_path.clone(),
        source,
    })?;
    let place: RawPlace = toml::from_str(&raw).map_err(|source| PlaceError::Parse {
        path: display_path.clone(),
        detail: source.to_string(),
    })?;

    validate_non_empty(&place.node.id, "node.id", &display_path)?;
    validate_non_empty(&place.node.territory, "node.territory", &display_path)?;
    validate_home_crs(&place.grounding.home_crs, &display_path)?;
    if let Some(bbox) = place.grounding.bbox {
        validate_bbox(bbox, &display_path)?;
    }

    let tsdf = validate_tsdf(place.tsdf, &display_path)?;
    Ok(Grounding {
        node_id: place.node.id,
        territory: place.node.territory,
        home_crs: place.grounding.home_crs,
        bbox: place.grounding.bbox,
        tsdf,
    })
}

fn validate_non_empty(value: &str, field: &str, path: &str) -> Result<(), PlaceError> {
    if value.trim().is_empty() {
        return Err(PlaceError::Invalid {
            path: path.to_string(),
            detail: format!("{field} must be non-empty"),
        });
    }
    Ok(())
}

fn validate_home_crs(home_crs: &str, path: &str) -> Result<(), PlaceError> {
    let suffix = home_crs.strip_prefix("EPSG:").unwrap_or("");
    if suffix.is_empty() || !suffix.chars().all(|c| c.is_ascii_digit()) {
        return Err(PlaceError::Invalid {
            path: path.to_string(),
            detail: "grounding.home_crs must match EPSG:<digits>".into(),
        });
    }
    Ok(())
}

fn validate_bbox([west, south, east, north]: [f64; 4], path: &str) -> Result<(), PlaceError> {
    // Finiteness first: NaN must reject here, not slip through a
    // rewritten comparison (NaN >= NaN is false).
    if [west, south, east, north].iter().any(|v| !v.is_finite()) {
        return Err(PlaceError::Invalid {
            path: path.to_string(),
            detail: "grounding.bbox values must be finite numbers".into(),
        });
    }
    if west >= east {
        return Err(PlaceError::Invalid {
            path: path.to_string(),
            detail: "grounding.bbox must have west < east".into(),
        });
    }
    if south >= north {
        return Err(PlaceError::Invalid {
            path: path.to_string(),
            detail: "grounding.bbox must have south < north".into(),
        });
    }
    if !(-180.0..=180.0).contains(&west) || !(-180.0..=180.0).contains(&east) {
        return Err(PlaceError::Invalid {
            path: path.to_string(),
            detail: "grounding.bbox longitude values must be in [-180, 180]".into(),
        });
    }
    if !(-90.0..=90.0).contains(&south) || !(-90.0..=90.0).contains(&north) {
        return Err(PlaceError::Invalid {
            path: path.to_string(),
            detail: "grounding.bbox latitude values must be in [-90, 90]".into(),
        });
    }
    Ok(())
}

fn validate_tsdf(tsdf: RawTsdf, path: &str) -> Result<TsdfOrigin, PlaceError> {
    match tsdf.source.as_str() {
        "vendored" => {
            reject_endpoint(tsdf.endpoint, "vendored", path)?;
            Ok(TsdfOrigin::Vendored)
        }
        "github" => {
            reject_endpoint(tsdf.endpoint, "github", path)?;
            Ok(TsdfOrigin::GitHub)
        }
        "local-server" => {
            let endpoint = tsdf.endpoint.unwrap_or_default();
            if endpoint.trim().is_empty() {
                return Err(PlaceError::Invalid {
                    path: path.to_string(),
                    detail: "tsdf.endpoint is required when tsdf.source is local-server".into(),
                });
            }
            Ok(TsdfOrigin::LocalServer(endpoint))
        }
        other => Err(PlaceError::Invalid {
            path: path.to_string(),
            detail: format!("tsdf.source '{other}' is not one of vendored, github, local-server"),
        }),
    }
}

fn reject_endpoint(endpoint: Option<String>, source: &str, path: &str) -> Result<(), PlaceError> {
    if endpoint.is_some() {
        return Err(PlaceError::Invalid {
            path: path.to_string(),
            detail: format!(
                "tsdf.endpoint is only valid when tsdf.source is local-server, not {source}"
            ),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn load_place_example_toml() {
        let repo_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let grounding = load(&repo_root.join("place.example.toml")).unwrap();

        assert_eq!(grounding.node_id, "example-node");
        assert_eq!(grounding.territory, "Example Territory");
        assert_eq!(grounding.home_crs, "EPSG:3857");
        assert_eq!(grounding.bbox, Some([-123.10, 47.05, -122.74, 47.29]));
        assert_eq!(grounding.tsdf, TsdfOrigin::Vendored);
    }

    #[test]
    fn rejects_missing_territory() {
        assert_invalid(
            r#"
[node]
id = "node"

[grounding]
home_crs = "EPSG:3857"

[tsdf]
source = "vendored"
"#,
            "territory",
        );
    }

    #[test]
    fn rejects_bad_crs() {
        assert_invalid(
            r#"
[node]
id = "node"
territory = "territory"

[grounding]
home_crs = "WGS84"

[tsdf]
source = "vendored"
"#,
            "home_crs",
        );
    }

    #[test]
    fn rejects_inverted_bbox() {
        assert_invalid(
            r#"
[node]
id = "node"
territory = "territory"

[grounding]
home_crs = "EPSG:3857"
bbox = [-122.0, 47.0, -123.0, 48.0]

[tsdf]
source = "vendored"
"#,
            "bbox",
        );
    }

    #[test]
    fn rejects_unknown_source() {
        assert_invalid(
            r#"
[node]
id = "node"
territory = "territory"

[grounding]
home_crs = "EPSG:3857"

[tsdf]
source = "upstream"
"#,
            "tsdf.source",
        );
    }

    #[test]
    fn rejects_local_server_without_endpoint() {
        assert_invalid(
            r#"
[node]
id = "node"
territory = "territory"

[grounding]
home_crs = "EPSG:3857"

[tsdf]
source = "local-server"
"#,
            "endpoint",
        );
    }

    #[test]
    fn rejects_unknown_key() {
        assert_invalid(
            r#"
[node]
id = "node"
territory = "territory"
extra = "typo"

[grounding]
home_crs = "EPSG:3857"

[tsdf]
source = "vendored"
"#,
            "extra",
        );
    }

    fn assert_invalid(raw: &str, expected: &str) {
        let path = temp_path("place.toml");
        fs::write(&path, raw).unwrap();
        let err = load(&path).unwrap_err().to_string();
        assert!(
            err.contains(expected),
            "expected error containing {expected:?}, got {err:?}"
        );
    }

    fn temp_path(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("geobase-place-{nonce}"));
        fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }
}
