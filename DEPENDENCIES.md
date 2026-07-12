# GeoBase — External Dependency Audit

*(audit date 2026-07-11, read-only audit; this file is the only artifact written.
Scope: every reference from tracked project content to a file or directory
**outside** the project tree, plus the heavy in-tree subtrees that drive backup
tiering. Installed programs/toolchains are out of scope except the Runtime Notes
line. Local data was inventoried by metadata only — no dataset contents were read.)*

## Summary

GeoBase is, for build and runtime purposes, **self-contained**. Every compile-time
file embed is repo-relative (`env!("CARGO_MANIFEST_DIR")` + relative path), the TSDF
tier model defaults to a vendored offline copy, the Light Engine renders from a
bundled T0 terrain tile set with no cloud/terrain service, and every runtime path is
either an in-repo relative default or supplied through an environment variable / CLI
argument / config key. The pnpm workspace links (`@geobase/*`) and the pnpm store
junctions all resolve **inside** the root — no reparse point escapes the project.

The only genuinely external *file* reference in the whole tracked tree is one
documentation pointer to a sibling repository. The only "external to VCS" data are
two git-ignored GeoPackages that live inside `data/` (declared below). One prior worth
correcting: there is **no vendored `wbtools_oss` / Whitebox tree in the repo** — it
exists only as a *future* decision gate (DG-3 / S1) in planning docs, so it carries no
external path reach today.

## Findings

| Path / reference | Referenced from (file:line) | Kind | Exists? | Size | Impact | Class / remediation |
|---|---|---|---|---|---|---|
| `C:\dev\dynamic-drought-module` (DDM sibling repo) | `docs/interop/DDM-BRIDGE.md:5` | doc-prose | Yes (verified) | sibling repo (out of scope) | docs-only | **IGNORE** — a greppable bridge pointer; the doc itself states "neither project takes a code dependency on the other." It is the one machine-absolute path in a committed file, which nicks AGENTS.md §7 ("no machine-absolute paths in committed files"); optionally relativize or drop the drive path. |
| `atniclimate/TieredSovereignDataFramework` (GitHub repo) | `crates/geobase-tsdf/src/lib.rs:171`; `governance-config.yaml:16`; `README.md`; `spec/tsdf/ATTRIBUTION.md` | code / config / doc | n/a (network name, not a local path) | — | none today (breaks-refresh only if implemented) | **IGNORE / PARAMETERIZE** — `GitHubSource` is a stub returning `NotImplemented`; nothing fetches. Default source is `vendored` (offline). |
| TSDF source selector + optional endpoint (`source = "vendored"\|"github"\|"local-server"`, `endpoint`) | `place.example.toml` (`[tsdf]`); `crates/geobase-tsdf/src/lib.rs:192-206` | config / code | n/a | — | breaks-runtime only if misconfigured | **PARAMETERIZE** — documented config key; default `vendored` embeds `spec/tsdf/tiers.toml` at compile time. `local-server` endpoint is user-supplied and loopback-intended. |
| `GEOBASE_PLACE` → `place.toml`; `GEOBASE_VAULT` → `data/vault`; tiles dev default → `engine-light/public/tiles/terrain` | `crates/geobase-engine-desktop/src/bin/geobase-desktop.rs:37,48,50` | code | in-repo defaults exist | — | none (in-repo relative) | **PARAMETERIZE (already done well)** — env-var indirection with in-repo relative fallbacks; no machine-absolute path. Cited as good practice, no action. |
| Node source for viewer restricted to `localhost` / `127.0.0.1` http(s); terrain from `${BASE_URL}tiles/terrain/` | `engine-light/src/main.ts:79,89,97`; `engine-light/src/layers.ts` | code | in-repo bundle exists | — | none | **IGNORE** — loopback-only + bundled tiles; upholds the offline/no-cloud invariant. No external file. |
| Tauri generated capability schemas | `crates/geobase-engine-desktop/gen/schemas/*.json` (scan matched `includes:\n`) | generated | in-repo (0.28 MB) | 0.28 MB | none | **IGNORE** — false-positive on the drive-letter scan; Tauri build output, rebuildable, no external reach. |
| Whitebox `wbtools_oss` / Next Gen crates (`github.com/jblindsay/whitebox_next_gen`, `whitebox-tools`; crates.io `wbraster`/`wblidar`/`wbvector`/…) | `PLAN_1.0.md`, `docs/GEOBASE-BUILD-DIRECTIVE.md`, `docs/GEOBASE-DIGITAL-TWIN-FEATURES.md` (all three **untracked** working-tree docs) | doc-prose | **Not vendored yet** (no such dir in repo) | — | none today | **IGNORE (future)** — a "stop-and-choose" decision gate (DG-3 / S1) for a not-yet-started `geobase-sim`. Refs are crates.io/GitHub **names**, not local paths; no vendored tree, no external reach at present. (Scope note: the citing docs are untracked, not committed content.) |
| `D:/secret` (synthetic, never opened) | `crates/geobase-core/src/baseline.rs:164` | test string | n/a | — | none | **IGNORE** — a *negative* unit test: a `source_path` smuggled into the manifest **must fail** parsing. Asserts the opposite of a dependency. Forward-slash drive path, so the backslash-only `[A-Za-z]:\\` sweep misses it. |
| `D:/miniconda3/python.exe` (anti-pattern) | `docs/LESSONS-FROM-PROTOTYPE.md:59` | doc-prose | n/a | — | none | **IGNORE** — quoted as the *prototype's* mistake to avoid ("no machine-specific absolute paths"). Forward-slash, so also outside the backslash sweep. Not a current dependency. |

**Broken references:** none. Every external path referenced by tracked content that
could be verified exists (the DDM repo, the Rust `include_str!` fixtures, the CLI-usage
example baseline). CI workflows contain no machine paths.

## Declared External Datasets

These live *inside* the project root but are **git-ignored** (`.gitignore` excludes
`/data/**` except `README.md`, `.gitkeep`, and `data/fixtures/**`). They are "external
to version control," which is the project's deliberate data boundary (`data/README.md`,
AGENTS.md §7). Sizes are from filesystem metadata only.

| Dataset | Location | Approx size | Provenance | Rebuild / re-acquire recipe |
|---|---|---|---|---|
| T0 baseline GeoPackage | `data/baselines/squaxin_t0.gpkg` (+ `.aux.xml`) | 39.7 MB | Derived T0 (provisional). Source DEM is public-domain US federal data: USGS 3DEP 1/3 arc-second + NOAA CRM (`data/README.md`). Carries an in-artifact `gpkg_metadata` TSDF tag. | `python scripts/make_t0_baseline.py --dem <dem.tif> --grid <grid.gpkg> --out data/baselines/squaxin_t0.gpkg` (input paths are CLI-only; re-acquire the DEM/grid from the public sources above). |
| Demo vault GeoPackage | `data/vault/demo_t0.gpkg` | 1.11 MB | Small dev/demo vault artifact (git-ignored). | Regenerated by desktop-engine/vault dev flows; not a real dataset. Safe to recreate. |
| Bundled T0 terrain tiles | `engine-light/public/tiles/terrain/` (31 PNG + manifest) | 1.26 MB (cap 5 MB) | Terrarium re-encoding of `squaxin_t0.gpkg` at 1/256 m; **tracked** (the one committed data exception). | `python scripts/generate_terrain_tiles.py --baseline data/baselines/squaxin_t0.gpkg --out engine-light/public/tiles/terrain`; gate: `engine-light/scripts/verify-render.mjs`. |
| DDM sibling repository | `C:\dev\dynamic-drought-module` | out of scope | Separate ATNI project; doc bridge only, no code/data dependency. | `git clone` the DDM repo if the bridge doc must resolve locally; not required to build or run GeoBase. |

Committed synthetic fixtures under `data/fixtures/geopack/` (dem_small.tif 160 KB,
plus small `.shp/.dbf/.shx/.prj/.cpg` + `*_pkg.toml`, ~0.16 MB total) are tracked, tiny,
and regenerable via `scripts/make_geopack_fixtures.py`; they are part of Tier A, not a
declared external dataset.

## Self-Containment Verdict

**CONTAINED-WITH-DECLARED-DATA.**

- Build, test, and runtime are self-contained and offline: `cargo build/test
  --workspace --locked`, `pnpm install --frozen-lockfile` + `pnpm -r build`, and the
  bundled terrain make the Pages demo render with zero network. No compile-time or
  runtime path reaches outside the root.
- It is *not* fully SELF-CONTAINED only because the T0 provenance data
  (`data/baselines/squaxin_t0.gpkg`) needed to **regenerate** the terrain bundle lives
  outside VCS by policy, and one committed doc carries a machine-absolute pointer to the
  DDM repo.

To move up to **SELF-CONTAINED** (housekeeping, not structural): (1) relativize or drop
the `C:\dev\dynamic-drought-module` path in `docs/interop/DDM-BRIDGE.md`; (2) treat
`data/baselines/squaxin_t0.gpkg` as a declared artifact backed up alongside the mirror
(below), since its rebuild depends on re-acquiring external public DEM inputs. Nothing
in the code needs to change.

## Backup Manifest

Session-end mirror target: **`H:\`** (e.g. `H:\GeoBase`).

**Tier A — always mirror (code, docs, configs, small data, git history): ~15.5 MB**
- All source and manifests: `crates/`, `solo/sdk`, `solo/rstep` (source only), `engine-light/{src,scripts,public,index.html,*.json,*.ts,config}`, `spec/`, `docs/` (incl. 3 verification PNGs, ~6.8 MB is docs), `scripts/`, `prompts/`, `.github/`, `.claude/`, root files (`Cargo.toml`, `Cargo.lock`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `rust-toolchain.toml`, `governance-config.yaml`, `place.example.toml`, `*.md`, `LICENSE`, `.gitignore`, `.gitattributes`).
- `data/fixtures/` (tracked synthetic fixtures, ~0.16 MB) and `data/README.md`.
- `.git/` (~3.54 MB) — include for full history.

**Declared data to mirror alongside Tier A (recommended): ~41 MB**
- `data/baselines/squaxin_t0.gpkg` (39.7 MB) + `.aux.xml` — T0 provenance; expensive to rebuild (needs external USGS/NOAA inputs). Include it so the mirror is a complete restore.
- `data/vault/demo_t0.gpkg` (1.11 MB) — small; include.

**Tier B — heavy, regenerable; EXCLUDE from the mirror:**
| Subtree | Size | Rebuild cost |
|---|---|---|
| `target/` | ~10.7 GB | `cargo build --workspace --locked` (minutes; largest single win) |
| `node_modules/` (root pnpm store) | ~110 MB | `pnpm install --frozen-lockfile` (seconds–minutes; needs network once) |
| `engine-light/dist/`, `engine-light/dist-desktop/` | ~7.5 MB | `pnpm -r build` |
| `engine-light/verify-out/` | ~5.9 MB | render gate `verify-render.mjs` / `verify-layers.mjs` |
| `engine-light/node_modules/`, `solo/rstep/node_modules/`, `solo/sdk/node_modules/` | ~5 MB (junctions) | recreated by `pnpm install` |

**robocopy exclusion list (`/XD` names are excluded at every depth):**
```powershell
# PowerShell — session-end mirror to H:\ (run when the desktop node is NOT running)
robocopy C:\dev\GeoBase H:\GeoBase /MIR /XJ /R:1 /W:1 /NP `
  /XD target node_modules dist dist-desktop verify-out `
  /XF *.tmp
```
- `/XJ` skips junction points defensively; combined with the `node_modules` `/XD` it
  prevents robocopy from ever traversing the pnpm symlink farm (all reparse points in
  the repo live under an excluded `node_modules`).
- `/MIR` will copy `data/baselines` and `data/vault` (not excluded), giving a complete
  restore (~56 MB total). Drop them by adding `/XD baselines vault` if you back the
  GeoPackages up separately.
- **Estimated mirror size: ~56 MB** (~15.5 MB code/docs/history + ~41 MB declared
  GeoPackages), versus ~10.9 GB if the tree were copied naively.

**Locked-file cautions:**
- The GeoPackages (`*.gpkg`) are SQLite; if the desktop engine, QGIS, or any tool has
  one open, robocopy will skip it (sharing violation). Mirror with the node stopped.
- `.git/` objects can be briefly locked during a concurrent git operation; avoid
  mirroring mid-commit. `/R:1 /W:1` keeps a locked file from stalling the run.

## Restore Test

After restoring the mirror to another drive (e.g. `X:\GeoBase`):
1. **Rust spine:** `cargo build --workspace --locked` then `cargo test --workspace --locked` — succeeds from `Cargo.lock`; confirms no path escaped the tree and the vendored TSDF test (`vendored_spec_loads_pinned_version_and_four_tiers`, version `0.9.4`) passes.
2. **TS workspaces:** `pnpm install --frozen-lockfile` then `pnpm -r build` — regenerates `node_modules`, the `@geobase/*` workspace links, and `engine-light`/`solo` dist; confirms the lockfile is sufficient.
3. **Offline render:** `pnpm --filter @geobase/engine-light run verify:render` (or preview `engine-light/dist`) with the network off — terrain renders from `public/tiles/terrain/`; proves the no-cloud path and the bundled T0 exception survived.
4. **Declared data present + tagged:** confirm `data/baselines/squaxin_t0.gpkg` exists and reads a T0 TSDF tag, or re-run `python scripts/generate_terrain_tiles.py --baseline data/baselines/squaxin_t0.gpkg --out engine-light/public/tiles/terrain` and check the render gate passes at ≤5 MB.
5. **No leaked absolute paths:** `Select-String -Path X:\GeoBase\* -Pattern '[A-Za-z]:[\\/]' -Recurse` over tracked dirs (note the widened `[\\/]` — the original backslash-only `[A-Za-z]:\\` missed forward-slash drive strings). Expect only: the known DDM doc line; two benign forward-slash hits (`baseline.rs:164` `D:/secret` negative-test string, `LESSONS-FROM-PROTOTYPE.md:59` `D:/miniconda3` anti-pattern); and Tauri `gen/` false positives (`...includes:\n`) — nothing new.

## Runtime Notes

Assumed present on any build/restore host (out of audit scope): Rust **stable ≥ 1.85**
with `rustfmt` + `clippy` (`rust-toolchain.toml`); **Node ≥ 20** and **pnpm 9.15.9**
(`package.json`); **Tauri 2** for the desktop shell; and, only for regenerating fixtures
or terrain tiles, a **Python geo stack** — numpy, rasterio, pyogrio, shapely, PIL
(`scripts/oracle-requirements.txt`, `scripts/session-preflight.ps1`). The dev helper
`scripts/codex-run.ps1` additionally expects the **Codex CLI** on `PATH`. None of these
are file dependencies of the project and none are mirrored; they are installed per host.

## Verification (adversarial pass)

Second reviewer, 2026-07-11 — independent re-audit from different search angles.
**Verdict CONFIRMED: CONTAINED-WITH-DECLARED-DATA.** The audit was sound; two benign
completeness items were added and one verification recipe was tightened. No genuine
external build/runtime dependency was missed.

**Corrected / added:**
- Added two forward-slash drive-path strings the first pass's backslash-only sweep would
  miss, both **benign non-dependencies**: `crates/geobase-core/src/baseline.rs:164`
  (`"D:/secret"` — a *negative* unit test asserting a smuggled `source_path` is
  **rejected**) and `docs/LESSONS-FROM-PROTOTYPE.md:59` (`D:/miniconda3/python.exe` —
  quoted as the prototype anti-pattern to avoid). Neither is a file the project opens.
- Widened the Restore-Test §5 leak regex from `[A-Za-z]:\\` to `[A-Za-z]:[\\/]` so a
  future forward-slash absolute path cannot slip past the guard.
- Clarified the Whitebox row: the three citing docs (`PLAN_1.0.md`,
  `docs/GEOBASE-BUILD-DIRECTIVE.md`, `docs/GEOBASE-DIGITAL-TWIN-FEATURES.md`) are
  **untracked** working-tree files, and the wbtools/Next-Gen references are
  crates.io/GitHub **names** for a not-yet-started `geobase-sim` (future DG-3 gate), not
  local paths.

**Independently confirmed:**
- **Reparse points:** enumerated every junction/symlink in the tree (`Get-ChildItem
  -Attributes ReparsePoint`). **All** targets resolve inside `C:\dev\GeoBase`, including
  the three `@geobase/*` workspace links (`engine-light`, `solo\rstep`, `solo\sdk`). No
  `.lnk`, no escaping reparse point. RStep/SoLO are **in-repo** pnpm members
  (`workspace:*`), not the `H:\RStep` repo. No `H:\…` reference exists anywhere on disk.
- **Compile-time embeds:** every `include_str!`/`include_bytes!` uses
  `env!("CARGO_MANIFEST_DIR")` + relative path; the two embedded fixtures
  (`crates/geobase-core/tests/fixtures/geobase-baseline.json`, `spec/tsdf/tiers.toml`)
  exist. No `.gitmodules`, no submodules.
- **Network surfaces:** TSDF `GitHubSource::load()` and `LocalServerSource::load()` both
  return `NotImplemented`; default is `VendoredSource::embedded()`. No `reqwest`/`hyper`
  client/`ureq`/`fetch` in any Rust crate. Zero `fetch`/`http(s)`/XHR in tracked TS/JS;
  the viewer restricts node sources to `localhost`/`127.0.0.1` and falls back to bundled
  tiles. CI is standard actions on loopback URLs, no secrets/absolute paths.
- **Sizes (filesystem metadata only, no dataset contents read):** `target/` 11.2 GB,
  `node_modules/` 110 MiB, `squaxin_t0.gpkg` 39.7 MiB (+485 B `.aux.xml`), `demo_t0.gpkg`
  1.11 MiB, terrain tiles 1.26 MiB, `.git` 3.54 MiB, `dist`+`dist-desktop` 7.5 MiB,
  `verify-out` 5.9 MiB, `data/fixtures` 0.16 MiB — all match the audit. Robocopy
  exclusions (`target node_modules dist dist-desktop verify-out`) drop nothing
  load-bearing (all git-ignored/rebuildable; workspace source lives outside `node_modules`).
- **Other angles swept clean:** no OneDrive/Dropbox/GDrive mentions; no scheduled-task
  /cron refs; `Start-Process`/subprocess/`Command::new` calls use PATH tools or
  caller-supplied paths (no hardcoded machine paths); both `.ps1` shims parameterize all
  paths; `tauri.conf.json` `frontendDist` is repo-relative (`../../engine-light/dist-desktop`);
  `governance-config.yaml` only names the TSDF GitHub URL with "mock and proceed" offline
  guidance; the `gen/schemas/*.json` drive-letter hits are confirmed false positives
  (`...includes:\n`). The `C:\dev\dynamic-drought-module` DDM pointer in
  `docs/interop/DDM-BRIDGE.md` remains the one machine-absolute path in **committed**
  content (doc-prose, verified to exist, no code dependency).
