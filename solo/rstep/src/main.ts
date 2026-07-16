import maplibregl from "maplibre-gl";
import type {
  CircleLayerSpecification,
  FillLayerSpecification,
  GeoJSONSourceSpecification,
  LineLayerSpecification,
  RasterDEMSourceSpecification,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { NodeClient, NodeRequestError } from "@geobase/solo-sdk";
import type { FeatureCollection, LayerMeta, PackLayers, PackSummary } from "@geobase/solo-sdk";
import { HandRolledPaintTool } from "./paint";
import "./style.css";

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

interface CatalogLayer {
  key: string;
  pack: string;
  table: string;
  meta: LayerMeta;
  geometry: string;
}

const VIEWER_CRS = "EPSG:3857";
const RENDERABLE_SRS = "EPSG:4326";
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
    : [-123.13, 47.14];

const maybeClient = nodeClient();
if (maybeClient === null) {
  renderRefusal("RStep requires ?node= or __GEOBASE_NODE__ with an http(s) localhost/127.0.0.1 URL");
  throw new Error("[RStep] refused: no valid loopback node");
}
const client: NodeClient = maybeClient;

const map = new maplibregl.Map({
  container: "map",
  style: {
    version: 8,
    sources: {},
    layers: [{ id: "background", type: "background", paint: { "background-color": "#0b1a1f" } }],
  },
  center,
  zoom: num("zoom", 11.5),
  pitch: num("pitch", 45),
  bearing: num("bearing", 0),
  maxPitch: 70,
});

map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");

const panel = buildPanel();
const activePackIds: string[] = [];
const paint = new HandRolledPaintTool(map, { score: () => scoreValue(panel.score) });
paint.onChange(() => updateDrawButton(panel.draw, paint));

panel.draw.addEventListener("click", () => {
  if (paint.isDrawing()) {
    paint.cancel();
  } else {
    paint.start();
  }
  updateDrawButton(panel.draw, paint);
});

panel.exportButton.addEventListener("click", () => {
  void exportProduct();
});

const ready: Promise<void> = new Promise((resolve, reject) => {
  map.on("load", () => {
    (async (): Promise<void> => {
      await enableTerrain();
      await stackRenderableLayers();
    })().then(resolve, reject);
  });
});

declare global {
  interface Window {
    __GEOBASE_NODE__?: string;
    __GEOBASE_EXPORT_TOKEN__?: string;
    __geobase: {
      map: maplibregl.Map;
      ready: Promise<void>;
    };
    __rstep: {
      map: maplibregl.Map;
      ready: Promise<void>;
      paint: HandRolledPaintTool;
      client: NodeClient;
      activePacks(): string[];
    };
  }
}

window.__geobase = { map, ready };
window.__rstep = {
  map,
  ready,
  paint,
  client,
  activePacks: () => [...activePackIds],
};

void ready.catch((err: unknown) => {
  console.error("[RStep] refused:", err);
  panel.status.textContent = err instanceof Error ? err.message : String(err);
});

function nodeClient(): NodeClient | null {
  const node = params.get("node") ?? window.__GEOBASE_NODE__ ?? null;
  if (node === null || node === undefined || node.trim() === "") return null;
  // Interim operator export token (Phase A guard): injected by the desktop
  // shell (or a harness init script) as a window global — deliberately NOT
  // a URL param, which would leak into history/logs. Absent → export
  // attempts are refused by the node (403), read endpoints are unaffected.
  const exportToken = window.__GEOBASE_EXPORT_TOKEN__ ?? undefined;
  try {
    return new NodeClient(node, exportToken !== undefined ? { exportToken } : undefined);
  } catch (err: unknown) {
    console.error(`[RStep] rejected node source '${node}'`, err);
    return null;
  }
}

function renderRefusal(message: string): void {
  console.error(`[RStep] ${message}`);
  document.body.innerHTML = "";
  const refusal = document.createElement("main");
  refusal.id = "rstep-refusal";
  refusal.textContent = message;
  document.body.appendChild(refusal);
}

function validateManifest(m: BaselineManifest): void {
  const fail = (why: string): never => {
    throw new Error(`baseline manifest rejected: ${why}`);
  };
  if (!/^T[0-3]$/.test(m.tier)) fail(`tier '${m.tier}' is not a TSDF tier code`);
  if (m.tier !== "T0") fail(`tier ${m.tier} may not be served from a public bundle`);
  if (m.encoding !== "terrarium") fail(`encoding '${m.encoding}' is not 'terrarium'`);
  if (m.scheme !== "xyz") fail(`scheme '${m.scheme}' — raster-dem always requests XYZ`);
  if (m.crs_chain[m.crs_chain.length - 1] !== VIEWER_CRS) fail(`crs_chain must end at ${VIEWER_CRS}`);
  const [w, s, e, n] = m.bounds;
  const sane = w >= -180 && e <= 180 && s >= -90 && n <= 90 && w < e && s < n;
  if (!sane) fail(`bounds ${m.bounds} are not sane lon/lat`);
  if (!m.tiles[0]?.includes("{z}")) fail("tiles[0] lost its {z} placeholder");
}

async function enableTerrain(): Promise<void> {
  const base = `${client.baseUrl}/tiles/terrain/`;
  const response = await fetch(`${base}geobase-baseline.json`);
  if (!response.ok) throw new Error(`baseline manifest fetch failed: ${response.status}`);
  const manifest = (await response.json()) as BaselineManifest;
  validateManifest(manifest);

  const tiles = manifest.tiles.map((t) => `${base}${t}`);
  if (!tiles[0].includes("{z}")) throw new Error("tile template lost its {z} placeholder");

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

  const settled = new Promise<void>((resolve) => map.once("idle", () => resolve()));
  map.setTerrain({ source: "terrain-dem", exaggeration: 1.3 });
  await settled;
}

async function stackRenderableLayers(): Promise<void> {
  const catalog = await client.packs();
  const renderable: CatalogLayer[] = [];
  const data = new Map<string, FeatureCollection>();

  for (const pack of catalog) {
    const layers = await packLayers(pack);
    if (layers === null) continue;

    for (const layer of layers.layers) {
      const geometry = layer.geometry_type.toUpperCase();
      const key = `${pack.id}.${layer.table}`;

      if (!supportedGeometry(geometry)) {
        console.error(`[RStep] unsupported layer geometry '${layer.geometry_type}' for ${key}`);
        continue;
      }
      if (layer.srs !== RENDERABLE_SRS) {
        console.error(
          `[RStep] refused layer ${key}: srs ${JSON.stringify(layer.srs)} is not ${RENDERABLE_SRS} — ` +
            "the features endpoint serves native-CRS GeoJSON and this viewer does not reproject yet",
        );
        continue;
      }

      try {
        data.set(key, await client.features(pack.id, layer.table));
        renderable.push({ key, pack: pack.id, table: layer.table, meta: layer, geometry });
      } catch (err: unknown) {
        console.error(`[RStep] feature fetch failed for ${pack.id}/${layer.table}:`, err);
      }
    }
  }

  if (renderable.length === 0) return;

  const settled = new Promise<void>((resolve) => map.once("idle", () => resolve()));
  for (const layer of renderable) {
    const source = sourceId(layer.key);
    map.addSource(source, { type: "geojson", data: data.get(layer.key) as GeoJSONSourceSpecification["data"] });
    for (const styleLayer of styleLayers(layer)) map.addLayer(styleLayer);
    if (!activePackIds.includes(layer.pack)) activePackIds.push(layer.pack);
  }
  paintLayersToTop();
  await settled;
}

async function packLayers(pack: PackSummary): Promise<PackLayers | null> {
  try {
    return await client.layers(pack.id);
  } catch (err: unknown) {
    if (err instanceof NodeRequestError) {
      console.error(`[RStep] failed to list layers for pack '${pack.id}': ${err.status} ${err.reason}`);
      return null;
    }
    console.error(`[RStep] failed to list layers for pack '${pack.id}':`, err);
    return null;
  }
}

function paintLayersToTop(): void {
  for (const id of ["rstep:paint:fill", "rstep:paint:line", "rstep:paint:selected", "rstep:draft:fill", "rstep:draft:line"]) {
    if (map.getLayer(id) !== undefined) map.moveLayer(id);
  }
}

function sourceId(key: string): string {
  return `pkg:${key}`;
}

function styleLayerIds(key: string, geometry: string): string[] {
  const prefix = sourceId(key);
  switch (geometry) {
    case "POLYGON":
    case "MULTIPOLYGON":
      return [`${prefix}:fill`, `${prefix}:line`];
    case "LINESTRING":
    case "MULTILINESTRING":
      return [`${prefix}:line`];
    case "POINT":
    case "MULTIPOINT":
      return [`${prefix}:circle`];
    default:
      return [];
  }
}

function supportedGeometry(geometry: string): boolean {
  return styleLayerIds("x.y", geometry).length > 0;
}

function styleLayers(layer: CatalogLayer): (FillLayerSpecification | LineLayerSpecification | CircleLayerSpecification)[] {
  const hue = layer.meta.color_seed % 360;
  const color = `hsl(${hue} 70% 55%)`;
  const dark = `hsl(${hue} 70% 35%)`;
  const ids = styleLayerIds(layer.key, layer.geometry);
  const source = sourceId(layer.key);
  switch (layer.geometry) {
    case "POLYGON":
    case "MULTIPOLYGON":
      return [
        { id: ids[0], type: "fill", source, paint: { "fill-color": color, "fill-opacity": 0.45 } },
        { id: ids[1], type: "line", source, paint: { "line-color": dark, "line-width": 1.5 } },
      ];
    case "LINESTRING":
    case "MULTILINESTRING":
      return [{ id: ids[0], type: "line", source, paint: { "line-color": color, "line-width": 2 } }];
    case "POINT":
    case "MULTIPOINT":
      return [
        {
          id: ids[0],
          type: "circle",
          source,
          paint: {
            "circle-radius": 5,
            "circle-color": color,
            "circle-stroke-color": dark,
            "circle-stroke-width": 1,
          },
        },
      ];
    default:
      return [];
  }
}

function buildPanel(): {
  product: HTMLInputElement;
  requester: HTMLInputElement;
  score: HTMLInputElement;
  draw: HTMLButtonElement;
  exportButton: HTMLButtonElement;
  status: HTMLPreElement;
} {
  const section = document.createElement("section");
  section.id = "rstep-panel";

  const product = input("rstep-product", "text", "product");
  const requester = input("rstep-requester", "text", "requester");
  const score = input("rstep-score", "number", "1");
  score.value = "1";

  const draw = document.createElement("button");
  draw.id = "rstep-draw";
  draw.type = "button";
  draw.textContent = "Draw";
  draw.setAttribute("aria-pressed", "false");

  const exportButton = document.createElement("button");
  exportButton.id = "rstep-export";
  exportButton.type = "button";
  exportButton.textContent = "Export";

  const status = document.createElement("pre");
  status.id = "rstep-status";

  section.append(product, requester, score, draw, exportButton, status);
  document.body.appendChild(section);
  return { product, requester, score, draw, exportButton, status };
}

function input(id: string, type: string, placeholder: string): HTMLInputElement {
  const element = document.createElement("input");
  element.id = id;
  element.type = type;
  element.placeholder = placeholder;
  return element;
}

function scoreValue(inputElement: HTMLInputElement): number {
  const value = Number(inputElement.value);
  return Number.isFinite(value) ? value : 1;
}

function updateDrawButton(button: HTMLButtonElement, tool: HandRolledPaintTool): void {
  const drawing = tool.isDrawing();
  button.setAttribute("aria-pressed", drawing ? "true" : "false");
  button.textContent = drawing ? "Cancel" : "Draw";
}

async function exportProduct(): Promise<void> {
  try {
    const outcome = await client.exportProduct({
      product: panel.product.value,
      source_packs: [...activePackIds],
      requester: panel.requester.value,
      features: paint.features().map((feature) => ({ geometry: feature.geometry, score: feature.score })),
    });

    panel.status.textContent = [
      `product: ${outcome.product}`,
      `tier: ${outcome.tier}`,
      `features: ${outcome.features}`,
      ...Object.entries(outcome.files).map(([key, file]) => `${key}: ${file.name} ${file.sha256}`),
      `ceremony: ${outcome.ceremony.process}`,
      `basis: ${outcome.ceremony.basis}`,
    ].join("\n");
  } catch (err: unknown) {
    if (err instanceof NodeRequestError) {
      panel.status.textContent = `${err.status} ${err.reason}`;
      return;
    }
    panel.status.textContent = err instanceof Error ? err.message : String(err);
  }
}
