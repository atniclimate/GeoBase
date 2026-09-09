import type { JsonObject, JsonValue } from "../../shared/json.js";
import { isJsonObject } from "../../shared/json.js";
import { parseJson, stableStringify } from "../../shared/stable-json.js";
import { sha256Text } from "../hash.js";
import { parseSourceLayer } from "../source-layer/parser.js";
import type { ParsedSourceLayer } from "../source-layer/types.js";
import { evaluateScreening } from "./engine.js";
import { createScenario } from "./scenario.js";
import {
  RSTEP_LIMITS,
  RSTEP_SIDECAR_SCHEMA_VERSION,
  type CreateSidecarInput,
  type LayerSnapshot,
  type OverlayMutationInput,
  type OverlayPermission,
  type OverlaySnapshot,
  type RstepScenario,
  type RstepSidecar,
  type ScreeningResult,
  type SidecarContentDigest,
} from "./types.js";

const WARNING = "DEVELOPMENT BUILD - SOVEREIGNTY CONTROLS NOT ENFORCED" as const;

export class RstepSidecarError extends Error {
  public readonly path: string;
  public constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "RstepSidecarError";
    this.path = path;
  }
}

export async function createSidecar(input: CreateSidecarInput): Promise<RstepSidecar> {
  const validatedLayers = await Promise.all(input.layers.map(validateParsedInput));
  const validatedOverlays = await Promise.all(
    input.overlays.map(async ({ layer, permission }) => ({
      layer: await validateParsedInput(layer),
      permission,
    })),
  );
  const layers = validatedLayers.map(snapshot);
  const overlays = validatedOverlays.map(({ layer, permission }) => overlaySnapshot(layer, permission));
  const scenarios = input.scenarios.map(createScenario);
  unique(
    scenarios.map((scenario) => scenario.id),
    "scenarios",
    "scenario id",
  );
  const active = scenarios.find((scenario) => scenario.id === input.activeScenarioId);
  if (active === undefined) fail("active_scenario_id", "does not identify an embedded scenario");
  validateDistinctSnapshots(layers, overlays);
  validateActiveBindings(scenarios, input.activeScenarioId, layers, overlays);
  validateAggregateLimits(
    validatedLayers,
    validatedOverlays.map((item) => item.layer),
  );
  const stableResult = input.stableResult === undefined ? null : bindResult(active, input.stableResult);
  const sidecar: RstepSidecar = {
    schema_version: RSTEP_SIDECAR_SCHEMA_VERSION,
    project_sha256: input.projectSha256 === null ? null : digest(input.projectSha256, "project_sha256"),
    governance: {
      governance_mode: "development_bypass",
      governance_enforced: false,
      public_distribution_allowed: false,
      warning: WARNING,
    },
    layers,
    overlays,
    scenarios,
    active_scenario_id: input.activeScenarioId,
    stable_result: stableResult,
    stale_result: null,
  };
  if (stableResult !== null) {
    const replayed = await replaySidecar(sidecar);
    if (replayed.result_id !== stableResult.result_id)
      fail("stable_result", "does not match deterministic replay");
  }
  validateSerializedSize(sidecar);
  return sidecar;
}

export function serializeSidecar(sidecar: RstepSidecar): string {
  return stableStringify(sidecar as unknown as JsonValue);
}

export async function parseSidecar(text: string): Promise<RstepSidecar> {
  if (new TextEncoder().encode(text).byteLength > RSTEP_LIMITS.sidecarBytes) {
    fail("sidecar", `JSON exceeds ${RSTEP_LIMITS.sidecarBytes} bytes`);
  }
  const value = parseJson(text);
  if (!isJsonObject(value)) fail("sidecar", "must be an object");
  const sidecar = await parseSidecarValue(value);
  const replayed = await replaySidecar(sidecar);
  if (sidecar.stable_result !== null && replayed.result_id !== sidecar.stable_result.result_id) {
    fail("stable_result", "does not match deterministic replay");
  }
  return sidecar;
}

export async function replaySidecar(sidecar: RstepSidecar): Promise<ScreeningResult> {
  const active = sidecar.scenarios.find((scenario) => scenario.id === sidecar.active_scenario_id);
  if (active === undefined) fail("active_scenario_id", "does not identify an embedded scenario");
  const layers = await Promise.all([...sidecar.layers, ...sidecar.overlays].map(parseSnapshot));
  return evaluateScreening({ aoi: active.aoi, scenario: active, layers });
}

export function sidecarContentDigests(sidecar: RstepSidecar): SidecarContentDigest[] {
  return [
    ...sidecar.layers.map((item) => ({
      kind: "layer" as const,
      layer_id: item.layer_id,
      revision: item.revision,
      sha256: item.sha256,
    })),
    ...sidecar.overlays.map((item) => ({
      kind: "overlay" as const,
      layer_id: item.layer_id,
      revision: item.revision,
      sha256: item.sha256,
    })),
  ].sort((left, right) =>
    compare(
      `${left.kind}:${left.layer_id}@${left.revision}`,
      `${right.kind}:${right.layer_id}@${right.revision}`,
    ),
  );
}

export async function addOverlay(sidecar: RstepSidecar, input: OverlayMutationInput): Promise<RstepSidecar> {
  if (sidecar.overlays.some((item) => item.layer_id === input.layer.document.layer_id)) {
    fail("overlays", `layer ${input.layer.document.layer_id} already exists; use explicit replacement`);
  }
  const next = clone(sidecar);
  next.overlays.push(overlaySnapshot(input.layer, input.permission));
  next.overlays.sort(snapshotCompare);
  markStale(next, "overlay_added");
  validateDistinctSnapshots(next.layers, next.overlays);
  await validateMutationLimits(next);
  return next;
}

export async function replaceOverlay(
  sidecar: RstepSidecar,
  input: OverlayMutationInput,
): Promise<RstepSidecar> {
  const index = sidecar.overlays.findIndex((item) => item.layer_id === input.layer.document.layer_id);
  if (index < 0)
    fail("overlays", `layer ${input.layer.document.layer_id} cannot be replaced because it is absent`);
  const prior = sidecar.overlays[index] as OverlaySnapshot;
  if (prior.revision === input.layer.document.revision && prior.sha256 !== input.layer.exactSha256)
    fail(
      "overlays",
      `layer ${input.layer.document.layer_id} uses the same revision with different exact bytes; assign a new revision`,
    );
  const next = clone(sidecar);
  next.overlays[index] = overlaySnapshot(input.layer, input.permission);
  next.overlays.sort(snapshotCompare);
  markStale(next, "overlay_replaced");
  validateDistinctSnapshots(next.layers, next.overlays);
  await validateMutationLimits(next);
  return next;
}

export function removeOverlay(sidecar: RstepSidecar, layerId: string): RstepSidecar {
  const next = clone(sidecar);
  const retained = next.overlays.filter((item) => item.layer_id !== layerId);
  if (retained.length === next.overlays.length) fail("overlays", `layer ${layerId} is absent`);
  next.overlays = retained;
  markStale(next, "overlay_removed");
  return next;
}

export function editScenario(sidecar: RstepSidecar, value: unknown): RstepSidecar {
  const scenario = createScenario(value);
  const next = clone(sidecar);
  const index = next.scenarios.findIndex((item) => item.id === scenario.id);
  if (index < 0) next.scenarios.push(scenario);
  else {
    const prior = next.scenarios[index] as RstepScenario;
    if (
      prior.revision === scenario.revision &&
      stableStringify(prior as unknown as JsonValue, false) !==
        stableStringify(scenario as unknown as JsonValue, false)
    )
      fail(
        "scenarios",
        `same scenario revision ${scenario.id}@${scenario.revision} has different content; assign a new revision or id`,
      );
    next.scenarios[index] = scenario;
  }
  next.scenarios.sort((left, right) =>
    compare(`${left.id}@${left.revision}`, `${right.id}@${right.revision}`),
  );
  unique(
    next.scenarios.map((item) => item.id),
    "scenarios",
    "scenario id",
  );
  if (scenario.id === next.active_scenario_id)
    validateActiveBindings(next.scenarios, next.active_scenario_id, next.layers, next.overlays);
  markStale(next, "rule_or_scenario_edited");
  validateSerializedSize(next);
  return next;
}

export function selectScenario(sidecar: RstepSidecar, scenarioId: string): RstepSidecar {
  const next = clone(sidecar);
  if (!next.scenarios.some((scenario) => scenario.id === scenarioId))
    fail("active_scenario_id", `scenario ${scenarioId} is absent`);
  next.active_scenario_id = scenarioId;
  validateActiveBindings(next.scenarios, scenarioId, next.layers, next.overlays);
  markStale(next, "rule_or_scenario_edited");
  validateSerializedSize(next);
  return next;
}

export function attachScreeningResult(sidecar: RstepSidecar, result: ScreeningResult): RstepSidecar {
  const active = sidecar.scenarios.find((scenario) => scenario.id === sidecar.active_scenario_id);
  if (active === undefined) fail("active_scenario_id", "does not identify an embedded scenario");
  const next = clone(sidecar);
  next.stable_result = bindResult(active, result);
  next.stale_result = null;
  return next;
}

async function parseSidecarValue(value: JsonObject): Promise<RstepSidecar> {
  const root = object(value, "sidecar", [
    "schema_version",
    "project_sha256",
    "governance",
    "layers",
    "overlays",
    "scenarios",
    "active_scenario_id",
    "stable_result",
    "stale_result",
  ]);
  literal(root.schema_version, RSTEP_SIDECAR_SCHEMA_VERSION, "schema_version");
  const governance = object(root.governance, "governance", [
    "governance_mode",
    "governance_enforced",
    "public_distribution_allowed",
    "warning",
  ]);
  literal(governance.governance_mode, "development_bypass", "governance.governance_mode");
  literal(governance.governance_enforced, false, "governance.governance_enforced");
  literal(governance.public_distribution_allowed, false, "governance.public_distribution_allowed");
  literal(governance.warning, WARNING, "governance.warning");
  const layers = await Promise.all(
    array(root.layers, "layers").map((item, index) => parseLayerSnapshot(item, `layers[${index}]`)),
  );
  const overlays = await Promise.all(
    array(root.overlays, "overlays").map((item, index) => parseOverlaySnapshot(item, `overlays[${index}]`)),
  );
  validateDistinctSnapshots(layers, overlays);
  const scenarios = array(root.scenarios, "scenarios").map((item, index) => {
    if (!isJsonObject(item)) fail(`scenarios[${index}]`, "must be an object");
    return createScenario(item);
  });
  unique(
    scenarios.map((item) => item.id),
    "scenarios",
    "scenario id",
  );
  const activeScenarioId = text(root.active_scenario_id, "active_scenario_id");
  if (!scenarios.some((item) => item.id === activeScenarioId))
    fail("active_scenario_id", "does not identify an embedded scenario");
  const stableResult = root.stable_result === null ? null : parseStable(root.stable_result);
  const staleResult = root.stale_result === null ? null : parseStale(root.stale_result);
  if (stableResult !== null && staleResult !== null)
    fail("sidecar", "cannot contain stable and stale result bindings together");
  const parsedLayers = await Promise.all([...layers, ...overlays].map(parseSnapshot));
  validateAggregateLimits(
    parsedLayers.filter((_, index) => index < layers.length),
    parsedLayers.filter((_, index) => index >= layers.length),
  );
  const sidecar: RstepSidecar = {
    schema_version: RSTEP_SIDECAR_SCHEMA_VERSION,
    project_sha256: root.project_sha256 === null ? null : digest(root.project_sha256, "project_sha256"),
    governance: {
      governance_mode: "development_bypass",
      governance_enforced: false,
      public_distribution_allowed: false,
      warning: WARNING,
    },
    layers,
    overlays,
    scenarios,
    active_scenario_id: activeScenarioId,
    stable_result: stableResult,
    stale_result: staleResult,
  };
  if (stableResult !== null) {
    const active = scenarios.find((scenario) => scenario.id === activeScenarioId) as RstepScenario;
    if (stableResult.scenario_id !== active.id || stableResult.scenario_revision !== active.revision)
      fail("stable_result", "must bind the active scenario revision");
  }
  validateActiveBindings(scenarios, activeScenarioId, layers, overlays);
  return sidecar;
}

async function parseLayerSnapshot(value: JsonValue, path: string): Promise<LayerSnapshot> {
  const item = object(value, path, ["layer_id", "revision", "exact_json", "sha256"]);
  const result = {
    layer_id: text(item.layer_id, `${path}.layer_id`),
    revision: text(item.revision, `${path}.revision`),
    exact_json: text(item.exact_json, `${path}.exact_json`),
    sha256: digest(item.sha256, `${path}.sha256`),
  };
  await validateSnapshot(result, path, false);
  return result;
}

async function parseOverlaySnapshot(value: JsonValue, path: string): Promise<OverlaySnapshot> {
  const item = object(value, path, ["layer_id", "revision", "exact_json", "sha256", "permission"]);
  const result = {
    layer_id: text(item.layer_id, `${path}.layer_id`),
    revision: text(item.revision, `${path}.revision`),
    exact_json: text(item.exact_json, `${path}.exact_json`),
    sha256: digest(item.sha256, `${path}.sha256`),
    permission: parsePermission(item.permission, `${path}.permission`),
  };
  await validateSnapshot(result, path, true);
  return result;
}

async function validateSnapshot(item: LayerSnapshot, path: string, overlay: boolean): Promise<void> {
  if ((await sha256Text(item.exact_json)) !== item.sha256)
    fail(`${path}.sha256`, "does not match exact embedded JSON bytes");
  const parsed = await parseSourceLayer(item.exact_json);
  if (parsed.document.layer_id !== item.layer_id || parsed.document.revision !== item.revision)
    fail(path, "identity or revision contradicts embedded layer JSON");
  if (overlay !== (parsed.document.kind === "partner_overlay"))
    fail(
      path,
      overlay ? "must embed a partner_overlay layer" : "partner_overlay requires overlay permission metadata",
    );
}

function snapshot(layer: ParsedSourceLayer): LayerSnapshot {
  if (layer.document.kind === "partner_overlay")
    fail("layers", "partner_overlay requires overlay permission metadata");
  return {
    layer_id: layer.document.layer_id,
    revision: layer.document.revision,
    exact_json: layer.exactJson,
    sha256: layer.exactSha256,
  };
}

function overlaySnapshot(layer: ParsedSourceLayer, permission: OverlayPermission): OverlaySnapshot {
  if (layer.document.kind !== "partner_overlay") fail("overlays", "must contain only partner_overlay layers");
  return {
    ...snapshotFields(layer),
    permission: parsePermission(permission as unknown as JsonValue, "permission"),
  };
}

function snapshotFields(layer: ParsedSourceLayer): LayerSnapshot {
  return {
    layer_id: layer.document.layer_id,
    revision: layer.document.revision,
    exact_json: layer.exactJson,
    sha256: layer.exactSha256,
  };
}

async function parseSnapshot(item: LayerSnapshot): Promise<ParsedSourceLayer> {
  const parsed = await parseSourceLayer(item.exact_json);
  if (
    parsed.exactSha256 !== item.sha256 ||
    parsed.document.layer_id !== item.layer_id ||
    parsed.document.revision !== item.revision
  )
    fail("snapshot", "embedded content identity changed");
  return parsed;
}

async function validateParsedInput(input: ParsedSourceLayer): Promise<ParsedSourceLayer> {
  const parsed = await parseSourceLayer(input.exactJson);
  if (
    parsed.exactSha256 !== input.exactSha256 ||
    parsed.exactBytes !== input.exactBytes ||
    parsed.document.layer_id !== input.document.layer_id ||
    parsed.document.revision !== input.document.revision
  )
    fail("layer", "parsed object contradicts its exact retained JSON");
  return parsed;
}

function parsePermission(value: JsonValue, path: string): OverlayPermission {
  const item = object(value, path, ["status", "custodian", "intended_scope"]);
  return {
    status: oneOf(
      item.status,
      ["public_fixture_authorized", "synthetic_authorized"],
      `${path}.status`,
    ) as OverlayPermission["status"],
    custodian: text(item.custodian, `${path}.custodian`),
    intended_scope: text(item.intended_scope, `${path}.intended_scope`),
  };
}

function validateActiveBindings(
  scenarios: readonly RstepScenario[],
  activeScenarioId: string,
  layers: readonly LayerSnapshot[],
  overlays: readonly OverlaySnapshot[],
): void {
  const keys = new Set([...layers, ...overlays].map((item) => key(item.layer_id, item.revision)));
  const active = scenarios.find((scenario) => scenario.id === activeScenarioId);
  if (active === undefined) fail("active_scenario_id", "does not identify an embedded scenario");
  for (const binding of [...active.layer_bindings, ...active.overlay_bindings]) {
    if (!keys.has(key(binding.layer_id, binding.revision)))
      fail(
        `scenarios.${active.id}.binding`,
        `revision ${binding.layer_id}@${binding.revision} is not embedded`,
      );
  }
}

function validateAggregateLimits(
  layers: readonly ParsedSourceLayer[],
  overlays: readonly ParsedSourceLayer[],
): void {
  if (layers.length + overlays.length > RSTEP_LIMITS.layers)
    fail("sidecar", `exceeds ${RSTEP_LIMITS.layers} embedded layers`);
  const vertices = [...layers, ...overlays].reduce((sum, item) => sum + item.vertexCount, 0);
  if (vertices > RSTEP_LIMITS.activeVertices)
    fail("sidecar", `exceeds ${RSTEP_LIMITS.activeVertices} active vertices`);
}

async function validateMutationLimits(sidecar: RstepSidecar): Promise<void> {
  const layers = await Promise.all(sidecar.layers.map(parseSnapshot));
  const overlays = await Promise.all(sidecar.overlays.map(parseSnapshot));
  validateAggregateLimits(layers, overlays);
  validateSerializedSize(sidecar);
}

function validateSerializedSize(sidecar: RstepSidecar): void {
  if (
    new TextEncoder().encode(stableStringify(sidecar as unknown as JsonValue)).byteLength >
    RSTEP_LIMITS.sidecarBytes
  )
    fail("sidecar", `JSON exceeds ${RSTEP_LIMITS.sidecarBytes} bytes`);
}

function validateDistinctSnapshots(
  layers: readonly LayerSnapshot[],
  overlays: readonly OverlaySnapshot[],
): void {
  unique(
    [...layers, ...overlays].map((item) => key(item.layer_id, item.revision)),
    "snapshots",
    "layer revision",
  );
  unique(
    [...layers, ...overlays].map((item) => item.layer_id),
    "snapshots",
    "layer id",
  );
}

function bindResult(scenario: RstepScenario, result: ScreeningResult) {
  if (result.scenario_id !== scenario.id || result.scenario_revision !== scenario.revision)
    fail("stable_result", "scenario identity does not match active scenario");
  return {
    scenario_id: result.scenario_id,
    scenario_revision: result.scenario_revision,
    result_id: digest(result.result_id, "stable_result.result_id"),
  };
}

function parseStable(value: JsonValue) {
  const item = object(value, "stable_result", ["scenario_id", "scenario_revision", "result_id"]);
  return {
    scenario_id: text(item.scenario_id, "stable_result.scenario_id"),
    scenario_revision: text(item.scenario_revision, "stable_result.scenario_revision"),
    result_id: digest(item.result_id, "stable_result.result_id"),
  };
}

function parseStale(value: JsonValue) {
  const item = object(value, "stale_result", ["reason", "prior_result_id"]);
  return {
    reason: oneOf(
      item.reason,
      ["overlay_added", "overlay_removed", "overlay_replaced", "rule_or_scenario_edited"],
      "stale_result.reason",
    ) as NonNullable<RstepSidecar["stale_result"]>["reason"],
    prior_result_id:
      item.prior_result_id === null ? null : digest(item.prior_result_id, "stale_result.prior_result_id"),
  };
}

function markStale(sidecar: RstepSidecar, reason: NonNullable<RstepSidecar["stale_result"]>["reason"]): void {
  const prior = sidecar.stable_result?.result_id ?? sidecar.stale_result?.prior_result_id ?? null;
  sidecar.stable_result = null;
  sidecar.stale_result = { reason, prior_result_id: prior };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
function key(id: string, revision: string): string {
  return JSON.stringify([id, revision]);
}
function snapshotCompare(left: LayerSnapshot, right: LayerSnapshot): number {
  return compare(key(left.layer_id, left.revision), key(right.layer_id, right.revision));
}
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function unique(values: readonly string[], path: string, label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) fail(path, `duplicate ${label} ${value}`);
    seen.add(value);
  }
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
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index]))
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
function digest(value: JsonValue, path: string): string {
  const item = text(value, path);
  if (!/^[a-f0-9]{64}$/u.test(item)) fail(path, "must be a lowercase SHA-256 digest");
  return item;
}
function oneOf(value: JsonValue, choices: readonly string[], path: string): string {
  if (typeof value !== "string" || !choices.includes(value))
    fail(path, `must be one of ${choices.join(", ")}`);
  return value;
}
function literal<T extends JsonValue>(value: JsonValue, expected: T, path: string): T {
  if (value !== expected) fail(path, `must equal ${String(expected)}`);
  return expected;
}
function fail(path: string, message: string): never {
  throw new RstepSidecarError(path, message);
}
