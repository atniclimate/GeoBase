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
