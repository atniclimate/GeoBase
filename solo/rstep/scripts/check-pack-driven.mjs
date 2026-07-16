#!/usr/bin/env node
// A6 (PLAN_1.0.md) — F7.4 honesty pin. RStep's renewable/NoGo behavior must
// stay PACK-DRIVEN: which layers render and which pack ids export is decided
// by what the node's vault serves (client.packs() -> activePackIds), never by
// pack identities baked into the app. This static check fails loudly if a
// future edit hardcodes a specific fixture pack id or a tier-keyed role
// branch into the RStep source — the exact drift F7.4 warns against.
//
// Deliberately a source-shape assertion, not a full test framework: the TS
// workspaces run no unit-test runner (ci.yml runs no `pnpm test`), and adding
// one to the sovereignty-audited stack for a single pin is unwarranted. The
// empirical proof lives in verify-rstep.mjs, which stacks two arbitrary
// fixture packs by name-agnostic discovery; this guards the invariant cheaply.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const files = ["main.ts", "paint.ts"];

// Fixture pack identities the harness uses. If any appears in app source, the
// app has been keyed to specific packs — no longer pack-driven.
const FORBIDDEN_PACK_IDS = [/rstep-capacity-2026/, /rstep-nogo-2026/, /["'`]capacity["'`]/, /["'`]nogo["'`]/];
// Tier-keyed role branching in the app would mean RStep decides behavior from
// tier rather than from what the node serves (tier enforcement is the node's
// job, not the app's).
const FORBIDDEN_TIER_LOGIC = [/=== ?["'`]T[0-3]["'`]/, /tier ?=== ?["'`]T/];

const failures = [];
for (const file of files) {
  const text = readFileSync(join(SRC, file), "utf-8");
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (line.trimStart().startsWith("//")) return; // comments may name packs
    for (const pattern of [...FORBIDDEN_PACK_IDS, ...FORBIDDEN_TIER_LOGIC]) {
      if (pattern.test(line)) {
        failures.push(`${file}:${index + 1}: ${pattern} — ${line.trim()}`);
      }
    }
  });
}

// Positive assertion: stacking must still flow from the node catalog.
const mainText = readFileSync(join(SRC, "main.ts"), "utf-8");
if (!/client\.packs\(\)/.test(mainText)) {
  failures.push("main.ts: no client.packs() call — layer stacking is no longer node-catalog-driven");
}
if (!/activePackIds/.test(mainText)) {
  failures.push("main.ts: no activePackIds — export source packs are no longer discovery-driven");
}

if (failures.length > 0) {
  console.error("PACK-DRIVEN CHECK FAILED (F7.4): RStep has hardcoded pack/tier role logic:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(
  "PACK-DRIVEN CHECK PASSED (F7.4): RStep role behavior is driven by the node " +
    "catalog (client.packs() -> activePackIds), with no fixture pack id or tier " +
    "branch hardcoded in app source.",
);
