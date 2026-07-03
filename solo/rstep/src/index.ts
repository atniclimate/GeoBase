/**
 * RStep — the first SoLO app (Renewable Siting Tool for Energy Planning).
 *
 * Orchestrates renewable-energy capacity layers and NoGo zones, lets a Tribe
 * paint areas of opportunity, and exports a T2 shapefile containing only the
 * painted product — never the source siting data.
 *
 * Scaffold only — implementation lands in docs/ROADMAP.md Phase 1.3.
 */

import type { LayerRef, OpportunityArea, SoloApp, Tier } from "@geobase/solo-sdk";

export class RStep implements SoloApp {
  readonly id = "rstep";
  readonly title = "RStep — Renewable Siting";

  layers(): LayerRef[] {
    return [
      { id: "capacity", name: "Renewable energy capacity", tier: "T1" },
      { id: "nogo", name: "NoGo zones", tier: "T3" },
    ];
  }

  async exportProduct(_areas: OpportunityArea[], _tier: Tier): Promise<Blob> {
    // Phase 1.3: emit a shapefile of the painted areas ONLY, stripping every
    // source layer. NoGo (T3) inputs inform the paint but must never appear in
    // the export. Enforced by geobase-core / geobase-gpkg export guards.
    throw new Error("RStep.exportProduct not yet implemented (roadmap Phase 1.3)");
  }
}
