// Phase 1.1 layer gate: prove two INDEPENDENT layer packages toggle and
// STACK over the T0 baseline — observed pixels, not green data checks.
//
// Method: with the node-served page at the pinned render-gate camera,
// capture baseline (twice — noise floor), landcover-only, both stacked,
// flood-only, and returned-to-baseline states, then require:
//   each layer alone repaints >= MIN, flood repaints ON TOP of landcover,
//   the two layers' renders differ, and removal returns to baseline within
//   the noise bound. URL-as-state is proven by booting a fresh page with
//   ?layers= and observing the same repaint. Never byte-compare PNGs.
//
// The node (with the two fixture packages in its vault) is booted by the
// caller — locally by the director, in CI by the Layer Gate job. NODE_URL
// is required; the gate refuses to run against bundled-only terrain.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { chromium } from "playwright";
import { preview } from "vite";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(PKG_ROOT, "verify-out", "layers");

// Same pinned camera as verify-render.mjs — the layers stack over the SAME
// baseline the render gate proves, so a human can compare captures.
const CAMERA = "pitch=45&zoom=11.5&center=-123.13,47.14&bearing=0";
const VIEWPORT = { width: 1280, height: 720, deviceScaleFactor: 1 };
const WAIT_MS = 60_000; // a hang is a loud gate failure, not a CI flake
const LC = "landcover-2026.landcover";
const FL = "flood-2026.flood";
const ABSOLUTE_FLOOR = 0.01; // fixtures are sized to repaint well above 1%
const NOISE_MULTIPLIER = 5;
const ROUNDTRIP_FLOOR = 0.002;
const ROUNDTRIP_NOISE_MULTIPLIER = 3;

const fail = (why) => {
  console.error(`LAYER GATE FAILED: ${why}`);
  process.exit(1);
};

const withTimeout = (promise, what) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${what} timed out after ${WAIT_MS} ms`)), WAIT_MS),
    ),
  ]);

const NODE_URL = process.env.NODE_URL;
if (!NODE_URL) fail("NODE_URL env is required — the layer gate only proves node-served layers");

// ---------------------------------------------------------------------------
// Serve the BUILT app via Vite's JS API (verify-render.mjs pattern).
// ---------------------------------------------------------------------------
const server = await preview({ root: PKG_ROOT });
const baseUrl = server.resolvedUrls?.local[0];
if (!baseUrl) fail("vite preview did not resolve a local URL (is dist/ built?)");
const pageUrl = `${baseUrl}?${CAMERA}&node=${encodeURIComponent(NODE_URL)}`;
console.log(`[preview] ${pageUrl}`);

mkdirSync(OUT_DIR, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: VIEWPORT });

const waitReady = async () => {
  // __geobase.ready and layers.ready are PROMISES (the main.ts sync
  // contract); await them in the page, never poll for === true.
  await withTimeout(
    page.evaluate(() => window.__geobase.ready),
    "terrain ready",
  );
  const hasLayers = await page.evaluate(() => Boolean(window.__geobase.layers));
  if (!hasLayers) fail("node mode did not expose window.__geobase.layers");
  await withTimeout(
    page.evaluate(() => window.__geobase.layers.ready),
    "layer panel ready",
  );
};

const active = () => page.evaluate(() => window.__geobase.layers.active());

const toggle = (key) =>
  withTimeout(
    // toggle() resolves after the map reaches idle (layers.ts contract).
    page.evaluate((k) => window.__geobase.layers.toggle(k), key),
    `toggle ${key}`,
  );

const capture = async (name) => {
  const file = join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: file });
  return file;
};

const ratio = (fileA, fileB) => {
  const a = PNG.sync.read(readFileSync(fileA));
  const b = PNG.sync.read(readFileSync(fileB));
  if (a.width !== b.width || a.height !== b.height) {
    fail(`capture dimensions differ: ${fileA} vs ${fileB}`);
  }
  return pixelmatch(a.data, b.data, null, a.width, a.height) / (a.width * a.height);
};

const assertSequence = (got, want, what) => {
  if (got.length !== want.length || got.some((v, i) => v !== want[i])) {
    fail(`${what}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  }
};

let ratios;
let thresholds;
try {
  await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
  await waitReady();

  // Panel contract: the two fixture layers are listed and enabled.
  if ((await page.locator("#layer-panel").count()) !== 1) fail("#layer-panel is missing");
  for (const key of [LC, FL]) {
    const box = page.locator(`input[data-layer="${key}"]`);
    if ((await box.count()) !== 1) fail(`checkbox missing for ${key}`);
    if (!(await box.isEnabled())) fail(`checkbox disabled for ${key}`);
  }

  assertSequence(await active(), [], "baseline active layers");
  const A = await capture("a-baseline");

  // Noise floor: second baseline capture after a repaint round-trip
  // (verify-render.mjs pattern — idle registered in the same sync block).
  await withTimeout(
    page.evaluate(() => {
      const map = window.__geobase.map;
      const settled = new Promise((resolve) => map.once("idle", () => resolve(undefined)));
      map.triggerRepaint();
      return settled;
    }),
    "noise-floor settle",
  );
  const A2 = await capture("a2-baseline");

  await toggle(LC);
  assertSequence(await active(), [LC], "landcover-only active layers");
  const B = await capture("b-landcover");

  await toggle(FL);
  assertSequence(await active(), [LC, FL], "stacked active layers");
  const layersParam = new URL(page.url()).searchParams.get("layers");
  if (layersParam !== `${LC},${FL}`) {
    fail(`URL layers param is ${JSON.stringify(layersParam)}, expected "${LC},${FL}"`);
  }
  const D = await capture("d-stack");

  await toggle(LC);
  assertSequence(await active(), [FL], "flood-only active layers");
  const E = await capture("e-flood-only");

  await toggle(FL);
  assertSequence(await active(), [], "returned-to-baseline active layers");
  if (new URL(page.url()).searchParams.get("layers") !== null) {
    fail("layers URL param must disappear when nothing is active");
  }
  const F = await capture("f-roundtrip-baseline");

  // URL-as-state boot proof: a fresh navigation with ?layers= must restore
  // the flood layer with no imperative toggles (DDM: shareable views).
  await page.goto(`${pageUrl}&layers=${encodeURIComponent(FL)}`, {
    waitUntil: "domcontentloaded",
  });
  await waitReady();
  assertSequence(await active(), [FL], "URL-boot active layers");
  const G = await capture("g-url-boot-flood");

  const noise = ratio(A, A2);
  const min = Math.max(ABSOLUTE_FLOOR, NOISE_MULTIPLIER * noise);
  const roundTripMax = Math.max(ROUNDTRIP_FLOOR, ROUNDTRIP_NOISE_MULTIPLIER * noise);
  thresholds = { noise, min, roundTripMax };
  ratios = {
    landcoverAlone: ratio(A, B),
    floodOverLandcover: ratio(B, D),
    floodAlone: ratio(A, E),
    layersDiffer: ratio(B, E),
    roundTripToBaseline: ratio(A, F),
    urlBootFlood: ratio(A, G),
  };
} finally {
  await browser.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}

const checks = {
  landcoverAlone: ratios.landcoverAlone >= thresholds.min,
  floodOverLandcover: ratios.floodOverLandcover >= thresholds.min,
  floodAlone: ratios.floodAlone >= thresholds.min,
  layersDiffer: ratios.layersDiffer >= thresholds.min,
  roundTripToBaseline: ratios.roundTripToBaseline <= thresholds.roundTripMax,
  urlBootFlood: ratios.urlBootFlood >= thresholds.min,
};
writeFileSync(
  join(OUT_DIR, "summary.json"),
  JSON.stringify({ camera: CAMERA, viewport: VIEWPORT, thresholds, ratios, checks }, null, 2),
);
for (const [name, value] of Object.entries(ratios)) {
  console.log(`[diff] ${name} ${(value * 100).toFixed(3)}%`);
}
console.log(
  `[diff] thresholds: min ${(thresholds.min * 100).toFixed(3)}% ` +
    `(noise ${(thresholds.noise * 100).toFixed(3)}%), ` +
    `round-trip max ${(thresholds.roundTripMax * 100).toFixed(3)}%`,
);

if (!checks.landcoverAlone) fail("landcover alone did not repaint enough pixels");
if (!checks.floodAlone) fail("flood alone did not repaint enough pixels");
if (!checks.floodOverLandcover) fail("flood did not visibly stack on top of landcover");
if (!checks.layersDiffer) fail("the two layers do not render distinctly");
if (!checks.roundTripToBaseline) fail("removing all layers did not return to the baseline render");
if (!checks.urlBootFlood) fail("URL ?layers= boot did not restore the flood layer");
console.log(
  "LAYER GATE PASSED: two independent layer packages toggle and stack over the baseline, observed.",
);
