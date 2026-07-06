/**
 * Layer panel — Phase 1.1c (node mode ONLY). FROZEN CONTRACT.
 *
 * Stackable layer packages toggle over the T0 terrain baseline. State
 * lives in the URL (DDM: URL-as-state — a view is a shareable link).
 *
 * ## Key grammar
 *
 * A layer key is `<pack>.<table>` where pack matches
 * `^[a-z0-9][a-z0-9_-]*$` (the GeoPack manifest id grammar) and table
 * matches `^[a-z_][a-z0-9_]*$`. Neither charset contains `.`, so the
 * first `.` splits unambiguously.
 *
 * ## URL param
 *
 * `?layers=<key>(,<key>)*` — comma-joined, order = stacking order,
 * FIRST key at the bottom. Synced with `history.replaceState` after
 * every applied change, preserving all other params. Malformed or
 * unknown keys are `console.error`'d, dropped from the URL, and never
 * activated silently — no silent fallbacks in the UI either.
 *
 * ## Data flow
 *
 * Catalog: `GET {nodeBase}/api/packs`, then
 * `GET {nodeBase}/api/packs/{id}/layers` per pack. A 403 (T2/T3 —
 * "requires the Phase 1.2 permissions ceremony") skips the pack with a
 * `console.warn` naming it; never retried, never listed. Feature data:
 * `GET {nodeBase}/api/packs/{pack}/tables/{table}/features`, fetched at
 * most once per key and cached for re-toggles.
 *
 * ## DOM (the layer gate drives these — do not rename)
 *
 * - `<section id="layer-panel">` appended to `document.body`, node mode
 *   only; contains an `<h2>` reading `Layers`.
 * - One `<label class="layer-item" data-layer="<key>">` per layer, in
 *   catalog order, containing an `<input type="checkbox"
 *   data-layer="<key>">` (checked mirrors active) and the key text.
 * - A layer whose geometry type is unsupported renders with the
 *   checkbox `disabled` and a `console.error` naming the type.
 *
 * ## MapLibre ids + styling rule
 *
 * Source: `pkg:<key>` (GeoJSON). Style layers by `geometry_type`
 * (uppercase, from the layers endpoint):
 * - `POLYGON`/`MULTIPOLYGON`: `pkg:<key>:fill` — fill-color C,
 *   fill-opacity 0.45; plus `pkg:<key>:line` — line-color CD,
 *   line-width 1.5.
 * - `LINESTRING`/`MULTILINESTRING`: `pkg:<key>:line` — line-color C,
 *   line-width 2.
 * - `POINT`/`MULTIPOINT`: `pkg:<key>:circle` — circle-radius 5,
 *   circle-color C, circle-stroke-color CD, circle-stroke-width 1.
 * - Anything else: refused loudly (narrow doctrine).
 *
 * Color rule: `hue = color_seed % 360`; C = `hsl(<hue> 70% 55%)`;
 * CD = `hsl(<hue> 70% 35%)`. `color_seed` comes from the layers
 * endpoint VERBATIM — the client never recomputes it.
 *
 * ## Toggle semantics
 *
 * ON: fetch features if uncached → `addSource` → `addLayer`(s) on top
 * of everything currently rendered. OFF: `removeLayer`(s) →
 * `removeSource` (cache retained). `toggle()` resolves after the map
 * reaches `idle` following the change. On boot, `?layers=` keys are
 * applied bottom-first after the caller's ready gate. Fetch failures
 * `console.error` pack/table + status; the entry stays inactive and is
 * dropped from the URL.
 */

import type maplibregl from "maplibre-gl";
import type {
  CircleLayerSpecification,
  FillLayerSpecification,
  GeoJSONSourceSpecification,
  LineLayerSpecification,
} from "maplibre-gl";

/** One entry from `GET /api/packs` (subset the panel needs). */
export interface PackSummary {
  id: string;
  tier: string;
  tables: { name: string; data_type: string }[];
}

/** One layer from `GET /api/packs/{id}/layers`. */
export interface LayerMeta {
  table: string;
  geometry_type: string;
  bounds: [number, number, number, number] | null;
  srs: string | null;
  tier: string;
  color_seed: number;
}

/** Response shape of `GET /api/packs/{id}/layers`. */
export interface PackLayers {
  pack: string;
  tier: string;
  layers: LayerMeta[];
}

/** Handle the verification harness drives (window.__geobase.layers). */
export interface LayersHandle {
  /** Settles when the catalog is listed AND all `?layers=` boot keys
   *  have been applied (or loudly dropped) and the map is idle. */
  ready: Promise<void>;
  /** Active keys, bottom-first (mirrors the URL param). */
  active(): string[];
  /** Toggle one key; resolves after the map is idle. Rejects on
   *  unknown key. */
  toggle(key: string): Promise<void>;
}

/**
 * Build the panel and apply `?layers=` boot state. `nodeBase` is the
 * validated loopback node URL WITHOUT a trailing slash (main.ts owns
 * that validation — this module never widens it).
 */
export function initLayerPanel(
  map: maplibregl.Map,
  nodeBase: string,
): LayersHandle {
  const panel = document.createElement("section");
  panel.id = "layer-panel";
  const heading = document.createElement("h2");
  heading.textContent = "Layers";
  panel.appendChild(heading);
  document.body.appendChild(panel);

  const layers = new Map<string, CatalogLayer>();
  const checkboxes = new Map<string, HTMLInputElement>();
  const featureCache = new Map<string, Promise<GeoJSONSourceSpecification["data"]>>();
  const activeKeys: string[] = [];

  const setChecked = (key: string, checked: boolean): void => {
    const checkbox = checkboxes.get(key);
    if (checkbox !== undefined) checkbox.checked = checked;
  };

  const ready = (async (): Promise<void> => {
    let bootKeys = parseBootKeys();
    try {
      const catalog = await fetchCatalog(nodeBase);
      for (const pack of catalog) {
        if (!PACK_ID_RE.test(pack.id)) {
          // eslint-disable-next-line no-console
          console.error(`[GeoBase] rejected pack id '${pack.id}' from catalog`);
          continue;
        }
        const packLayers = await fetchPackLayers(nodeBase, pack.id);
        if (packLayers === null) continue;
        for (const layer of packLayers.layers) {
          const key = layerKey(pack.id, layer.table);
          if (key === null) {
            // eslint-disable-next-line no-console
            console.error(`[GeoBase] rejected layer key for pack '${pack.id}', table '${layer.table}'`);
            continue;
          }
          const geometry = layer.geometry_type.toUpperCase();
          const supported = supportedGeometry(geometry);
          if (!supported) {
            // eslint-disable-next-line no-console
            console.error(`[GeoBase] unsupported layer geometry '${layer.geometry_type}' for ${key}`);
          }
          const catalogLayer: CatalogLayer = { key, pack: pack.id, table: layer.table, meta: layer, geometry };
          layers.set(key, catalogLayer);
          appendLayerItem(panel, catalogLayer, supported, checkboxes, (nextKey) => {
            void applyToggle(nextKey).catch((err: unknown) => {
              // eslint-disable-next-line no-console
              console.error(`[GeoBase] layer toggle failed for ${nextKey}:`, err);
              setChecked(nextKey, false);
              removeActive(nextKey, activeKeys);
              syncUrl(activeKeys);
            });
          });
        }
      }
    } catch (err: unknown) {
      // eslint-disable-next-line no-console
      console.error("[GeoBase] layer catalog failed:", err);
      bootKeys = [];
    }

    const appliedBootKeys: string[] = [];
    for (const key of bootKeys) {
      const layer = layers.get(key);
      if (layer === undefined) {
        // eslint-disable-next-line no-console
        console.error(`[GeoBase] unknown layer key '${key}'`);
        continue;
      }
      if (!supportedGeometry(layer.geometry)) {
        // eslint-disable-next-line no-console
        console.error(`[GeoBase] refused unsupported layer '${key}' from URL`);
        continue;
      }
      try {
        await setLayerActive(key, true);
        appliedBootKeys.push(key);
      } catch {
        // setLayerActive logs the pack/table/status failure.
      }
    }
    activeKeys.splice(0, activeKeys.length, ...appliedBootKeys);
    syncUrl(activeKeys);
  })();

  // Toggles are serialized: a rapid second toggle must observe the map
  // state the first one left behind, never race its async fetch/add.
  let toggleQueue: Promise<void> = Promise.resolve();
  function applyToggle(key: string): Promise<void> {
    const run = toggleQueue.then(async () => {
      await ready;
      await setLayerActive(key, !activeKeys.includes(key));
      syncUrl(activeKeys);
    });
    toggleQueue = run.catch(() => undefined);
    return run;
  }

  async function setLayerActive(key: string, nextActive: boolean): Promise<void> {
    if (!KEY_RE.test(key)) throw new Error(`[GeoBase] invalid layer key '${key}'`);
    const layer = layers.get(key);
    if (layer === undefined) throw new Error(`[GeoBase] unknown layer key '${key}'`);
    if (!supportedGeometry(layer.geometry)) throw new Error(`[GeoBase] unsupported layer '${key}'`);
    if (nextActive) {
      if (activeKeys.includes(key)) return;
      const data = await featuresFor(layer, nodeBase, featureCache);
      const settled = new Promise<void>((resolve) => map.once("idle", () => resolve()));
      map.addSource(sourceId(key), { type: "geojson", data });
      for (const styleLayer of styleLayers(layer)) {
        map.addLayer(styleLayer);
      }
      activeKeys.push(key);
      setChecked(key, true);
      await settled;
    } else {
      if (!activeKeys.includes(key)) return;
      const settled = new Promise<void>((resolve) => map.once("idle", () => resolve()));
      for (const id of styleLayerIds(layer).reverse()) {
        if (map.getLayer(id) !== undefined) map.removeLayer(id);
      }
      if (map.getSource(sourceId(key)) !== undefined) map.removeSource(sourceId(key));
      removeActive(key, activeKeys);
      setChecked(key, false);
      await settled;
    }
  }

  return {
    ready,
    active: () => [...activeKeys],
    toggle: applyToggle,
  };
}

const PACK_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
const TABLE_RE = /^[a-z_][a-z0-9_]*$/;
const KEY_RE = /^[a-z0-9][a-z0-9_-]*\.[a-z_][a-z0-9_]*$/;

interface CatalogLayer {
  key: string;
  pack: string;
  table: string;
  meta: LayerMeta;
  geometry: string;
}

function layerKey(pack: string, table: string): string | null {
  if (!PACK_ID_RE.test(pack) || !TABLE_RE.test(table)) return null;
  return `${pack}.${table}`;
}

function sourceId(key: string): string {
  return `pkg:${key}`;
}

function styleLayerIds(layer: CatalogLayer): string[] {
  const prefix = sourceId(layer.key);
  switch (layer.geometry) {
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
  return styleLayerIds({ key: "x.y", pack: "x", table: "y", meta: emptyMeta, geometry }).length > 0;
}

const emptyMeta: LayerMeta = {
  table: "y",
  geometry_type: "POINT",
  bounds: null,
  srs: null,
  tier: "T0",
  color_seed: 0,
};

function styleLayers(layer: CatalogLayer): (FillLayerSpecification | LineLayerSpecification | CircleLayerSpecification)[] {
  const hue = layer.meta.color_seed % 360;
  const color = `hsl(${hue} 70% 55%)`;
  const dark = `hsl(${hue} 70% 35%)`;
  const ids = styleLayerIds(layer);
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

function parseBootKeys(): string[] {
  const raw = new URLSearchParams(window.location.search).get("layers");
  if (raw === null || raw.trim() === "") return [];
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    if (!KEY_RE.test(part)) {
      // eslint-disable-next-line no-console
      console.error(`[GeoBase] malformed layer key '${part}'`);
      continue;
    }
    if (seen.has(part)) {
      // eslint-disable-next-line no-console
      console.error(`[GeoBase] duplicate layer key '${part}'`);
      continue;
    }
    seen.add(part);
    keys.push(part);
  }
  return keys;
}

function syncUrl(activeKeys: string[]): void {
  const url = new URL(window.location.href);
  if (activeKeys.length === 0) {
    url.searchParams.delete("layers");
  } else {
    url.searchParams.set("layers", activeKeys.join(","));
  }
  history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

async function fetchCatalog(nodeBase: string): Promise<PackSummary[]> {
  const response = await fetch(`${nodeBase}/api/packs`);
  if (!response.ok) throw new Error(`catalog fetch failed: ${response.status}`);
  const body = (await response.json()) as unknown;
  if (!Array.isArray(body)) throw new Error("catalog response is not an array");
  const catalog: PackSummary[] = [];
  for (const item of body) {
    if (isPackSummary(item)) {
      catalog.push(item);
    } else {
      // eslint-disable-next-line no-console
      console.error("[GeoBase] rejected malformed catalog entry");
    }
  }
  return catalog;
}

async function fetchPackLayers(nodeBase: string, pack: string): Promise<PackLayers | null> {
  const response = await fetch(`${nodeBase}/api/packs/${encodeURIComponent(pack)}/layers`);
  if (response.status === 403) {
    // eslint-disable-next-line no-console
    console.warn(`[GeoBase] skipped restricted pack '${pack}' — requires the Phase 1.2 permissions ceremony`);
    return null;
  }
  if (!response.ok) {
    // eslint-disable-next-line no-console
    console.error(`[GeoBase] failed to list layers for pack '${pack}': ${response.status}`);
    return null;
  }
  const body = (await response.json()) as unknown;
  if (!isPackLayers(body)) {
    // eslint-disable-next-line no-console
    console.error(`[GeoBase] rejected malformed layers response for pack '${pack}'`);
    return null;
  }
  return body;
}

async function featuresFor(
  layer: CatalogLayer,
  nodeBase: string,
  featureCache: Map<string, Promise<GeoJSONSourceSpecification["data"]>>,
): Promise<GeoJSONSourceSpecification["data"]> {
  const cached = featureCache.get(layer.key);
  if (cached !== undefined) return cached;
  const pending = fetchFeatures(layer, nodeBase);
  featureCache.set(layer.key, pending);
  // Cache data, not failures: a transient fetch error must not poison
  // the key until reload.
  pending.catch(() => featureCache.delete(layer.key));
  return pending;
}

async function fetchFeatures(
  layer: CatalogLayer,
  nodeBase: string,
): Promise<GeoJSONSourceSpecification["data"]> {
  const response = await fetch(
    `${nodeBase}/api/packs/${encodeURIComponent(layer.pack)}/tables/${encodeURIComponent(layer.table)}/features`,
  );
  if (!response.ok) {
    // eslint-disable-next-line no-console
    console.error(`[GeoBase] feature fetch failed for ${layer.pack}/${layer.table}: ${response.status}`);
    throw new Error(`feature fetch failed: ${response.status}`);
  }
  const body = (await response.json()) as unknown;
  if (!isFeatureCollection(body)) {
    // eslint-disable-next-line no-console
    console.error(`[GeoBase] feature fetch failed for ${layer.pack}/${layer.table}: malformed GeoJSON`);
    throw new Error("feature response is not a GeoJSON FeatureCollection");
  }
  return body as GeoJSONSourceSpecification["data"];
}

function appendLayerItem(
  panel: HTMLElement,
  layer: CatalogLayer,
  supported: boolean,
  checkboxes: Map<string, HTMLInputElement>,
  onToggle: (key: string) => void,
): void {
  const label = document.createElement("label");
  label.className = "layer-item";
  label.dataset.layer = layer.key;
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.dataset.layer = layer.key;
  checkbox.disabled = !supported;
  checkbox.addEventListener("change", () => onToggle(layer.key));
  label.appendChild(checkbox);
  label.appendChild(document.createTextNode(layer.key));
  panel.appendChild(label);
  checkboxes.set(layer.key, checkbox);
}

function removeActive(key: string, activeKeys: string[]): void {
  const index = activeKeys.indexOf(key);
  if (index !== -1) activeKeys.splice(index, 1);
}

function isPackSummary(value: unknown): value is PackSummary {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.tier === "string" &&
    Array.isArray(value.tables)
  );
}

function isPackLayers(value: unknown): value is PackLayers {
  if (!isRecord(value)) return false;
  return (
    typeof value.pack === "string" &&
    typeof value.tier === "string" &&
    Array.isArray(value.layers) &&
    value.layers.every(isLayerMeta)
  );
}

function isLayerMeta(value: unknown): value is LayerMeta {
  if (!isRecord(value)) return false;
  return (
    typeof value.table === "string" &&
    typeof value.geometry_type === "string" &&
    (value.bounds === null || isBounds(value.bounds)) &&
    (value.srs === null || typeof value.srs === "string") &&
    typeof value.tier === "string" &&
    typeof value.color_seed === "number" &&
    Number.isFinite(value.color_seed)
  );
}

function isBounds(value: unknown): value is [number, number, number, number] {
  return Array.isArray(value) && value.length === 4 && value.every((n) => typeof n === "number");
}

function isFeatureCollection(value: unknown): value is { type: "FeatureCollection"; features: unknown[] } {
  return isRecord(value) && value.type === "FeatureCollection" && Array.isArray(value.features);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
