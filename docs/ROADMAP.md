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

### 0.3 — Ingestor (GeoPack) MVP  *(complete — gate met in CI)*
First real work for `geobase-ingestor`. Take a shapefile and a GeoTIFF, package
them into a **GeoPack** — a secure GeoPackage bundle carrying TSDF tier +
framework version + an audit record. Unclassified inputs default to T3.
Round-trip verified by re-opening in the engine. (Phase 0.2's
`scripts/make_t0_baseline.py` is the working sketch this formalizes in Rust.)

**Gate:** `scripts/geopack_gate.py`, run continuously by the `GeoPack Gate`
workflow — a T0-classified fixture pack passes the GDAL cross-implementation
oracle value-for-value and flows through the engine tile path; the same
fixtures ingested unclassified default to **T3 and are refused** by the
public tile emitter. Enforcement observed, both directions. Implementation
is pure Rust (no GDAL in the product; see `docs/DECISIONS.md`, 2026-07-06).

### 1.0 — Desktop Engine core  *(complete — gate met)*
`geobase-engine-desktop` gains its Tauri shell and an `axum` local server that
serves tiles/data to the embedded MapLibre view. The node loads `place.toml` and
is "grounded." This is where GeoBase becomes a real local node, not just libraries.

**Gate artifact:** [`docs/verification/phase-1.0-desktop-node.png`](verification/phase-1.0-desktop-node.png)
— the Tauri shell rendering the T0 baseline in its embedded MapLibre, tiles
served by the grounded node over `127.0.0.1` (webview keep-alive connections
to the node verified at capture time). Ongoing enforcement: the
`node-render-gate` CI job drives the Phase 0.2 pixel-diff harness through a
booted node (`NODE_URL`), proving node-served displacement continuously.
The server ships the egress stance: loopback-only bind (not configurable),
DNS-rebinding + CORS loopback guard, T2/T3 feature serving refused until the
Phase 1.2 ceremony exists. Desktop shell is feature-gated (`--features
shell`) so workspace CI stays webkit-free.

### 1.1 — Layer packages  *(complete — gate met)*
Generalize import so GeoPackages/shapefiles register as stackable layer packages
(LandCover, Flood projections, Responsible Siting). A package's effective tier is
the most restrictive of its datasets (already modeled in `geobase-core`).
Shipped: `geopack package --manifest pkg.toml` (one GeoPack = one layer package;
frozen manifest schema in `geobase-ingestor::package` docs), the
`GET /api/packs/{id}/layers` render-metadata surface (T0/T1 only — T2/T3 refuse
before the artifact is opened), and the engine-light layer panel with
URL-as-state (`?layers=pack.table,…` — shareable views; same state boots the
desktop shell via `GEOBASE_LAYERS`).

**Gate artifact:** [`docs/verification/phase-1.1-desktop-layers.png`](verification/phase-1.1-desktop-layers.png)
— the desktop shell rendering both fixture layer packages (landcover +
flood) stacked over the node-served T0 baseline. Ongoing enforcement: the
`layer-gate` CI job packages the two committed fixture manifests with the
real `geopack` CLI, boots a grounded node, and pixel-diff-asserts in
`engine-light/scripts/verify-layers.mjs` that each package repaints alone,
stacks on the other, differs from the other, and removes cleanly back to
baseline — plus the `?layers=` boot restoring the same render. Raster
overlays (color ramps) are deliberately out of scope until a later phase;
vector-layer fixtures are natively EPSG:4326 because the features endpoint
serves native-CRS GeoJSON (viewer-side reprojection arrives with a wider
CRS phase).

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

> **Note (2026-07-11, Phase 0 congruence):** a candidate digital-twin
> expansion of this phase (deck.gl/COPC point-cloud streaming, an optional
> CesiumJS escalation path) was scanned in now-**superseded** working docs
> (`docs/GEOBASE-BUILD-DIRECTIVE.md`, `docs/GEOBASE-DIGITAL-TWIN-FEATURES.md`
> — see their in-file status banners and `docs/DECISIONS.md` 2026-07-11).
> Under the ratified 1.0 line (`docs/RELEASE-DEFINITION.md`, RATIFIED
> 2026-07-16), that scope is
> **non-gating 1.x backlog only** and is not adopted here; this phase's
> wording stays "optional native Rust/`wgpu`" and stays consistent with
> `docs/ARCHITECTURE.md`'s rendering decision (a heavy-render path is "a
> deferred Phase 2.1 option, not a v1 requirement"). If a future session
> adopts the deck.gl direction, it is recorded as a fresh `docs/DECISIONS.md`
> entry and this note is updated in the same commit — not read as
> pre-authorization.

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
