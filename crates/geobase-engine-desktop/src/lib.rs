//! # geobase-engine-desktop
//!
//! The **Desktop Engine** — the heavyweight local node. It owns the secure
//! GPKG vault, the catalog, a local tile/data server (for the embedded
//! MapLibre view), TSDF enforcement, and (Phase 2.0) the federation
//! server. It is what makes a GeoBase install "grounded to place": a node
//! is bound to a territory and T2/T3 data never leaves it.
//!
//! Phase 1.0 wave 1: grounding loader ([`place`]), vault catalog
//! ([`vault`]), localhost-only server ([`server`]). The Tauri shell that
//! embeds the Light Engine front-end arrives in wave 2.

pub mod export;
pub mod place;
pub mod server;
pub mod session;
pub mod vault;

use std::path::Path;

use geobase_tsdf::source_from_config;

/// The running desktop node: grounding + tier model + catalog.
pub struct Node {
    pub grounding: place::Grounding,
    /// Origin of the tier model in force (e.g. `"vendored:embedded"`).
    pub tsdf_origin: String,
    /// TSDF framework version in force.
    pub tsdf_version: String,
    pub catalog: Vec<vault::CatalogEntry>,
}

impl Node {
    /// Boot a node: load grounding, resolve the tier model (fail fast — a
    /// node must never run without a known sovereignty policy in force),
    /// and scan the vault.
    pub fn boot(place_toml: &Path, vault_dir: &Path) -> Result<Node, EngineError> {
        let grounding = place::load(place_toml)?;
        let src = source_from_config(grounding.tsdf.source_kind());
        let spec = src.load().map_err(|e| EngineError::Tsdf(e.to_string()))?;
        let catalog = vault::scan(vault_dir)?;
        Ok(Node {
            grounding,
            tsdf_origin: src.origin(),
            tsdf_version: spec.version,
            catalog,
        })
    }
}

/// Errors from the desktop engine.
#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("tsdf error: {0}")]
    Tsdf(String),
    #[error(transparent)]
    Place(#[from] place::PlaceError),
    #[error(transparent)]
    Vault(#[from] vault::VaultError),
    #[error("engine feature not yet implemented: {0}")]
    NotImplemented(&'static str),
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Boot against the repo's own example grounding and an empty vault —
    /// the node must fail fast on a broken tier model and come up grounded.
    #[test]
    fn node_boots_grounded_from_example_place_toml() {
        let place = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../place.example.toml");
        let vault = std::env::temp_dir().join("geobase-empty-vault-test");
        let node = Node::boot(&place, &vault).expect("boot");
        assert_eq!(node.grounding.node_id, "example-node");
        assert_eq!(node.tsdf_origin, "vendored:embedded");
        assert_eq!(node.tsdf_version, "0.9.4");
        assert!(node.catalog.is_empty());
    }
}
