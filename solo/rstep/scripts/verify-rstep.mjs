#!/usr/bin/env node
// RStep 1.3d gate harness (Phase A, A3+A4): paint -> export -> product-only
// shapefile, OBSERVED end to end, then re-proven from outside the product.
//
//   1. Package the committed capacity+nogo fixture manifests into an
//      isolated vault with the REAL `geopack` CLI.
//   2. Boot the real node (examples/node.rs) with exports enabled behind the
//      A1 operator token (env-injected; tokens never touch stdout or URLs).
//   3. Drive RStep in Chromium via the window.__rstep gate handle: assert
//      both fixture packs stacked, exercise the paint interaction state
//      machine, inject a deterministic polygon, pixel-diff the paint,
//      fill the real panel, click the real Export button.
//   4. Re-prove the product with the pyogrio oracle (verify_rstep_oracle.py):
//      whitelist-only fields, output == painted, ZERO source disclosure,
//      sidecar schema. Verify response hashes against the files on disk.
//   5. Read the T3 ledger ONLY through the trusted Rust verifier
//      (examples/verify-export-audit.rs — survives Phase B encryption):
//      export.ceremony + export.t2 rows, actor, basis, and the export token
//      NEVER appearing in the trail.
//   6. Negative controls: a tampered product must fail the oracle; a
//      sovereign-basis expectation must fail against the provisional gate.
//
// PROVISIONAL-GATE LABEL (acceptance-integrity, PLAN_1.0.md / CONTRIBUTING.md):
// this harness currently runs against ProvisionalDevGate and asserts the
// PROVISIONAL basis verbatim. Green here is ENGINEERING EVIDENCE, NEVER
// Phase 1.3 acceptance. At Phase B's exit (B8) the EXPECT_BASIS below flips
// to the sovereign process name — that flip is the one-line gate change
// docs/CEREMONY-GATE.md pre-registers.

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { chromium } from "playwright";
import { preview } from "vite";

const RSTEP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = join(RSTEP_ROOT, "..", "..");
const OUT_DIR = join(RSTEP_ROOT, "verify-out", "rstep");
const EXE = process.platform === "win32" ? ".exe" : "";
const GEOPACK = join(REPO_ROOT, "target", "debug", `geopack${EXE}`);
const NODE_EXAMPLE = join(REPO_ROOT, "target", "debug", "examples", `node${EXE}`);
const AUDIT_VERIFIER = join(REPO_ROOT, "target", "debug", "examples", `verify-export-audit${EXE}`);
const FIXTURES = join(REPO_ROOT, "data", "fixtures", "geopack");
const TILES = join(REPO_ROOT, "engine-light", "public", "tiles", "terrain");
const PLACE = join(REPO_ROOT, "place.example.toml");
const PYTHON =
  process.env.RSTEP_ORACLE_PYTHON ?? (process.platform === "win32" ? "python" : "python3");

const CAMERA = "pitch=45&zoom=11.5&center=-123.13,47.14&bearing=0";
const VIEWPORT = { width: 1280, height: 720, deviceScaleFactor: 1 };
const WAIT_MS = 60_000;
const PAINT_FLOOR = 0.001; // one painted quad repaints a small but real area
const NOISE_MULTIPLIER = 5;
const PACKS = ["rstep-capacity-2026", "rstep-nogo-2026"];
const PRODUCT = "rstep-gate-product";
const REQUESTER = "rstep-gate-harness";
// The provisional basis, verbatim (ceremony.rs PROVISIONAL_BASIS). B8 flips
// this expectation to the sovereign process name — and ONLY then may anyone
// read a green run as acceptance.
const EXPECT_BASIS = "provisional — no sovereign ceremony process ran (Phase 1.2 pending)";
// Deliberately irregular coordinates: must never coincide with a fixture
// source geometry (the oracle proves it, this makes it structurally so).
const PAINT_GEOMETRY = {
  type: "Polygon",
  coordinates: [
    [
      [-123.1571, 47.1263],
      [-123.1042, 47.1291],
      [-123.1073, 47.1608],
      [-123.1589, 47.1577],
      [-123.1571, 47.1263],
    ],
  ],
};
const PAINT_SCORE = 0.7;

const fail = (why) => {
  console.error(`RSTEP GATE FAILED: ${why}`);
  process.exit(1);
};

const withTimeout = (promise, what) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${what} timed out after ${WAIT_MS} ms`)), WAIT_MS),
    ),
  ]);

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

const run = (command, args, options = {}) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { ...options, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.on("error", (err) => resolve({ code: -1, stdout, stderr: String(err) }));
  });

// ---------------------------------------------------------------------------
// Preflight: everything the harness depends on, named loudly.
// ---------------------------------------------------------------------------
for (const [what, path] of [
  ["geopack CLI (cargo build -p geobase-ingestor --bin geopack)", GEOPACK],
  ["node example (cargo build -p geobase-engine-desktop --example node)", NODE_EXAMPLE],
  [
    "audit verifier (cargo build -p geobase-engine-desktop --example verify-export-audit)",
    AUDIT_VERIFIER,
  ],
  ["capacity manifest (A2 fixtures)", join(FIXTURES, "pkg-capacity.toml")],
  ["nogo manifest (A2 fixtures)", join(FIXTURES, "pkg-nogo.toml")],
  ["T0 tile pyramid", join(TILES, "geobase-baseline.json")],
  ["grounding (place.example.toml)", PLACE],
]) {
  if (!existsSync(path)) fail(`missing ${what}: ${path}`);
}

// ---------------------------------------------------------------------------
// Stage: isolated vault + exports dir, fixtures packaged by the real CLI.
// ---------------------------------------------------------------------------
const tmp = mkdtempSync(join(tmpdir(), "rstep-gate-"));
const vault = join(tmp, "vault");
const exportsDir = join(tmp, "exports");
mkdirSync(vault, { recursive: true });
mkdirSync(exportsDir, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

for (const pack of ["capacity", "nogo"]) {
  const out = join(vault, `rstep-${pack}-2026.gpkg`);
  const result = await run(GEOPACK, ["package", "--manifest", `pkg-${pack}.toml`, "--out", out], {
    cwd: FIXTURES,
  });
  if (result.code !== 0) fail(`geopack package ${pack} failed:\n${result.stderr}`);
}

// ---------------------------------------------------------------------------
// Boot the node: exports enabled behind the A1 token (env only), dev ledger
// cipher opted in EXPLICITLY (this is the provisional-gate harness; the B8
// acceptance run replaces this with the real at-rest cipher).
// ---------------------------------------------------------------------------
const token = randomBytes(16).toString("hex");
const nodeProcess = spawn(NODE_EXAMPLE, [PLACE, vault, TILES, "0", exportsDir], {
  cwd: REPO_ROOT,
  shell: false,
  env: { ...process.env, GEOBASE_EXPORT_TOKEN: token, GEOBASE_DEV_UNENCRYPTED: "1" },
});
let nodeLog = "";
const nodeReady = new Promise((resolve, reject) => {
  nodeProcess.stdout.on("data", (chunk) => {
    nodeLog += chunk;
    const match = nodeLog.match(/NODE-READY (http:\/\/\S+)/);
    if (match) resolve(match[1]);
  });
  nodeProcess.stderr.on("data", (chunk) => (nodeLog += chunk));
  nodeProcess.on("exit", (code) => reject(new Error(`node exited early (${code}):\n${nodeLog}`)));
});
let nodeUrl;
try {
  nodeUrl = await withTimeout(nodeReady, "node boot");
} catch (err) {
  fail(String(err));
}
console.log(`[node] ${nodeUrl} (isolated vault: 2 fixture packs, exports behind A1 token)`);

// ---------------------------------------------------------------------------
// Serve the BUILT RStep app; drive it.
// ---------------------------------------------------------------------------
const server = await preview({ root: RSTEP_ROOT });
const baseUrl = server.resolvedUrls?.local[0];
if (!baseUrl) fail("vite preview did not resolve a local URL (is solo/rstep/dist built?)");
const pageUrl = `${baseUrl}?${CAMERA}&node=${encodeURIComponent(nodeUrl)}`;
console.log(`[preview] ${pageUrl}`);

const browser = await chromium.launch();
let exportResponse;
let painted;
let ratios = {};
try {
  const page = await browser.newPage({ viewport: VIEWPORT });
  // Token via init script (the desktop shell's injection path) — never a URL
  // param, never stdout.
  await page.addInitScript(`window.__GEOBASE_EXPORT_TOKEN__ = ${JSON.stringify(token)};`);
  // Every request the page makes must be loopback (the browser-side half of
  // the network posture; the OS-level node proof is B7).
  const nonLoopback = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    // data:/blob: are page-local (blob: backs MapLibre's worker) — not
    // network. Everything else must resolve to loopback.
    if (
      url.protocol !== "data:" &&
      url.protocol !== "blob:" &&
      url.hostname !== "localhost" &&
      url.hostname !== "127.0.0.1" &&
      url.hostname !== "[::1]"
    ) {
      nonLoopback.push(request.url());
    }
  });

  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

  await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
  // The gate handle appears when the module has executed (deferred for
  // type=module). Wait for it, then await its ready promise.
  try {
    await page.waitForFunction(() => window.__rstep !== undefined, undefined, { timeout: WAIT_MS });
    await withTimeout(
      page.evaluate(() => window.__rstep.ready),
      "rstep ready",
    );
  } catch (err) {
    fail(`rstep did not become ready: ${err}\nconsole:\n${consoleErrors.join("\n")}`);
  }

  const active = await page.evaluate(() => window.__rstep.activePacks().slice().sort());
  const expected = PACKS.slice().sort();
  if (JSON.stringify(active) !== JSON.stringify(expected)) {
    fail(`active packs ${JSON.stringify(active)} != fixtures ${JSON.stringify(expected)}`);
  }

  const capture = async (name) => {
    const file = join(OUT_DIR, `${name}.png`);
    await page.screenshot({ path: file });
    return file;
  };
  const ratio = (fileA, fileB) => {
    const a = PNG.sync.read(readFileSync(fileA));
    const b = PNG.sync.read(readFileSync(fileB));
    if (a.width !== b.width || a.height !== b.height) fail("capture dimensions differ");
    return pixelmatch(a.data, b.data, null, a.width, a.height) / (a.width * a.height);
  };

  const A = await capture("a-stacked-baseline");
  await withTimeout(
    page.evaluate(() => {
      const map = window.__rstep.map;
      const settled = new Promise((resolve) => map.once("idle", () => resolve(undefined)));
      map.triggerRepaint();
      return settled;
    }),
    "noise-floor settle",
  );
  const A2 = await capture("a2-stacked-baseline");

  // Paint state machine sanity: start -> Escape cancels, nothing painted.
  await page.evaluate(() => window.__rstep.paint.start());
  if (!(await page.evaluate(() => window.__rstep.paint.isDrawing()))) {
    fail("paint.start() did not enter drawing mode");
  }
  await page.keyboard.press("Escape");
  if (await page.evaluate(() => window.__rstep.paint.isDrawing())) {
    fail("Escape did not cancel drawing");
  }
  if ((await page.evaluate(() => window.__rstep.paint.features().length)) !== 0) {
    fail("cancelled draw left painted features behind");
  }

  // The deterministic paint (gate-handle injection per PLAN A3), observed.
  await withTimeout(
    page.evaluate(
      ({ geometry, score }) => {
        const map = window.__rstep.map;
        const settled = new Promise((resolve) => map.once("idle", () => resolve(undefined)));
        window.__rstep.paint.inject({ id: "gate", geometry, score });
        return settled;
      },
      { geometry: PAINT_GEOMETRY, score: PAINT_SCORE },
    ),
    "paint inject settle",
  );
  const B = await capture("b-painted");
  painted = await page.evaluate(() => window.__rstep.paint.features());
  if (painted.length !== 1) fail(`expected 1 painted feature, got ${painted.length}`);

  const noise = ratio(A, A2);
  const min = Math.max(PAINT_FLOOR, NOISE_MULTIPLIER * noise);
  ratios = { noise, min, painted: ratio(A, B) };
  if (ratios.painted < min) {
    fail(
      `painting repainted ${(ratios.painted * 100).toFixed(3)}% ` +
        `< required ${(min * 100).toFixed(3)}% — paint not observed`,
    );
  }

  // The REAL export flow: panel inputs + button, response captured.
  await page.fill("#rstep-product", PRODUCT);
  await page.fill("#rstep-requester", REQUESTER);
  const responsePromise = page.waitForResponse(
    (response) => response.url().includes("/api/export") && response.request().method() === "POST",
    { timeout: WAIT_MS },
  );
  await page.click("#rstep-export");
  const response = await responsePromise;
  exportResponse = { status: response.status(), body: await response.json() };
  await page.waitForFunction(
    () => document.querySelector("#rstep-status")?.textContent?.length > 0,
    undefined,
    { timeout: WAIT_MS },
  );
  const statusText = await page.textContent("#rstep-status");
  if (!statusText?.includes("tier: T2")) {
    fail(`panel status does not show the T2 outcome:\n${statusText}`);
  }
  if (nonLoopback.length > 0) {
    fail(`page made non-loopback requests: ${nonLoopback.join(", ")}`);
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
  nodeProcess.kill();
}

// ---------------------------------------------------------------------------
// Response contract + on-disk hashes.
// ---------------------------------------------------------------------------
if (exportResponse.status !== 200) {
  fail(`export returned ${exportResponse.status}: ${JSON.stringify(exportResponse.body)}`);
}
const body = exportResponse.body;
if (body.tier !== "T2") fail(`product tier ${body.tier} != T2`);
if (body.features !== 1) fail(`features ${body.features} != 1`);
if (body.ceremony?.process !== "provisional-dev") {
  fail(
    `ceremony process ${body.ceremony?.process} != provisional-dev ` +
      "(this harness is provisional-gate labeled)",
  );
}
if (body.ceremony?.basis !== EXPECT_BASIS) {
  fail(`ceremony basis ${JSON.stringify(body.ceremony?.basis)} != the provisional basis verbatim`);
}
for (const [kind, file] of Object.entries(body.files)) {
  const onDisk = join(exportsDir, file.name);
  if (!existsSync(onDisk)) fail(`response names ${file.name} but it is not on disk`);
  const digest = sha256(onDisk);
  if (digest !== file.sha256) {
    fail(`${kind} sha256 mismatch: disk ${digest} != response ${file.sha256}`);
  }
}
console.log("[export] 200 T2, provisional basis verbatim, all response hashes match disk");

// ---------------------------------------------------------------------------
// Oracle re-proof (pyogrio) + ledger via the trusted Rust verifier.
// ---------------------------------------------------------------------------
const paintedJson = join(tmp, "painted.json");
writeFileSync(paintedJson, JSON.stringify(painted));
const oracleArgs = (shp, sidecar) => [
  join(RSTEP_ROOT, "scripts", "verify_rstep_oracle.py"),
  "--product-shp",
  shp,
  "--painted-json",
  paintedJson,
  "--sidecar",
  sidecar,
  "--expect-features",
  "1",
  "--source",
  join(vault, "rstep-capacity-2026.gpkg"),
  "--source",
  join(vault, "rstep-nogo-2026.gpkg"),
];
const oracle = await run(
  PYTHON,
  oracleArgs(join(exportsDir, `${PRODUCT}.shp`), join(exportsDir, `${PRODUCT}.tsdf.json`)),
);
if (oracle.code !== 0) fail(`oracle failed:\n${oracle.stdout}\n${oracle.stderr}`);
console.log(`[oracle] ${oracle.stdout.trim()}`);

const audit = await run(AUDIT_VERIFIER, [
  exportsDir,
  PRODUCT,
  "--expect-action",
  "export.ceremony",
  "--expect-action",
  "export.t2",
  "--expect-actor",
  REQUESTER,
  "--expect-basis-contains",
  "provisional",
  "--forbid-substring",
  token,
]);
if (audit.code !== 0) fail(`audit verifier failed:\n${audit.stdout}\n${audit.stderr}`);
console.log(`[ledger] ${audit.stdout.trim().split("\n").pop()}`);

// ---------------------------------------------------------------------------
// Negative controls — a gate that cannot fail proves nothing.
// ---------------------------------------------------------------------------
// (1) Tampered product must fail the oracle. Copy the bundle, flip one
// coordinate byte inside the .shp record section, re-run.
const tampered = join(tmp, "tampered");
mkdirSync(tampered, { recursive: true });
for (const ext of ["shp", "shx", "dbf", "prj", "tsdf.json"]) {
  copyFileSync(join(exportsDir, `${PRODUCT}.${ext}`), join(tampered, `${PRODUCT}.${ext}`));
}
const shpBytes = readFileSync(join(tampered, `${PRODUCT}.shp`));
if (shpBytes.length < 160) fail("tamper target .shp unexpectedly small");
// Point coordinates live at the END of the record (after the header, shape
// type, bbox, part index); the bbox bytes are recomputed from points by the
// reader, so tamper an actual coordinate double — the last point's mantissa.
shpBytes[shpBytes.length - 6] ^= 0xff;
writeFileSync(join(tampered, `${PRODUCT}.shp`), shpBytes);
const tamperedOracle = await run(
  PYTHON,
  oracleArgs(join(tampered, `${PRODUCT}.shp`), join(tampered, `${PRODUCT}.tsdf.json`)),
);
if (tamperedOracle.code === 0) {
  fail("NEGATIVE CONTROL FAILED: the oracle accepted a tampered product");
}
console.log("[negative] tampered product refused by the oracle");

// (2) A sovereign-basis expectation must FAIL against the provisional gate —
// the exact assertion flip B8 performs cannot silently pass early.
const sovereignCheck = await run(AUDIT_VERIFIER, [
  exportsDir,
  PRODUCT,
  "--expect-basis-contains",
  "sovereign ceremony completed",
]);
if (sovereignCheck.code === 0) {
  fail(
    "NEGATIVE CONTROL FAILED: a sovereign-basis expectation passed against the provisional gate",
  );
}
console.log("[negative] sovereign-basis expectation correctly fails against the provisional gate");

writeFileSync(
  join(OUT_DIR, "summary.json"),
  JSON.stringify(
    {
      camera: CAMERA,
      viewport: VIEWPORT,
      ratios,
      export: { status: exportResponse.status, tier: body.tier, files: body.files },
      provisionalGate: true,
      acceptance: "NOT ACCEPTANCE — provisional gate (PLAN_1.0.md A7/B8)",
    },
    null,
    2,
  ),
);
rmSync(tmp, { recursive: true, force: true });

console.log(
  "RSTEP GATE PASSED (provisional-gate labeled): paint observed, export " +
    "product-only, zero source disclosure, ledger rows verified, negatives refused. " +
    "This green is engineering evidence — Phase 1.3 acceptance happens once, at B8, " +
    "against the sovereign gate.",
);
