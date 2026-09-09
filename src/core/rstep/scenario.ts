import type { MultiPolygon, Polygon } from "geojson";
import { assertPositionInCrs, visitGeometryPositions } from "../crs.js";
import { isJsonObject, type JsonObject, type JsonValue } from "../../shared/json.js";
import { parseJson, stableStringify } from "../../shared/stable-json.js";
import { requirePolygonalGeometry } from "../spatial/polygon.js";
import { createJstsPlanarTopologyEngine } from "../spatial/topology.js";
import {
  RSTEP_SCENARIO_SCHEMA_VERSION,
  type RstepJurisdiction,
  type RstepLayerBinding,
  type RstepRule,
  type RstepScenario,
  type RstepTechnology,
  type RuleBasis,
  type RulePredicate,
  type RuleTreatment,
} from "./types.js";

const topology = createJstsPlanarTopologyEngine();

export class RstepScenarioError extends Error {
  public readonly path: string;
  public constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "RstepScenarioError";
    this.path = path;
  }
}

export function createScenario(value: unknown): RstepScenario {
  if (!isJsonObject(value)) fail("scenario", "must be an object");
  return parseScenarioValue(value);
}

export function parseScenario(text: string): RstepScenario {
  const value = parseJson(text);
  if (!isJsonObject(value)) fail("scenario", "must be an object");
  return parseScenarioValue(value);
}

export function serializeScenario(scenario: RstepScenario): string {
  return stableStringify(parseScenarioValue(scenario as unknown as JsonObject) as unknown as JsonValue);
}

function parseScenarioValue(value: JsonObject): RstepScenario {
  const scenario = object(value, "scenario", [
    "schema_version",
    "id",
    "revision",
    "name",
    "technology",
    "jurisdiction",
    "aoi",
    "analysis_crs",
    "project_inputs",
    "layer_bindings",
    "overlay_bindings",
    "rules",
  ]);
  literal(scenario.schema_version, RSTEP_SCENARIO_SCHEMA_VERSION, "scenario.schema_version");
  literal(scenario.analysis_crs, "EPSG:5070", "scenario.analysis_crs");
  const aoi = polygon(scenario.aoi, "scenario.aoi");
  visitGeometryPositions(aoi, (position) => assertPositionInCrs(position, "EPSG:5070"), "scenario.aoi");
  const verdict = topology.validate(aoi);
  if (!verdict.valid || topology.area(aoi) <= 0)
    fail("scenario.aoi", `must be a valid positive-area polygon: ${verdict.reason ?? "invalid"}`);
  const projectInputs = object(scenario.project_inputs, "scenario.project_inputs");
  for (const [key, item] of Object.entries(projectInputs)) {
    if (item !== null && typeof item === "object")
      fail(`scenario.project_inputs.${key}`, "must be a scalar or null");
  }
  const layerBindings = bindings(scenario.layer_bindings, "scenario.layer_bindings");
  const overlayBindings = bindings(scenario.overlay_bindings, "scenario.overlay_bindings");
  const allBindingKeys = new Set([...layerBindings, ...overlayBindings].map(bindingKey));
  const rules = array(scenario.rules, "scenario.rules").map((item, index) =>
    parseRule(item, `scenario.rules[${index}]`),
  );
  unique(
    rules.map((rule) => `${rule.id}@${rule.revision}`),
    "scenario.rules",
    "rule revision",
  );
  for (const rule of rules) {
    if (!allBindingKeys.has(bindingKey({ layer_id: rule.layer_id, revision: rule.layer_revision }))) {
      fail(`scenario.rules.${rule.id}`, "layer/revision has no scenario binding");
    }
  }
  return {
    schema_version: RSTEP_SCENARIO_SCHEMA_VERSION,
    id: text(scenario.id, "scenario.id"),
    revision: text(scenario.revision, "scenario.revision"),
    name: text(scenario.name, "scenario.name"),
    technology: oneOf(scenario.technology, ["wind", "solar"], "scenario.technology") as RstepTechnology,
    jurisdiction: oneOf(
      scenario.jurisdiction,
      ["WA", "OR", "ID"],
      "scenario.jurisdiction",
    ) as RstepJurisdiction,
    aoi,
    analysis_crs: "EPSG:5070",
    project_inputs: structuredClone(projectInputs),
    layer_bindings: layerBindings,
    overlay_bindings: overlayBindings,
    rules,
  };
}

function bindings(value: JsonValue, path: string): RstepLayerBinding[] {
  const result = array(value, path).map((item, index) => {
    const itemPath = `${path}[${index}]`;
    const record = object(item, itemPath, ["layer_id", "revision", "enabled"]);
    if (typeof record.enabled !== "boolean") fail(`${itemPath}.enabled`, "must be boolean");
    return {
      layer_id: text(record.layer_id, `${itemPath}.layer_id`),
      revision: text(record.revision, `${itemPath}.revision`),
      enabled: record.enabled,
    };
  });
  unique(result.map(bindingKey), path, "layer revision");
  return result;
}

function parseRule(value: JsonValue, path: string): RstepRule {
  const rule = object(value, path, [
    "id",
    "revision",
    "name",
    "basis",
    "technology",
    "jurisdictions",
    "layer_id",
    "layer_revision",
    "geometry_operation",
    "buffer_metres",
    "treatment",
    "project_requirements",
    "exceptions",
    "citation",
    "limitations",
  ]);
  const geometryOperation = oneOf(
    rule.geometry_operation,
    ["overlap", "buffer_overlap"],
    `${path}.geometry_operation`,
  );
  if (geometryOperation === "buffer_overlap")
    fail(`${path}.geometry_operation`, "buffer_overlap is not supported by scenario schema v1");
  literal(rule.buffer_metres, null, `${path}.buffer_metres`);
  const basis = oneOf(
    rule.basis,
    [
      "verified_legal_prohibition",
      "permit_or_compatibility_review",
      "engineering_screen",
      "economic_assumption",
      "custodian_or_scenario_avoidance",
      "context_or_opportunity",
      "unknown_or_conflict",
    ],
    `${path}.basis`,
  ) as RuleBasis;
  const treatment = oneOf(
    rule.treatment,
    ["exclude", "review", "avoid", "context"],
    `${path}.treatment`,
  ) as RuleTreatment;
  if (basis === "context_or_opportunity" && treatment !== "context")
    fail(`${path}.treatment`, "context basis must use context treatment");
  if (
    (basis === "permit_or_compatibility_review" || basis === "unknown_or_conflict") &&
    treatment === "exclude"
  ) {
    fail(`${path}.treatment`, `${basis} cannot assert an exclusion`);
  }
  const technologies = stringsFromSet(
    rule.technology,
    ["wind", "solar"],
    `${path}.technology`,
  ) as RstepTechnology[];
  const jurisdictions = stringsFromSet(
    rule.jurisdictions,
    ["WA", "OR", "ID"],
    `${path}.jurisdictions`,
  ) as RstepJurisdiction[];
  const limitations = stringArray(rule.limitations, `${path}.limitations`);
  if (limitations.length === 0) fail(`${path}.limitations`, "must state at least one limitation");
  return {
    id: text(rule.id, `${path}.id`),
    revision: text(rule.revision, `${path}.revision`),
    name: text(rule.name, `${path}.name`),
    basis,
    technology: technologies,
    jurisdictions,
    layer_id: text(rule.layer_id, `${path}.layer_id`),
    layer_revision: text(rule.layer_revision, `${path}.layer_revision`),
    geometry_operation: "overlap",
    buffer_metres: null,
    treatment,
    project_requirements: predicates(rule.project_requirements, `${path}.project_requirements`),
    exceptions: predicates(rule.exceptions, `${path}.exceptions`),
    citation: text(rule.citation, `${path}.citation`),
    limitations,
  };
}

function predicates(value: JsonValue, path: string): RulePredicate[] {
  return array(value, path).map((item, index) => {
    const itemPath = `${path}[${index}]`;
    const predicate = object(item, itemPath, ["field", "operator", "value"]);
    if (!["string", "number", "boolean"].includes(typeof predicate.value))
      fail(`${itemPath}.value`, "must be string, number or boolean");
    return {
      field: text(predicate.field, `${itemPath}.field`),
      operator: oneOf(
        predicate.operator,
        ["equals", "gte", "lte"],
        `${itemPath}.operator`,
      ) as RulePredicate["operator"],
      value: predicate.value as RulePredicate["value"],
    };
  });
}

function polygon(value: JsonValue, path: string): Polygon | MultiPolygon {
  try {
    return requirePolygonalGeometry(value, path);
  } catch (error) {
    fail(path, error instanceof Error ? error.message : "must be polygonal");
  }
}
function bindingKey(binding: Pick<RstepLayerBinding, "layer_id" | "revision">): string {
  return JSON.stringify([binding.layer_id, binding.revision]);
}
function unique(values: string[], path: string, label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) fail(path, `duplicate ${label} ${value}`);
    seen.add(value);
  }
}
function stringsFromSet(value: JsonValue, allowed: readonly string[], path: string): string[] {
  const result = array(value, path).map((item, index) => oneOf(item, allowed, `${path}[${index}]`));
  if (result.length === 0) fail(path, "must not be empty");
  unique(result, path, "value");
  return result;
}
function object<const K extends readonly string[]>(
  value: JsonValue,
  path: string,
  keys: K,
): JsonObject & { [P in K[number]]: JsonValue };
function object(value: JsonValue, path: string): JsonObject;
function object(value: JsonValue, path: string, keys?: readonly string[]): JsonObject {
  if (!isJsonObject(value)) fail(path, "must be an object");
  if (keys !== undefined) exactKeys(value, keys, path);
  return value;
}
function exactKeys(value: JsonObject, keys: readonly string[], path: string): void {
  const actual = Object.keys(value).sort(),
    expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    fail(path, "has missing or unexpected fields");
}
function array(value: JsonValue, path: string): JsonValue[] {
  if (!Array.isArray(value)) fail(path, "must be an array");
  return value;
}
function text(value: JsonValue, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) fail(path, "must be non-empty text");
  return value;
}
function stringArray(value: JsonValue, path: string): string[] {
  return array(value, path).map((item, index) => text(item, `${path}[${index}]`));
}
function oneOf(value: JsonValue, allowed: readonly string[], path: string): string {
  if (typeof value !== "string" || !allowed.includes(value))
    fail(path, `must be one of ${allowed.join(", ")}`);
  return value;
}
function literal<T extends JsonValue>(value: JsonValue, expected: T, path: string): T {
  if (value !== expected) fail(path, `must equal ${String(expected)}`);
  return expected;
}
function fail(path: string, message: string): never {
  throw new RstepScenarioError(path, message);
}
