//! # geobase-core
//!
//! The GeoBase **spine**: the shared data model, catalog, CRS-pipeline contract,
//! and layer-package API that both engines (desktop + light) and every SoLO app
//! build on. Every dataset carries a TSDF [`Tier`] and the framework version it
//! was classified under, so classification is always reproducible.
//!
//! This crate is a scaffold. Behavior arrives per `docs/ROADMAP.md`; the types
//! here fix the vocabulary the rest of the platform shares.

use geobase_tsdf::Tier;
use serde::{Deserialize, Serialize};

pub mod baseline;
pub mod crs;

/// GeoBase platform version marker for the spine.
pub const SPINE_VERSION: &str = env!("CARGO_PKG_VERSION");

/// A coordinate reference system, identified by authority code (e.g. `"EPSG:26910"`).
///
/// GeoBase is **CRS-agnostic**: data is stored in its native CRS and reprojected
/// to [`CrsPipeline::VIEWER_CRS`] for display. See `docs/CRS-PIPELINE.md`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Crs(pub String);

impl Crs {
    pub fn epsg(code: u32) -> Self {
        Crs(format!("EPSG:{code}"))
    }
}

/// The one CRS discipline (contract only in this scaffold).
///
/// Lesson from the prototype: sessions oscillated between EPSG:26910/32610/4326
/// and silent CRS mismatches produced garbage. GeoBase never mandates a single
/// project CRS; it mandates a single *pipeline*: validate source CRS → store
/// native → reproject to the viewer CRS, asserting at every hop.
pub struct CrsPipeline;

impl CrsPipeline {
    /// Web-map display CRS used by both engines.
    pub const VIEWER_CRS: &'static str = "EPSG:3857";
}

/// A single dataset registered in a node's catalog.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Dataset {
    pub id: String,
    pub title: String,
    /// TSDF classification. Unclassified data defaults to `T3` (never assume less).
    pub tier: Tier,
    /// TSDF framework version this dataset was classified under.
    pub tsdf_version: String,
    /// Native CRS the data is stored in.
    pub crs: Crs,
}

/// A stackable **layer package**: one or more datasets imported together
/// (e.g. LandCover, Flood projections, Responsible Siting) that render as a
/// toggleable layer over the T0 baseline.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LayerPackage {
    pub id: String,
    pub name: String,
    pub datasets: Vec<Dataset>,
}

impl LayerPackage {
    /// The most restrictive (highest) tier across the package's datasets — the
    /// tier the whole package must be handled at.
    pub fn effective_tier(&self) -> Tier {
        self.datasets
            .iter()
            .map(|d| d.tier)
            .max()
            .unwrap_or(Tier::T3)
    }
}

/// Errors from the core spine.
#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("catalog error: {0}")]
    Catalog(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layer_package_takes_most_restrictive_tier() {
        let pkg = LayerPackage {
            id: "flood".into(),
            name: "Flood projections".into(),
            datasets: vec![
                Dataset {
                    id: "a".into(),
                    title: "public extent".into(),
                    tier: Tier::T0,
                    tsdf_version: "0.9.4".into(),
                    crs: Crs::epsg(3857),
                },
                Dataset {
                    id: "b".into(),
                    title: "sensitive parcels".into(),
                    tier: Tier::T2,
                    tsdf_version: "0.9.4".into(),
                    crs: Crs::epsg(26910),
                },
            ],
        };
        assert_eq!(pkg.effective_tier(), Tier::T2);
    }
}
