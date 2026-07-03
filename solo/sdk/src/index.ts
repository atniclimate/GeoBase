/**
 * SoLO — Sovereign Layer Orchestrator SDK.
 *
 * SoLO apps are GeoBase mini-applications (RStep is the first). They let a Tribe
 * stack layer packages, "paint" areas of opportunity over them, and export a
 * shareable product — WITHOUT ever disclosing the underlying source data. The
 * export path is TSDF-aware: a T2 export contains only the derived product.
 *
 * Scaffold only — behavior lands per docs/ROADMAP.md (Phase 1.3).
 */

/** TSDF tier codes, mirrored from the Rust `geobase-tsdf` crate. */
export type Tier = "T0" | "T1" | "T2" | "T3";

/** A layer package the orchestrator can stack. */
export interface LayerRef {
  id: string;
  name: string;
  tier: Tier;
}

/** A painted "area of opportunity" — the product a SoLO app produces. */
export interface OpportunityArea {
  id: string;
  /** GeoJSON geometry of the painted area (product, not source). */
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon;
  notes?: string;
}

/** Contract every SoLO app implements. */
export interface SoloApp {
  readonly id: string;
  readonly title: string;
  /** Layer packages this app orchestrates. */
  layers(): LayerRef[];
  /**
   * Export the painted product for sharing. Implementations MUST strip source
   * layers and honor the export tier (default T2 for partner sharing).
   */
  exportProduct(areas: OpportunityArea[], tier: Tier): Promise<Blob>;
}

/** Placeholder for GeoJSON typings until a real dependency is added. */
export declare namespace GeoJSON {
  interface Polygon {
    type: "Polygon";
    coordinates: number[][][];
  }
  interface MultiPolygon {
    type: "MultiPolygon";
    coordinates: number[][][][];
  }
}

export const SOLO_SDK_VERSION = "0.1.0";
