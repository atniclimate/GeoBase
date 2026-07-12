# Contributing to GeoBase

GeoBase is sovereign data infrastructure for Tribal Nations. Contributions are
welcome, with two non-negotiable rules.

## The two rules

1. **Never commit geospatial data.** Code, specs, and tiny fixtures only. No
   `.gpkg`, `.tif`, `.laz`, `.nc`, shapefiles, or any T1–T3 data. Ever.
2. **Never weaken TSDF enforcement.** Tier semantics load from the TSDF resolver;
   do not hardcode them, and do not add an egress path for T3. Default
   classification is T3 — keep it that way.

## Workflow

- Rust: `cargo fmt`, `cargo clippy --workspace`, `cargo test --workspace` must pass.
- TypeScript: `pnpm -r build` must pass.
- Keep to **one** viewer and **one** CRS discipline (see `docs/`). Do not fork
  viewers or introduce ad-hoc project CRSs.
- Render-facing changes need a rendered-output check (screenshot), not just green
  data checks — see `docs/LESSONS-FROM-PROTOTYPE.md`.

## Scope of changes

Follow the phased roadmap in `docs/ROADMAP.md`. If a change spans phases or
touches sovereignty guarantees, open an issue first.

## Branch & congruence discipline

Recorded here per `PLAN_1.0.md` P0.5, so it lives in a tracked, enforced
location rather than only inside a plan document.

- **No phase starts until its governing docs are tracked and congruent on
  `main`.** A phase's plan, fixtures, and any doc it depends on must already
  be committed before implementation work begins.
- **One branch per phase**, bundling fixtures + implementation + the observed
  gate + status-doc updates (`docs/ROADMAP.md` / `docs/PROCESS-MAP.md` /
  `README.md`) together, so that `main` never carries a claim its own gates
  don't back. Never merge implementation without the matching status-doc
  update in the same branch.
- **Source-of-truth hierarchy** (drift resolution order, highest wins):
  `docs/RELEASE-DEFINITION.md` (once ratified) → `docs/DECISIONS.md` →
  `docs/ROADMAP.md` + `docs/PROCESS-MAP.md` → status docs (`README.md`,
  `MANIFEST.md`, `PLAN_1.0.md`). If two tracked docs disagree, the higher
  layer is right and the lower is corrected in the same session that finds
  the drift — never left as an open question.
- **The congruence grep (standing drift audit).** Before merging any phase
  branch, grep `README.md`, `docs/ROADMAP.md`, and `docs/PROCESS-MAP.md` for
  phase-status strings (e.g. `Phase 0.1`, `QUEUED`, `complete`,
  `accepted-complete`) and confirm they agree with each other and with the
  actual CI gate state. Re-run the same check at every phase's exit, not just
  before merge.
- **Acceptance is not inferred from a green harness against a placeholder.**
  A gate is marked accepted-complete in `docs/ROADMAP.md` only when it runs
  against the real, shipping mechanism — never against a documented
  known-insecure placeholder such as `ProvisionalDevGate`
  (`crates/geobase-gpkg/src/ceremony.rs`). See
  `docs/RELEASE-DEFINITION.md`'s acceptance-integrity rule.
