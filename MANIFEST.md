## What This Project Is

GeoBase is an offline-first, sovereign geospatial platform for Tribal Nations. It combines one shared Rust data/compliance spine with two deployment engines: a grounded Rust/Tauri desktop node and a TypeScript/MapLibre light viewer. Its GeoPack ingestor turns supported raster and vector inputs into self-describing GeoPackages, while the Tiered Sovereign Data Framework (TSDF) supplies versioned classification rules. SoLO applications, beginning with RStep, use the same node and layer-package contracts to create shareable derived products without exposing source layers. This purpose and architecture are stated in `README.md` and `docs/ARCHITECTURE.md`; the operational sovereignty rules are defined by `AGENTS.md`, `governance-config.yaml`, `docs/TSDF-INTEGRATION.md`, and `spec/tsdf/tiers.toml`.

The defining constraints are visible in both plans and code: source CRS must be identified rather than assumed (`docs/CRS-PIPELINE.md`, `crates/geobase-core/src/crs.rs`, `crates/geobase-ingestor/src/crs_id.rs`); unclassified material defaults to T3 (`spec/tsdf/tiers.toml`, `crates/geobase-ingestor/src/lib.rs`); classification and audit information travel in GeoPackage metadata (`crates/geobase-gpkg/src/lib.rs`); T3 has no egress path (`AGENTS.md`, `crates/geobase-gpkg/src/ceremony.rs`, `crates/geobase-engine-desktop/src/server.rs`); and the viewer uses bundled/local terrain rather than a cloud terrain service (`engine-light/src/main.ts`, `engine-light/scripts/verify-render.mjs`).

## Current Development Status

- The authoritative roadmap marks Phases 0.1 through 1.1 complete: scaffold/spine, local 3D baseline rendering, GeoPack ingestion, the desktop node, and stackable layer packages (`docs/ROADMAP.md`). The corresponding observed artifacts are committed under `docs/verification/`, and ongoing checks are defined in `scripts/geopack_gate.py`, `engine-light/scripts/verify-render.mjs`, `engine-light/scripts/verify-layers.mjs`, and `.github/workflows/`. `README.md` still says “Phase 0.1,” so its short status paragraph is stale relative to `docs/ROADMAP.md` and the implementation.
- The Rust workspace is materially implemented across five crates listed in `Cargo.toml`: shared model/CRS contracts (`crates/geobase-core`), the pluggable TSDF resolver (`crates/geobase-tsdf`), GeoPackage metadata/raster/vector/ceremony/cipher support (`crates/geobase-gpkg`), GeoTIFF and shapefile ingestion plus package assembly (`crates/geobase-ingestor`), and the grounded node, vault, loopback API, and export pipeline (`crates/geobase-engine-desktop`). Their crate manifests and opened source modules support these descriptions.
- Phase 1.2 is not complete as specified. A fail-closed at-rest cipher seam and an export-authorization trait exist, and T3 is refused unconditionally, but the only ceremony implementation is explicitly `ProvisionalDevGate`; the sovereign FPIC mechanism remains a handoff requirement (`crates/geobase-gpkg/src/cipher.rs`, `crates/geobase-gpkg/src/ceremony.rs`, `docs/CEREMONY-GATE.md`). This matches the unmarked Phase 1.2 entry in `docs/ROADMAP.md`.
- Much of Phase 1.3 is implemented but its acceptance status is not recorded as complete in the roadmap. The SoLO SDK exposes node, layer, paint, and export contracts (`solo/sdk/src/index.ts`); RStep stacks node layers, paints opportunity polygons, and submits export requests (`solo/rstep/src/main.ts`, `solo/rstep/src/paint.ts`); and the desktop engine writes product-only shapefile exports with audit handling (`crates/geobase-engine-desktop/src/export.rs`, `crates/geobase-engine-desktop/src/server.rs`). However, the tracked `docs/PROCESS-MAP.md` still labels the end-to-end RStep observed-behavior gate as queued, and no tracked workflow named for that gate appears under `.github/workflows/`. Therefore this inventory treats Phase 1.3 as implemented/in progress, not accepted complete.
- Federation remains a placeholder for Phase 2.0 (`spec/fidp/README.md`), and the roadmap leaves Phases 2.0–2.2 incomplete (`docs/ROADMAP.md`). No tracked `target/` or `.agents/` files were present. No build or test command was run during this analysis because those commands would create or update output files, contrary to the task’s single-write restriction.

## Proposed Reorganization (NOT EXECUTED)

**PROPOSAL ONLY — NO FILES OR FOLDERS HAVE BEEN MOVED OR RENAMED.** The mappings below describe a possible future layout. They would require coordinated updates to Cargo/pnpm workspace manifests, scripts, workflows, documentation links, and fixture paths if approved and executed later.

- `engine-light/` -> `apps/engine-light/` — group the deployable MapLibre viewer with other user-facing applications while leaving Rust libraries and services under `crates/`.
- `solo/rstep/` -> `apps/solo/rstep/` — place the deployable RStep application beside the light engine.
- `solo/sdk/` -> `packages/solo-sdk/` — distinguish the reusable TypeScript contract package from deployable apps.
- `docs/ROADMAP.md` -> `docs/planning/ROADMAP.md` — separate forward plans from architecture, policy, and reference documentation.
- `docs/PROCESS-MAP.md` -> `docs/planning/PROCESS-MAP.md` — keep the implementation/gate sequence with the roadmap that it tracks.
- `docs/CEREMONY-GATE.md` -> `docs/planning/handoffs/CEREMONY-GATE.md` — make the still-pending Phase 1.2 handoff discoverable as transitional planning material.
- `docs/verification/` -> `evidence/render-gates/` — distinguish observed acceptance artifacts from explanatory documentation.
- `scripts/geopack_gate.py`, `scripts/verify_geopack_oracle.py` -> `tools/gates/geopack/` — colocate the GeoPack gate driver with its cross-implementation oracle.
- `scripts/make_geopack_fixtures.py`, `scripts/make_t0_baseline.py`, `scripts/generate_terrain_tiles.py` -> `tools/fixtures/` — separate deterministic fixture generation from gate execution and developer-session helpers.
- `scripts/session-preflight.ps1`, `scripts/codex-run.ps1` -> `tools/dev/` — group local development/agent entry points away from product verification scripts.
- `prompts/standing/` -> `tools/agent/prompts/` — make the standing survey, triage, review, and retrospective prompts visibly part of development tooling rather than runtime code.
- `.github/workflows/` -> unchanged — GitHub requires workflows at this location.
- `Cargo.toml`, `package.json`, `pnpm-workspace.yaml`, `AGENTS.md`, `README.md`, `governance-config.yaml`, `spec/`, and `data/` -> unchanged — these are workspace entry points, repository policy/specification roots, or deliberate data-boundary locations whose root-level visibility is useful.

## Inventory Notes

- `crates/` contains the five-member Rust workspace. `geobase-gpkg` and `geobase-ingestor` hold most storage/format logic; `geobase-engine-desktop` contains the node, vault, local server, Tauri shell, and export path.
- `engine-light/` is a Vite/TypeScript MapLibre application with local terrain assets and two pixel-based verification scripts. Its committed terrain bundle is the documented, size-capped T0 exception described in `data/README.md`.
- `solo/` contains the reusable SoLO SDK and the RStep Vite app. The pnpm workspace includes both along with `engine-light` (`pnpm-workspace.yaml`).
- `spec/tsdf/` vendors TSDF version 0.9.4 and its machine-readable tier definitions; `spec/fidp/` is currently a federation-profile placeholder.
- `data/fixtures/geopack/` contains small committed synthetic GeoTIFF/shapefile inputs and package manifests. Other data is intentionally excluded by policy (`data/README.md`, `AGENTS.md`). Binary fixtures were inventoried by tracked path, not used as planning evidence.
- `docs/` contains architecture, roadmap, CRS/TSDF integration, decisions, process/gate documentation, interoperability notes, and three committed verification screenshots.
- `scripts/` mixes fixture creation, GeoPack/oracle gates, terrain generation, and developer-session helpers; this mixed responsibility motivates the proposed `tools/` split above.
- `prompts/standing/` contains four reusable agent workflow prompts: survey, triage, diff review, and retrospective.
- `.github/workflows/` contains Rust/web CI, GeoPack gating, Pages deployment, and render/layer gating. No tracked `.agents/` or `target/` content was encountered. Root `CLAUDE.md` and tracked phase/kickoff/handoff/session-note collections were not present; the tracked session-related file encountered was `scripts/session-preflight.ps1`.
