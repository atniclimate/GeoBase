//! # geobase-ingestor — "Weir"
//!
//! The ingestor packages arbitrary inputs — files, imagery, shapefiles,
//! databases — into **TSDF-tagged secure GeoPackages**, applying sovereignty
//! compliance uniformly at the point of ingest.
//!
//! The name **Weir** is a proposal: a weir is traditional Coast Salish fishing
//! technology that selectively controls what passes through — the exact metaphor
//! for an ingestor that gates what flows out by TSDF tier. (Name not final; the
//! crate id stays `geobase-ingestor` so renaming is cheap.)
//!
//! Scaffold only — the packaging pipeline lands in roadmap Phase 0.3.

use geobase_tsdf::{Tier, TsdfSource, VendoredSource};

/// A request to package an input into the secure vault.
pub struct IngestRequest {
    pub source_path: String,
    /// Requested tier. If `None`, the TSDF default (T3) applies:
    /// "When in doubt, classify as T3."
    pub tier: Option<Tier>,
}

/// Result of an ingest: a handle plus the tier and TSDF version it was stamped with.
pub struct IngestResult {
    pub dataset_id: String,
    pub tier: Tier,
    pub tsdf_version: String,
}

/// Resolve the tier for a request, honoring the TSDF default when unspecified.
pub fn resolve_tier(req: &IngestRequest) -> Result<(Tier, String), IngestError> {
    let spec = VendoredSource::embedded()
        .load()
        .map_err(|e| IngestError::Tsdf(e.to_string()))?;
    let tier = req.tier.unwrap_or_else(|| spec.default_classification());
    Ok((tier, spec.version))
}

/// Package an input into a TSDF-tagged secure GeoPackage.
///
/// Not yet implemented — see `docs/ROADMAP.md` Phase 0.3.
pub fn ingest(_req: &IngestRequest) -> Result<IngestResult, IngestError> {
    Err(IngestError::NotImplemented(
        "Weir packaging pipeline (roadmap Phase 0.3)",
    ))
}

/// Errors from the ingestor.
#[derive(Debug, thiserror::Error)]
pub enum IngestError {
    #[error("ingest not yet implemented: {0}")]
    NotImplemented(&'static str),
    #[error("tsdf error: {0}")]
    Tsdf(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unspecified_tier_defaults_to_t3() {
        let req = IngestRequest {
            source_path: "some.shp".into(),
            tier: None,
        };
        let (tier, version) = resolve_tier(&req).unwrap();
        assert_eq!(tier, Tier::T3);
        assert_eq!(version, "0.9.4");
    }
}
