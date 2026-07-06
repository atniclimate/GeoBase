/**
 * SoLO — Sovereign Layer Orchestrator SDK. FROZEN CONTRACT (Phase 1.3c).
 *
 * SoLO apps are GeoBase mini-applications (RStep is the first). They stack
 * layer packages served by the local node, "paint" areas of opportunity
 * over them, and export a shareable product — WITHOUT ever disclosing the
 * underlying source data. The export path is TSDF-aware: the node's
 * ceremony seam authorizes it, the product is T2-stamped, and the export
 * verifier (server-side) refuses anything but the painted product.
 *
 * Three surfaces, all frozen here:
 * 1. `NodeClient` — typed client for the node API (loopback only).
 * 2. `PaintTool` — the ADAPTER SEAM for polygon painting (decision
 *    2026-07-06, docs/DECISIONS.md): Phase 1.3 ships a hand-rolled
 *    implementation behind this interface; a drawing library can replace
 *    it without touching app code. Phase 1.3 paint UX is deliberately
 *    narrow: desktop-pointer-first, draw/select/delete only, no vertex
 *    editing, no touch commitment.
 * 3. `SoloApp` — what every SoLO mini-app implements.
 *
 * No runtime dependencies — GeoJSON typings are local declarations.
 */

/** TSDF tier codes, mirrored from the Rust `geobase-tsdf` crate. */
export type Tier = "T0" | "T1" | "T2" | "T3";

/** Local GeoJSON typings (no dependency; narrow to what SoLO needs). */
export interface Polygon {
  type: "Polygon";
  coordinates: number[][][];
}
export interface MultiPolygon {
  type: "MultiPolygon";
  coordinates: number[][][][];
}
export type ProductGeometry = Polygon | MultiPolygon;

// ---------------------------------------------------------------------------
// Node API shapes (mirror the server responses byte-for-byte; the server
// contract lives in crates/geobase-engine-desktop/src/{server,export}.rs).
// ---------------------------------------------------------------------------

/** `GET /api/node`. */
export interface NodeInfo {
  node_id: string;
  territory: string;
  home_crs: string;
  bbox: [number, number, number, number] | null;
  tsdf_origin: string;
  pack_count: number;
}

/** One entry of `GET /api/packs`. */
export interface PackSummary {
  id: string;
  tier: Tier;
  tagged: boolean;
  tsdf_version: string | null;
  tables: { name: string; data_type: string }[];
}

/** One layer of `GET /api/packs/{id}/layers`. */
export interface LayerMeta {
  table: string;
  geometry_type: string;
  bounds: [number, number, number, number] | null;
  srs: string | null;
  tier: Tier;
  color_seed: number;
}

/** `GET /api/packs/{id}/layers`. */
export interface PackLayers {
  pack: string;
  tier: Tier;
  layers: LayerMeta[];
}

/** RFC 7946 FeatureCollection as served (native CRS — see server docs). */
export interface FeatureCollection {
  type: "FeatureCollection";
  features: {
    type: "Feature";
    id: number;
    geometry: { type: string; coordinates: unknown };
    properties: Record<string, unknown>;
  }[];
}

/** One painted feature in a `POST /api/export` request. */
export interface ExportFeature {
  /** EPSG:4326 lon/lat — the paint surface (narrow doctrine). */
  geometry: ProductGeometry;
  /** Finite; recorded verbatim in the product's `score` column. */
  score: number;
}

/** `POST /api/export` request body. */
export interface ExportRequestBody {
  /** Product name `^[a-z0-9][a-z0-9_-]*$` — the output file stem. */
  product: string;
  /** Catalog ids the product derives from (>= 1). */
  source_packs: string[];
  requester: string;
  purpose?: string;
  features: ExportFeature[];
}

/** `POST /api/export` 200 response. */
export interface ExportOutcome {
  product: string;
  tier: Tier;
  features: number;
  files: Record<string, { name: string; sha256: string }>;
  area_m2_total: number;
  ceremony: { process: string; basis: string };
  audit_ids: number[];
}

/** A refusal/error from the node, typed by status. `reason` is the
 *  server's own wording, surfaced verbatim (never rephrased). */
export class NodeRequestError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    readonly tier?: string,
  ) {
    super(`node request failed (${status}): ${reason}`);
    this.name = "NodeRequestError";
  }
}

/**
 * Typed client for the local node API. `baseUrl` MUST be loopback
 * (http(s) on localhost/127.0.0.1) — the constructor throws otherwise;
 * the SDK never widens the egress stance. Implementation: 1.3c [C].
 */
export class NodeClient {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    const parsed = new URL(baseUrl);
    const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !loopback) {
      throw new Error("node baseUrl must be an http(s) URL on localhost/127.0.0.1");
    }
    this.baseUrl = parsed.href.replace(/\/$/, "");
  }

  node(): Promise<NodeInfo> {
    return this.getObject<NodeInfo>("/api/node");
  }

  packs(): Promise<PackSummary[]> {
    return this.getArray<PackSummary>("/api/packs");
  }

  layers(pack: string): Promise<PackLayers> {
    return this.getObject<PackLayers>(`/api/packs/${encodeURIComponent(pack)}/layers`);
  }

  features(pack: string, table: string): Promise<FeatureCollection> {
    return this.getObject<FeatureCollection>(
      `/api/packs/${encodeURIComponent(pack)}/tables/${encodeURIComponent(table)}/features`,
    );
  }

  /** POST /api/export. Refusals (403 ceremony, 400 invalid, 409 exists)
   *  reject with `NodeRequestError` carrying the server's reason. */
  exportProduct(body: ExportRequestBody): Promise<ExportOutcome> {
    return this.requestObject<ExportOutcome>("/api/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  private getObject<T>(path: string): Promise<T> {
    return this.requestObject<T>(path, { method: "GET" });
  }

  private getArray<T>(path: string): Promise<T[]> {
    return this.requestArray<T>(path, { method: "GET" });
  }

  private async requestObject<T>(path: string, init: RequestInit): Promise<T> {
    const body = await this.request(path, init);
    if (!isRecord(body)) throw new Error("node response is not an object");
    return body as T;
  }

  private async requestArray<T>(path: string, init: RequestInit): Promise<T[]> {
    const body = await this.request(path, init);
    if (!Array.isArray(body)) throw new Error("node response is not an array");
    return body as T[];
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, init);
    const body = await parseJson(response);
    if (!response.ok) {
      const reason = refusalReason(body, response);
      const tier = refusalTier(body);
      throw new NodeRequestError(response.status, reason, tier);
    }
    return body;
  }
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function refusalReason(body: unknown, response: Response): string {
  if (isRecord(body)) {
    if (typeof body.reason === "string") return body.reason;
    if (typeof body.tier === "string") return body.tier;
  }
  return response.statusText;
}

function refusalTier(body: unknown): string | undefined {
  return isRecord(body) && typeof body.tier === "string" ? body.tier : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Paint — the adapter seam (docs/DECISIONS.md 2026-07-06).
// ---------------------------------------------------------------------------

/** A painted opportunity polygon held by the tool. */
export interface PaintedFeature {
  /** Stable id assigned by the tool (unique within the session). */
  id: string;
  geometry: ProductGeometry;
  /** Painter's score, finite; defaults to 1 until scored. */
  score: number;
}

/**
 * The paint adapter seam. Phase 1.3 ships a hand-rolled implementation
 * (draw polygon: click adds a vertex, Backspace removes the last one,
 * dblclick/Enter closes — refusing degenerate rings with < 3 distinct
 * vertices, Escape cancels; click selects, Delete removes). A drawing
 * library becomes a drop-in replacement behind this interface — app
 * code and the RStep gate depend on nothing else.
 */
export interface PaintTool {
  /** Enter drawing mode (idempotent). */
  start(): void;
  /** Leave drawing mode, discarding any in-progress ring. */
  cancel(): void;
  /** Delete the selected feature; false if none selected. */
  deleteSelected(): boolean;
  /** All painted features, paint order. Ring winding is normalized to
   *  the GeoJSON convention (exterior CCW) on read — the export path
   *  relies on this. */
  features(): PaintedFeature[];
  /** Programmatic injection — the RStep gate's path. Applies the same
   *  validation as interactive painting; throws on degenerate input. */
  inject(feature: PaintedFeature): void;
  /** Subscribe to changes; returns an unsubscribe function. */
  onChange(listener: (features: PaintedFeature[]) => void): () => void;
  /** Remove tool layers/listeners from the map (idempotent). */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// SoLO app contract.
// ---------------------------------------------------------------------------

/** Contract every SoLO mini-app implements. */
export interface SoloApp {
  readonly id: string;
  readonly title: string;
  /** Layer packages this app orchestrates (from the node catalog). */
  layers(): Promise<PackLayers[]>;
  /**
   * Export the painted product through the node (`POST /api/export`).
   * The node's ceremony seam + export verifier enforce
   * zero-source-disclosure; the app only assembles the request. Files
   * stay in the node's exports dir — nothing is downloaded and nothing
   * leaves the machine.
   */
  exportProduct(
    product: string,
    features: PaintedFeature[],
    requester: string,
  ): Promise<ExportOutcome>;
}

export const SOLO_SDK_VERSION = "0.2.0";
