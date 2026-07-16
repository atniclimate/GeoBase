# AGENTS.md — agent contract for GeoBase

Standing instructions for coding agents operating in this repository
(Codex CLI reads this file automatically; other agents should too).
GeoBase is a sovereign geospatial platform: two engines (desktop Rust/Tauri,
light MapLibre/TS) over one shared data spine, with the Tiered Sovereign
Data Framework (TSDF) as the compliance backbone. Read `docs/ARCHITECTURE.md`
and `docs/ROADMAP.md` before substantive work; `docs/LESSONS-FROM-PROTOTYPE.md`
explains why the invariants below exist.

## Build / test

- Rust workspace: `cargo fmt --all --check`, `cargo clippy --workspace
  --all-targets -- -D warnings`, `cargo build --workspace --locked`,
  `cargo test --workspace --locked` (CI runs exactly these).
- Web: `pnpm install --frozen-lockfile`, `pnpm -r build`. Render gate:
  `pnpm --filter @geobase/engine-light run verify:render`.
- This is a Windows dev machine (PowerShell 7); CI is ubuntu-latest. Code
  must work on both — never hardcode path separators or platform paths.

## Invariant checklist (review every diff against these, in order)

1. **CRS pipeline discipline** (`docs/CRS-PIPELINE.md`): validate source CRS
   on ingest and reject if missing/unparseable — never assume. Store data in
   its native CRS. Reproject only for the viewer (`EPSG:3857`). Assert CRS
   and bounds after every hop. No silent CRS fallbacks anywhere.
2. **Tier discipline**: unclassified data defaults to **T3** ("when in
   doubt, classify as T3"). A package's effective tier is the most
   restrictive of its datasets. Tier semantics load from a `TsdfSource` —
   never hardcode tier definitions or behavior tables.
3. **T3 egress guarantee**: no code path may export, serve, or network T3
   data. Anything weakening this is a blocking finding, always.
4. **Classification travels with the artifact**: TSDF tier, framework
   version, classification basis, and source hashes are written into the
   artifact itself (standard `gpkg_metadata` tables), not into docs or
   sidecar files that can detach.
5. **Lossless data handling**: never degrade an encoding (e.g. Float32
   rasters must not quantize through PNG16 tiles). Handle NoData explicitly
   before any encoding step. Verify copies against sources byte-for-byte or
   value-for-value where feasible.
6. **Write-ordering invariants hold**: when building GPKGs, raster coverage
   is written before vector layers (GDAL `CreateCopy` semantics destroy an
   existing file). Artifact-level verification must check the complete
   artifact so a reorder fails loudly.
7. **Data never enters git**: code, specs, docs, and tiny synthetic fixtures
   only. No real-world datasets, no machine-absolute paths in committed
   files, no credentials.
8. **Observed-behavior gates**: acceptance is an observed artifact (a
   rendered screenshot, a verified round-trip), never just a passing data
   check. Don't weaken or bypass a gate to make CI green.
9. **Offline-first, no cloud lock-in**: no cloud terrain/tile services, no
   network dependency in any render or data path. Vendored/embedded
   defaults must keep working with no network at all.
10. **Rust hygiene**: errors via `thiserror` enums, no `unwrap`/`expect` in
    library code paths (tests are fine), public items documented, clippy
    clean at `-D warnings`.

## Review protocol

Report **blocking issues first** (invariant violations, correctness,
data-safety), then advisories. Be specific: file, line, failure mode.
Claude (the director) is the final decider; review is input, not veto.

## Data gate — what agents may read or transmit

- **Green**: tracked repo content (code, specs, docs, committed synthetic
  fixtures), diffs of tracked content, build/test output.
- **Owner grant (2026-07-16, Patrick Freeland; recorded in
  `docs/DECISIONS.md` same date):** for work in this repository, Codex has
  **full read/write access to the entire repo working tree**, including the
  gitignored planning material (`docs/handoffs/`, `docs/_local/`, `data/`
  staging). Basis: owner declaration that all material in use for this build
  is Tier 0 under the TSDF. This grant is deliberately loud so no inherited
  instruction quietly narrows it.
- **Red — still never read, pipe, or summarize**: any real-world dataset
  outside this repository, credentials or secrets anywhere, anything outside
  the multi-project workspace this repo lives in. Never push to remotes. When
  in doubt, treat as red — the TSDF default posture applies to context, too.
  The adversary-profile deny-by-default review rules (the workspace-root
  `AGENTS.md`, one level above this repo) continue to bind review jobs
  regardless of this grant.
