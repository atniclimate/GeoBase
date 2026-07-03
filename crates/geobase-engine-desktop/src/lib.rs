//! # geobase-engine-desktop
//!
//! The **Desktop Engine** — the heavyweight local node. It owns the secure GPKG
//! vault, the catalog, a local tile/data server (for the embedded MapLibre view),
//! TSDF enforcement, and (Phase 2.0) the federation server. It is what makes a
//! GeoBase install "grounded to place": a node is bound to a territory and T2/T3
//! data never leaves it.
//!
//! Scaffold only. The Tauri shell + axum server land in roadmap Phase 1.0.

use geobase_tsdf::{source_from_config, SourceKind};

/// A node's grounding — which place it is bound to. Loaded from `place.toml`.
/// (See `place.example.toml`.) T2/T3 datasets are pinned to this node.
pub struct Grounding {
    pub node_id: String,
    pub territory: String,
    /// Home CRS hint for the territory (data is still stored in native CRS).
    pub home_crs: String,
}

/// The running desktop node.
pub struct Node {
    pub grounding: Grounding,
    pub tsdf_origin: String,
}

impl Node {
    /// Boot a node, resolving its TSDF tier model from config (vendored by default).
    pub fn boot(grounding: Grounding, source: SourceKind) -> Result<Node, EngineError> {
        let src = source_from_config(source);
        // Fail fast if the tier model can't load — a node must never run without
        // a known sovereignty policy in force.
        let spec = src.load().map_err(|e| EngineError::Tsdf(e.to_string()))?;
        let _ = spec.default_classification();
        Ok(Node {
            grounding,
            tsdf_origin: src.origin(),
        })
    }
}

/// Errors from the desktop engine.
#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("tsdf error: {0}")]
    Tsdf(String),
    #[error("engine feature not yet implemented: {0}")]
    NotImplemented(&'static str),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_boots_with_vendored_tsdf() {
        let node = Node::boot(
            Grounding {
                node_id: "demo".into(),
                territory: "Example Territory".into(),
                home_crs: "EPSG:3857".into(),
            },
            SourceKind::Vendored,
        )
        .unwrap();
        assert_eq!(node.tsdf_origin, "vendored:embedded");
    }
}
