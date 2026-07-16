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

/**
 * `POST /api/export` request body — B3 shape (breaking change, recorded
 * in `docs/CEREMONY-DESIGN.md` §2.4): the pre-B3 `source_packs` and
 * `requester` fields are REFUSED by the node. The source set is the
 * node's own witnessed record for `session`; identity is authenticated
 * node-side, never claimed by the app.
 */
export interface ExportRequestBody {
  /** Product name `^[a-z0-9][a-z0-9_-]*$` — the output file stem. */
  product: string;
  /** The node-witnessed export session id (`NodeClient.beginSession`).
   *  Optional here: `exportProduct` fills it from the client's active
   *  session when omitted. */
  session?: string;
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
  publication_id: string;
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
export interface NodeClientOptions {
  /** Interim operator export token (Phase A guard, A1). Sent as
   *  `x-geobase-export-token` on `POST /api/export` only. Provisional:
   *  replaced by real requester authentication in Phase B (B5). Optional
   *  second constructor argument — a non-breaking extension of the frozen
   *  1.3c contract. */
  exportToken?: string;
}

export class NodeClient {
  readonly baseUrl: string;
  private readonly exportToken?: string;
  private activeSession?: string;

  constructor(baseUrl: string, options?: NodeClientOptions) {
    const parsed = new URL(baseUrl);
    const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !loopback) {
      throw new Error("node baseUrl must be an http(s) URL on localhost/127.0.0.1");
    }
    this.baseUrl = parsed.href.replace(/\/$/, "");
    this.exportToken = options?.exportToken;
  }

  node(): Promise<NodeInfo> {
    return this.getObject<NodeInfo>("/api/node");
  }

  packs(): Promise<PackSummary[]> {
    return this.getArray<PackSummary>("/api/packs");
  }

  /**
   * Begin a node-witnessed export session (B3, `docs/CEREMONY-DESIGN.md`
   * §4). Every pack subsequently served through this client is witnessed
   * by the node into the session, and the export's source set is the
   * NODE'S record — the app can neither add nor subtract. Call this
   * before fetching layers/features that the painted product derives
   * from; without a session no export can be authorized.
   */
  async beginSession(): Promise<string> {
    const body = await this.requestObject<{ session: string }>("/api/sessions", {
      method: "POST",
    });
    if (typeof body.session !== "string" || body.session === "") {
      throw new Error("node did not return a session id");
    }
    this.activeSession = body.session;
    return body.session;
  }

  /** The active export session id, if `beginSession` has been called. */
  session(): string | undefined {
    return this.activeSession;
  }

  layers(pack: string): Promise<PackLayers> {
    return this.getObject<PackLayers>(`/api/packs/${encodeURIComponent(pack)}/layers`);
  }

  features(pack: string, table: string): Promise<FeatureCollection> {
    return this.getObject<FeatureCollection>(
      `/api/packs/${encodeURIComponent(pack)}/tables/${encodeURIComponent(table)}/features`,
    );
  }

  /** POST /api/export. Refusals (403 ceremony/token/session, 400 invalid,
   *  409 exists, 503 infrastructure) reject with `NodeRequestError`
   *  carrying the server's reason. The session defaults to the client's
   *  active one; the export token is passed explicitly here — and only
   *  here; read endpoints never send it. */
  exportProduct(body: ExportRequestBody): Promise<ExportOutcome> {
    const session = body.session ?? this.activeSession;
    if (session === undefined) {
      throw new Error(
        "no export session — call beginSession() before loading source layers " +
          "(the node witnesses served packs into the session; an export " +
          "without one is refused)",
      );
    }
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.exportToken !== undefined) {
      headers["x-geobase-export-token"] = this.exportToken;
    }
    return this.requestObject<ExportOutcome>("/api/export", {
      method: "POST",
      headers,
      body: JSON.stringify({ ...body, session }),
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
    // Attach the active session to READ requests so the node witnesses
    // every served pack into it (non-breaking header addition, B3 §4).
    if (this.activeSession !== undefined && init.method === "GET") {
      init.headers = {
        ...(init.headers as Record<string, string> | undefined),
        "x-geobase-session": this.activeSession,
      };
    }
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
   * zero-source-disclosure; the app only assembles the request — the
   * source set is the node's witnessed session record and the requester
   * identity is authenticated node-side (B3: the app no longer names
   * either). Files stay in the node's exports dir — nothing is
   * downloaded and nothing leaves the machine.
   */
  exportProduct(product: string, features: PaintedFeature[]): Promise<ExportOutcome>;
}

export const SOLO_SDK_VERSION = "0.3.0";
