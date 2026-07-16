#!/usr/bin/env node
// RStep 1.3d gate harness (Phase A, A3+A4; B3 rework: sovereign gate):
// consent -> session -> paint -> export -> product-only bundle, OBSERVED
// end to end, re-proven from outside the product.
//
//   1. Package the committed capacity+nogo fixture manifests into an isolated
//      vault with the REAL `geopack` CLI.
//   2. Record a fixture consent agreement into the node's consent store the
//      way the LOCAL OPERATOR does (examples/record-consent.rs — recording is
//      never a network route), covering both fixture packs and binding the
//      interim A1 operator identity.
//   3. Boot the real node (examples/node.rs) with exports enabled behind the
//      A1 operator token (env-injected; tokens never touch stdout or URLs).
//      B3: the node composes the SOVEREIGN RecordedConsentGate; the app
//      begins a node-witnessed export session before loading layers.
//   4. Drive RStep in Chromium via the REAL UI: click the Draw button, click
//      map vertices, close the ring with Enter — the operator paint path.
//      Assert exactly one painted feature, pixel-diff the paint, then click
//      the real Export button. The painted geometry the oracle checks is
//      whatever paint.features() actually reports.
//   5. Re-prove the product with the pyogrio oracle (verify_rstep_oracle.py):
//      whitelist-only fields, id sequence, score == painted, area_m2 within
//      tolerance, ZERO source disclosure, sidecar values. Verify response
//      hashes against the published bundle on disk.
//   6. Read the T3 ledger ONLY through the trusted, assertion-only Rust
//      verifier (examples/verify-export-audit.rs — never emits row contents):
//      the FULL publication protocol row sequence (intent -> ceremony -> t2
//      -> published), authenticated actor, sovereign basis, token-absence,
//      provisional-wording absence.
//   7. Negative controls, each asserting the SPECIFIC failure marker: a
//      tampered product must fail the oracle (ORACLE-FAIL); a
//      PROVISIONAL-basis expectation must fail the ledger verifier
//      (AUDIT-FAIL) against the sovereign gate — provisional-wording
//      exclusivity, the inverse of the pre-B3 control.
//
// ACCEPTANCE LABEL (acceptance-integrity, PLAN_1.0.md / CONTRIBUTING.md):
// since B3 this harness runs against the SOVEREIGN gate and asserts
// EXPECT_PROCESS and EXPECT_BASIS independently, plus basis != the
// provisional wording. Green here is ENGINEERING EVIDENCE, NEVER
// acceptance — the observed acceptance run happens exactly once, at B8.

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
import { setTimeout as sleep } from "node:timers/promises";
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
const RECORD_CONSENT = join(REPO_ROOT, "target", "debug", "examples", `record-consent${EXE}`);
const FIXTURES = join(REPO_ROOT, "data", "fixtures", "geopack");
const TILES = join(REPO_ROOT, "engine-light", "public", "tiles", "terrain");
const PLACE = join(REPO_ROOT, "place.example.toml");
const PYTHON =
  process.env.RSTEP_ORACLE_PYTHON ?? (process.platform === "win32" ? "python" : "python3");

const CAMERA = "pitch=45&zoom=11.5&center=-123.13,47.14&bearing=0";
const VIEWPORT = { width: 1280, height: 720, deviceScaleFactor: 1 };
const WAIT_MS = 60_000;
const PAINT_FLOOR = 0.001;
const NOISE_MULTIPLIER = 5;
const PACKS = ["rstep-capacity-2026", "rstep-nogo-2026"];
const PRODUCT = "rstep-gate-product";
const PAINT_SCORE = "0.7";
// B8 asserts process and basis INDEPENDENTLY (docs/CEREMONY-DESIGN.md §8),
// and that the basis is not the provisional wording. Same bar here.
const EXPECT_PROCESS = "geobase-recorded-consent-check-v1";
const EXPECT_BASIS = "active recorded consent evidence matched for T2 derived-product export";
const PROVISIONAL_BASIS = "provisional — no sovereign ceremony process ran (Phase 1.2 pending)";
// The authenticated interim A1 operator identity (server.rs; B5 replaces).
const EXPECT_ACTOR = "local-operator:a1-interim-export-token";
// Vertices the OPERATOR paints (as map lng/lat). Chosen near camera centre so
// they project onto the map canvas away from the corner panel, irregular so
// they cannot coincide with a fixture source polygon. The exact painted
// geometry is read back from paint.features() after the round-trip through
// real clicks — the oracle checks the product against that, not against these.
const PAINT_VERTICES = [
  [-123.157, 47.126],
  [-123.104, 47.129],
  [-123.107, 47.161],
  [-123.159, 47.158],
];

class GateError extends Error {}
const fail = (why) => {
  throw new GateError(why);
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

// Single owner of all external resources so cleanup is total on every path
// (review H4): success, assertion failure, boot timeout — everything is torn
// down in one finally before the process ends.
const resources = { browser: null, server: null, node: null, tmp: null };

async function cleanup() {
  if (resources.browser) await resources.browser.close().catch(() => {});
  if (resources.server) {
    await new Promise((resolve) => resources.server.httpServer.close(resolve)).catch(() => {});
  }
  if (resources.node && resources.node.exitCode === null) {
    const exited = new Promise((resolve) => resources.node.once("exit", resolve));
    resources.node.kill();
    await Promise.race([exited, sleep(5_000)]);
  }
  if (resources.tmp) rmSync(resources.tmp, { recursive: true, force: true });
}

async function main() {
  // ------- Preflight -------
  for (const [what, path] of [
    ["geopack CLI (cargo build -p geobase-ingestor --bin geopack)", GEOPACK],
    ["node example (cargo build -p geobase-engine-desktop --example node)", NODE_EXAMPLE],
    [
      "audit verifier (cargo build -p geobase-engine-desktop --example verify-export-audit)",
      AUDIT_VERIFIER,
    ],
    [
      "consent recorder (cargo build -p geobase-engine-desktop --example record-consent)",
      RECORD_CONSENT,
    ],
    ["capacity manifest (A2 fixtures)", join(FIXTURES, "pkg-capacity.toml")],
    ["nogo manifest (A2 fixtures)", join(FIXTURES, "pkg-nogo.toml")],
    ["T0 tile pyramid", join(TILES, "geobase-baseline.json")],
    ["grounding (place.example.toml)", PLACE],
  ]) {
    if (!existsSync(path)) fail(`missing ${what}: ${path}`);
  }

  // ------- Stage isolated vault + exports, package with the real CLI -------
  const tmp = mkdtempSync(join(tmpdir(), "rstep-gate-"));
  resources.tmp = tmp;
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

  // ------- Record the fixture consent agreement (LOCAL OPERATOR act) -------
  // B3: the sovereign gate authorizes only against a recorded agreement
  // covering the node-witnessed source set. Recording happens on the node,
  // never over the network — this is the operator's tool.
  const consent = await run(
    RECORD_CONSENT,
    [
      exportsDir,
      "rstep-gate-agreement-2026",
      "--source", PACKS[0],
      "--source", PACKS[1],
      "--authority", "RStep Gate Fixture Signatory (synthetic)",
      "--document-ref", "fixtures://rstep-gate-agreement-2026",
      "--document-sha256", createHash("sha256").update("rstep-gate-agreement-2026").digest("hex"),
    ],
    { env: { ...process.env, GEOBASE_DEV_UNENCRYPTED: "1" } },
  );
  if (consent.code !== 0 || !consent.stdout.includes("CONSENT-OK")) {
    fail(`consent recording failed:\n${consent.stdout}\n${consent.stderr}`);
  }
  console.log(`[consent] ${consent.stdout.trim()}`);

  // ------- Boot the node (exports behind A1 token; dev ledger cipher) -------
  const token = randomBytes(16).toString("hex");
  const node = spawn(NODE_EXAMPLE, [PLACE, vault, TILES, "0", exportsDir], {
    cwd: REPO_ROOT,
    shell: false,
    env: { ...process.env, GEOBASE_EXPORT_TOKEN: token, GEOBASE_DEV_UNENCRYPTED: "1" },
  });
  resources.node = node;
  let nodeLog = "";
  const nodeUrl = await withTimeout(
    new Promise((resolve, reject) => {
      node.stdout.on("data", (chunk) => {
        nodeLog += chunk;
        const match = nodeLog.match(/NODE-READY (http:\/\/\S+)/);
        if (match) resolve(match[1]);
      });
      node.stderr.on("data", (chunk) => (nodeLog += chunk));
      node.on("exit", (code) => reject(new Error(`node exited early (${code}):\n${nodeLog}`)));
    }),
    "node boot",
  );
  console.log(`[node] ${nodeUrl} (isolated vault: 2 fixture packs, exports behind A1 token)`);

  // ------- Serve the built app -------
  const server = await preview({ root: RSTEP_ROOT });
  resources.server = server;
  const baseUrl = server.resolvedUrls?.local[0];
  if (!baseUrl) fail("vite preview did not resolve a local URL (is solo/rstep/dist built?)");
  const pageUrl = `${baseUrl}?${CAMERA}&node=${encodeURIComponent(nodeUrl)}`;
  console.log(`[preview] ${pageUrl}`);

  const browser = await chromium.launch();
  resources.browser = browser;
  const page = await browser.newPage({ viewport: VIEWPORT });
  await page.addInitScript(`window.__GEOBASE_EXPORT_TOKEN__ = ${JSON.stringify(token)};`);

  const nonLoopback = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
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
  page.on("console", (msg) => msg.type() === "error" && consoleErrors.push(msg.text()));
  page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

  await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
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

  // ------- B5: drive the REAL operator paint path -------
  await page.fill("#rstep-score", PAINT_SCORE);
  // Draw button toggles drawing on.
  await page.click("#rstep-draw");
  if (!(await page.evaluate(() => window.__rstep.paint.isDrawing()))) {
    fail("clicking Draw did not enter drawing mode");
  }
  // Project each lng/lat to canvas pixels and click it as a real pointer.
  const canvasBox = await page.locator("#map canvas.maplibregl-canvas").boundingBox();
  if (!canvasBox) fail("map canvas has no bounding box");
  for (const [lng, lat] of PAINT_VERTICES) {
    const pt = await page.evaluate(
      ([lng, lat]) => {
        const p = window.__rstep.map.project([lng, lat]);
        return { x: p.x, y: p.y };
      },
      [lng, lat],
    );
    // Spaced clicks (distinct positions + a gap) so the browser never
    // coalesces two into a dblclick, which would close the ring early.
    await page.mouse.click(canvasBox.x + pt.x, canvasBox.y + pt.y);
    await sleep(350);
  }
  // Close the ring through the real keyboard path (Enter).
  await page.keyboard.press("Enter");
  await withTimeout(
    page.waitForFunction(
      () => window.__rstep.paint.isDrawing() === false && window.__rstep.paint.features().length === 1,
      undefined,
      { timeout: WAIT_MS },
    ),
    "ring close",
  ).catch(() =>
    fail(
      "operator paint did not produce exactly one closed polygon " +
        `(isDrawing/features mismatch)\nconsole:\n${consoleErrors.join("\n")}`,
    ),
  );
  const painted = await page.evaluate(() => window.__rstep.paint.features());
  if (painted.length !== 1) fail(`expected 1 painted feature, got ${painted.length}`);
  if (painted[0].score !== Number(PAINT_SCORE)) {
    fail(`painted score ${painted[0].score} != panel score ${PAINT_SCORE}`);
  }
  const B = await capture("b-painted");

  const noise = ratio(A, A2);
  const min = Math.max(PAINT_FLOOR, NOISE_MULTIPLIER * noise);
  const ratios = { noise, min, painted: ratio(A, B) };
  if (ratios.painted < min) {
    fail(
      `painting repainted ${(ratios.painted * 100).toFixed(3)}% ` +
        `< required ${(min * 100).toFixed(3)}% — paint not observed`,
    );
  }

  // ------- The real export flow -------
  // B3: no requester field — identity is authenticated node-side; the
  // source set is the node's witnessed session record.
  await page.fill("#rstep-product", PRODUCT);
  const responsePromise = page.waitForResponse(
    (response) => response.url().includes("/api/export") && response.request().method() === "POST",
    { timeout: WAIT_MS },
  );
  await page.click("#rstep-export");
  const response = await responsePromise;
  const exportResponse = { status: response.status(), body: await response.json() };
  await page.waitForFunction(
    () => (document.querySelector("#rstep-status")?.textContent?.length ?? 0) > 0,
    undefined,
    { timeout: WAIT_MS },
  );
  const statusText = await page.textContent("#rstep-status");
  if (!statusText?.includes("tier: T2")) fail(`panel status does not show the T2 outcome:\n${statusText}`);
  if (nonLoopback.length > 0) fail(`page made non-loopback requests: ${nonLoopback.join(", ")}`);

  // ------- Response contract + on-disk hashes -------
  if (exportResponse.status !== 200) {
    fail(`export returned ${exportResponse.status}: ${JSON.stringify(exportResponse.body)}`);
  }
  const body = exportResponse.body;
  if (body.tier !== "T2") fail(`product tier ${body.tier} != T2`);
  if (body.features !== 1) fail(`features ${body.features} != 1`);
  // Process and basis asserted INDEPENDENTLY, plus provisional exclusion
  // (the B8 bar, docs/CEREMONY-DESIGN.md §8).
  if (body.ceremony?.process !== EXPECT_PROCESS) {
    fail(`ceremony process ${JSON.stringify(body.ceremony?.process)} != ${EXPECT_PROCESS}`);
  }
  if (body.ceremony?.basis !== EXPECT_BASIS) {
    fail(`ceremony basis ${JSON.stringify(body.ceremony?.basis)} != the sovereign basis verbatim`);
  }
  if (body.ceremony?.basis === PROVISIONAL_BASIS) {
    fail("ceremony basis is the provisional wording — the sovereign gate must never emit it");
  }
  if (typeof body.publication_id !== "string" || body.publication_id === "") {
    fail("response carries no publication_id (B3 recoverable-publication protocol)");
  }
  // B3: the product publishes as a BUNDLE DIRECTORY exports/<product>/.
  const bundleDir = join(exportsDir, PRODUCT);
  for (const [kind, file] of Object.entries(body.files)) {
    const onDisk = join(bundleDir, file.name);
    if (!existsSync(onDisk)) fail(`response names ${file.name} but it is not in the bundle`);
    const digest = sha256(onDisk);
    if (digest !== file.sha256) fail(`${kind} sha256 mismatch: disk ${digest} != response ${file.sha256}`);
  }
  console.log("[export] 200 T2, sovereign process+basis verbatim, all response hashes match the published bundle");

  // ------- Oracle re-proof + ledger via the trusted (assertion-only) verifier -------
  const paintedJson = join(tmp, "painted.json");
  writeFileSync(paintedJson, JSON.stringify(painted));
  const oracleArgs = (shp, sidecar) => [
    join(RSTEP_ROOT, "scripts", "verify_rstep_oracle.py"),
    "--product-shp", shp,
    "--painted-json", paintedJson,
    "--sidecar", sidecar,
    "--expect-features", "1",
    "--expect-product", PRODUCT,
    "--source", join(vault, "rstep-capacity-2026.gpkg"),
    "--source", join(vault, "rstep-nogo-2026.gpkg"),
  ];
  const oracle = await run(
    PYTHON,
    oracleArgs(join(bundleDir, `${PRODUCT}.shp`), join(bundleDir, `${PRODUCT}.tsdf.json`)),
  );
  if (oracle.code !== 0) fail(`oracle failed:\n${oracle.stdout}\n${oracle.stderr}`);
  console.log(`[oracle] ${oracle.stdout.trim()}`);

  const audit = await run(AUDIT_VERIFIER, [
    exportsDir, PRODUCT,
    // The FULL B3 publication protocol, ordered and exhaustive.
    "--expect-action", "export.intent",
    "--expect-action", "export.ceremony",
    "--expect-action", "export.t2",
    "--expect-action", "export.published",
    "--expect-actor", EXPECT_ACTOR,
    "--expect-basis-contains", EXPECT_BASIS,
    "--forbid-substring", token,
    // Provisional-wording exclusivity: the sovereign trail must not
    // contain the provisional sentence anywhere.
    "--forbid-substring", PROVISIONAL_BASIS,
  ]);
  if (audit.code !== 0) fail(`audit verifier failed:\n${audit.stdout}\n${audit.stderr}`);
  console.log(`[ledger] ${audit.stdout.trim().split("\n").pop()}`);

  // ------- Negative controls (assert the SPECIFIC failure marker) -------
  const tampered = join(tmp, "tampered");
  mkdirSync(tampered, { recursive: true });
  for (const ext of ["shp", "shx", "dbf", "prj", "tsdf.json"]) {
    copyFileSync(join(bundleDir, `${PRODUCT}.${ext}`), join(tampered, `${PRODUCT}.${ext}`));
  }
  const shpBytes = readFileSync(join(tampered, `${PRODUCT}.shp`));
  if (shpBytes.length < 160) fail("tamper target .shp unexpectedly small");
  shpBytes[shpBytes.length - 6] ^= 0xff; // a real coordinate double, not the bbox
  writeFileSync(join(tampered, `${PRODUCT}.shp`), shpBytes);
  const tamperedOracle = await run(
    PYTHON,
    oracleArgs(join(tampered, `${PRODUCT}.shp`), join(tampered, `${PRODUCT}.tsdf.json`)),
  );
  if (tamperedOracle.code === 0 || !`${tamperedOracle.stdout}${tamperedOracle.stderr}`.includes("ORACLE-FAIL")) {
    fail(`NEGATIVE CONTROL FAILED: tampered product not refused with ORACLE-FAIL:\n${tamperedOracle.stderr}`);
  }
  console.log("[negative] tampered product refused by the oracle (ORACLE-FAIL)");

  // Provisional-wording exclusivity, inverted from the pre-B3 control: a
  // PROVISIONAL-basis expectation must fail against the sovereign gate.
  const provisionalCheck = await run(AUDIT_VERIFIER, [
    exportsDir, PRODUCT,
    "--expect-basis-contains", "provisional",
  ]);
  if (provisionalCheck.code === 0 || !`${provisionalCheck.stdout}${provisionalCheck.stderr}`.includes("AUDIT-FAIL")) {
    fail(
      "NEGATIVE CONTROL FAILED: a provisional-basis expectation did not fail with AUDIT-FAIL " +
        `against the sovereign gate:\n${provisionalCheck.stderr}`,
    );
  }
  console.log("[negative] provisional-basis expectation correctly fails against the sovereign gate (AUDIT-FAIL)");

  writeFileSync(
    join(OUT_DIR, "summary.json"),
    JSON.stringify(
      {
        camera: CAMERA,
        viewport: VIEWPORT,
        ratios,
        painting: "driven through real Draw button + map clicks + Enter",
        export: {
          status: exportResponse.status,
          tier: body.tier,
          files: body.files,
          publication_id: body.publication_id,
        },
        sovereignGate: true,
        process: EXPECT_PROCESS,
        acceptance: "NOT ACCEPTANCE — engineering evidence; the observed acceptance run happens once, at B8 (PLAN_1.0.md)",
      },
      null,
      2,
    ),
  );

  console.log(
    "RSTEP GATE PASSED (sovereign gate, B3): recorded consent matched, session-witnessed " +
      "source set, operator painted a polygon, export product-only, zero source disclosure, " +
      "full publication protocol trail verified, negatives refused. This green is engineering " +
      "evidence — acceptance happens once, at B8.",
  );
}

try {
  await main();
} catch (err) {
  console.error(`RSTEP GATE FAILED: ${err instanceof Error ? err.message : String(err)}`);
  await cleanup();
  process.exit(1);
}
await cleanup();
