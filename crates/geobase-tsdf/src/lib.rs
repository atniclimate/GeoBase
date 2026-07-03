//! # geobase-tsdf
//!
//! GeoBase's implementation of the **Tiered Sovereign Data Framework (TSDF)**.
//!
//! Tier definitions are **not hardcoded**. They load at runtime from a
//! [`TsdfSource`], so the tier model can evolve with the upstream framework
//! version and can migrate from a vendored file → the public GitHub framework →
//! a future private/local governance server, all by swapping the source in
//! config rather than rewriting code.
//!
//! Canonical framework: <https://github.com/atniclimate/TieredSovereignDataFramework>
//! Pinned version vendored under `spec/tsdf/` (see [`VENDORED_TIERS`]).

use serde::{Deserialize, Serialize};

/// The four TSDF tiers. Ordinal order is ascending sensitivity: `T0 < T3`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum Tier {
    /// Open/Public — federated baseline, auto-distributed.
    T0,
    /// Network — shared within the Indigenous network.
    T1,
    /// Negotiated — external partners via formal agreement (product only, never source).
    T2,
    /// Sovereign — never leaves community systems; local-only, ceremony-gated.
    T3,
}

impl Tier {
    /// Parse a tier code such as `"T2"`.
    pub fn from_code(code: &str) -> Option<Tier> {
        match code.trim().to_ascii_uppercase().as_str() {
            "T0" => Some(Tier::T0),
            "T1" => Some(Tier::T1),
            "T2" => Some(Tier::T2),
            "T3" => Some(Tier::T3),
            _ => None,
        }
    }

    /// The canonical code string, e.g. `"T2"`.
    pub fn code(&self) -> &'static str {
        match self {
            Tier::T0 => "T0",
            Tier::T1 => "T1",
            Tier::T2 => "T2",
            Tier::T3 => "T3",
        }
    }

    /// Whether data at this tier may ever leave the local node.
    /// T3 never leaves community systems; T2 leaves only as a derived product.
    pub fn allows_egress(&self) -> bool {
        !matches!(self, Tier::T3)
    }
}

/// A single tier definition, as loaded from a TSDF source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TierDef {
    pub code: String,
    pub name: String,
    pub definition: String,
    pub geobase_behavior: String,
    pub ai_training: String,
    pub ai_inference: String,
}

/// A complete, versioned TSDF specification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TsdfSpec {
    pub version: String,
    pub default_tier: String,
    pub principle: String,
    #[serde(default)]
    pub grounded_in: Vec<String>,
    #[serde(rename = "tier")]
    pub tiers: Vec<TierDef>,
}

impl TsdfSpec {
    /// The tier assigned to new / unclassified data: "When in doubt, classify as T3."
    pub fn default_classification(&self) -> Tier {
        Tier::from_code(&self.default_tier).unwrap_or(Tier::T3)
    }

    /// Look up a tier definition by code.
    pub fn tier(&self, tier: Tier) -> Option<&TierDef> {
        self.tiers.iter().find(|t| t.code == tier.code())
    }
}

/// Errors from loading a TSDF specification.
#[derive(Debug, thiserror::Error)]
pub enum TsdfError {
    #[error("failed to parse TSDF spec: {0}")]
    Parse(#[from] toml::de::Error),
    #[error("TSDF spec is invalid: {0}")]
    Invalid(String),
    #[error("TSDF source not yet implemented: {0}")]
    NotImplemented(&'static str),
}

/// A pluggable origin for the TSDF tier model.
///
/// Implementations let the same GeoBase binary read tier definitions from a
/// vendored file today and a private governance server tomorrow, chosen by
/// config. See [`VendoredSource`], [`GitHubSource`], [`LocalServerSource`].
pub trait TsdfSource {
    /// Load and validate the current tier specification.
    fn load(&self) -> Result<TsdfSpec, TsdfError>;
    /// Human-readable origin, for audit records (e.g. `"vendored:spec/tsdf"`).
    fn origin(&self) -> String;
}

/// The vendored, pinned TSDF spec compiled into the binary from `spec/tsdf/tiers.toml`.
/// This is the offline default and the anchor `GitHubSource` diffs against.
pub const VENDORED_TIERS: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../spec/tsdf/tiers.toml"
));

/// Reads the vendored tier model. Offline, deterministic, always available.
pub struct VendoredSource {
    raw: String,
    origin: String,
}

impl VendoredSource {
    /// Use the tier model embedded at compile time from `spec/tsdf/tiers.toml`.
    pub fn embedded() -> Self {
        Self {
            raw: VENDORED_TIERS.to_string(),
            origin: "vendored:embedded".to_string(),
        }
    }

    /// Use a tier model from an explicit TOML string (e.g. read from disk at runtime).
    pub fn from_str(raw: impl Into<String>, origin: impl Into<String>) -> Self {
        Self {
            raw: raw.into(),
            origin: origin.into(),
        }
    }
}

impl TsdfSource for VendoredSource {
    fn load(&self) -> Result<TsdfSpec, TsdfError> {
        let spec: TsdfSpec = toml::from_str(&self.raw)?;
        validate(&spec)?;
        Ok(spec)
    }

    fn origin(&self) -> String {
        self.origin.clone()
    }
}

/// Fetches the tier model from the public atniclimate framework repo and diffs
/// it against the vendored anchor. **Stub** — network fetch lands in a later phase;
/// adoption of a new version is always a deliberate sovereign decision, never
/// automatic, so this intentionally does not silently self-update.
pub struct GitHubSource {
    pub repo: String,
    pub git_ref: String,
}

impl Default for GitHubSource {
    fn default() -> Self {
        Self {
            repo: "atniclimate/TieredSovereignDataFramework".to_string(),
            git_ref: "main".to_string(),
        }
    }
}

impl TsdfSource for GitHubSource {
    fn load(&self) -> Result<TsdfSpec, TsdfError> {
        Err(TsdfError::NotImplemented(
            "GitHubSource: upstream fetch + sovereign-review diff (roadmap)",
        ))
    }

    fn origin(&self) -> String {
        format!("github:{}@{}", self.repo, self.git_ref)
    }
}

/// Reads the tier model from a future private/local TSDF governance server.
/// **Stub interface** — wired now so migration off the public repo is a config
/// change, not a rewrite (roadmap Phase 2.2).
pub struct LocalServerSource {
    pub endpoint: String,
}

impl TsdfSource for LocalServerSource {
    fn load(&self) -> Result<TsdfSpec, TsdfError> {
        Err(TsdfError::NotImplemented(
            "LocalServerSource: private/local governance server (roadmap Phase 2.2)",
        ))
    }

    fn origin(&self) -> String {
        format!("local-server:{}", self.endpoint)
    }
}

/// Which TSDF source a node uses, selected from config.
pub enum SourceKind {
    Vendored,
    GitHub,
    LocalServer(String),
}

/// Build a [`TsdfSource`] from configuration. Migration between origins is a
/// config change here — no code path in GeoBase hardcodes tier semantics.
pub fn source_from_config(kind: SourceKind) -> Box<dyn TsdfSource> {
    match kind {
        SourceKind::Vendored => Box::new(VendoredSource::embedded()),
        SourceKind::GitHub => Box::new(GitHubSource::default()),
        SourceKind::LocalServer(endpoint) => Box::new(LocalServerSource { endpoint }),
    }
}

fn validate(spec: &TsdfSpec) -> Result<(), TsdfError> {
    if spec.version.trim().is_empty() {
        return Err(TsdfError::Invalid("empty version".into()));
    }
    for expected in ["T0", "T1", "T2", "T3"] {
        if !spec.tiers.iter().any(|t| t.code == expected) {
            return Err(TsdfError::Invalid(format!("missing tier {expected}")));
        }
    }
    if Tier::from_code(&spec.default_tier).is_none() {
        return Err(TsdfError::Invalid(format!(
            "default_tier '{}' is not a valid tier code",
            spec.default_tier
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vendored_spec_loads_pinned_version_and_four_tiers() {
        let spec = VendoredSource::embedded()
            .load()
            .expect("vendored spec loads");
        assert_eq!(spec.version, "0.9.4", "pinned TSDF version");
        assert_eq!(spec.tiers.len(), 4, "exactly four tiers");
        for code in ["T0", "T1", "T2", "T3"] {
            assert!(spec.tier(Tier::from_code(code).unwrap()).is_some());
        }
    }

    #[test]
    fn unclassified_data_defaults_to_t3() {
        let spec = VendoredSource::embedded().load().unwrap();
        assert_eq!(spec.default_classification(), Tier::T3);
    }

    #[test]
    fn t3_never_permits_egress() {
        assert!(!Tier::T3.allows_egress());
        assert!(Tier::T0.allows_egress());
    }

    #[test]
    fn stub_sources_report_origin_and_defer() {
        assert!(GitHubSource::default().load().is_err());
        assert!(LocalServerSource {
            endpoint: "https://tsdf.internal".into()
        }
        .load()
        .is_err());
        assert!(GitHubSource::default().origin().starts_with("github:"));
    }

    #[test]
    fn config_selects_vendored_source() {
        let src = source_from_config(SourceKind::Vendored);
        assert_eq!(src.load().unwrap().version, "0.9.4");
        assert_eq!(src.origin(), "vendored:embedded");
    }
}
