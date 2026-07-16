#!/usr/bin/env node
// RStep 1.3d gate harness (Phase A, A3+A4; hardened per review B5/H4/H2/advisories):
// paint -> export -> product-only shapefile, OBSERVED end to end, re-proven
// from outside the product.
//
//   1. Package the committed capacity+nogo fixture manifests into an isolated
//      vault with the REAL `geopack` CLI.
//   2. Boot the real node (examples/node.rs) with exports enabled behind the
//      A1 operator token (env-injected; tokens never touch stdout or URLs).
//   3. Drive RStep in Chromium via the REAL UI: click the Draw button, click
//      map vertices, close the ring with Enter — the operator paint path, not
//      a synthetic inject() (review B5). Assert exactly one painted feature,
//      pixel-diff the paint, then fill the panel and click the real Export
//      button. The painted geometry the oracle checks is whatever
//      paint.features() actually reports — the product must equal THAT.
//   4. Re-prove the product with the pyogrio oracle (verify_rstep_oracle.py):
//      whitelist-only fields, id sequence, score == painted, area_m2 within
//      tolerance of an independent geodesic area, ZERO source disclosure
//      (geometry AND attribute values), sidecar values. Verify response
//      hashes against the files on disk.
//   5. Read the T3 ledger ONLY through the trusted, assertion-only Rust
//      verifier (examples/verify-export-audit.rs — never emits row contents):
//      export.ceremony + export.t2 rows, actor, basis, token-absence.
//   6. Negative controls, each asserting the SPECIFIC failure marker: a
//      tampered product must fail the oracle (ORACLE-FAIL); a sovereign-basis
//      expectation must fail the ledger verifier (AUDIT-FAIL) against the
//      provisional gate.
//
// PROVISIONAL-GATE LABEL (acceptance-integrity, PLAN_1.0.md / CONTRIBUTING.md):
// this harness runs against ProvisionalDevGate and asserts the PROVISIONAL
// basis verbatim. Green here is ENGINEERING EVIDENCE, NEVER Phase 1.3
// acceptance. At Phase B's exit (B8) EXPECT_BASIS flips to the sovereign
// process name (docs/CEREMONY-GATE.md).

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
const REQUESTER = "rstep-gate-harness";
const PAINT_SCORE = "0.7";
const EXPECT_BASIS = "provisional — no sovereign ceremony process ran (Phase 1.2 pending)";
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
  await page.fill("#rstep-product", PRODUCT);
  await page.fill("#rstep-requester", REQUESTER);
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
  if (body.ceremony?.process !== "provisional-dev") {
    fail(`ceremony process ${body.ceremony?.process} != provisional-dev (provisional-gate labeled)`);
  }
  if (body.ceremony?.basis !== EXPECT_BASIS) {
    fail(`ceremony basis ${JSON.stringify(body.ceremony?.basis)} != the provisional basis verbatim`);
  }
  for (const [kind, file] of Object.entries(body.files)) {
    const onDisk = join(exportsDir, file.name);
    if (!existsSync(onDisk)) fail(`response names ${file.name} but it is not on disk`);
    const digest = sha256(onDisk);
    if (digest !== file.sha256) fail(`${kind} sha256 mismatch: disk ${digest} != response ${file.sha256}`);
  }
  console.log("[export] 200 T2, provisional basis verbatim, all response hashes match disk");

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
    oracleArgs(join(exportsDir, `${PRODUCT}.shp`), join(exportsDir, `${PRODUCT}.tsdf.json`)),
  );
  if (oracle.code !== 0) fail(`oracle failed:\n${oracle.stdout}\n${oracle.stderr}`);
  console.log(`[oracle] ${oracle.stdout.trim()}`);

  const audit = await run(AUDIT_VERIFIER, [
    exportsDir, PRODUCT,
    "--expect-action", "export.ceremony",
    "--expect-action", "export.t2",
    "--expect-actor", REQUESTER,
    "--expect-basis-contains", "provisional",
    "--forbid-substring", token,
  ]);
  if (audit.code !== 0) fail(`audit verifier failed:\n${audit.stdout}\n${audit.stderr}`);
  console.log(`[ledger] ${audit.stdout.trim().split("\n").pop()}`);

  // ------- Negative controls (assert the SPECIFIC failure marker) -------
  const tampered = join(tmp, "tampered");
  mkdirSync(tampered, { recursive: true });
  for (const ext of ["shp", "shx", "dbf", "prj", "tsdf.json"]) {
    copyFileSync(join(exportsDir, `${PRODUCT}.${ext}`), join(tampered, `${PRODUCT}.${ext}`));
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

  const sovereignCheck = await run(AUDIT_VERIFIER, [
    exportsDir, PRODUCT,
    "--expect-basis-contains", "sovereign ceremony completed",
  ]);
  if (sovereignCheck.code === 0 || !`${sovereignCheck.stdout}${sovereignCheck.stderr}`.includes("AUDIT-FAIL")) {
    fail(
      "NEGATIVE CONTROL FAILED: a sovereign-basis expectation did not fail with AUDIT-FAIL " +
        `against the provisional gate:\n${sovereignCheck.stderr}`,
    );
  }
  console.log("[negative] sovereign-basis expectation correctly fails against the provisional gate (AUDIT-FAIL)");

  writeFileSync(
    join(OUT_DIR, "summary.json"),
    JSON.stringify(
      {
        camera: CAMERA,
        viewport: VIEWPORT,
        ratios,
        painting: "driven through real Draw button + map clicks + Enter",
        export: { status: exportResponse.status, tier: body.tier, files: body.files },
        provisionalGate: true,
        acceptance: "NOT ACCEPTANCE — provisional gate (PLAN_1.0.md A7/B8)",
      },
      null,
      2,
    ),
  );

  console.log(
    "RSTEP GATE PASSED (provisional-gate labeled): operator painted a polygon, export " +
      "product-only, zero source disclosure, ledger rows verified, negatives refused. " +
      "This green is engineering evidence — Phase 1.3 acceptance happens once, at B8, " +
      "against the sovereign gate.",
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
