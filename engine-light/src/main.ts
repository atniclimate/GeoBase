import maplibregl from "maplibre-gl";
import type { RasterDEMSourceSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";

/**
 * GeoBase Light Engine — Phase 0.2: true 3D terrain from a LOCAL raster-dem
 * source (no Cesium, no cloud terrain). Configuration is driven by the
 * baseline manifest emitted by scripts/generate_terrain_tiles.py; its schema
 * is owned by geobase-core::baseline::BaselineManifest and mirrored here.
 * Terrain is REFUSED if the manifest fails the contract — mis-declared data
 * must fail loudly, never render silently.
 */

/** TS mirror of geobase-core::baseline::BaselineManifest (the contract). */
interface BaselineManifest {
  tilejson: string;
  name: string;
  attribution: string;
  classification: string;
  tier: string;
  tsdf_version: string;
  encoding: string;
  scheme: string;
  crs_chain: string[];
  elevation_range_m: [number, number];
  minzoom: number;
  maxzoom: number;
  bounds: [number, number, number, number];
  tiles: string[];
}

const VIEWER_CRS = "EPSG:3857"; // geobase-core::CrsPipeline::VIEWER_CRS

function validateManifest(m: BaselineManifest): void {
  const fail = (why: string): never => {
    throw new Error(`baseline manifest rejected: ${why}`);
  };
  if (!/^T[0-3]$/.test(m.tier)) fail(`tier '${m.tier}' is not a TSDF tier code`);
  if (m.tier !== "T0") fail(`tier ${m.tier} may not be served from a public bundle`);
  if (m.encoding !== "terrarium") fail(`encoding '${m.encoding}' is not 'terrarium'`);
  if (m.scheme !== "xyz") fail(`scheme '${m.scheme}' — raster-dem always requests XYZ`);
  if (m.crs_chain[m.crs_chain.length - 1] !== VIEWER_CRS)
    fail(`crs_chain must end at ${VIEWER_CRS}`);
  const [w, s, e, n] = m.bounds;
  const sane = w >= -180 && e <= 180 && s >= -90 && n <= 90 && w < e && s < n;
  if (!sane) fail(`bounds ${m.bounds} are not sane lon/lat`);
  if (!m.tiles[0]?.includes("{z}")) fail("tiles[0] lost its {z} placeholder");
}

// Deterministic camera control for the verification harness and for humans.
const params = new URLSearchParams(window.location.search);
const num = (key: string, fallback: number): number => {
  const v = params.get(key);
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const centerParam = params.get("center")?.split(",").map(Number);
const center: [number, number] =
  centerParam?.length === 2 && centerParam.every(Number.isFinite)
    ? [centerParam[0], centerParam[1]]
    : [-123.13, 47.14]; // pinned gate camera: high-relief upland (peak 374.9 m)

const map = new maplibregl.Map({
  container: "map",
  style: {
    version: 8,
    sources: {},
    layers: [
      {
        id: "background",
        type: "background",
        paint: { "background-color": "#0b1a1f" },
      },
    ],
  },
  center,
  zoom: num("zoom", 11.5),
  pitch: num("pitch", 45),
  bearing: num("bearing", 0),
  maxPitch: 70,
});

map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");

async function enableTerrain(): Promise<void> {
  // Manifest and tile URLs are built by string concatenation ONLY. `new URL()`
  // percent-encodes {z}/{x}/{y} placeholders, which MapLibre's literal
  // substitution never matches — a silent all-404 failure mode.
  const base = `${import.meta.env.BASE_URL}tiles/terrain/`;
  const response = await fetch(`${base}geobase-baseline.json`);
  if (!response.ok) throw new Error(`baseline manifest fetch failed: ${response.status}`);
  const manifest = (await response.json()) as BaselineManifest;
  validateManifest(manifest);

  const tiles = manifest.tiles.map((t) => `${base}${t}`);
  if (!tiles[0].includes("{z}")) throw new Error("tile template lost its {z} placeholder");

  // MapLibre needs a separate raster-dem source for terrain vs. hillshade
  // ("Use a different source ... to improve render quality" — official
  // 3d-terrain example); terrain drives its source's tile loading at its own
  // zoom offsets, so sharing one source degrades the hillshade.
  const demSource = (): RasterDEMSourceSpecification => ({
    type: "raster-dem",
    tiles,
    encoding: "terrarium",
    tileSize: 256,
    minzoom: manifest.minzoom,
    maxzoom: manifest.maxzoom,
    bounds: manifest.bounds,
    attribution: manifest.attribution,
  });
  map.addSource("terrain-dem", demSource());
  map.addSource("hillshade-dem", demSource());
  map.addLayer({
    id: "hillshade",
    type: "hillshade",
    source: "hillshade-dem",
    paint: { "hillshade-exaggeration": 0.6 },
  });

  // The idle listener is registered in the same synchronous block as
  // setTerrain so a consumer awaiting `ready` can never miss the event.
  const settled = new Promise<void>((resolve) => map.once("idle", () => resolve()));
  map.setTerrain({ source: "terrain-dem", exaggeration: 1.3 });
  await settled;

  // eslint-disable-next-line no-console
  console.log(
    `[GeoBase] terrain ready — ${manifest.name} (${manifest.tier}, ` +
      `TSDF ${manifest.tsdf_version}), local raster-dem, ${manifest.encoding}.`,
  );
}

/** Resolves only after terrain is enabled AND the map has settled (idle). */
const ready: Promise<void> = new Promise((resolve, reject) => {
  map.on("load", () => {
    enableTerrain().then(resolve, reject);
  });
});

declare global {
  interface Window {
    __geobase: { map: maplibregl.Map; ready: Promise<void> };
  }
}
window.__geobase = { map, ready };

void ready.catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error("[GeoBase] terrain refused:", err);
});
