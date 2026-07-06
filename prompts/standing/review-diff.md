# Standing Diff Review Prompt

You are Codex reviewing a GeoBase diff. Follow `AGENTS.md` exactly.

Before review, read:

- `AGENTS.md`
- `docs/ARCHITECTURE.md`
- `docs/ROADMAP.md`
- Relevant changed files and nearby tests/docs

Task: review the current diff from a blocking-first engineering and sovereignty-safety perspective.

Review checklist:

- CRS pipeline discipline: no missing CRS assumptions, no silent fallback, native CRS preserved, viewer-only reprojection to `EPSG:3857`.
- Tier discipline: unclassified defaults to T3; effective package tier is most restrictive; tier semantics come from `TsdfSource`.
- T3 egress guarantee: no export, serving, or network path for T3 data.
- Classification metadata travels inside artifacts.
- Lossless data handling, explicit NoData handling, no avoidable quantization.
- GPKG write ordering and complete artifact verification.
- No real data, credentials, absolute local paths, or red-context leakage.
- Observed-behavior gates remain meaningful.
- Offline-first behavior and no cloud lock-in.
- Rust hygiene: `thiserror`, no library `unwrap`/`expect`, documented public items, clippy clean.

Output format:

1. Findings first, ordered by severity. Each finding must include file/line, failure mode, and why it matters.
2. Open questions or assumptions.
3. Brief change summary only after findings.
4. Test gaps or verification not run.

If there are no findings, say so plainly and still list residual test risk.
