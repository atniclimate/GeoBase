//! # geobase-gpkg
//!
//! **Secure GeoPackage** handling — GeoBase's on-disk container for datasets.
//!
//! A GeoPackage is a SQLite database. GeoBase extends it with:
//! - TSDF metadata tables (tier, framework version, provenance),
//! - an append-only audit trail,
//! - at-rest encryption for T3 (`.sgpkg`), providing the *architectural egress
//!   guarantee* that T3 data cannot be read off-node.
//!
//! Scaffold only — the SQLite/SpatiaLite/SQLCipher implementation lands in
//! roadmap Phase 0.3 (ingestor) and 1.2 (enforcement). Types here fix the shape.

use geobase_core::Dataset;
use geobase_tsdf::Tier;

/// Handle to a secure GeoPackage vault entry.
pub struct SecureGpkg {
    pub path: String,
    pub tier: Tier,
}

impl SecureGpkg {
    /// Whether this container may be encrypted at rest. T3 (and, by policy,
    /// anything a node marks sensitive) requires encryption so it cannot leave.
    pub fn requires_encryption(&self) -> bool {
        matches!(self.tier, Tier::T3)
    }
}

/// A single append-only audit record. Every classification, access, and export
/// decision is recorded with the TSDF version in force at the time.
pub struct AuditRecord {
    pub dataset_id: String,
    pub action: String,
    pub tsdf_version: String,
}

/// Open (or, later, create) a secure GeoPackage for a dataset.
///
/// Not yet implemented — see `docs/ROADMAP.md` Phase 0.3.
pub fn open(_dataset: &Dataset) -> Result<SecureGpkg, GpkgError> {
    Err(GpkgError::NotImplemented(
        "secure GPKG open/create (roadmap Phase 0.3)",
    ))
}

/// Errors from secure GeoPackage operations.
#[derive(Debug, thiserror::Error)]
pub enum GpkgError {
    #[error("gpkg operation not yet implemented: {0}")]
    NotImplemented(&'static str),
    #[error("io error: {0}")]
    Io(String),
}
