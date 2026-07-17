# GeoBase-DDM bridge

> **Currency note (2026-07-16):** §2/§3's phase-0.2 framing was written
> before that phase landed. Phase 0.2 is **accepted-complete**
> (`docs/ROADMAP.md`; gate artifact
> `docs/verification/phase-0.2-terrain-45deg.png`) — the render path this
> file says GeoBase "must prove" is proven, so the DDM seam described in §2
> is consumable today. The rest of the contract and sync log stand unchanged.

The interproject communication structure between ATNI-GeoBase (this
repository) and the Dynamic Drought Module (DDM,
`C:\dev\dynamic-drought-module`; live at
https://atniclimate.github.io/dynamic-drought-module/). Each repository
carries one bridge file (this one here; `docs/interop/GEOBASE-BRIDGE.md`
there) with the same contract and a per-repo sync log. A session in either
project that changes a shared-interest surface appends one line to its own
sync log; a session in the other project working near the seam reads the
counterpart file at open. The bridge is documentation plus a greppable tag;
neither project takes a code dependency on the other.

## 1. Why the DDM matters to GeoBase

The DDM is the production-proven sibling: a serverless MapLibre GL +
TypeScript + Vite web map, deployed on GitHub Pages, embeddable by iframe,
built under the same stewardship posture GeoBase enforces through the
Tiered Sovereign Data Framework (TSDF). It is, in effect, a running
preview of the Light Engine's world: everything it has already solved is
available to borrow instead of re-derive, and everything it consumes is a
first customer for GeoBase's T0 baseline.

## 2. The DDM seam GeoBase will attach to

The DDM carries two dormant, greppable `atni-geobase` attachment points:

- **Map-initialization seam** (`src/map/init.ts` in the DDM): where 3D
  enables (`map.setTerrain(..)`) after the map constructor returns.
- **Terrain-source seam** (`src/map/style.ts` in the DDM): where a T0
  elevation baseline registers as a MapLibre `raster-dem` source (local
  tiles or PMTiles; never a cloud terrain service).

The DDM's 2026-07-02 assessment chose MapLibre native terrain over a local
`raster-dem` as its lightest honest 3D option, which is the same render
path this repository's phase 0.2 ("baseline render proof") must prove.
The two projects converge on one stack; when phase 0.2 produces the T0
baseline, the DDM can consume it at its seam unchanged. That makes the
phase 0.2 gate double-valuable: it proves GeoBase's render pipeline AND
lights up the DDM seam.

## 3. DDM assets worth borrowing (pointers into the DDM repo)

- **Browser verification harness** for the phase 0.2 pitched-screenshot
  gate: `playwright.config.ts` + `tests/` + `.github/workflows/smoke.yml`
  (build-then-preview-then-drive; ANGLE-over-SwiftShader launch flags make
  MapLibre render headless; workers capped at 2; deterministic-backbone
  doctrine).
- **Layer lifecycle discipline**: lazy activation, single-flight dynamic
  imports, per-layer operation serialization, the stay-on failure
  contract (`src/ui/sidebar.ts`, `src/config/layers.ts`, TODO.md standing
  decision records).
- **Honest status reporting**: five canonical layer states plus the
  debounced raster tile-error watcher (`src/util/raster-status.ts`).
- **URL-as-state and the embed contract** (`src/state/url.ts`), for Light
  Engine deep links and iframes.
- **PMTiles build pipeline** (`scripts/build-ecoregion-tiles.mjs`) and
  protocol registration (`src/map/init.ts`).
- **Toolchain reference**: Vite 8 / Rolldown with `codeSplitting` vendor
  chunks (`vite.config.ts`), Pages deploy with a dependency-free retry
  for the deploy-pages transient (`.github/workflows/deploy.yml`),
  self-hosted variable fonts with OFL texts shipping in dist
  (`public/fonts/`).

## 4. What GeoBase provides the DDM

- The **T0 elevation baseline** (phase 0.2) consumable at the DDM's
  terrain-source seam, with resolution and CRS documented.
- **CRS pipeline discipline** (`docs/CRS-PIPELINE.md`) as the reference
  for any DDM build-script reprojection.
- The **layer-package schema** (phase 1.1) early, so the DDM's future
  import path aligns with it rather than inventing a parallel format.

## 5. Stewardship boundary

Only **T0 (open/public by sovereign decision)** data ever crosses this
bridge. The DDM never hosts or transits T1/T2/T3 material; TSDF
enforcement lives here. "When in doubt, classify as T3" governs anything
ambiguous before it is offered across the bridge.

## 6. Sync log (append-only; newest last)

- 2026-07-02 (GeoBase): bridge established from the DDM side. DDM seam
  tags live at its `src/map/init.ts` and `src/map/style.ts`; its
  lightest-honest-3D assessment (MapLibre native terrain over local
  raster-dem) converges with this repository's phase 0.2 render proof.
  Counterpart file: DDM `docs/interop/GEOBASE-BRIDGE.md`.
- 2026-07-03 (GeoBase): first pattern borrowed over the bridge. The Pages
  deploy transient ("Deployment failed, try again later" at the status
  poll) hit this repository twice; `.github/workflows/pages.yml` now
  carries the DDM's dependency-free in-workflow retry (continue-on-error
  first attempt, 30-second settle, gated second attempt).
