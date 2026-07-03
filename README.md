# GeoBase

**A sovereign geospatial baseline platform for Tribal Nations.**

GeoBase is an interchangeable geospatial platform and a development *spine*. It
provides a baseline of terrain, elevation, and surface types (the **T0** layer),
imports GeoPackage/shapefile **layer packages** (LandCover, Flood projections,
Responsible Siting, …), hosts **SoLO** (Sovereign Layer Orchestrator) mini-apps
such as **RStep**, and enforces the **Tiered Sovereign Data Framework (TSDF)**
system-wide — so Tribes can add high-resolution secure data (LiDAR, remote
sensing), "paint" areas of opportunity, and export shareable products for
partners **without ever disclosing source data**.

> Built by the Affiliated Tribes of Northwest Indians — Tribal Climate Resilience.

## Why it exists

GeoBase is a ground-up rebuild after a prototype hit a wall: its data pipeline
verified green at every step, yet the cloud-dependent 3D terrain renderer never
worked, and the project drowned in duplicate viewers and co-located data. GeoBase
fixes those root causes by design — see [`docs/LESSONS-FROM-PROTOTYPE.md`](docs/LESSONS-FROM-PROTOTYPE.md).

## Architecture at a glance

- **Spine (`crates/geobase-core`)** — shared data model, catalog, CRS pipeline,
  layer-package API.
- **TSDF (`crates/geobase-tsdf`)** — versioned, pluggable tier resolver. Tier
  definitions load at runtime from a vendored file, the public framework repo, or
  (future) a private governance server — swappable by config.
- **Desktop Engine (`crates/geobase-engine-desktop`)** — the heavyweight local,
  grounded node: secure GPKG vault, local tile server, TSDF enforcement,
  federation (Rust + Tauri).
- **Light Engine (`engine-light/`)** — MapLibre GL viewer for web / small apps,
  deployable to GitHub Pages. No cloud-terrain dependency.
- **Ingestor "GeoPack" (`crates/geobase-ingestor`)** — packages files,
  documents, imagery, shapefiles, and databases into **GeoPacks**: TSDF-tagged
  secure GeoPackage bundles, harmonized and ready to serve.
- **SoLO (`solo/`)** — Sovereign Layer Orchestrator SDK + apps (RStep first).

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and the 10-phase plan in
[`docs/ROADMAP.md`](docs/ROADMAP.md).

## The TSDF tiers

| Tier | Name | Meaning |
|------|------|---------|
| **T0** | Open/Public | Publicly released by sovereign decision — the federated baseline |
| **T1** | Network | Shared within the Indigenous network |
| **T2** | Negotiated | Shared with external partners via formal agreement (product only) |
| **T3** | Sovereign | Never leaves community systems — local-only, ceremony-gated |

Default classification is **T3**: *"When in doubt, classify as T3."* See
[`docs/TSDF-INTEGRATION.md`](docs/TSDF-INTEGRATION.md). The framework itself lives
at [atniclimate/TieredSovereignDataFramework](https://github.com/atniclimate/TieredSovereignDataFramework).

## Development

Prerequisites: Rust (stable), Node ≥ 20, pnpm ≥ 9.

```powershell
# Rust workspace
cargo build --workspace
cargo test --workspace

# TypeScript workspaces
pnpm install
pnpm -r build

# Run the Light Engine locally
pnpm --filter @geobase/engine-light dev
```

## Status

**Phase 0.1 — scaffold & spine.** This is the foundation; feature work follows
the roadmap. See [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Licensing

- **Code:** Apache-2.0 (see [`LICENSE`](LICENSE)).
- **TSDF framework content** vendored under `spec/tsdf/` remains **CC-BY-NC-SA 4.0**;
  it is not relicensed by inclusion. See [`spec/tsdf/ATTRIBUTION.md`](spec/tsdf/ATTRIBUTION.md).

Geospatial **data** is never committed to this repository. Secure GeoPackages,
LiDAR, and imagery live outside version control.
