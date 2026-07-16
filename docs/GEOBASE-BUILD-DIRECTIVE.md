> **STATUS: SUPERSEDED / OUT OF SCOPE FOR PRODUCT-1.0** (recorded 2026-07-11,
> Phase 0 congruence pass; see `docs/DECISIONS.md` 2026-07-11 and
> `docs/RELEASE-DEFINITION.md`, RATIFIED 2026-07-16). This directive's rendering/digital-twin
> scope directly contradicts tracked `docs/ARCHITECTURE.md`, which rules a
> native heavy-render path "a **deferred Phase 2.1 option**, not a v1
> requirement" (`docs/ARCHITECTURE.md`, "Rendering decision"). Under DG-1's
> default (sovereignty-core 1.0 = the combined Phase 1.2+1.3 gate + release
> hardening; digital-twin/F1-F4/federation/LiDAR are serial, non-gating 1.x
> backlog), nothing in this document is ratified, and no verdict recorded here
> (§0 "Ratified decisions") governs any Phase 0-C critical-path work. It is
> retained, not deleted, as a candidate specification for **post-1.0 backlog
> workstreams only** (see `PLAN_1.0.md` Backlog Queue B-1..B-4), and any part
> of it that is later adopted must be ratified through its own
> `docs/DECISIONS.md` entry — this file's own "do not re-open" language does
> not itself constitute ratification. Tracked `docs/ROADMAP.md` 2.1 keeps its
> "optional native Rust/`wgpu`" wording per the DG-1 default (see
> `docs/ROADMAP.md` 2.1 note, 2026-07-11).

> **INVARIANT CONFLICT NOTICE (blocking — added 2026-07-11).** Beyond being
> superseded, this directive concretizes a design that **contradicts
> `AGENTS.md` invariant 3** ("no code path may export, serve, or network T3
> data. Anything weakening this is a blocking finding, always"). The
> conflicting composition is **VOID as written** and must never be
> implemented, at any phase, backlog or not:
>
> - **VOID — WP4 items 1-6 as a composition** (§2, "Node COPC range
>   endpoint" + `lidar ingest` "default T3" + the point-cloud view consuming
>   it, with an exit gate rendering a T3 LiDAR layer): a loopback HTTP range
>   endpoint is still a serving/network code path, and serving default-T3
>   COPC data over it — behind only an unspecified "tier-check" — violates
>   the invariant regardless of bind address. The governing rule: **T3 is
>   never served or networked, loopback included.** Any T3 rendering must be
>   a non-serving, non-network, in-process path; any COPC/range endpoint must
>   **refuse T3 before opening the artifact** (the shipped
>   refusal-before-open pattern), exactly as the existing layers endpoint
>   refuses T2/T3. A future backlog adoption of WP4 must first redesign the
>   T3 display path around this rule and record it in `docs/DECISIONS.md`.
> - **Reaffirmed (correct here; the sibling doc's version is void):** §0
>   item 8's "Survey data defaults T3; T2 is an explicit act" is the
>   governing rule; `docs/GEOBASE-DIGITAL-TWIN-FEATURES.md`'s "default T2"
>   statement for F5 is void.
>
> This directive's imperative language ("Ratified decisions", "Order is
> binding", "Hard constraints") is inoperative — see the SUPERSEDED banner
> above. An inline `VOID` marker appears at WP4. The text is retained
> unmodified beneath it for the historical record only.

# GeoBase Digital-Twin Build Directive

**Status:** Response to `digital-twin-vetting.md` (2026-07-06). On Patrick's
commit of this file, the vetting report's verdicts are **ratified as written**,
including all Codex-round amendments. This document does not restate their
reasoning — the vetting report is the authority for *why*; this is the
authority for *what, where, and in what order*.
**Precedence:** repo DECISIONS.md > this directive > the vetting report > the
original research doc (now historical; its five corrected claims in vetting §11
are void — do not size or design from them).

---

## §0 Ratified decisions (do not re-open)

1. Rendering: **Option C** — deck.gl overlay, **non-interleaved**, behind a
   frozen `PointCloudView` adapter seam, node-mode-only, lazy-loaded, terrain
   disabled in twin mode. Adopt vetting §6's DECISIONS draft **verbatim**
   (fill the date). Option A = escalation only per its criterion; Option B dead.
2. F1 ADOPT conditional on the two Next Gen conditions precedent; legacy-MIT
   vendor is the pre-approved fallback — **no new vetting round if it trips.**
3. F2 rescoped: COPC read/validate/serve/derive in v1; COPC *write* is a scoped
   2.1 work item with its own oracle. Vault integration decided at 2.1 by the
   measured blob-vs-file spike; lean (a) container-is-artifact.
4. F1/F2 boundary rule as sharpened: parameterized → sim recipe; canonical →
   ingest. Ingestor gains exactly one capability (`lidar ingest`).
5. Tier policy: mechanical recipes inherit most-restrictive input tier;
   inferential (or unknown class) → unset → T3. `inferential` flag required.
6. `/api/sim` composes the exact `geopack package` path; zero artifact-writing
   code in the sim crate.
7. F4 same-repo `tools/acquire/`; acquire-gate never a required check; product
   CI never consumes acquire output, forever.
8. F5 = "GroundTruth" SoLO app, post-2.0. Survey data defaults T3; T2 is an
   explicit act. Node is merge authority; conflicts surface, never last-wins.
9. F6 parking lot; the one future-entry sentence commits now (WP0).
10. F7: #4 held; #1,#5 doc-language now; #2 (`geopack validate`) and #3
    (ladder-in-provenance) queued with adjacent phases.
11. Sequencing: **1.3d RStep Gate remains first.** Nothing below preempts it.

---

## §1 Asset registry — where everything lives

Every external artifact: exact coordinates, pin, license posture, and the
validation step that must pass before first use. Vendor by pinned commit;
record every pin in `THIRD_PARTY_NOTICES.md` (created in WP0).

### 1.1 Simulation engine (F1)

| Asset | Coordinates | Pin/version | Validate before use |
|---|---|---|---|
| Whitebox Next Gen engine crates | crates.io: `wbraster` 0.2.0, `wblidar` 0.1.2, `wbvector` 0.1.5, `wbgeotiff`, `wbprojection`, `wbtopology` | exact `=x.y.z` in Cargo.toml | Each crate page asserts "MIT OR Apache-2.0"; record per-crate |
| `wbtools_oss` (the 500+ tools; `publish = false`) | github.com/jblindsay/whitebox_next_gen → `crates/wbtools_oss` | pinned git rev, vendored | **Condition precedent (i):** per-file license inventory — every vendored file carries the MIT/Apache grant (repo has no top-level LICENSE). **Condition (ii):** confirm all ten F1 tools present in the *open* split: BreachDepressionsLeastCost, FillDepressions, D8/DInf/FD8 accumulation, Watershed, ExtractStreams, WetnessIndex, ElevationAboveStream, DownslopeDistanceToStream (+ LidarGroundPointFilter, TINGridding, IDWInterpolation, LidarTile for F2 recipes). CI check: no `wbtools_pro_shim`/extension stubs in the vendored tree |
| Fallback: legacy WhiteboxTools | github.com/jblindsay/whitebox-tools | v2.4.0 tag or the 2026-05-26 legacy-freeze commit | Top-level MIT LICENSE.txt confirmed; add a lib target ourselves; all ten tools' source confirmed present (vetting §3) |
| Sim oracle | `richdem` or GDAL D8 (CI only, C1-exempt class) | existing oracle pattern | Value-for-value D8 accumulation check in sim-gate |

Spike order for the conditions precedent: run the license inventory **before
writing any geobase-sim code** — it's a half-day script (walk tree, assert
SPDX/grant header or crate-level license file) and it decides the dependency
graph. Also check whether `wbtools_oss` tool signatures accept in-memory
`wbraster` objects (vetting §3 rule 3) — if yes, the work-file question mostly
dissolves for T0/T1.

### 1.2 Point clouds (F2/F3)

| Asset | Coordinates | Pin | Validate |
|---|---|---|---|
| `las` crate (COPC read) | crates.io/crates/las | =0.9.11 | `las::copc` module present; read a 3DEP fixture tile |
| `laz` crate (LAZ codec, pure Rust) | crates.io/crates/laz | =0.12.2 | Decodes layered-v3, PDRF 6–10 on the fixture |
| `copcverify` (CI oracle) | github.com/hobuinc/copcverify | pin | Passes on the pristine 3DEP fixture (positive control) |
| PDAL (CI oracle only, for the 2.1 COPC-write item) | container image in CI | pin image digest | `writers.copc` round-trip cross-check |
| `copc_converter` (candidate vendor for COPC-write, evaluate then) | github.com/360-geo (copc_converter) | pin if adopted | Must pass copcverify + PDAL cross-check **before** trust — self-reported compliance only |
| maplibre-gl-lidar (first `PointCloudView` impl, ADAPT) | github.com/opengeos/maplibre-gl-lidar | =0.16.2 (MIT) | Pre-1.0/unstable: pin exact, wrap fully behind the seam, expose zero plugin types in app code; evaluate narrowed fork (npm `copc` + deck core only) if bundle audit objects |
| `copc` (JS reference reader) | npm `copc` (connormanning/copc.js) | exact | Needs only HTTP Range — our axum/tower-http serves it |
| deck.gl | npm, 9.3.x | exact | Non-interleaved MapboxOverlay only; do NOT use interleaved (open bugs #8091/#7064 with raster-dem) |

### 1.3 Acquisition endpoints (F4) — federal data, no keys required

| Source | Access | Notes for the fetcher |
|---|---|---|
| 3DEP DEM (1/3 arc-sec + 1 m where available) | TNMAccess API: `https://tnmaccess.nationalmap.gov/api/v1/products` (query by bbox + dataset name) | Returns direct GeoTIFF/staged-product URLs; respect advertised `sizeInBytes` |
| 3DEP LiDAR point clouds | Same TNMAccess index for LAZ tiles; bulk COPC/EPT mirrors: `https://usgs.entwine.io` + AWS `s3://usgs-lidar-public` (registry.opendata.aws/usgs-lidar) | Prefer the COPC/EPT mirrors — pre-tiled, range-readable, no re-sort needed (ratified decision 3) |
| LANDFIRE fuels/vegetation | LANDFIRE Product Service (LFPS): `https://lfps.usgs.gov/api` (AOI clip jobs) | Async job API: submit → poll → download clip; keep mazzap_veil's poll pattern |
| NHDPlus HR / WBD | TNMAccess (staged HU4/HU8 GDB/GPKG products) or NHDPlus HR direct downloads | Fetch by HUC intersecting the AOI |
| Upstream reference | github.com/zymazza/mazzap_veil (MIT) | Pin the commit adapted from; adapt fetch logic + safety discipline (size check, headroom, refuse-oversized, clip, discard archives); attribution in THIRD_PARTY_NOTICES.md |

Endpoints drift — the fetchers must treat scheme/URL as config, fail loudly
with the probe response body, and never fall back to scraping.

### 1.4 Fixtures (commit these; product CI depends on nothing else, ever)

- **Sim fixture:** the existing committed T0 terrain fixture is sufficient for
  flood_hand/watershed/D8 sim-gate runs — no new data needed.
- **COPC fixture:** one small 3DEP `.copc.laz` tile (choose the smallest
  covering the existing fixture AOI; a few MB target), fetched **once by an
  operator**, committed. Also derive a corrupted-hierarchy variant (negative
  control for validate) and a **mixed-vertical-datum pair** (one NAVD88, one
  ellipsoidal WKT VLR) for the refusal gate.
- **Acquire-gate fixture AOI:** a tiny polygon (~1 km²) over public land within
  the 3DEP+LANDFIRE overlap; the gate's fetched output is quarantined to its
  job and discarded (ratified decision 7).

---

## §2 Work packages in build order

Each WP states entry condition, contents, and exit gate. Order within a WP is
binding; parallelism across WPs only where stated.

### WP0 — Paper commits (now; ~1 session; no code)
Entry: Patrick commits this directive.
1. DECISIONS.md: the Part 1 entry from vetting §6 verbatim, dated.
2. DECISIONS.md: F7.5 sentence into 2.0/FIDP language ("the portable twin is
   `place.toml` + the vault of GeoPacks; any conformant engine renders it");
   F7.1 scoped-to-F5 sentence; the F6 future-entry sentence ("keep the node
   API separable from the shell so an external adapter can wrap it").
3. ROADMAP.md: the one wording change — Phase 2.1's "optional native
   Rust/`wgpu` render path" → "heavy-3D path per DECISIONS <date>: deck.gl
   overlay (Option C), CesiumJS escalation criterion recorded."
4. Create `THIRD_PARTY_NOTICES.md` (mazzap_veil entry first).
5. Parking lot (in ROADMAP "Naming still open" style or a PARKING.md):
   wildfire spread sim (candidate 2.x SoLO app), F6 MCP layer, T1
   `ai_inference="network_scope_only"` local-model interpretation → flagged as
   a **governance question, not a code default**.
Exit: CI green (docs-only), Patrick review.

### WP1 — 1.3d RStep Gate (unchanged, first in queue)
No changes from this directive. Keep renewable/NoGo logic pack-driven (F7.4
honesty check is part of its review).

### WP2 — F4 `tools/acquire` + acquire-gate (parallel to 1.2, after 1.3d)
1. `tools/acquire/` (Python; out-of-product class): fetchers for exactly the
   first four (§1.3), shared safety module (size/headroom/refuse/clip/discard),
   output → staging dir consumed by `geopack package`. Domain-pin allowed hosts
   in the script.
2. Operator doc: `tools/acquire/README.md` — AOI-in, GeoPacks-out in one page.
3. `acquire-gate.yml`: `workflow_dispatch` + `schedule` only, never required,
   `permissions: contents: read`, no secrets; fetches the fixture AOI from two
   sources, ingests, asserts tier + audit + render via existing harness, then
   asserts product workflows remained network-off. Add the accretion rule as a
   comment block in the workflow file itself.
Exit: acquire-gate green on dispatch; a real AOI produces stacked layers in the
desktop shell by operator hands.

### WP3 — F1 `geobase-sim` (parallel workstream alongside 2.0)
Order is binding:
1. **Spike S1 (conditions precedent):** license-inventory script over vendored
   `wbtools_oss` + tool-coverage check + in-memory-signature check. Outcome →
   short DECISIONS entry naming linkage (Next Gen in-process vs legacy-vendor
   fallback). *Stop-and-choose point; do not scaffold the crate before S1.*
2. I/O plumbing (the honest cost center, vetting §3 end): GPKG coverage
   *reader*; narrow GeoTIFF *writer* for staging; round-trip assertion that
   WBT-written GeoTIFF stays inside `geotiff.rs`'s accepted envelope
   (single-band F32/I16, stripped/tiled, none/LZW/Deflate) or widen
   deliberately.
3. Recipe registry: declarative param schema per recipe (QGIS
   processing-provider shape, vetting §9), **required** `inferential: bool`,
   capability-ladder rung recorded into `TsdfTag.extras`. Recipes v1:
   `watershed`, `streams`, `flood_hand`, `flow_paths`, `wetness`,
   `spring_candidates` (inferential), `wildfire_exposure` (slope/aspect/
   topo-position + LANDFIRE fuels composite).
4. Work-file rules 1–4 from vetting §3 implemented exactly (T2/T3 refusal
   mirroring `server.rs:589`; tempdir outside vault scan; cleanup on both
   paths; prefer in-memory if S1 confirmed).
5. `POST /api/sim/{recipe}` composing recipe execution + the exact
   `geopack package` path (ratified decision 6); refusal-before-open and
   loopback guard reused from the existing endpoints.
6. `sim-gate` CI: fixture flood_hand run → assert tier+provenance+audit
   (incl. `package.complete` row), pixel-diff render of the output pack,
   D8-vs-oracle value check, GeoTIFF round-trip assert.
Exit: sim-gate green in CI; an inferential recipe's output provably refuses to
serve until explicitly classified.

### WP4 — Phase 2.1 = F2 + F3 (after 2.0 per roadmap; node-side may start early)

**[VOID AS WRITTEN — see INVARIANT CONFLICT NOTICE at top. This work package
composes a loopback COPC range endpoint over default-T3 ingest with a T3
render gate; T3 is never served or networked, loopback included (`AGENTS.md`
invariant 3). Endpoints must refuse T3 before opening the artifact; T3
rendering requires a non-serving in-process path. Redesign + `DECISIONS.md`
entry required before any adoption.]**

Order is binding; item 1 is option-agnostic and may start any time after WP3.5:
1. **Node COPC range endpoint:** tier-check before byte one (layers-endpoint
   shape, `server.rs:321`), loopback-only, `x-geobase-tier` +
   `cache-control: no-store`. Serve file-backed first (works for both vault
   options).
2. **Spike S2 (vault decision):** measured blob-backed (SQLite incremental
   blob I/O) vs file-backed serving of the fixture tile under a real COPC
   client's request pattern (many small concurrent hierarchy/node reads);
   numbers into the DECISIONS entry; choose (a)/(c) per ratified decision 3.
3. `lidar ingest` in the ingestor: schema extension adding `pointcloud` kind
   (deliberate frozen-schema extension — one DECISIONS line), validate via
   `las::copc`, CRS + **vertical-datum refusal** (read WKT VLR; unknown/missing
   → refuse; record `vertical_datum` + method in extras/audit per the
   `crs_method` pattern), default T3.
4. Derivation recipes into `geobase-sim` (not ingestor): `dtm`, `dsm`, `chm`,
   `tree_features` (CHM local-maxima ladder). DTM→T0 promotion documented as a
   sovereign reclassification act through the existing ceremony/audit path.
5. **`PointCloudView` adapter seam** (frozen interface, paint-tool doctrine),
   first impl = pinned maplibre-gl-lidar 0.16.2 wrapped completely; lazy-load
   on first point-cloud toggle; twin mode sets terrain off.
6. Gates: twin-view gate (composited-output pixel assert at pitch + OS-level
   network-off boot) + proof overlay-off passes existing render/layer gates
   **byte-identically**; mixed-datum refusal fixture; escalation benchmark run
   on reference hardware, numbers recorded (24 fps/5M anchor, re-anchor on
   first real Tribal dataset).
7. **Scoped COPC-write item** (only if/when a non-COPC Tribal LAZ arrives or
   the T0-fixture path needs it): evaluate vendoring `copc_converter` first;
   either way the oracle is copcverify + PDAL cross-check in CI.
Exit: the roadmap 2.1 gate verbatim — 1 m LiDAR ingested as T3, rendered
locally without egress — plus S2's DECISIONS entry.

### Deferred (no action beyond WP0 paper)
- **F5 GroundTruth** (post-2.0): when opened, start from vetting §7's journal
  design (entity journal in the survey GeoPack, distinct from audit; QField
  delta model; conflicts surface; node = merge authority) and `geopack
  validate` (F7.2) queued with that ingestor phase.
- **F6** (post-2.2): tool surface must load `ai_training`/`ai_inference` from
  the TsdfSource mechanically; local models only.

---

## §3 Standing execution rules (success + token conservation)

For Claude Code sessions executing the WPs:

1. **Verdicts are settled.** Cite this directive's §0 by number instead of
   re-arguing. Re-opening a ratified decision requires new external evidence
   and a one-paragraph DECISIONS proposal — not a re-vetting.
2. **Navigate by citation.** The vetting report's file:line references are the
   map (`package.rs:11–30`, `server.rs:309–341/589`, `vault.rs:56–101`,
   `lib.rs:106–113/185`, `raster.rs:186`, `ceremony.rs:114–150`,
   `bin/geopack.rs:36–38`). Open those spans first; read whole files only when
   an edit lands there. Never re-read the two planning docs in full — §0 and
   the relevant WP section are the working set.
3. **Spike before build, numbers into DECISIONS.** S1 and S2 are cheap and
   decide expensive things. A spike that produces a recorded number or a
   license inventory is a deliverable; a spike that produces a feeling is not.
4. **Fallbacks are pre-approved.** S1 fails → legacy vendor path, no
   discussion. copc_converter fails validation → COPC-write stays deferred.
   Escalation criterion trips → Option A per the recorded entry.
5. **Fixture-first.** Write the gate's fixture and negative control before the
   feature. Committed synthetic/pinned fixtures are the only data CI touches
   (ratified decision 7 — applies to every WP, not just F4).
6. **One frozen-contract extension at a time,** each with its own one-line
   DECISIONS entry (`pointcloud` kind; any manifest field additions). Silent
   extension of frozen schemas remains the named failure mode.
7. **Reuse the shipped shapes.** New endpoints copy the refusal-before-open +
   loopback-guard pattern; new gates copy the pixel-diff/oracle harness
   pattern; new packaging flows call `geopack package`, never reimplement it.
   If a WP seems to need a new shape, that is a design flag to raise, not code
   to write.
8. **Session hygiene:** end every session with a ≤15-line summary — WP item
   touched, gates run, pins added to THIRD_PARTY_NOTICES.md, DECISIONS
   entries, next binding step. That summary (not the transcript) is the next
   session's context.
9. **Upstream watch, minimal:** at each WP start, check only for (a) a
   top-level LICENSE landing in whitebox_next_gen, (b) `wbtools_oss` becoming
   published on crates.io, (c) maplibre-gl-lidar 1.0 / loaders.gl COPC
   support. Any of these simplifies a pin — one line in DECISIONS, don't
   refactor mid-WP.

## §4 Reserved to Patrick (sovereign/owner decisions, not engineering)

- WP0 approval and the ROADMAP wording change.
- Classification acts: any DTM→T0 promotion; the expected-T2 designation for
  survey products; disposition of inferential recipe outputs.
- The governance question parked in WP0.5 (T1 `ai_inference` local-model
  interpretation) — route to the TSDF governance process, not a code default.
- Re-anchoring the escalation criterion when the first real Tribal dataset
  exists.
