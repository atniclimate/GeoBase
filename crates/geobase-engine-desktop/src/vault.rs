//! The node's **GPKG vault** — a directory of GeoPacks — and its catalog.
//!
//! Scanning rules:
//! - Non-recursive scan of `*.gpkg` in the vault dir, sorted by id.
//! - A missing vault dir is an empty vault (fresh node), not an error.
//! - A file that fails to open as a GeoPackage is a **loud error** naming
//!   the file — a vault with a corrupt pack must not silently hide it.
//! - Tier comes from the artifact's own TSDF tags
//!   (`GeoPackage::geopackage_tier`, most-restrictive semantics). An
//!   **untagged** pack catalogs as **T3** with `tagged: false` — "when in
//!   doubt, classify as T3" applies to reading, too.
//! - `tables` lists `gpkg_contents` rows (name + data_type) so the server
//!   can route without reopening every pack.

use std::path::{Path, PathBuf};

use geobase_gpkg::GeoPackage;
use geobase_tsdf::Tier;

/// One pack in the vault catalog.
#[derive(Debug, Clone)]
pub struct CatalogEntry {
    /// File stem (unique within the vault by construction).
    pub id: String,
    pub path: PathBuf,
    /// Effective tier (artifact tags; T3 when untagged).
    pub tier: Tier,
    /// Whether the artifact carried TSDF tags at all.
    pub tagged: bool,
    /// TSDF framework version from the tags, when tagged.
    pub tsdf_version: Option<String>,
    pub tables: Vec<TableInfo>,
}

/// One `gpkg_contents` row.
#[derive(Debug, Clone)]
pub struct TableInfo {
    pub name: String,
    /// `gpkg_contents.data_type` (e.g. `"features"`, `"2d-gridded-coverage"`).
    pub data_type: String,
}

/// Errors from vault scanning.
#[derive(Debug, thiserror::Error)]
pub enum VaultError {
    #[error("io error scanning vault {path}: {source}")]
    Io {
        path: String,
        source: std::io::Error,
    },
    #[error("vault pack {path} is not readable as a GeoPackage: {detail}")]
    BadPack { path: String, detail: String },
}

/// Scan `dir` per the module contract.
pub fn scan(dir: &Path) -> Result<Vec<CatalogEntry>, VaultError> {
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut entries = Vec::new();
    let read_dir = std::fs::read_dir(dir).map_err(|source| VaultError::Io {
        path: dir.display().to_string(),
        source,
    })?;

    for entry in read_dir {
        let entry = entry.map_err(|source| VaultError::Io {
            path: dir.display().to_string(),
            source,
        })?;
        let path = entry.path();
        if !is_gpkg_path(&path) {
            continue;
        }
        // Defense in depth: the export ledger carries this reserved name and
        // is a T3 node-history artifact. It is meant to live in `exports_dir`
        // (outside the vault), but if a node is ever misconfigured so the two
        // overlap, the ledger must STILL never be catalogued/served. Skip it
        // by name unconditionally.
        if is_reserved_ledger(&path) {
            continue;
        }
        entries.push(scan_pack(path)?);
    }

    entries.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(entries)
}

fn scan_pack(path: PathBuf) -> Result<CatalogEntry, VaultError> {
    let display_path = path.display().to_string();
    let gpkg = GeoPackage::open(&path).map_err(|source| VaultError::BadPack {
        path: display_path.clone(),
        detail: source.to_string(),
    })?;
    let tags = gpkg
        .read_tsdf_tags()
        .map_err(|source| VaultError::BadPack {
            path: display_path.clone(),
            detail: source.to_string(),
        })?;
    let tier = gpkg
        .geopackage_tier()
        .map_err(|source| VaultError::BadPack {
            path: display_path.clone(),
            detail: source.to_string(),
        })?
        .unwrap_or(Tier::T3);
    let tables = read_tables(&gpkg, &display_path)?;
    let id = path
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tsdf_version = tags
        .iter()
        .find(|tag| tag.scope == "geopackage")
        .or_else(|| tags.iter().find(|tag| tag.scope == "table"))
        .map(|tag| tag.tsdf_version.clone());

    Ok(CatalogEntry {
        id,
        path,
        tier,
        tagged: !tags.is_empty(),
        tsdf_version,
        tables,
    })
}

fn read_tables(gpkg: &GeoPackage, path: &str) -> Result<Vec<TableInfo>, VaultError> {
    let mut stmt = gpkg
        .conn()
        .prepare("SELECT table_name, data_type FROM gpkg_contents ORDER BY table_name")
        .map_err(|source| VaultError::BadPack {
            path: path.to_string(),
            detail: source.to_string(),
        })?;
    let rows = stmt
        .query_map([], |row| {
            Ok(TableInfo {
                name: row.get(0)?,
                data_type: row.get(1)?,
            })
        })
        .map_err(|source| VaultError::BadPack {
            path: path.to_string(),
            detail: source.to_string(),
        })?;

    let mut tables = Vec::new();
    for row in rows {
        tables.push(row.map_err(|source| VaultError::BadPack {
            path: path.to_string(),
            detail: source.to_string(),
        })?);
    }
    Ok(tables)
}

/// Re-resolve a pack's **current** effective tier by reopening the
/// artifact and reading its TSDF tags right now — NOT the tier cached in
/// the boot catalog (review B3 F1a). A pack reclassified or replaced while
/// the node is up must be evaluated at its present classification.
/// Missing, unreadable, or unclassifiable → **T3** (fail-closed, "when in
/// doubt, T3"): a node that cannot currently prove a low tier must treat
/// the pack as sovereign.
pub fn current_effective_tier(path: &Path) -> Tier {
    match GeoPackage::open(path) {
        Ok(gpkg) => effective_tier_of(&gpkg),
        // Missing/unreadable artifact — sovereign by default.
        Err(_) => Tier::T3,
    }
}

/// The effective tier of an ALREADY-OPEN artifact handle (review B3 F1b):
/// the serving routes read tier and data from the SAME open `GeoPackage`
/// so a file swapped between a tier check and a data read can never be
/// served at the stale tier — one open, one artifact, check and use
/// coherent by construction. Untagged or unreadable tags → T3.
pub fn effective_tier_of(gpkg: &GeoPackage) -> Tier {
    match gpkg.geopackage_tier() {
        Ok(Some(tier)) => tier,
        Ok(None) | Err(_) => Tier::T3,
    }
}

/// The reserved file name of the T3 export ledger (`export.rs`). Never
/// catalogued, wherever it is found.
pub const RESERVED_LEDGER_NAME: &str = "node-audit.gpkg";

fn is_reserved_ledger(path: &Path) -> bool {
    let reserved = |name: &str| {
        name.eq_ignore_ascii_case(RESERVED_LEDGER_NAME)
            || name.eq_ignore_ascii_case(geobase_gpkg::consent_store::RESERVED_CONSENT_STORE_NAME)
    };
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(reserved)
}

fn is_gpkg_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("gpkg"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use geobase_gpkg::TsdfTag;
    use serde_json::Map;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn missing_dir_scans_as_empty_vault() {
        let dir = temp_dir("missing").join("does-not-exist");
        assert!(scan(&dir).unwrap().is_empty());
    }

    #[test]
    fn scan_catalogs_untagged_and_tagged_packs_in_id_order() {
        let dir = temp_dir("catalog");
        let untagged_path = dir.join("z_untagged.gpkg");
        GeoPackage::create(&untagged_path).unwrap();

        let tagged_path = dir.join("a_tagged.GPKG");
        let tagged = GeoPackage::create(&tagged_path).unwrap();
        tagged
            .write_tsdf_tag(&TsdfTag {
                table: None,
                tier: Tier::T0,
                tsdf_version: "0.9.4".into(),
                tsdf_source_origin: "vendored:embedded".into(),
                classified_by: "vault-test".into(),
                extras: Map::new(),
            })
            .unwrap();
        drop(tagged);

        let catalog = scan(&dir).unwrap();
        assert_eq!(catalog.len(), 2);
        assert_eq!(catalog[0].id, "a_tagged");
        assert_eq!(catalog[0].tier, Tier::T0);
        assert!(catalog[0].tagged);
        assert_eq!(catalog[0].tsdf_version.as_deref(), Some("0.9.4"));
        assert!(catalog[0].tables.is_empty());
        assert_eq!(catalog[1].id, "z_untagged");
        assert_eq!(catalog[1].tier, Tier::T3);
        assert!(!catalog[1].tagged);
        assert_eq!(catalog[1].tsdf_version, None);
        assert!(catalog[1].tables.is_empty());
    }

    #[test]
    fn corrupt_gpkg_extension_is_bad_pack() {
        let dir = temp_dir("bad-pack");
        let fake = dir.join("fake.gpkg");
        fs::write(&fake, b"not a geopackage").unwrap();

        let err = scan(&dir).unwrap_err();
        match err {
            VaultError::BadPack { path, .. } => assert!(path.ends_with("fake.gpkg")),
            other => panic!("expected BadPack, got {other:?}"),
        }
    }

    fn temp_dir(prefix: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("geobase-vault-{prefix}-{nonce}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }
}
