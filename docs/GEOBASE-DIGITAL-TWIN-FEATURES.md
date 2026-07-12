> **STATUS: SUPERSEDED / OUT OF SCOPE FOR PRODUCT-1.0** (recorded 2026-07-11,
> Phase 0 congruence pass; see `docs/DECISIONS.md` 2026-07-11 and
> `docs/RELEASE-DEFINITION.md`, DRAFT). This candidate-features scan directly
> contradicts tracked `docs/ARCHITECTURE.md`, which rules a native heavy-render
> path "a **deferred Phase 2.1 option**, not a v1 requirement"
> (`docs/ARCHITECTURE.md`, "Rendering decision"). Under DG-1's default
> (sovereignty-core 1.0 = the combined Phase 1.2+1.3 gate + release hardening;
> F1-F4/federation/LiDAR/digital-twin are serial, non-gating 1.x backlog), no
> verdict in this document (Part 5's checklist, the F1-F7 "ADOPT/ADAPT/DEFER"
> framing) is ratified, and none of it gates Phase 0-C. It is retained, not
> deleted, as raw research material for **post-1.0 backlog workstreams only**
> (see `PLAN_1.0.md` Backlog Queue B-1..B-4, which carries the grounded,
> re-scoped versions of F1/F2/F4). Any part later adopted requires its own
> `docs/DECISIONS.md` entry. Tracked `docs/ROADMAP.md` 2.1 keeps its "optional
> native Rust/`wgpu`" wording per the DG-1 default (see `docs/ROADMAP.md` 2.1
> note, 2026-07-11).

> **INVARIANT CONFLICT NOTICE (blocking — added 2026-07-11).** Beyond being
> superseded, specific statements in this retained research **contradict
> `AGENTS.md` invariant 3** ("no code path may export, serve, or network T3
> data. Anything weakening this is a blocking finding, always") and invariant
> 2 (unclassified data defaults to T3). Those statements are **VOID** — they
> must never be implemented as written, at any phase, backlog or not:
>
> 1. **VOID — hard constraint C4 below** ("T3 never leaves the node. Any
>    digital-twin feature that implies serving heavy data serves it only over
>    the loopback-bound node server."). This restates the T3 guarantee as a
>    *location* boundary; it is not one. Loopback HTTP is still a
>    serving/network code path and is forbidden for T3 absolutely —
>    **loopback included**. The governing rule: **T3 is never served or
>    networked, over any socket, to any origin.** Any future T3 rendering
>    must be a non-serving, non-network, in-process path, and any COPC /
>    range / tile endpoint must refuse T3 **before opening the artifact**
>    (the shipped refusal-before-open pattern).
> 2. **VOID — F5's "Survey data is Tribal primary data: default T2"** (Part
>    2, F5). Survey data defaults **T3** like all unclassified/new primary
>    data ("when in doubt, classify as T3"). T2 is reached only by an
>    **explicit sovereign classification act** through the ceremony/audit
>    path — never as a code or design default.
>
> Inline `VOID` markers appear above both passages. The research text is
> retained unmodified beneath them for the historical record only.

# GeoBase — Digital Twin Candidate Features & Integration Spec

**Status:** Candidate proposals for Claude Code vetting — nothing here is decided.
**Date:** 2026-07-06
**Inputs:** `ARCHITECTURE.md`, `ROADMAP.md`, external review of `zymazza/mazzap` (v1) and
`zymazza/mazzap_veil` (v2), plus a research scan of digital-twin architectures,
simulation engines, point-cloud formats, and rendering stacks.
**Owner intent (interview results):** capability priority is
**1) Simulation (hydrology/flood/wildfire) → 2) LiDAR→3D features → 3) Field survey
round-trip → 4) local AI query layer**. No Tribal LiDAR captures exist yet
(capacity-ahead-of-data posture; public 3DEP is the first data source). The role of a
"local Cesium" heavy-3D view is **undecided — both options spec'd below, plus a third
option discovered during research.**

## How to use this document (instructions to Claude Code)

For each candidate feature: (1) read the **GeoBase fit** and **Integration sketch**,
(2) inspect our existing components named in **Touches**, (3) answer the **Vetting
questions**, and (4) return a verdict per feature: `ADOPT` / `ADAPT` / `REJECT —
ours is superior` / `DEFER — phase N`, with reasoning. Where a feature conflicts
with an existing GeoBase decision (one rendering stack; pure Rust in product; no
GDAL in product; T3 architectural egress guarantee; loopback-only node), the
existing decision wins unless you explicitly argue for a DECISIONS.md amendment.

**Hard constraints — restated so they are never relaxed by accident:**

- C1. Product code is pure Rust (+ the existing TypeScript engines). GDAL/Python
  allowed only in CI oracles and out-of-product tooling.
- C2. One rendering stack was a load-bearing lesson from the prototype. Any second
  stack must be justified as a *scoped exception with its own gate*, not a default.
- C3. All data enters through the Ingestor: TSDF tagging, audit record,
  default-T3-if-unclassified. Simulation *outputs* are new datasets and must
  re-enter through the same door.
- **[VOID — see INVARIANT CONFLICT NOTICE at top. T3 is never served or
  networked, loopback included; `AGENTS.md` invariant 3 governs.]**
  C4. T3 never leaves the node. Any digital-twin feature that implies serving heavy
  data serves it only over the loopback-bound node server.
- C5. No new runtime cloud dependencies. Offline-first is non-negotiable.
- C6. Nothing from `zymazza/mazzap` (v1) may be copied: **no LICENSE file** in that
  repo → all-rights-reserved. Patterns may be reimplemented from scratch; code may
  not. `mazzap_veil` (v2) is MIT — adaptable with attribution.

---

## Part 1 — The rendering decision (blocks F3; decide first)

The owner wants a "local Cesium based version" for digital-twin visuals. Research
surfaced **three** viable shapes. What killed the prototype was *Cesium Ion* (cloud
terrain service) — CesiumJS itself is Apache-2.0, vendor-neutral, and fully
self-hostable, consuming quantized-mesh terrain and 3D Tiles (pnts/b3dm) from any
HTTPS endpoint, including our own node.

### Option A — CesiumJS as the Phase 2.1 heavy-data render path (inside Desktop Engine)

The roadmap already reserves a slot: "optional native Rust/`wgpu` render path for
heavy data" in Phase 2.1. Option A fills that slot with CesiumJS instead of a
from-scratch renderer. The Tauri shell gains a second view mode ("Twin view")
that mounts CesiumJS pointed exclusively at `127.0.0.1` node endpoints:
quantized-mesh terrain tiles + 3D Tiles tilesets generated at ingest.

- Pros: purpose-built for massive point clouds/meshes; mature LOD streaming;
  years cheaper than wgpu-from-scratch; confined to the grounded node (no Light
  Engine exposure, no GitHub Pages surface area).
- Cons: a second rendering stack (C2 exception); terrain must be produced twice
  (raster-dem for MapLibre, quantized-mesh for Cesium); Cesium Terrain Builder
  (the common quantized-mesh generator) is a C++/GDAL tool → must run as
  out-of-product tooling or be replaced by a Rust tiler; CesiumJS defaults
  (Ion asset URLs, Bing geocoder) must be stripped and CI-asserted absent.
- Gate sketch: node boots with network disabled at the OS level; Twin view renders
  a 3DEP-derived point cloud + terrain at pitch; a CI grep/lint proves no
  `cesium.com`/`ion` endpoints exist in the bundle; pixel-diff harness extended to
  the Twin view.

### Option B — CesiumJS as a third standalone engine

A sibling of `engine-light/`: `engine-twin/`, deployable independently.

- Pros: clean separation; Light Engine stays tiny.
- Cons: worst option under C2 — three viewers is the prototype's failure mode with
  extra steps; duplicated layer UI, state handling, CI gates. **Recommend REJECT
  unless Claude Code finds a strong argument** (e.g., a Tribe needs a
  twin-only kiosk deployment).

### Option C — deck.gl interleaved into the existing MapLibre stack (no second stack)

Discovered during research: deck.gl's MapView syncs perfectly with MapLibre's
camera and can render **interleaved into MapLibre's own WebGL2 context**. Its
`Tile3DLayer` renders 3D Tiles (pnts/b3dm/i3dm) and I3S, decomposing into
PointCloudLayer/ScenegraphLayer/SimpleMeshLayer per tile type. Better yet, the
`opengeos/maplibre-gl-lidar` plugin (built on MapLibre + deck.gl) already does
**viewport-based streaming of COPC and EPT point clouds directly**, with
classification coloring, point picking, elevation filtering, and automatic
CRS→WGS84 transformation — no 3D Tiles conversion step required at all.

- Pros: preserves "one rendering stack" (deck.gl is an overlay *inside* MapLibre,
  not a viewer); both engines (light + embedded desktop view) gain the capability
  from one integration; COPC streaming means the ingest pipeline can stop at
  COPC (a LAZ 1.4 file with an internal octree — see F2) with no tileset build;
  layer panel, `?layers=` state, and existing gates extend naturally.
- Cons: deck.gl point-cloud rendering is good but not Cesium-class for *massive*
  meshes/photogrammetry; no globe; terrain-following overlays are newer
  (TerrainExtension). For "prerendered LiDAR features" (the owner's actual ask)
  this is likely sufficient; for future photorealistic city-scale meshes it may
  not be.

**Recommended framing for the vetting discussion:** Option C is the default
(cheapest, C2-compliant, covers priorities 1–2); Option A is the *documented
escalation path* if/when a Tribe brings data deck.gl can't carry (record this in
DECISIONS.md either way); Option B is rejected. Claude Code: validate or overturn
with evidence, e.g. a point-budget benchmark of maplibre-gl-lidar vs CesiumJS on a
representative 3DEP COPC tile.

---

## Part 2 — Candidate features

Ordered by the owner's capability ranking, not build order. Each is sized
*relative to existing GeoBase machinery*, which is why several are smaller than
they sound.

### F1 — Hydrology & flood simulation service  ★ priority 1

**Source of the idea:** Mazzap v2's "hydrology simulation engine" (spring-spot
candidates, storm-flow estimation). **Source of the implementation:**
**WhiteboxTools** — *not* Mazzap. WhiteboxTools is a pure-Rust, MIT-licensed
geospatial analysis engine (Univ. of Guelph) with one of the largest open
hydrology toolsets anywhere: depression breaching/filling, D8/Dinf/FD8 flow
pointers and accumulation, watershed/basin delineation, stream-network
extraction, wetness index, and **elevation-above-stream / downslope distance to
stream** — the ingredients of HAND-style preliminary floodplain mapping. It also
reads/writes GeoTIFF and LAS/LAZ natively, with no GDAL dependency. This is the
single best license-and-language match found in the entire scan.

**What GeoBase gains:** a `geobase-sim` crate exposing named *scenario recipes*
over the T0 baseline + layer packages:

- `watershed(outlet_point | pour_points)` → basin polygons
- `streams(threshold)` → stream network vectors
- `flood_hand(stage_m)` → inundation raster for a given stage height (HAND method)
- `flow_paths(rain_event)` → accumulation/flow rasters (Mazzap's "rainstorm" sim)
- `wetness()` / `spring_candidates()` → saturation-propensity surfaces

Every recipe's output is written as a GeoPack via `geobase-ingestor` (C3):
tier = most restrictive input tier, provenance = recipe + parameters + input
dataset IDs + TSDF framework version. Simulations become first-class, auditable
layer packages that stack in the existing layer panel — **no new UI concept
needed**, which is why this is cheaper than it sounds.

**Integration sketch:**
1. Vendor/pin the MIT WhiteboxTools repo. **License trap:** the open core is MIT
   but *some tools are proprietary extensions* (manual pages marked "Source code
   is unavailable due to proprietary license" / Whitebox Geospatial Inc.). Vendor
   only tools whose source exists in the MIT repo; add a CI check that the vendored
   tree contains no extension stubs. Note also "Whitebox Next Gen" is refactoring
   toward modular pure-Rust backend libraries — Claude Code should check whether
   the modular crates are published yet, which would beat vendoring the monolith.
2. Decide linkage mode: (a) link as a Rust library if the tool functions are
   importable, else (b) build the `whitebox_tools` binary from vendored source and
   invoke as a *node-managed subprocess* with file handoff inside the vault
   directory (still C1-compliant: it's our compiled Rust, no runtime downloads).
   Claude Code: inspect the crate structure and choose; (a) strongly preferred.
3. New crate `crates/geobase-sim`: recipe registry, parameter schema (serde),
   DEM staging from the T0 GeoPackage → GeoTIFF work files in a vault tempdir,
   WhiteboxTools invocation chain, output → `geopack package` with a generated
   manifest, then registration in the catalog.
4. Node API: `POST /api/sim/{recipe}` (loopback only, refused for T2/T3 inputs
   until the Phase 1.2 ceremony exists — mirror the existing tile-emitter refusal
   pattern) returning the new pack id; the engine layer panel picks it up via the
   existing `GET /api/packs` surface.
5. **Acceptance gate (observed, per roadmap style):** CI job `sim-gate` runs
   `flood_hand` on the committed T0 fixture, asserts the output GeoPack carries
   tier + provenance + audit, renders it through the existing layer pixel-diff
   harness, and cross-checks one recipe (e.g. D8 accumulation) against a
   GDAL/richdem oracle value-for-value — same oracle pattern as the GeoPack gate.

**Wildfire note:** true fire-spread simulation (Rothermel-based engines like
ELMFIRE/FlamMap) is a different beast — external scientific codebases, mostly
Fortran/C++, heavy fuel-model inputs. **Do not** fold it into F1. v1 wildfire
support = *exposure layers*, not spread simulation: ingest LANDFIRE fuels +
Wildfire Hazard Potential via F4, derive slope/aspect/topographic-position
surfaces with WhiteboxTools (slope is a first-order fire-behavior driver), and
ship a "wildfire exposure" recipe that composites them. Spread simulation goes to
the parking lot as a candidate Phase 2.x SoLO app. Claude Code: sanity-check this
scoping.

**Touches:** `geobase-core` (Dataset/LayerPackage), `geobase-ingestor`,
desktop-engine axum server, engine-light layer panel, CI workflows.
**Vetting questions:** Is subprocess handoff acceptable inside the vault, or does
the T3 egress guarantee require in-process linkage so no plaintext work files
touch disk? Should recipe outputs default to the input tier or input-tier-floor-T1
(since derived products can leak source detail — e.g. a HAND raster reveals the
DEM)? Does `effective_tier()` already give us this for free?

---

### F2 — LiDAR → derived-features pipeline ("the twin builder")  ★ priority 2

**Source of the idea:** Mazzap v2's capability ladder — derive trees/canopy from
the best available signal (LiDAR segmentation → canopy-height model → NDVI), plus
its DSM/DTM derivation from fetched LAZ tiles. **Sources of implementation:**
WhiteboxTools LiDAR tools (LAS/LAZ interrogation, tiling/joining, outlier
analysis, ground-point classification/filtering, interpolation to DEM/intensity
rasters) + the **COPC** format.

**Key format decision — COPC as the point-cloud vault format:** COPC is a LAZ 1.4
file with points reorganized into a clustered octree described by an internal
VLR. One file. Backward compatible with every LAZ reader. Supports partial
spatial reads / LOD streaming via range requests — which our loopback node can
serve — and USGS 3DEP is already distributed in COPC/EPT form. This means: the
GeoPack for a point cloud stores `.copc.laz` inside the secure bundle; the node
streams octree nodes to the viewer (F3/Option C reads COPC natively); analysis
tools read the same file. **No second copy, no tileset build step, no format
divergence between vault, analysis, and display.** Claude Code: verify Rust COPC
support — candidate crates `las`, `laz-rs` (LAZ codec), and any copc crate;
worst case the octree VLR writer is a small piece of Rust to own ourselves (spec
is short and frozen).

**Pipeline stages (each an ingestor capability, all pure Rust):**
1. `lidar ingest` — LAZ/LAS in → validated, CRS-asserted (existing CrsPipeline),
   optionally re-sorted to COPC → GeoPack, **default T3** (existing rule; correct
   posture for future Tribal captures even though today's inputs are public 3DEP,
   which gets classified T0/T1 at ingest).
2. `lidar derive dtm|dsm|chm` — ground-classify + interpolate (WhiteboxTools) →
   GeoTIFF rasters → GeoPacks. CHM = DSM − DTM.
3. `lidar derive features` — the capability ladder, reimplemented (pattern only —
   C6 does not apply since v2 is MIT, but reimplement in Rust regardless):
   tree/canopy polygons or stem points from CHM local-maxima; degrade gracefully
   to coarser products when inputs are missing. Outputs are ordinary vector layer
   packages → they stack in the existing panel and become RStep inputs (NoGo
   zones from canopy/slope).
4. DTM optionally *promotes the T0 baseline*: a Tribe with 1 m LiDAR gets 1 m
   terrain in both engines through the existing raster-dem path — the twin and
   the map share one ground truth.

**Acceptance gate:** extends the Phase 2.1 gate already in the roadmap — a 3DEP
COPC tile ingested, DTM/CHM derived, tree features rendered over the baseline,
all without egress; plus a value-oracle check of DTM cells vs a PDAL/GDAL CI
reference.

**Touches:** `geobase-ingestor` (largest), `geobase-core` (new dataset kinds:
PointCloud, DerivedRaster), node server (COPC range-read endpoint), CRS pipeline
(vertical datums — see open question).
**Vetting questions:** Do we add a vertical-datum field to `Crs` now? (LiDAR
makes ellipsoidal-vs-orthometric height a real bug class; Mazzap punts on this.)
Is `las`/`laz-rs` maturity sufficient or do we vendor? Should stage 2/3 live in
`geobase-sim` (F1) instead of the ingestor — i.e., is "derive" a simulation or an
ingest transform? (Recommend: F1 owns anything parameterized, ingestor owns
format-level transforms only.)

---

### F3 — Heavy-3D twin view  ★ tied to Part 1 decision

Whatever Part 1 decides, F3's node-side work is identical and can start first:

1. Node endpoint serving COPC via HTTP range requests from the vault
   (loopback-only, tier-checked before byte one — reuse the T2/T3 refusal
   pattern from Phase 1.1's `/api/packs/{id}/layers`).
2. Option C path: integrate deck.gl interleaved (`MapboxOverlay`,
   `interleaved: true`, requires maplibre-gl ≥ 3 — check our pinned version) or
   evaluate adopting `opengeos/maplibre-gl-lidar` outright (inspect its license,
   quality, and dependency weight; it may be an ADAPT-not-ADOPT).
3. Option A path (if escalated): quantized-mesh terrain tiler (out-of-product
   tooling initially), 3D Tiles pnts generation from COPC at ingest, CesiumJS
   Twin view in the Tauri shell with Ion-endpoint lint.

**Gate:** the Phase 2.1 roadmap gate verbatim — "1 m LiDAR layer ingested as T3
and rendered locally without egress" — with the pixel-diff harness pointed at the
twin view, and an OS-level network-off assertion during capture.

**Vetting questions:** point-budget benchmark (5M? 20M? points at 30 fps on a
mid-tier laptop) as the objective criterion for the C-vs-A escalation; does
deck.gl interleaved coexist with our terrain-on/off pixel-diff assertions or do
the gates need a deck-aware variant?

---

### F4 — Public-data acquisition sidecar ("geobase-acquire")

Carried over from the previous review, now formalized. Adapt Mazzap v2's (MIT)
national fetcher catalog — 3DEP DEM + LiDAR tile index (TNMAccess), NAIP,
LANDFIRE (land cover, vegetation, fuels), gSSURGO, NWI, NHDPlus/WBD, FEMA NFHL,
USFWS critical habitat, EPA ecoregions, PAD-US, USDA CDL, Drought Monitor,
Wildfire Hazard Potential, LCMS — into `tools/acquire/` (Python permitted:
out-of-product, C1-compliant). Keep its safety discipline: advertised-size
check, free-disk headroom requirement, refuse-oversized sources, clip-to-AOI,
discard raw archives. Output lands in a staging dir consumed by
`geopack package` (C3). Attribution in `THIRD_PARTY_NOTICES.md`, pinned upstream
commit recorded.

This is F1/F2's fuel line: it is how a Tribe with *no data yet* (the actual
situation) gets a populated twin from an AOI polygon in an afternoon.

**Gate:** `acquire-gate` (manual/scheduled CI, network-permitted job class): fetch
a tiny fixture AOI from 2 sources, ingest, assert tier + audit + render.
**Vetting questions:** which fetchers first? (Recommend: 3DEP DEM, 3DEP LiDAR
index, LANDFIRE fuels, NHDPlus — exactly the F1/F2 inputs.) Same repo or
separate? How do we sandbox a network-permitted CI job in a repo whose product CI
is network-off?

---### F5 — Field survey round-trip (QField)  ★ priority 3

Reimplement (not copy — pattern is what matters) Mazzap v2's loop: node exports a
QField/QGIS project scoped to selected layer packages → field crew edits offline
→ zipped project (incl. photos) uploaded to the node → ingest as journaled
entities with stable UUIDs, idempotent re-upload (unchanged skipped, moved keeps
identity, retirement explicit via status field, never inferred from absence).
**[VOID — see INVARIANT CONFLICT NOTICE at top. Survey data defaults T3; T2
only by an explicit sovereign classification act.]**
Survey data is Tribal primary data: **default T2**, FPIC ceremony applies on any
export — this feature is *why* Phase 1.2's ceremony exists, so schedule after 1.2.
GeoPackage is QField's native format, which makes the export step nearly free for
us.

**Vetting questions:** does the append-only audit trail from 1.2 double as the
survey journal, or is a per-entity journal a separate mechanism? Is this a core
capability or the second SoLO app after RStep? (Recommend: SoLO app —
"GroundTruth" — it exercises the SDK.)

---

### F6 — Local AI query layer ("ask the land")  ★ priority 4 — parking lot

Mazzap v2's MCP server pattern: expose the node's catalog/terrain/entity facts as
read-only MCP tools for a **local** model (their Ollama mode proves offline
feasibility; their OpenAI default is disqualified by C5). Write access limited to
ephemeral annotations, never the store — a good boundary to keep. Strictly
T0/T1-scoped tool surface; the MCP layer sits *outside* the tier boundary like
any other client. Defer past 2.2; record as a DECISIONS.md "future" entry so
nothing built earlier precludes it (mainly: keep the node API cleanly separated
from the shell so an MCP adapter can wrap it).

---

### F7 — Architecture patterns to adopt (no code)

From the digital-twin scan, patterns GeoBase should absorb as *discipline*, each
a small DECISIONS.md entry rather than a feature:

1. **Journaled store → materialized views.** Twin state = append-only event log;
   the GPKG/JSON the viewer reads is a rebuildable export. We already have
   append-only audit (1.2); extend the *concept* to survey/annotation data (F5).
2. **Frozen data contracts with a validate command.** Mazzap freezes its
   `grid.json` contract with "stop and flag, do not silently extend" language and
   ships a validator. Our GeoPack manifest schema is already frozen; add
   `geopack validate` as a user-facing command if not present.
3. **Capability ladder.** Every derived product declares its input tiers of
   quality and degrades explicitly (LiDAR → CHM → NDVI). Encode in F1/F2 recipe
   metadata so provenance records *which rung* produced an output.
4. **Engine/pack separation.** Their engine names no CRS, layer, or species —
   all content lives in packs. GeoBase already does this (Tribe-agnostic core,
   grounded nodes); keep SoLO apps honest to it: RStep's renewable/NoGo logic
   should be pack-driven config, not hardcoded.
5. **Twin = bundle + contracts, not app.** The portable artifact is the data
   bundle (GeoPacks + place.toml + baseline); any conformant engine renders it.
   This is federation-friendly (2.0) and the strongest sovereignty story: a
   Tribe's twin is *files they hold*, not software state.

---

## Part 3 — Digital-twin architecture research summary

What "digital twin" should mean for GeoBase — synthesized from the scan
(CesiumJS/3D Tiles ecosystem, COPC/EPT cloud-native formats, WhiteboxTools,
Mazzap/VEIL, deck.gl):

A geospatial digital twin has four planes, and GeoBase already owns three:

1. **State plane** — authoritative data store with provenance. GeoBase: GeoPacks
   in the vault + audit trail. *Already superior* to every surveyed system for
   our purposes because tiering/FPIC is native; nothing surveyed has an
   equivalent.
2. **Derivation plane** — turning raw captures into features and indicators
   (DTM/CHM/trees/hydro surfaces). GeoBase: missing → **F1 + F2 fill it.** This
   is the actual "digital twin components that transform LiDAR into prerendered
   features" the owner asked for — and the finding is that it's a *pipeline*
   capability, not a renderer capability.
3. **Presentation plane** — LOD-streamed 3D. GeoBase: partial (raster-dem
   terrain) → **F3.** Industry has converged on two open standards worth
   betting on: **3D Tiles** (OGC; pnts/b3dm; Cesium/deck.gl/loaders.gl all read
   it) for general 3D content, and **COPC** (single-file octree LAZ) for point
   clouds specifically. Recommendation: COPC as the stored/served truth, 3D Tiles
   only if Option A is ever escalated. Avoid bespoke mesh formats (Mazzap v1's
   Blender/Three.js meshes are the cautionary tale: unportable, regenerated per
   viewer).
4. **Interaction plane** — simulation-in-the-loop, field sync, semantic query.
   F1 (simulate), F5 (sync), F6 (query). The scan's most useful negative result:
   heavyweight "digital twin platforms" (city-scale commercial stacks) bundle
   these planes into hosted services — architecturally incompatible with
   sovereignty. The Mazzap/VEIL lineage demonstrates the *local-first* variant of
   each plane is practical for a small team, which is the existence proof GeoBase
   needed.

**License/provenance table:**

| Component | License | Use mode |
|---|---|---|
| WhiteboxTools (open core) | MIT (beware proprietary extension tools) | Vendor pinned; Rust lib or built subprocess |
| mazzap_veil (v2) | MIT | Adapt fetchers (Python, out-of-product); patterns only elsewhere |
| mazzap (v1) | **none — all rights reserved** | Patterns only, zero code |
| CesiumJS | Apache-2.0 | Only if Option A escalates; strip Ion defaults |
| deck.gl / loaders.gl | MIT | Option C overlay |
| opengeos/maplibre-gl-lidar | verify | Candidate ADOPT/ADAPT for F3 |
| COPC spec, `las`/`laz-rs` crates | open spec / verify crates | F2 vault format |

## Part 4 — Suggested phase mapping (for vetting, not commitment)

- **Now, parallel to 1.2:** F4 sidecar; Part 1 decision recorded in DECISIONS.md;
  F7 pattern entries.
- **After 1.3 / alongside 2.0:** F1 (`geobase-sim` + sim-gate) — it needs only
  T0/T1 inputs, so it does not block on LiDAR.
- **Phase 2.1 (redefined):** F2 + F3 together *are* Phase 2.1; the roadmap's
  existing 2.1 gate already fits verbatim.
- **Post-2.2:** F5 (needs the 1.2 ceremony matured), F6 (parking lot).

## Part 5 — Claude Code vetting checklist

- [ ] Part 1: benchmark C vs A on a 3DEP COPC fixture; record decision + escalation criterion in DECISIONS.md
- [ ] F1: inspect WhiteboxTools crate structure — lib-linkable? MIT-only vendor tree verified? modular Next Gen crates published?
- [ ] F1: recipe-output tier policy vs `effective_tier()` — new rule needed?
- [ ] F2: Rust COPC read/write viability (`las`, `laz-rs`, copc crates) — vendor, wrap, or write VLR handling ourselves?
- [ ] F2: vertical datum handling — extend `Crs` now or defer with recorded risk?
- [ ] F2/F1 boundary: "derive" recipes in sim crate vs ingestor — pick one rule
- [ ] F3: does deck.gl interleaved break the existing pixel-diff gates?
- [ ] F4: first-four fetcher set confirmed; network-permitted CI job design
- [ ] F5: audit-trail-as-journal feasibility; core vs SoLO app placement
- [ ] All: which existing GeoBase components are *superior* to the surveyed designs (expected: vault/TSDF/audit, CRS pipeline, gate discipline) — document so we stop re-litigating
