import type { MultiPolygon, Polygon } from "geojson";
import type { JsonValue } from "../../shared/json.js";
import { stableStringify } from "../../shared/stable-json.js";
import { sha256Text } from "../hash.js";
import { createJstsPlanarTopologyEngine } from "../spatial/topology.js";
import { parseSourceLayer } from "../source-layer/parser.js";
import type { ParsedSourceLayer, SourceLayerFeature } from "../source-layer/types.js";
import {
  commonIntersectionArea,
  clippedUnionArea,
  polygonalArea,
  polygonalCovers,
  polygonalIntersectionArea,
} from "./geometry.js";
import { createScenario } from "./scenario.js";
import {
  RSTEP_LIMITS,
  RSTEP_RESULT_SCHEMA_VERSION,
  type EvaluateScreeningInput,
  type ProjectInputValue,
  type RstepFinding,
  type RstepRule,
  type RuleApplicability,
  type ScreeningResult,
} from "./types.js";

const topology = createJstsPlanarTopologyEngine();
const ALGORITHM = Object.freeze({
  id: "rstep-epsg5070-overlay/1" as const,
  analysis_crs: "EPSG:5070" as const,
  operations: "jsts topological covers, intersection and union area" as const,
  jsts_version: "2.12.1" as const,
  proj4_version: "2.21.0" as const,
});

export class RstepEvaluationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RstepEvaluationError";
  }
}

export async function evaluateScreening(input: EvaluateScreeningInput): Promise<ScreeningResult> {
  const scenario = createScenario(input.scenario);
  if (!topology.equalsTopologically(input.aoi, scenario.aoi)) {
    throw new RstepEvaluationError("evaluation AOI must equal the exact scenario AOI");
  }
  const layerMap = new Map<string, ParsedSourceLayer>();
  let vertices = 0;
  for (const supplied of input.layers) {
    const layer = await parseSourceLayer(supplied.exactJson);
    if (
      layer.exactSha256 !== supplied.exactSha256 ||
      layer.document.layer_id !== supplied.document.layer_id ||
      layer.document.revision !== supplied.document.revision
    )
      throw new RstepEvaluationError("supplied layer object contradicts its exact retained JSON");
    const key = layerKey(layer.document.layer_id, layer.document.revision);
    if (layerMap.has(key)) throw new RstepEvaluationError(`duplicate supplied layer revision ${key}`);
    layerMap.set(key, layer);
    vertices += layer.vertexCount;
  }
  if (layerMap.size > RSTEP_LIMITS.layers)
    throw new RstepEvaluationError(`active layer count exceeds ${RSTEP_LIMITS.layers}`);
  if (vertices > RSTEP_LIMITS.activeVertices)
    throw new RstepEvaluationError(`active vertices exceed ${RSTEP_LIMITS.activeVertices}`);

  const bindingMap = new Map(
    [...scenario.layer_bindings, ...scenario.overlay_bindings].map(
      (binding) => [layerKey(binding.layer_id, binding.revision), binding] as const,
    ),
  );
  const findings: RstepFinding[] = [];
  const excludedGeometries: (Polygon | MultiPolygon)[] = [];
  const coverageGeometries: (Polygon | MultiPolygon)[] = [scenario.aoi];
  let evaluationBlocked = false;
  let requiredCoverageUnavailable = false;
  let allCoverageContainsAoi = true;
  const warnings = new Set<string>();

  for (const rule of [...scenario.rules].sort(compareRule)) {
    const applicability = evaluateApplicability(
      rule,
      scenario.technology,
      scenario.jurisdiction,
      scenario.project_inputs,
    );
    if (applicability === "not_applicable") {
      findings.push(
        finding(
          rule,
          "not_applicable",
          "not_applicable",
          [],
          "Rule does not apply to this technology, jurisdiction, project input, or resolved exception.",
        ),
      );
      continue;
    }
    if (applicability === "unknown") {
      findings.push(
        finding(rule, "unknown", "unknown", [], "Rule applicability or exception status is unresolved."),
      );
      warnings.add(`Rule ${rule.id}@${rule.revision} applicability is unresolved.`);
      evaluationBlocked = true;
      requiredCoverageUnavailable = true;
      continue;
    }
    const key = layerKey(rule.layer_id, rule.layer_revision);
    const binding = bindingMap.get(key);
    const layer = layerMap.get(key);
    if (binding === undefined || !binding.enabled || layer === undefined) {
      findings.push(
        finding(rule, "applicable", "unknown", [], "Required exact layer revision is not active."),
      );
      warnings.add(`Required layer ${rule.layer_id}@${rule.layer_revision} is unavailable.`);
      evaluationBlocked = true;
      requiredCoverageUnavailable = true;
      continue;
    }
    coverageGeometries.push(layer.document.coverage.geometry);
    const coverageArea = polygonalIntersectionArea(scenario.aoi, layer.document.coverage.geometry);
    const coversWholeAoi = polygonalCovers(layer.document.coverage.geometry, scenario.aoi);
    allCoverageContainsAoi &&= coversWholeAoi;
    if (layer.document.coverage.completeness !== "complete" || !coversWholeAoi) {
      if (layer.document.coverage.completeness !== "complete") evaluationBlocked = true;
      warnings.add(
        coversWholeAoi
          ? `Layer ${rule.layer_id}@${rule.layer_revision} coverage is ${layer.document.coverage.completeness}.`
          : `Layer ${rule.layer_id}@${rule.layer_revision} does not cover the whole AOI.`,
      );
    }
    const unsupported = layer.document.features
      .filter(
        (feature) =>
          feature.analysis_geometry.type !== "Polygon" && feature.analysis_geometry.type !== "MultiPolygon",
      )
      .map((feature) => feature.id)
      .sort(compareText);
    if (unsupported.length > 0) {
      evaluationBlocked = true;
      warnings.add(
        `Layer ${rule.layer_id}@${rule.layer_revision} contains geometry families unsupported by overlap schema v1.`,
      );
    }
    const matched = matchingPolygonFeatures(scenario.aoi, layer.document.features);
    if (matched.length > 0) {
      findings.push(
        finding(
          rule,
          "applicable",
          "overlap",
          matched.map((feature) => feature.id).sort(compareText),
          "One or more retained source features overlap the AOI.",
        ),
      );
      if (rule.treatment === "exclude") {
        for (const feature of matched)
          excludedGeometries.push(feature.analysis_geometry as Polygon | MultiPolygon);
      }
    } else if (unsupported.length > 0) {
      findings.push(
        finding(
          rule,
          "applicable",
          "unknown",
          [],
          "One or more retained source features use a geometry family unsupported by overlap schema v1.",
        ),
      );
    } else if (!coversWholeAoi || layer.document.coverage.completeness !== "complete") {
      findings.push(
        finding(
          rule,
          "applicable",
          "unknown",
          [],
          coverageArea <= 0
            ? "AOI is outside the layer's declared coverage."
            : "No overlap was observed, but the AOI is not wholly within declared complete coverage.",
        ),
      );
    } else {
      findings.push(
        finding(
          rule,
          "applicable",
          "non_match",
          [],
          "No overlap was observed within the layer's declared complete coverage.",
        ),
      );
    }
  }

  const aoiArea = polygonalArea(scenario.aoi);
  // Exact topological containment establishes full coverage without inferring it
  // from an area tolerance or inventing a roundoff-sized unknown sliver.
  const coveredArea = requiredCoverageUnavailable
    ? 0
    : allCoverageContainsAoi
      ? aoiArea
      : commonIntersectionArea(coverageGeometries);
  const evaluatedArea = evaluationBlocked ? 0 : coveredArea;
  const excludedArea = clippedUnionArea(scenario.aoi, excludedGeometries);
  const area = {
    aoi_square_metres: aoiArea,
    covered_square_metres: coveredArea,
    evaluated_square_metres: evaluatedArea,
    excluded_union_square_metres: excludedArea,
    remainder_square_metres: Math.max(0, aoiArea - excludedArea),
    unknown_or_incomplete_square_metres: Math.max(0, aoiArea - evaluatedArea),
  };
  const digests = [...layerMap.values()]
    .map((layer) => ({
      layer_id: layer.document.layer_id,
      revision: layer.document.revision,
      sha256: layer.exactSha256,
    }))
    .sort((left, right) =>
      compareText(layerKey(left.layer_id, left.revision), layerKey(right.layer_id, right.revision)),
    );
  const recipePayload = { algorithm: ALGORITHM, scenario, source_layer_digests: digests };
  const recipeId = await sha256Text(stableStringify(recipePayload as unknown as JsonValue, false));
  const stablePayload = {
    algorithm: ALGORITHM,
    scenario_id: scenario.id,
    scenario_revision: scenario.revision,
    recipe_id: recipeId,
    findings,
    area,
    source_layer_digests: digests,
    warnings: [...warnings].sort(compareText),
  };
  const resultId = await sha256Text(stableStringify(stablePayload as unknown as JsonValue, false));
  return {
    schema_version: RSTEP_RESULT_SCHEMA_VERSION,
    scenario_id: scenario.id,
    scenario_revision: scenario.revision,
    recipe_id: recipeId,
    result_id: resultId,
    algorithm: { ...ALGORITHM },
    conclusion: "not excluded by the selected screening rules",
    findings,
    area,
    source_layer_digests: digests,
    warnings: [...warnings].sort(compareText),
  };
}

function evaluateApplicability(
  rule: RstepRule,
  technology: "solar" | "wind",
  jurisdiction: "ID" | "OR" | "WA",
  inputs: Readonly<Record<string, JsonValue>>,
): RuleApplicability {
  if (!rule.technology.includes(technology) || !rule.jurisdictions.includes(jurisdiction))
    return "not_applicable";
  if (
    rule.basis === "verified_legal_prohibition" &&
    (rule.project_requirements.length === 0 || rule.exceptions.length === 0)
  )
    return "unknown";
  for (const predicate of rule.project_requirements) {
    const observed = inputs[predicate.field];
    if (observed === undefined || observed === null) return "unknown";
    const match = predicateMatches(observed as ProjectInputValue, predicate.operator, predicate.value);
    if (match === "unknown") return "unknown";
    if (!match) return "not_applicable";
  }
  for (const exception of rule.exceptions) {
    const observed = inputs[exception.field];
    if (observed === undefined || observed === null) return "unknown";
    const match = predicateMatches(observed as ProjectInputValue, exception.operator, exception.value);
    if (match === "unknown") return "unknown";
    if (match) return "not_applicable";
  }
  return "applicable";
}

function predicateMatches(
  observed: ProjectInputValue,
  operator: "equals" | "gte" | "lte",
  expected: string | number | boolean,
): boolean | "unknown" {
  if (operator === "equals") return typeof observed === typeof expected ? observed === expected : "unknown";
  if (typeof observed !== "number" || typeof expected !== "number") return "unknown";
  return operator === "gte" ? observed >= expected : observed <= expected;
}

function matchingPolygonFeatures(
  aoi: Polygon | MultiPolygon,
  features: readonly SourceLayerFeature[],
): SourceLayerFeature[] {
  return features.filter((feature) => {
    if (feature.analysis_geometry.type !== "Polygon" && feature.analysis_geometry.type !== "MultiPolygon")
      return false;
    return polygonalIntersectionArea(aoi, feature.analysis_geometry) > 0;
  });
}

function finding(
  rule: RstepRule,
  applicability: RuleApplicability,
  evaluation: RstepFinding["evaluation"],
  matchedFeatureIds: string[],
  message: string,
): RstepFinding {
  return {
    rule_id: rule.id,
    rule_revision: rule.revision,
    layer_id: rule.layer_id,
    layer_revision: rule.layer_revision,
    basis: rule.basis,
    applicability,
    evaluation,
    treatment: rule.treatment,
    matched_feature_ids: matchedFeatureIds,
    message,
  };
}
function layerKey(id: string, revision: string): string {
  return JSON.stringify([id, revision]);
}
function compareRule(left: RstepRule, right: RstepRule): number {
  return compareText(`${left.id}@${left.revision}`, `${right.id}@${right.revision}`);
}
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
