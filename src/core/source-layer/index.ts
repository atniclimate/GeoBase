export * from "./types.js";
export * from "./parser.js";
export * from "./data-center.js";

import type { ParsedSourceLayer, SourceLayerSummary } from "./types.js";

/** A bounded metadata-only view for generic consumers; it omits raw source properties and RSTEP state. */
export function sourceLayerSummary(layer: ParsedSourceLayer): SourceLayerSummary {
  const document = layer.document;
  return {
    layer_id: document.layer_id,
    revision: document.revision,
    name: document.name,
    kind: document.kind,
    publisher: document.source.publisher,
    source_title: document.source.title,
    source_edition: document.source.edition,
    coverage_completeness: document.coverage.completeness,
    states: [...document.coverage.states],
    feature_count: layer.featureCount,
    vertex_count: layer.vertexCount,
    effective_tier: "T3",
    exact_sha256: layer.exactSha256,
  };
}
export { queryDataCenters, type DataCenterAoiQuery } from "./data-center-query.js";
