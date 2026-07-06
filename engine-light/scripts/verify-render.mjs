// Phase 0.2 render gate: prove the terrain is DISPLACED, not a flat drape.
//
// Method: capture the same pinned camera with terrain on (A) and off (B),
// plus a second terrain-off capture (B') as the render-noise floor, then
// require the A/B pixel-diff to clear a calibrated threshold. The prototype
// died of green data checks over a broken render — this gate only passes if
// elevation data actually reached the renderer and moved pixels.
//
// The committed docs/verification screenshot is a one-time human-endorsed
// artifact; THIS assertion (locally and in CI) is the ongoing enforcement.
// Never byte-compare encoded PNGs.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { chromium } from "playwright";
import { preview } from "vite";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(PKG_ROOT, "verify-out");
const TILES_DIR = join(PKG_ROOT, "public", "tiles");

// Pinned gate camera (recorded in the Step-0 spike): high-relief upland,
// ~19 px of displacement from the 523 m exaggerated relief at this zoom.
const CAMERA = "pitch=45&zoom=11.5&center=-123.13,47.14&bearing=0";
const VIEWPORT = { width: 1280, height: 720, deviceScaleFactor: 1 };
const WAIT_MS = 60_000; // a hang is a loud gate failure, not a CI flake
const TILE_BUDGET_BYTES = 5 * 1024 * 1024; // endorsed carve-out cap
const ABSOLUTE_FLOOR = 0.005; // 5% measured at this camera; fail well below
const NOISE_MULTIPLIER = 5;

const fail = (why) => {
  console.error(`RENDER GATE FAILED: ${why}`);
  process.exit(1);
};

const withTimeout = (promise, what) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${what} timed out after ${WAIT_MS} ms`)), WAIT_MS),
    ),
  ]);

// ---------------------------------------------------------------------------
// Carve-out enforcement: the committed tile set must stay small and contain
// ONLY tiles + the manifest ("size-capped, T0-only" is observed, not asserted
// in prose — .gitignore does not block PNGs, so this check is the fence).
// ---------------------------------------------------------------------------
let tileBytes = 0;
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(path);
    } else {
      if (extname(entry.name) !== ".png" && entry.name !== "geobase-baseline.json") {
        fail(`unexpected file in committed tile dir: ${path}`);
      }
      tileBytes += statSync(path).size;
    }
  }
};
walk(TILES_DIR);
if (tileBytes > TILE_BUDGET_BYTES) {
  fail(`tile bundle ${(tileBytes / 1048576).toFixed(2)} MB exceeds 5 MB cap — drop maxzoom`);
}
console.log(`[carve-out] tile bundle ${(tileBytes / 1048576).toFixed(2)} MB, contents clean`);

// ---------------------------------------------------------------------------
// Serve the BUILT app via Vite's JS API; the resolved URL includes the base
// path (/GeoBase/), so a future base change cannot silently break the gate.
// ---------------------------------------------------------------------------
const server = await preview({ root: PKG_ROOT });
const baseUrl = server.resolvedUrls?.local[0];
if (!baseUrl) fail("vite preview did not resolve a local URL (is dist/ built?)");
const nodeParam = process.env.NODE_URL ? `&node=${encodeURIComponent(process.env.NODE_URL)}` : "";
const url = `${baseUrl}?${CAMERA}${nodeParam}`;
console.log(`[preview] ${url}`);

mkdirSync(OUT_DIR, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: VIEWPORT });

const tileStatuses = [];
page.on("response", (r) => {
  if (/\/tiles\/terrain\/\d+\/\d+\/\d+\.png$/.test(r.url())) tileStatuses.push(r.status());
});

try {
  await page.goto(url, { waitUntil: "domcontentloaded" });

  // Sync contract, part 1: __geobase.ready resolves only after the manifest
  // validated, terrain was enabled, and a subsequent idle fired.
  await withTimeout(
    page.evaluate(() => window.__geobase.ready),
    "terrain ready",
  );
  const state = await page.evaluate(() => ({
    terrain: !!window.__geobase.map.getTerrain(),
    zoom: window.__geobase.map.getZoom(),
    center: window.__geobase.map.getCenter(),
    pitch: window.__geobase.map.getPitch(),
    bearing: window.__geobase.map.getBearing(),
  }));
  if (!state.terrain) fail("map reports no terrain after ready");

  // Separate "flat because 404" from "flat because displacement is broken".
  const ok = tileStatuses.filter((s) => s === 200).length;
  if (ok === 0) fail(`no terrain tile request returned 200 (${tileStatuses.length} responses)`);
  console.log(`[tiles] ${ok}/${tileStatuses.length} tile responses ok`);
  console.log(`[camera] ${JSON.stringify(state)}`);

  const screenshotA = join(OUT_DIR, "a-terrain-on.png");
  await page.screenshot({ path: screenshotA });

  // Sync contract, part 2: register idle BEFORE setTerrain(null), in one
  // synchronous evaluate block — race-free by construction.
  await withTimeout(
    page.evaluate(() => {
      const map = window.__geobase.map;
      const settled = new Promise((resolve) => map.once("idle", () => resolve(undefined)));
      map.setTerrain(null);
      return settled;
    }),
    "terrain-off settle",
  );
  const terrainOff = await page.evaluate(() => window.__geobase.map.getTerrain() === null);
  if (!terrainOff) fail("setTerrain(null) did not take effect");
  await page.screenshot({ path: join(OUT_DIR, "b-terrain-off.png") });

  // Noise floor: second terrain-off capture after another repaint round-trip.
  await withTimeout(
    page.evaluate(() => {
      const map = window.__geobase.map;
      const settled = new Promise((resolve) => map.once("idle", () => resolve(undefined)));
      map.triggerRepaint();
      return settled;
    }),
    "noise-floor settle",
  );
  await page.screenshot({ path: join(OUT_DIR, "b2-terrain-off.png") });
} finally {
  await browser.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}

const load = (name) => PNG.sync.read(readFileSync(join(OUT_DIR, name)));
const a = load("a-terrain-on.png");
const b = load("b-terrain-off.png");
const b2 = load("b2-terrain-off.png");
const px = a.width * a.height;
const displacement = pixelmatch(a.data, b.data, null, a.width, a.height) / px;
const noiseFloor = pixelmatch(b.data, b2.data, null, b.width, b.height) / px;
const threshold = Math.max(ABSOLUTE_FLOOR, NOISE_MULTIPLIER * noiseFloor);

const summary = {
  camera: CAMERA,
  viewport: VIEWPORT,
  tileBundleBytes: tileBytes,
  displacementRatio: displacement,
  noiseFloorRatio: noiseFloor,
  threshold,
  pass: displacement >= threshold,
};
writeFileSync(join(OUT_DIR, "summary.json"), JSON.stringify(summary, null, 2));
console.log(
  `[diff] displacement ${(displacement * 100).toFixed(3)}% vs threshold ` +
    `${(threshold * 100).toFixed(3)}% (noise floor ${(noiseFloor * 100).toFixed(3)}%)`,
);

if (!summary.pass) {
  fail("terrain-on/off pixel diff below threshold — flat drape, the prototype's failure");
}
console.log("RENDER GATE PASSED: terrain is displaced, from a local source, observed.");
