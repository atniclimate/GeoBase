#!/usr/bin/env node
// verify-rstep.mjs — placeholder for the RStep 1.3d end-to-end observed-behavior
// gate (paint -> export -> product-only shapefile, verified against the
// sovereign ceremony record).
//
// STATUS: NOT YET BUILT. This is a Phase 0 (docs/congruence) repair of a
// dangling package.json script reference (`solo/rstep/package.json`'s
// `verify:rstep` pointed at this file when it did not exist). It exists so
// `pnpm --filter @geobase/rstep run verify:rstep` fails loudly and honestly
// instead of erroring on a missing file.
//
// The real harness is Phase A work (PLAN_1.0.md microtasks A2-A5): fixtures,
// a Playwright-driven boot of crates/geobase-engine-desktop/examples/node.rs,
// driving RStep through window.__rstep (paint -> close polygon -> export),
// then re-proving the export from outside the product (pyogrio oracle) that
// only the product whitelist (id, area_m2, score) is present, plus ledger
// rows in exports_dir/node-audit.gpkg. See docs/PROCESS-MAP.md §7-8 and
// docs/CEREMONY-GATE.md.
//
// Per PLAN_1.0.md's acceptance-integrity rule: even once built, this harness
// must NOT be used to accept Phase 1.3 while it runs against
// ProvisionalDevGate (crates/geobase-gpkg/src/ceremony.rs). Acceptance
// happens exactly once, at Phase B's exit, against the sovereign
// CeremonyGate.

console.error(
  "[verify-rstep] NOT YET BUILT (Phase A, PLAN_1.0.md microtasks A2-A5).\n" +
    "This is an honest placeholder, not a passing check. The RStep 1.3d\n" +
    "gate — paint -> export -> product-only shapefile verified via the\n" +
    "pyogrio oracle, plus a ceremony record in exports_dir/node-audit.gpkg —\n" +
    "does not exist yet. See docs/PROCESS-MAP.md §8 (RStep row: QUEUED) and\n" +
    "docs/ROADMAP.md Phase 1.3 (not accepted-complete)."
);
process.exit(1);
