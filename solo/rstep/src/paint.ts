import type maplibregl from "maplibre-gl";
import type {
  FillLayerSpecification,
  GeoJSONSource,
  GeoJSONSourceSpecification,
  LineLayerSpecification,
  MapLayerMouseEvent,
  MapMouseEvent,
} from "maplibre-gl";
import type { PaintedFeature, PaintTool, ProductGeometry } from "@geobase/solo-sdk";

type Position = [number, number];

interface JsonFeature {
  type: "Feature";
  id?: string;
  properties: Record<string, unknown>;
  geometry: ProductGeometry | { type: "LineString"; coordinates: number[][] };
}

interface JsonFeatureCollection {
  type: "FeatureCollection";
  features: JsonFeature[];
}

interface PaintOptions {
  score(): number;
}

const PAINT_SOURCE = "rstep:paint";
const DRAFT_SOURCE = "rstep:draft";
const FILL_LAYER = "rstep:paint:fill";
const LINE_LAYER = "rstep:paint:line";
const SELECTED_LAYER = "rstep:paint:selected";
const DRAFT_FILL_LAYER = "rstep:draft:fill";
const DRAFT_LINE_LAYER = "rstep:draft:line";

export class HandRolledPaintTool implements PaintTool {
  private readonly map: maplibregl.Map;
  private readonly score: () => number;
  private readonly painted: PaintedFeature[] = [];
  private readonly listeners = new Set<(features: PaintedFeature[]) => void>();
  private readonly canvas: HTMLElement;
  private drawing = false;
  private disposed = false;
  private vertices: Position[] = [];
  private cursor: Position | null = null;
  private selectedId: string | null = null;
  private nextId = 1;
  private previousCursor = "";
  private restoreDblClickZoom = false;

  constructor(map: maplibregl.Map, options: PaintOptions) {
    this.map = map;
    this.score = options.score;
    this.canvas = map.getCanvas();

    this.addSourcesAndLayers();
    this.map.on("click", this.onMapClick);
    this.map.on("click", FILL_LAYER, this.onPaintClick);
    this.map.on("mousemove", this.onMouseMove);
    this.map.on("dblclick", this.onDoubleClick);
    window.addEventListener("keydown", this.onKeyDown);
  }

  start(): void {
    if (this.disposed || this.drawing) return;
    this.drawing = true;
    this.vertices = [];
    this.cursor = null;
    this.selectedId = null;
    this.previousCursor = this.canvas.style.cursor;
    this.canvas.style.cursor = "crosshair";
    this.restoreDblClickZoom = this.map.doubleClickZoom.isEnabled();
    if (this.restoreDblClickZoom) this.map.doubleClickZoom.disable();
    this.syncPaint();
    this.syncDraft();
  }

  cancel(): void {
    if (!this.drawing) return;
    this.drawing = false;
    this.vertices = [];
    this.cursor = null;
    this.canvas.style.cursor = this.previousCursor;
    if (this.restoreDblClickZoom) this.map.doubleClickZoom.enable();
    this.restoreDblClickZoom = false;
    this.syncDraft();
  }

  deleteSelected(): boolean {
    if (this.selectedId === null) return false;
    const index = this.painted.findIndex((feature) => feature.id === this.selectedId);
    if (index === -1) {
      this.selectedId = null;
      this.syncPaint();
      return false;
    }
    this.painted.splice(index, 1);
    this.selectedId = null;
    this.syncPaint();
    this.emitChange();
    return true;
  }

  features(): PaintedFeature[] {
    return this.painted.map((feature) => ({
      id: feature.id,
      score: feature.score,
      geometry: normalizeGeometry(feature.geometry),
    }));
  }

  inject(feature: PaintedFeature): void {
    const geometry = normalizeGeometry(validateGeometry(feature.geometry));
    const score = Number.isFinite(feature.score) ? feature.score : 1;
    const id = `paint-${this.nextId}`;
    this.nextId += 1;
    this.painted.push({ id, geometry, score });
    this.syncPaint();
    this.emitChange();
  }

  onChange(listener: (features: PaintedFeature[]) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancel();
    this.disposed = true;
    this.map.off("click", this.onMapClick);
    this.map.off("click", FILL_LAYER, this.onPaintClick);
    this.map.off("mousemove", this.onMouseMove);
    this.map.off("dblclick", this.onDoubleClick);
    window.removeEventListener("keydown", this.onKeyDown);

    for (const layer of [SELECTED_LAYER, LINE_LAYER, FILL_LAYER, DRAFT_LINE_LAYER, DRAFT_FILL_LAYER]) {
      if (this.map.getLayer(layer) !== undefined) this.map.removeLayer(layer);
    }
    for (const source of [PAINT_SOURCE, DRAFT_SOURCE]) {
      if (this.map.getSource(source) !== undefined) this.map.removeSource(source);
    }
  }

  isDrawing(): boolean {
    return this.drawing;
  }

  private readonly onMapClick = (event: MapMouseEvent): void => {
    if (this.disposed) return;
    if (this.drawing) {
      this.vertices.push([event.lngLat.lng, event.lngLat.lat]);
      this.syncDraft();
      return;
    }

    const painted = this.map.queryRenderedFeatures(event.point, { layers: [FILL_LAYER] });
    if (painted.length === 0 && this.selectedId !== null) {
      this.selectedId = null;
      this.syncPaint();
    }
  };

  private readonly onPaintClick = (event: MapLayerMouseEvent): void => {
    if (this.disposed || this.drawing) return;
    const id = event.features?.[0]?.properties?.id;
    if (typeof id === "string") {
      this.selectedId = id;
      this.syncPaint();
    }
  };

  private readonly onMouseMove = (event: MapMouseEvent): void => {
    if (!this.drawing) return;
    this.cursor = [event.lngLat.lng, event.lngLat.lat];
    this.syncDraft();
  };

  private readonly onDoubleClick = (event: MapMouseEvent): void => {
    if (!this.drawing) return;
    event.preventDefault();
    this.closeRing();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.disposed || focusIsEditable()) return;

    if (this.drawing) {
      if (event.key === "Backspace") {
        event.preventDefault();
        this.vertices.pop();
        this.syncDraft();
      } else if (event.key === "Enter") {
        event.preventDefault();
        this.closeRing();
      } else if (event.key === "Escape") {
        event.preventDefault();
        this.cancel();
      }
      return;
    }

    if (event.key === "Delete") {
      event.preventDefault();
      this.deleteSelected();
    }
  };

  private closeRing(): void {
    const ring = closeOpenRing(this.vertices);
    try {
      validateRing(ring);
    } catch (err: unknown) {
      console.error("[RStep] refused painted ring:", err);
      return;
    }

    const id = `paint-${this.nextId}`;
    this.nextId += 1;
    const score = this.score();
    this.painted.push({
      id,
      score: Number.isFinite(score) ? score : 1,
      geometry: normalizeGeometry({ type: "Polygon", coordinates: [ring] }),
    });
    this.cancel();
    this.syncPaint();
    this.emitChange();
  }

  private addSourcesAndLayers(): void {
    const empty = emptyCollection();
    if (this.map.getSource(PAINT_SOURCE) === undefined) {
      this.map.addSource(PAINT_SOURCE, { type: "geojson", data: empty as GeoJSONSourceSpecification["data"] });
    }
    if (this.map.getSource(DRAFT_SOURCE) === undefined) {
      this.map.addSource(DRAFT_SOURCE, { type: "geojson", data: empty as GeoJSONSourceSpecification["data"] });
    }

    const draftFill: FillLayerSpecification = {
      id: DRAFT_FILL_LAYER,
      type: "fill",
      source: DRAFT_SOURCE,
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: { "fill-color": "#f59e0b", "fill-opacity": 0.18 },
    };
    const draftLine: LineLayerSpecification = {
      id: DRAFT_LINE_LAYER,
      type: "line",
      source: DRAFT_SOURCE,
      paint: { "line-color": "#fbbf24", "line-width": 2, "line-dasharray": [2, 1] },
    };
    const paintFill: FillLayerSpecification = {
      id: FILL_LAYER,
      type: "fill",
      source: PAINT_SOURCE,
      paint: { "fill-color": "#38bdf8", "fill-opacity": 0.35 },
    };
    const paintLine: LineLayerSpecification = {
      id: LINE_LAYER,
      type: "line",
      source: PAINT_SOURCE,
      paint: { "line-color": "#075985", "line-width": 2 },
    };
    const selectedLine: LineLayerSpecification = {
      id: SELECTED_LAYER,
      type: "line",
      source: PAINT_SOURCE,
      filter: ["==", ["get", "id"], ""],
      paint: { "line-color": "#f8fafc", "line-width": 4 },
    };

    for (const layer of [draftFill, draftLine, paintFill, paintLine, selectedLine]) {
      if (this.map.getLayer(layer.id) === undefined) this.map.addLayer(layer);
    }
  }

  private syncPaint(): void {
    setSourceData(this.map, PAINT_SOURCE, {
      type: "FeatureCollection",
      features: this.painted.map((feature) => ({
        type: "Feature",
        id: feature.id,
        properties: { id: feature.id, score: feature.score },
        geometry: feature.geometry,
      })),
    });
    if (this.map.getLayer(SELECTED_LAYER) !== undefined) {
      this.map.setFilter(SELECTED_LAYER, ["==", ["get", "id"], this.selectedId ?? ""]);
    }
  }

  private syncDraft(): void {
    const features: JsonFeature[] = [];
    if (this.drawing && this.vertices.length > 0) {
      const line = this.cursor === null ? this.vertices : [...this.vertices, this.cursor];
      features.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: line } });
      if (this.vertices.length >= 3) {
        features.push({
          type: "Feature",
          properties: {},
          geometry: { type: "Polygon", coordinates: [closeOpenRing(this.vertices)] },
        });
      }
    }
    setSourceData(this.map, DRAFT_SOURCE, { type: "FeatureCollection", features });
  }

  private emitChange(): void {
    const snapshot = this.features();
    for (const listener of this.listeners) listener(snapshot);
  }
}

function setSourceData(map: maplibregl.Map, id: string, data: JsonFeatureCollection): void {
  const source = map.getSource(id);
  if (source !== undefined) {
    (source as GeoJSONSource).setData(data as unknown as GeoJSONSourceSpecification["data"]);
  }
}

function emptyCollection(): JsonFeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

function focusIsEditable(): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  return active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active.isContentEditable;
}

function closeOpenRing(vertices: Position[]): Position[] {
  const cleaned: Position[] = [];
  for (const vertex of vertices) {
    const previous = cleaned[cleaned.length - 1];
    if (previous === undefined || previous[0] !== vertex[0] || previous[1] !== vertex[1]) {
      cleaned.push([vertex[0], vertex[1]]);
    }
  }
  if (cleaned.length === 0) return [];
  const first = cleaned[0];
  const last = cleaned[cleaned.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) cleaned.push([first[0], first[1]]);
  return cleaned;
}

function validateGeometry(geometry: ProductGeometry): ProductGeometry {
  if (geometry.type === "Polygon") {
    for (const ring of geometry.coordinates) validateRing(ring);
    return geometry;
  }
  for (const polygon of geometry.coordinates) {
    for (const ring of polygon) validateRing(ring);
  }
  return geometry;
}

function validateRing(ring: number[][]): void {
  if (ring.length < 4) throw new Error("ring has fewer than 3 distinct vertices");
  for (const coord of ring) {
    if (coord.length < 2 || !Number.isFinite(coord[0]) || !Number.isFinite(coord[1])) {
      throw new Error("ring contains non-finite coordinates");
    }
  }
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) throw new Error("ring is not closed");

  const distinct = new Set(ring.slice(0, -1).map((coord) => `${coord[0]},${coord[1]}`));
  if (distinct.size < 3) throw new Error("ring has fewer than 3 distinct vertices");
}

function normalizeGeometry(geometry: ProductGeometry): ProductGeometry {
  if (geometry.type === "Polygon") {
    return { type: "Polygon", coordinates: normalizePolygon(geometry.coordinates) };
  }
  return { type: "MultiPolygon", coordinates: geometry.coordinates.map(normalizePolygon) };
}

function normalizePolygon(rings: number[][][]): number[][][] {
  return rings.map((ring, index) => orientRing(ring, index === 0));
}

function orientRing(ring: number[][], ccw: boolean): number[][] {
  const copied = ring.map((coord): number[] => [coord[0], coord[1]]);
  const isCcw = signedArea(copied) > 0;
  if (isCcw !== ccw) copied.reverse();
  return copied;
}

function signedArea(ring: number[][]): number {
  let area = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const current = ring[index];
    const next = ring[index + 1];
    area += current[0] * next[1] - next[0] * current[1];
  }
  return area / 2;
}
