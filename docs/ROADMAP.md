# GeoBase Roadmap — the 10-Phase Spine

GeoBase is built as a *spine*: a stable core that a phased development process
hangs off of. Phases run `0.1 → 0.2 → 0.3 → 1.0 → 1.1 → 1.2 → 1.3 → 2.0 → 2.1 → 2.2`.

Every phase has a **Goal** and an **acceptance gate** — the thing that must be
*observed*, not merely built. The gates are deliberately about observed behavior
because the prototype failed by passing data checks while the actual map never
rendered (see [`LESSONS-FROM-PROTOTYPE.md`](LESSONS-FROM-PROTOTYPE.md)).

| Phase | Name | Goal | Acceptance gate |
|------|------|------|-----------------|
| **0.1** | Spine / Scaffold | Public repo, monorepo skeleton, TSDF vendored + resolver, core data-model types, docs, CI, Pages placeholder | Repo builds green in CI; `ROADMAP.md` + `TSDF-INTEGRATION.md` published; Pages placeholder live |
| **0.2** | Baseline render proof | Light Engine loads a terrain/elevation/surface-type **GeoPackage baseline (T0)** and renders true 3D from a **local** source | Headless **screenshot at ~45° pitch** shows displaced terrain (not a flat drape) — the prototype's exact failure, proven fixed |
| **0.3** | Ingestor (GeoPack) MVP | Package a shapefile + GeoTIFF into a **TSDF-tagged secure GPKG** with version stamp + audit record | Round-trip: ingest → open in engine → tier + audit metadata present and correct |
| **1.0** | Desktop Engine core | Rust/Tauri local node: catalog, GPKG vault, local `axum` tile server, `place.toml` grounding | Desktop app opens a grounded node and serves the T0 baseline to its embedded MapLibre |
| **1.1** | Layer packages | Import GeoPackage/shapefile as stackable **layer packages** (LandCover, Flood, Responsible Siting) with layer UI | Two independent layer packages toggle/stack over the baseline in both engines |
| **1.2** | TSDF enforcement + ceremony | Tier-based access control, **permissions ceremony (FPIC)** for T2/T3, audit trails, **architectural T3 egress guarantee** | T3 dataset is provably non-exportable/non-networkable; T2 export requires a recorded agreement; audit trail complete |
| **1.3** | SoLO framework + RStep | SoLO SDK + **RStep** (renewable capacity, NoGo zones); **paint opportunity → export T2 shapefile without source disclosure** | RStep paints an opportunity polygon and exports a shapefile containing *only* the product — source layers absent from output |
| **2.0** | Federation (FIDP) | **T0 baseline auto-distribution** to federated GeoBase nodes; multi-node sync per FIDP | Second node auto-receives an updated T0 baseline; T2/T3 confirmed to never transit |
| **2.1** | Secure high-res layers | Ingest **LiDAR / remote sensing** into secure GPKG; optional native Rust/`wgpu` render path for heavy data | 1 m LiDAR layer ingested as T3 and rendered locally without egress |
| **2.2** | Hardening & server-migration path | Switch TSDF resolver toward **private/local server** (`LocalServerSource`), packaging, security review, versioned-TSDF update flow | Resolver source swapped via config only; security review passed; TSDF version-bump flow demonstrated |

---

## Phase detail

### 0.1 — Spine / Scaffold  *(complete — tagged `v0.1.0`)*
Stand up the monorepo (Cargo + pnpm workspaces), vendor TSDF v0.9.4 with the
pluggable `TsdfSource` resolver, define the shared data-model vocabulary in
`geobase-core`, write the docs, wire CI + a Pages placeholder, and publish the
public repo. **Deliverable of this phase = everything needed to build the rest.**

### 0.2 — Baseline render proof  *(complete — gate met)*
Prove the render pipeline the prototype could not. The Light Engine loads a small
terrain/elevation/surface-type GeoPackage as the T0 baseline and enables MapLibre
3D terrain from a **local `raster-dem` source** (no Cesium Ion, no cloud). The gate
is a rendered screenshot at pitch — the single most important lesson encoded as a
CI-checkable artifact.

**Gate artifact:** [`docs/verification/phase-0.2-terrain-45deg.png`](verification/phase-0.2-terrain-45deg.png)
— headless capture at 45° pitch, displaced terrain from bundled local Terrarium
tiles (T0, provisional). Ongoing enforcement is the terrain-on/off pixel-diff
assertion in `engine-light/scripts/verify-render.mjs` (run locally pre-push and
by the `Render Gate` workflow); the committed PNG is the one-time human-endorsed
capture, never byte-compared.

### 0.3 — Ingestor (GeoPack) MVP
First real work for `geobase-ingestor`. Take a shapefile and a GeoTIFF, package
them into a **GeoPack** — a secure GeoPackage bundle carrying TSDF tier +
framework version + an audit record. Unclassified inputs default to T3.
Round-trip verified by re-opening in the engine. (Phase 0.2's
`scripts/make_t0_baseline.py` is the working sketch this formalizes in Rust.)

### 1.0 — Desktop Engine core
`geobase-engine-desktop` gains its Tauri shell and an `axum` local server that
serves tiles/data to the embedded MapLibre view. The node loads `place.toml` and
is "grounded." This is where GeoBase becomes a real local node, not just libraries.

### 1.1 — Layer packages
Generalize import so GeoPackages/shapefiles register as stackable layer packages
(LandCover, Flood projections, Responsible Siting). A package's effective tier is
the most restrictive of its datasets (already modeled in `geobase-core`).

### 1.2 — TSDF enforcement + ceremony
Turn policy into mechanism: tier-based access control, an FPIC permissions
ceremony for T2/T3, append-only audit trails, and the **architectural guarantee**
that T3 cannot be exported or networked (encryption at rest, no egress code path).

### 1.3 — SoLO framework + RStep
Flesh out the SoLO SDK and ship RStep: orchestrate renewable-capacity and NoGo
layers, paint areas of opportunity, and export a T2 shapefile of the **product
only** — the core "share without disclosing source" capability.

### 2.0 — Federation (FIDP)
Implement GeoBase's profile of the Federated Indigenous Data Protocol. T0
baselines advertise, verify, and auto-distribute to peer nodes; T1–T3 provably
never transit. See `spec/fidp/`.

### 2.1 — Secure high-res layers
Ingest LiDAR / remote sensing into secure GPKGs (T3 by default) and add an
optional native Rust/`wgpu` render path for data too heavy for the browser.

### 2.2 — Hardening & server-migration path
Exercise the `LocalServerSource` so a Tribe can move TSDF governance to a private
or local server by config alone. Full security review, packaging, and a
demonstrated TSDF version-bump adoption flow.

---

## Naming still open

- **Ingestor:** current codename **"GeoPack"** — named for the *artifact* it
  produces: a packed, harmonized, TSDF-tagged bundle of data + documents that
  enters GeoBase like a zip built for sovereign geodata. (Prior codename
  "Weir", the Coast Salish fishing weir; its selective-gating idea lives on in
  tier enforcement.) Crate id stays `geobase-ingestor` until the name is final.
