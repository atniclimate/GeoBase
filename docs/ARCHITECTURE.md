# GeoBase Architecture

GeoBase is **two deployment engines over one shared data spine and one rendering
stack**. That single sentence encodes the two biggest lessons from the prototype:
avoid viewer sprawl (one rendering stack, not 29) and avoid cloud-terrain lock-in
(MapLibre local sources, not Cesium Ion).

```
                        ┌───────────────────────────────────────────┐
                        │            GeoBase Spine (core)            │
                        │  data model · catalog · CRS pipeline ·     │
                        │  TSDF resolver · audit · layer-package API │
                        └───────────────────────────────────────────┘
              ┌──────────────────────┼───────────────────────────────┐
              ▼                      ▼                                ▼
   ┌───────────────────┐  ┌────────────────────┐        ┌────────────────────────┐
   │  Desktop Engine    │  │   Light Engine      │        │  Ingestor ("Weir")     │
   │  (Rust + Tauri)    │  │  (MapLibre GL, TS)  │        │  files/img/shp/db →    │
   │  local node: GPKG  │  │  static web / small │        │  TSDF-tagged secure    │
   │  vault, tile serve,│  │  apps · GitHub Pages│        │  GeoPackage            │
   │  TSDF enforcement, │  │  T0 baseline viewer │        └────────────────────────┘
   │  federation server │  └────────────────────┘
   └───────────────────┘
              ▲
              │ hosts
   ┌────────────────────────────────────────────┐
   │  SoLO — Sovereign Layer Orchestrator apps   │
   │  RStep (renewable capacity, NoGo zones) ·   │
   │  "paint" opportunity → export T2 shapefile  │
   └────────────────────────────────────────────┘
```

## Components

### Spine — `crates/geobase-core`
The shared vocabulary: `Dataset`, `LayerPackage`, `Crs`, the `CrsPipeline`
contract. Every dataset carries a TSDF `Tier` and the framework version it was
classified under, so classification is reproducible. A layer package's
`effective_tier()` is the most restrictive of its datasets.

### TSDF — `crates/geobase-tsdf`
The compliance backbone. Tier definitions are **not hardcoded**; they load from a
`TsdfSource`:
- `VendoredSource` — offline default, embeds `spec/tsdf/tiers.toml` (v0.9.4).
- `GitHubSource` — fetches the public framework and diffs it for sovereign review.
- `LocalServerSource` — stub for a future private/local governance server.

`source_from_config(..)` selects one — migration between origins is a config
change. See [`TSDF-INTEGRATION.md`](TSDF-INTEGRATION.md).

### Desktop Engine — `crates/geobase-engine-desktop`
The heavyweight, **grounded** local node. Owns the secure GPKG vault, catalog, a
local tile/data server for the embedded MapLibre view, TSDF enforcement, and
(Phase 2.0) the federation server. Bound to a place via `place.toml`; T2/T3 data
never leaves it. Rust core + Tauri shell (added Phase 1.0).

### Light Engine — `engine-light/`
A thin MapLibre GL viewer (TypeScript + Vite) for the web and small apps,
deployable to GitHub Pages. Renders the same data as the desktop engine via
MapLibre. **No cloud-terrain dependency** — 3D terrain comes from a local
`raster-dem` source. The desktop engine embeds this same front-end, so there is
exactly one rendering stack.

### Ingestor "Weir" — `crates/geobase-ingestor`
Packages arbitrary inputs (files, imagery, shapefiles, databases) into
TSDF-tagged secure GeoPackages, applying sovereignty compliance uniformly at
ingest. Unclassified inputs default to T3.

### SoLO — `solo/`
The Sovereign Layer Orchestrator SDK (`solo/sdk`) plus apps. A SoLO app stacks
layer packages, lets a Tribe paint areas of opportunity, and exports a product
for sharing **without disclosing source data**. RStep (`solo/rstep`) is the first.

## Rendering decision

MapLibre GL JS for both engines. Its native `raster-dem` 3D terrain is proven and
free of the Cesium-Ion dependency that killed the prototype's terrain. A native
Rust/`wgpu` renderer for massive LiDAR is a **deferred Phase 2.1 option**, not a
v1 requirement.

## CRS discipline

GeoBase does not mandate a single project CRS (it serves any Tribe). It mandates a
single *pipeline*: validate source CRS → store native → reproject to `EPSG:3857`
for the viewer, asserting at every hop. See [`CRS-PIPELINE.md`](CRS-PIPELINE.md).

## Data & sovereignty boundaries

- **Data never enters git.** Code + specs + tiny fixtures only.
- **T3 has an architectural egress guarantee** — enforced by the node
  (encryption at rest, no export/network path), not by `.gitignore`.
- **Grounded to place** — a node is bound to a territory; sovereignty guarantees
  are enforced per node.
