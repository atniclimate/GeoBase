import type { SourceLayerDocument } from "./types.js";

export interface DataCenterSummary {
  representations: number;
  canonical_sites: number;
  known_demand_records: number;
  unknown_demand_records: number;
}

/** Counts source representations separately from canonical sites; demand values are never summed. */
export function summarizeDataCenters(document: SourceLayerDocument): DataCenterSummary {
  const records = document.features.flatMap((feature) =>
    feature.data_center === null ? [] : [feature.data_center],
  );
  return {
    representations: records.length,
    canonical_sites: new Set(records.map((record) => record.canonical_site_id)).size,
    known_demand_records: records.filter((record) => record.demand.status === "asserted").length,
    unknown_demand_records: records.filter((record) => record.demand.status === "unknown").length,
  };
}
