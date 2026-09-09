import booleanIntersects from "@turf/boolean-intersects";
import type { Feature, GeoJsonProperties, Geometry, MultiPolygon, Polygon } from "geojson";
import type { JsonObject, JsonValue } from "../shared/json";
import type { ImportedGeoJsonLayer } from "./geojson";
import type { HardExclusionSetting, Scenario, SoftConstraintSetting } from "./project";

export type OpportunityState = "excluded" | "included" | "penalized" | "unavailable" | "unknown";

export type AnalysisReasonCode =
  | "HARD_EXCLUSION_MATCH"
  | "HARD_EXCLUSION_NO_MATCH"
  | "INPUT_UNAVAILABLE"
  | "RESOURCE_MISSING"
  | "RESOURCE_VALUE"
  | "RULE_DISABLED"
  | "SOFT_CONSTRAINT_MATCH"
  | "SOFT_CONSTRAINT_NO_MATCH";

export interface AnalysisReason {
  code: AnalysisReasonCode;
  layer_id: string;
  matched: boolean | null;
  message: string;
  penalty_fraction: number | null;
  rule_id: string | null;
  selected: boolean;
  sequence: number;
}

export interface AnalysisResult {
  adjusted_value: number | null;
  feature_id: string;
  geometry: MultiPolygon | Polygon;
  penalty_fraction: number | null;
  reasons: AnalysisReason[];
  resource_value: number | null;
  source_properties: JsonObject;
  state: OpportunityState;
}

export interface AnalyzeScenarioInput {
  constraintLayers: ImportedGeoJsonLayer[];
  resourceLayer: ImportedGeoJsonLayer;
  scenario: Scenario;
}

export class AnalysisError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AnalysisError";
  }
}

/**
 * Applies deterministic hard-exclusion precedence followed by missing/unavailable
 * handling and multiplicative soft penalties. Every configured rule emits a trace.
 */
export function analyzeScenario(input: AnalyzeScenarioInput): AnalysisResult[] {
  const { resourceLayer, scenario } = input;
  if (resourceLayer.metadata.layer.id !== scenario.resource_layer_id) {
    throw new AnalysisError(
      `scenario expects resource layer ${scenario.resource_layer_id}, received ${resourceLayer.metadata.layer.id}`,
    );
  }
  if (resourceLayer.metadata.layer.role !== "resource") {
    throw new AnalysisError(
      `layer ${resourceLayer.metadata.layer.id} has role ${resourceLayer.metadata.layer.role}, expected resource`,
    );
  }

  const constraints = new Map<string, ImportedGeoJsonLayer>();
  for (const layer of input.constraintLayers) {
    if (constraints.has(layer.metadata.layer.id)) {
      throw new AnalysisError(`duplicate constraint layer ${layer.metadata.layer.id}`);
    }
    if (layer.metadata.coordinate_reference_system !== resourceLayer.metadata.coordinate_reference_system) {
      throw new AnalysisError(
        `constraint layer ${layer.metadata.layer.id} uses ${layer.metadata.coordinate_reference_system}; ` +
          `explicitly transform it to ${resourceLayer.metadata.coordinate_reference_system} before analysis`,
      );
    }
    constraints.set(layer.metadata.layer.id, layer);
  }

  const hardRules = [...scenario.hard_exclusions].sort(compareRules);
  const softRules = [...scenario.soft_constraints].sort(compareRules);

  return resourceLayer.document.features
    .map((feature) => analyzeFeature(feature, scenario, hardRules, softRules, constraints))
    .sort((left, right) => left.feature_id.localeCompare(right.feature_id));
}

function analyzeFeature(
  resourceFeature: Feature<Geometry, GeoJsonProperties>,
  scenario: Scenario,
  hardRules: readonly HardExclusionSetting[],
  softRules: readonly SoftConstraintSetting[],
  constraints: ReadonlyMap<string, ImportedGeoJsonLayer>,
): AnalysisResult {
  if (resourceFeature.geometry.type !== "Polygon" && resourceFeature.geometry.type !== "MultiPolygon") {
    throw new AnalysisError(`resource feature ${String(resourceFeature.id)} must be Polygon or MultiPolygon`);
  }
  if (
    typeof resourceFeature.id !== "string" ||
    resourceFeature.properties === null ||
    Array.isArray(resourceFeature.properties) ||
    typeof resourceFeature.properties !== "object"
  ) {
    throw new AnalysisError("resource feature must have a stable string id and object properties");
  }

  const hasResourceValue = Object.hasOwn(resourceFeature.properties, scenario.resource_value_property);
  const rawResourceValue = resourceFeature.properties[scenario.resource_value_property];
  let resourceValue: number | null;
  if (!hasResourceValue || rawResourceValue === null) {
    resourceValue = null;
  } else if (typeof rawResourceValue !== "number" || !Number.isFinite(rawResourceValue)) {
    const valueType = Array.isArray(rawResourceValue) ? "array" : typeof rawResourceValue;
    throw new AnalysisError(
      `resource feature ${resourceFeature.id} property ${scenario.resource_value_property} must be a finite number, null, or absent; received ${valueType}`,
    );
  } else {
    resourceValue = rawResourceValue;
  }
  const reasons: AnalysisReason[] = [];
  let sequence = 0;
  let hardMatched = false;
  let unavailable = false;
  let combinedRetainedFraction = 1;
  let softMatched = false;

  reasons.push({
    code: resourceValue === null ? "RESOURCE_MISSING" : "RESOURCE_VALUE",
    layer_id: scenario.resource_layer_id,
    matched: null,
    message:
      resourceValue === null
        ? `property ${scenario.resource_value_property} is missing or null; it is unknown, not zero`
        : `resource value ${resourceValue} read from ${scenario.resource_value_property}`,
    penalty_fraction: null,
    rule_id: null,
    selected: true,
    sequence: sequence++,
  });

  for (const rule of hardRules) {
    if (!rule.enabled) {
      reasons.push(disabledReason(rule, sequence++));
      continue;
    }
    const layer = constraints.get(rule.layer_id);
    if (layer === undefined) {
      unavailable = true;
      reasons.push(unavailableReason(rule, sequence++));
      continue;
    }
    assertLayerRole(layer, "hard_exclusion", rule.rule_id);
    const matched = intersectsAny(resourceFeature.geometry, layer.document.features);
    hardMatched ||= matched;
    reasons.push({
      code: matched ? "HARD_EXCLUSION_MATCH" : "HARD_EXCLUSION_NO_MATCH",
      layer_id: rule.layer_id,
      matched,
      message: matched
        ? `${rule.description}: geometry intersects the selected hard exclusion`
        : `${rule.description}: no intersection with the selected hard exclusion`,
      penalty_fraction: null,
      rule_id: rule.rule_id,
      selected: true,
      sequence: sequence++,
    });
  }

  for (const rule of softRules) {
    if (!rule.enabled) {
      reasons.push(disabledReason(rule, sequence++));
      continue;
    }
    const layer = constraints.get(rule.layer_id);
    if (layer === undefined) {
      unavailable = true;
      reasons.push(unavailableReason(rule, sequence++));
      continue;
    }
    assertLayerRole(layer, "soft_constraint", rule.rule_id);
    const matched = intersectsAny(resourceFeature.geometry, layer.document.features);
    if (matched) {
      softMatched = true;
      combinedRetainedFraction *= 1 - rule.penalty_fraction;
    }
    reasons.push({
      code: matched ? "SOFT_CONSTRAINT_MATCH" : "SOFT_CONSTRAINT_NO_MATCH",
      layer_id: rule.layer_id,
      matched,
      message: matched
        ? `${rule.description}: applied ${(rule.penalty_fraction * 100).toFixed(2)}% penalty`
        : `${rule.description}: no intersection, so no penalty applied`,
      penalty_fraction: matched ? rule.penalty_fraction : null,
      rule_id: rule.rule_id,
      selected: true,
      sequence: sequence++,
    });
  }

  let state: OpportunityState;
  let adjustedValue: number | null;
  let penaltyFraction: number | null;
  if (hardMatched) {
    state = "excluded";
    adjustedValue = null;
    penaltyFraction = null;
  } else if (unavailable) {
    state = "unavailable";
    adjustedValue = null;
    penaltyFraction = null;
  } else if (resourceValue === null) {
    state = "unknown";
    adjustedValue = null;
    penaltyFraction = null;
  } else if (softMatched) {
    state = "penalized";
    penaltyFraction = 1 - combinedRetainedFraction;
    adjustedValue = resourceValue * combinedRetainedFraction;
  } else {
    state = "included";
    adjustedValue = resourceValue;
    penaltyFraction = null;
  }

  return {
    adjusted_value: adjustedValue,
    feature_id: resourceFeature.id,
    geometry: resourceFeature.geometry,
    penalty_fraction: penaltyFraction,
    reasons,
    resource_value: resourceValue,
    source_properties: resourceFeature.properties,
    state,
  };
}

function intersectsAny(
  geometry: MultiPolygon | Polygon,
  features: Feature<Geometry, GeoJsonProperties>[],
): boolean {
  const resourceFeature: Feature<MultiPolygon | Polygon> = {
    geometry,
    properties: {},
    type: "Feature",
  };
  return features.some((constraint) => booleanIntersects(resourceFeature, constraint));
}

function disabledReason(
  rule: HardExclusionSetting | SoftConstraintSetting,
  sequence: number,
): AnalysisReason {
  return {
    code: "RULE_DISABLED",
    layer_id: rule.layer_id,
    matched: null,
    message: `${rule.description}: rule is not selected`,
    penalty_fraction: null,
    rule_id: rule.rule_id,
    selected: false,
    sequence,
  };
}

function unavailableReason(
  rule: HardExclusionSetting | SoftConstraintSetting,
  sequence: number,
): AnalysisReason {
  return {
    code: "INPUT_UNAVAILABLE",
    layer_id: rule.layer_id,
    matched: null,
    message: `${rule.description}: selected input layer is unavailable`,
    penalty_fraction: null,
    rule_id: rule.rule_id,
    selected: true,
    sequence,
  };
}

function assertLayerRole(
  layer: ImportedGeoJsonLayer,
  expected: "hard_exclusion" | "soft_constraint",
  ruleId: string,
): void {
  if (layer.metadata.layer.role !== expected) {
    throw new AnalysisError(
      `rule ${ruleId} requires ${expected} but layer ${layer.metadata.layer.id} has role ${layer.metadata.layer.role}`,
    );
  }
}

function compareRules(
  left: HardExclusionSetting | SoftConstraintSetting,
  right: HardExclusionSetting | SoftConstraintSetting,
): number {
  return left.rule_id.localeCompare(right.rule_id);
}

/** Converts an analysis result to JSON-safe properties for display or export. */
export function analysisResultProperties(result: AnalysisResult): JsonObject {
  return {
    adjusted_value: result.adjusted_value,
    analysis_state: result.state,
    penalty_fraction: result.penalty_fraction,
    reason_trace: result.reasons as unknown as JsonValue,
    resource_value: result.resource_value,
    source_feature_id: result.feature_id,
  };
}
