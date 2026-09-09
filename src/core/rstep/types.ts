import type { MultiPolygon, Polygon } from "geojson";
import type { JsonObject, JsonValue } from "../../shared/json.js";
import type { ParsedSourceLayer } from "../source-layer/types.js";

export const RSTEP_SCENARIO_SCHEMA_VERSION = "geobase.rstep-scenario/1" as const;
export const RSTEP_SIDECAR_SCHEMA_VERSION = "geobase.rstep-sidecar/1" as const;
export const RSTEP_RESULT_SCHEMA_VERSION = "geobase.rstep-result/1" as const;
export const RSTEP_LIMITS = Object.freeze({
  sidecarBytes: 128 * 1024 * 1024,
  layers: 20,
  activeVertices: 1_000_000,
});

export type RstepTechnology = "solar" | "wind";
export type RstepJurisdiction = "ID" | "OR" | "WA";
export type RuleBasis =
  | "context_or_opportunity"
  | "custodian_or_scenario_avoidance"
  | "economic_assumption"
  | "engineering_screen"
  | "permit_or_compatibility_review"
  | "unknown_or_conflict"
  | "verified_legal_prohibition";
export type RuleTreatment = "avoid" | "context" | "exclude" | "review";
export type RuleApplicability = "applicable" | "not_applicable" | "unknown";
export type RuleEvaluation = "error" | "non_match" | "not_applicable" | "overlap" | "unknown";

export interface RulePredicate {
  field: string;
  operator: "equals" | "gte" | "lte";
  value: string | number | boolean;
}

export interface RstepRule {
  id: string;
  revision: string;
  name: string;
  basis: RuleBasis;
  technology: RstepTechnology[];
  jurisdictions: RstepJurisdiction[];
  layer_id: string;
  layer_revision: string;
  geometry_operation: "buffer_overlap" | "overlap";
  /** Null for overlap. v1 rejects buffer_overlap until its exact parameters are added. */
  buffer_metres: number | null;
  treatment: RuleTreatment;
  project_requirements: RulePredicate[];
  exceptions: RulePredicate[];
  citation: string;
  limitations: string[];
}

export interface RstepLayerBinding {
  layer_id: string;
  revision: string;
  enabled: boolean;
}

export interface RstepScenario {
  schema_version: typeof RSTEP_SCENARIO_SCHEMA_VERSION;
  id: string;
  revision: string;
  name: string;
  technology: RstepTechnology;
  jurisdiction: RstepJurisdiction;
  aoi: Polygon | MultiPolygon;
  analysis_crs: "EPSG:5070";
  project_inputs: JsonObject;
  layer_bindings: RstepLayerBinding[];
  overlay_bindings: RstepLayerBinding[];
  rules: RstepRule[];
}

export interface RstepFinding {
  rule_id: string;
  rule_revision: string;
  layer_id: string;
  layer_revision: string;
  basis: RuleBasis;
  applicability: RuleApplicability;
  evaluation: RuleEvaluation;
  treatment: RuleTreatment;
  matched_feature_ids: string[];
  message: string;
}

export interface ScreeningAreaAccounting {
  aoi_square_metres: number;
  covered_square_metres: number;
  evaluated_square_metres: number;
  excluded_union_square_metres: number;
  remainder_square_metres: number;
  unknown_or_incomplete_square_metres: number;
}

export interface ScreeningResult {
  schema_version: typeof RSTEP_RESULT_SCHEMA_VERSION;
  scenario_id: string;
  scenario_revision: string;
  recipe_id: string;
  result_id: string;
  algorithm: {
    id: "rstep-epsg5070-overlay/1";
    analysis_crs: "EPSG:5070";
    operations: "jsts topological covers, intersection and union area";
    jsts_version: "2.12.1";
    proj4_version: "2.21.0";
  };
  conclusion: "not excluded by the selected screening rules";
  findings: RstepFinding[];
  area: ScreeningAreaAccounting;
  source_layer_digests: { layer_id: string; revision: string; sha256: string }[];
  warnings: string[];
}

export interface LayerSnapshot {
  layer_id: string;
  revision: string;
  exact_json: string;
  sha256: string;
}

export interface OverlayPermission {
  status: "public_fixture_authorized" | "synthetic_authorized";
  custodian: string;
  intended_scope: string;
}

export interface OverlaySnapshot extends LayerSnapshot {
  permission: OverlayPermission;
}

export interface StableResultBinding {
  scenario_id: string;
  scenario_revision: string;
  result_id: string;
}

export interface StaleResult {
  reason: "overlay_added" | "overlay_removed" | "overlay_replaced" | "rule_or_scenario_edited";
  prior_result_id: string | null;
}

export interface RstepSidecar {
  schema_version: typeof RSTEP_SIDECAR_SCHEMA_VERSION;
  /** Null identifies an independent RSTEP workspace with no legacy GeoBase project binding. */
  project_sha256: string | null;
  governance: {
    governance_mode: "development_bypass";
    governance_enforced: false;
    public_distribution_allowed: false;
    warning: "DEVELOPMENT BUILD - SOVEREIGNTY CONTROLS NOT ENFORCED";
  };
  layers: LayerSnapshot[];
  overlays: OverlaySnapshot[];
  scenarios: RstepScenario[];
  active_scenario_id: string;
  stable_result: StableResultBinding | null;
  stale_result: StaleResult | null;
}

export interface CreateSidecarInput {
  projectSha256: string | null;
  layers: ParsedSourceLayer[];
  overlays: { layer: ParsedSourceLayer; permission: OverlayPermission }[];
  scenarios: RstepScenario[];
  activeScenarioId: string;
  stableResult?: ScreeningResult;
}

export interface EvaluateScreeningInput {
  aoi: Polygon | MultiPolygon;
  scenario: RstepScenario;
  layers: ParsedSourceLayer[];
}

export interface OverlayMutationInput {
  layer: ParsedSourceLayer;
  permission: OverlayPermission;
}

export interface SidecarContentDigest {
  kind: "layer" | "overlay";
  layer_id: string;
  revision: string;
  sha256: string;
}

export type ProjectInputValue = Exclude<JsonValue, JsonObject | JsonValue[]>;
