import type { Feature, MultiPolygon, Polygon } from "geojson";
import { assertDevelopmentBypassState, type DevelopmentBypassState } from "../shared/governance";
import type { JsonObject, JsonValue } from "../shared/json";
import { isJsonObject, isJsonValue } from "../shared/json";
import { stableStringify } from "../shared/stable-json";
import type { AnalysisReason, AnalysisResult, OpportunityState } from "./analysis";
import { isSupportedCrs, type SupportedCrsCode, transformGeometry } from "./crs";
import {
  ATNI_GEOJSON_SCHEMA_VERSION,
  type AtniFeatureCollection,
  type ImportedGeoJsonLayer,
  importAtniGeoJson,
  serializeAtniGeoJson,
} from "./geojson";
import { assertValidGeometry } from "./geometry";
import type { TsdfSource } from "./governance/tsdf-source.js";
import { sha256Hex } from "./hash";
import {
  assertTransformationChain,
  type CoordinateTransformationRecord,
  type LayerMetadata,
  parseLayerMetadata,
} from "./layer";
import {
  type CandidatePolygon,
  type ProjectDocument,
  type ProjectLayerReference,
  type ProjectWaTribalContextBinding,
  parseProjectWaTribalContextBinding,
  type Scenario,
} from "./project";

export interface OpportunityExportFeature {
  analysis_state: OpportunityState;
  attributes: JsonObject;
  geometry: MultiPolygon | Polygon;
  id: string;
  name: string;
  reason_trace: AnalysisReason[];
  source_crs: SupportedCrsCode;
}

export interface OpportunityExportBinding {
  generated_at: string;
  generated_by: OpportunityExportGenerator;
  governance: DevelopmentBypassState;
  project: {
    name: string;
    project_id: string;
    updated_at: string;
  };
  scenario: Scenario;
  source_layers: ProjectLayerReference[];
  wa_tribal_context: ProjectWaTribalContextBinding | null;
}

export interface OpportunityExportGenerator {
  application_commit: string;
  application_version: string;
}

export interface OpportunityExportGeneratorInput {
  applicationCommit: string;
  applicationVersion: string;
}

export interface OpportunityExport {
  bytes: Uint8Array;
  document: AtniFeatureCollection;
  sha256: string;
  text: string;
}

export interface ImportedOpportunityExport extends ImportedGeoJsonLayer {
  readonly binding: OpportunityExportBinding;
}

export interface ExportOpportunityInput {
  features: OpportunityExportFeature[];
  generatedAt: string;
  generatedBy: OpportunityExportGeneratorInput;
  project: ProjectDocument;
  scenarioId: string;
  /** Required whenever a WA/Tribal binding is present; artifact-supplied tier semantics are untrusted. */
  trustedTsdfSource?: TsdfSource;
}

export type RoundTripMismatchKind =
  | "attributes"
  | "bypass"
  | "crs"
  | "geometry"
  | "provenance"
  | "scenario"
  | "wa_tribal_context";

export interface RoundTripMismatch {
  kind: RoundTripMismatchKind;
  message: string;
}

export interface RoundTripComparison {
  equivalent: boolean;
  mismatches: RoundTripMismatch[];
}

const RESERVED_ATTRIBUTE_NAMES = new Set([
  "analysis_state",
  "atni_feature_id",
  "atni_feature_name",
  "atni_project_id",
  "atni_scenario_id",
  "reason_trace",
]);

/** Exports selected opportunity polygons with inseparable project/scenario/provenance metadata. */
export async function exportOpportunityGeoJson(input: ExportOpportunityInput): Promise<OpportunityExport> {
  const scenario = input.project.scenarios.find((member) => member.id === input.scenarioId);
  if (scenario === undefined) {
    throw new Error(`scenario ${input.scenarioId} does not exist in project ${input.project.project_id}`);
  }
  requireTimestamp(input.generatedAt, "generatedAt");
  const generatedBy: OpportunityExportGenerator = {
    application_commit: requireNonEmpty(input.generatedBy.applicationCommit, "generatedBy.applicationCommit"),
    application_version: requireNonEmpty(
      input.generatedBy.applicationVersion,
      "generatedBy.applicationVersion",
    ),
  };
  if (input.features.length === 0) {
    throw new Error("opportunity export requires at least one feature");
  }
  const waTribalContext = parseExportableWaTribalContext(
    input.project.wa_tribal_context,
    "project.wa_tribal_context",
    input.trustedTsdfSource,
  );

  const sourceCrs = requireCommonSourceCrs(input.features);
  const transformations: CoordinateTransformationRecord[] =
    sourceCrs === "EPSG:4326"
      ? []
      : [
          {
            operation: "proj4",
            performed_at: input.generatedAt,
            preserves_extra_dimensions: true,
            reason: "GeoJSON opportunity interoperability export",
            source_crs: sourceCrs,
            target_crs: "EPSG:4326",
          },
        ];

  const layerMetadata: LayerMetadata = {
    absence_semantics: {
      missing: "unknown; never interpreted as suitable or zero",
      outside_coverage: "not analyzed",
      zero: "explicit numeric zero retained from analysis",
    },
    authoritative_source_crs: sourceCrs,
    id: `opportunity-${input.project.project_id}-${scenario.id}`,
    name: `${input.project.name} — ${scenario.name} opportunity export`,
    native_resolution: {
      description: "Authored and derived vector boundaries; no scalar raster resolution applies",
      unit: "not_applicable",
      value: null,
    },
    provenance: {
      acquired_at: input.generatedAt,
      license:
        "UNLICENSED derived development artifact; attached source restrictions continue to apply and no public distribution grant is made",
      limitations: [
        "Development build output; sovereignty controls were not enforced and public distribution is forbidden.",
        "Decision-support result only; source limitations remain attached in export_binding.source_layers.",
      ],
      source_organization: "ATNI GeoBase local development application",
      source_sha256: null,
      source_title: `${input.project.name} / ${scenario.name} opportunity result`,
      source_uri: null,
      synthetic: input.project.layers.every((layer) => layer.metadata.provenance.synthetic),
    },
    role: "opportunity_result",
    source_custody: aggregateSourceCustody(input.project.layers),
    transformations,
    uncertainty: {
      description:
        "Carries model states and rule traces; no independent quantitative uncertainty was calculated for the vector boundaries.",
      quantitative_attribute: null,
      representation: "not_quantified",
    },
    units: {
      quantity: "opportunity analysis state",
      unit: "categorical",
    },
  };

  const binding: OpportunityExportBinding = {
    generated_at: input.generatedAt,
    generated_by: generatedBy,
    governance: input.project.governance,
    project: {
      name: input.project.name,
      project_id: input.project.project_id,
      updated_at: input.project.updated_at,
    },
    scenario,
    source_layers: input.project.layers,
    wa_tribal_context: waTribalContext,
  };

  const features: Feature<MultiPolygon | Polygon>[] = input.features
    .map((feature) => buildFeature(feature, input.project, scenario, sourceCrs))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const document: AtniFeatureCollection = {
    atni_geobase: {
      artifact_kind: "opportunity_export",
      coordinate_reference_system: "EPSG:4326",
      export_binding: binding as unknown as JsonObject,
      layer: layerMetadata,
      schema_version: ATNI_GEOJSON_SCHEMA_VERSION,
    },
    features,
    type: "FeatureCollection",
  };

  const bytes = serializeAtniGeoJson(document);
  return {
    bytes,
    document,
    sha256: await sha256Hex(bytes),
    text: new TextDecoder().decode(bytes),
  };
}

/** Re-imports and independently validates the export-only metadata binding. */
export async function importOpportunityGeoJson(
  bytes: Uint8Array,
  trustedTsdfSource?: TsdfSource,
): Promise<ImportedOpportunityExport> {
  const imported = await importAtniGeoJson(bytes);
  if (imported.metadata.artifact_kind !== "opportunity_export") {
    throw new Error(`expected opportunity_export, received ${imported.metadata.artifact_kind}`);
  }
  if (imported.metadata.layer.role !== "opportunity_result") {
    throw new Error(
      `opportunity export layer role must be opportunity_result, received ${imported.metadata.layer.role}`,
    );
  }
  const binding = parseExportBinding(imported.metadata.export_binding, trustedTsdfSource);
  for (const [index, feature] of imported.document.features.entries()) {
    if (!isJsonObject(feature.properties)) {
      throw new Error(`features[${index}].properties must be an object`);
    }
    if (feature.properties.atni_project_id !== binding.project.project_id) {
      throw new Error(`features[${index}] project linkage contradicts export binding`);
    }
    if (feature.properties.atni_scenario_id !== binding.scenario.id) {
      throw new Error(`features[${index}] scenario linkage contradicts export binding`);
    }
  }
  return { ...imported, binding };
}

/**
 * Compares behavior-bearing round-trip claims independently: geometry, attributes,
 * CRS/history, provenance custody, scenario linkage, and bypass facts.
 */
export function compareOpportunityRoundTrip(
  expected: AtniFeatureCollection,
  imported: ImportedOpportunityExport,
  trustedTsdfSource?: TsdfSource,
): RoundTripComparison {
  const mismatches: RoundTripMismatch[] = [];
  const expectedBinding = parseExportBinding(expected.atni_geobase.export_binding, trustedTsdfSource);
  comparePart(
    "geometry",
    expected.features.map((feature) => ({ id: feature.id, geometry: feature.geometry })),
    imported.document.features.map((feature) => ({ id: feature.id, geometry: feature.geometry })),
    mismatches,
  );
  comparePart(
    "attributes",
    expected.features.map((feature) => ({ id: feature.id, properties: feature.properties })),
    imported.document.features.map((feature) => ({ id: feature.id, properties: feature.properties })),
    mismatches,
  );
  comparePart(
    "crs",
    {
      coordinate_reference_system: expected.atni_geobase.coordinate_reference_system,
      authoritative_source_crs: expected.atni_geobase.layer.authoritative_source_crs,
      transformations: expected.atni_geobase.layer.transformations,
    },
    {
      coordinate_reference_system: imported.metadata.coordinate_reference_system,
      authoritative_source_crs: imported.metadata.layer.authoritative_source_crs,
      transformations: imported.metadata.layer.transformations,
    },
    mismatches,
  );
  comparePart(
    "provenance",
    {
      layer_metadata: expected.atni_geobase.layer,
      source_layers: expectedBinding.source_layers,
    },
    {
      layer_metadata: imported.metadata.layer,
      source_layers: imported.binding.source_layers,
    },
    mismatches,
  );
  comparePart(
    "scenario",
    {
      generated_at: expectedBinding.generated_at,
      generated_by: expectedBinding.generated_by,
      project: expectedBinding.project,
      scenario: expectedBinding.scenario,
    },
    {
      generated_at: imported.binding.generated_at,
      generated_by: imported.binding.generated_by,
      project: imported.binding.project,
      scenario: imported.binding.scenario,
    },
    mismatches,
  );
  comparePart("bypass", expectedBinding.governance, imported.binding.governance, mismatches);
  comparePart(
    "wa_tribal_context",
    expectedBinding.wa_tribal_context,
    imported.binding.wa_tribal_context,
    mismatches,
  );

  return { equivalent: mismatches.length === 0, mismatches };
}

export function analysisResultToOpportunityFeature(
  result: AnalysisResult,
  sourceCrs: SupportedCrsCode,
): OpportunityExportFeature {
  return {
    analysis_state: result.state,
    attributes: {
      ...result.source_properties,
      adjusted_value: result.adjusted_value,
      penalty_fraction: result.penalty_fraction,
      resource_value: result.resource_value,
    },
    geometry: result.geometry,
    id: result.feature_id,
    name: result.feature_id,
    reason_trace: result.reasons,
    source_crs: sourceCrs,
  };
}

export function candidateToOpportunityFeature(
  candidate: CandidatePolygon,
  state: OpportunityState,
  reasons: AnalysisReason[],
): OpportunityExportFeature {
  return {
    analysis_state: state,
    attributes: candidate.properties,
    geometry: candidate.geometry,
    id: candidate.id,
    name: candidate.name,
    reason_trace: reasons,
    source_crs: candidate.coordinate_reference_system,
  };
}

function buildFeature(
  input: OpportunityExportFeature,
  project: ProjectDocument,
  scenario: Scenario,
  commonSourceCrs: SupportedCrsCode,
): Feature<MultiPolygon | Polygon> {
  requireNonEmpty(input.id, "feature.id");
  requireNonEmpty(input.name, "feature.name");
  if (!isJsonObject(input.attributes)) {
    throw new Error(`feature ${input.id} attributes must be a JSON object`);
  }
  for (const key of Object.keys(input.attributes)) {
    if (RESERVED_ATTRIBUTE_NAMES.has(key) || key.startsWith("atni_")) {
      throw new Error(`feature ${input.id} attribute ${key} is reserved for export custody metadata`);
    }
  }
  assertValidGeometry(input.geometry, input.source_crs);
  const transformed =
    commonSourceCrs === "EPSG:4326"
      ? input.geometry
      : (transformGeometry(input.geometry, commonSourceCrs, "EPSG:4326") as MultiPolygon | Polygon);
  assertValidGeometry(transformed, "EPSG:4326");

  return {
    geometry: transformed,
    id: input.id,
    properties: {
      ...input.attributes,
      analysis_state: input.analysis_state,
      atni_feature_id: input.id,
      atni_feature_name: input.name,
      atni_project_id: project.project_id,
      atni_scenario_id: scenario.id,
      reason_trace: input.reason_trace as unknown as JsonValue,
    },
    type: "Feature",
  };
}

function requireCommonSourceCrs(features: readonly OpportunityExportFeature[]): SupportedCrsCode {
  const sourceCrs = features[0]?.source_crs;
  if (sourceCrs === undefined) {
    throw new Error("opportunity export requires at least one feature");
  }
  for (const feature of features) {
    if (feature.source_crs !== sourceCrs) {
      throw new Error(
        `opportunity export mixes ${sourceCrs} and ${feature.source_crs}; explicitly transform features to one CRS first`,
      );
    }
  }
  return sourceCrs;
}

function aggregateSourceCustody(layers: readonly ProjectLayerReference[]): LayerMetadata["source_custody"] {
  const mapField = (field: keyof LayerMetadata["source_custody"]): JsonValue =>
    layers.map((layer) => ({
      layer_id: layer.metadata.id,
      value: layer.metadata.source_custody[field],
    }));
  return {
    consent: mapField("consent"),
    governance: mapField("governance"),
    ownership: mapField("ownership"),
    source_classification: mapField("source_classification"),
  };
}

function parseExportBinding(
  value: JsonObject | null,
  trustedTsdfSource?: TsdfSource,
): OpportunityExportBinding {
  if (!isJsonObject(value)) {
    throw new Error("opportunity export requires an in-artifact export_binding object");
  }
  requireExactKeys(
    value,
    [
      "generated_at",
      "generated_by",
      "governance",
      "project",
      "scenario",
      "source_layers",
      "wa_tribal_context",
    ],
    "export_binding",
  );
  requireTimestamp(value.generated_at, "export_binding.generated_at");
  if (!isJsonObject(value.generated_by)) {
    throw new Error("export_binding.generated_by must be an object");
  }
  requireExactKeys(
    value.generated_by,
    ["application_commit", "application_version"],
    "export_binding.generated_by",
  );
  const generatedBy: OpportunityExportGenerator = {
    application_commit: requireNonEmpty(
      value.generated_by.application_commit,
      "export_binding.generated_by.application_commit",
    ),
    application_version: requireNonEmpty(
      value.generated_by.application_version,
      "export_binding.generated_by.application_version",
    ),
  };
  assertDevelopmentBypassState(value.governance);

  if (!isJsonObject(value.project)) {
    throw new Error("export_binding.project must be an object");
  }
  requireExactKeys(value.project, ["name", "project_id", "updated_at"], "export_binding.project");
  const project = {
    name: requireNonEmpty(value.project.name, "export_binding.project.name"),
    project_id: requireNonEmpty(value.project.project_id, "export_binding.project.project_id"),
    updated_at: requireTimestamp(value.project.updated_at, "export_binding.project.updated_at"),
  };

  const scenarioValue = value.scenario;
  if (scenarioValue === undefined) {
    throw new Error("export_binding.scenario is missing");
  }
  const scenario = parseScenarioSnapshot(scenarioValue);
  if (!Array.isArray(value.source_layers)) {
    throw new Error("export_binding.source_layers must be an array");
  }
  const sourceLayers = value.source_layers.map((member, index) =>
    parseSourceLayerSnapshot(member, `export_binding.source_layers[${index}]`),
  );
  const waTribalContext = parseExportableWaTribalContext(
    value.wa_tribal_context,
    "export_binding.wa_tribal_context",
    trustedTsdfSource,
  );

  return {
    generated_at: value.generated_at as string,
    generated_by: generatedBy,
    governance: value.governance as unknown as DevelopmentBypassState,
    project,
    scenario,
    source_layers: sourceLayers,
    wa_tribal_context: waTribalContext,
  };
}

function parseExportableWaTribalContext(
  value: unknown,
  path: string,
  trustedTsdfSource?: TsdfSource,
): ProjectWaTribalContextBinding | null {
  if (value === null) return null;
  const context = parseProjectWaTribalContextBinding(value, path);
  if (trustedTsdfSource === undefined) {
    throw new Error(`${path} requires a trusted TSDF source before export or import`);
  }
  if (
    stableStringify(context.custody.classification.tsdf_source as unknown as JsonValue, false) !==
    stableStringify(trustedTsdfSource.record as unknown as JsonValue, false)
  ) {
    throw new Error(`${path} embedded TSDF source does not match the trusted authority`);
  }
  const tier = trustedTsdfSource.effectiveTier(context.custody.classification.source_tier_ids);
  if (tier.id !== context.custody.classification.effective_tier_id) {
    throw new Error(`${path} effective tier does not match the trusted TSDF resolution`);
  }
  if (!tier.behavior.export_allowed) {
    throw new Error(`${path} effective tier ${tier.id} forbids export under the trusted TSDF behavior`);
  }
  return context;
}

function parseScenarioSnapshot(value: JsonValue): Scenario {
  if (!isJsonObject(value)) throw new Error("export_binding.scenario must be an object");
  requireExactKeys(
    value,
    ["hard_exclusions", "id", "name", "resource_layer_id", "resource_value_property", "soft_constraints"],
    "export_binding.scenario",
  );
  if (!Array.isArray(value.hard_exclusions) || !Array.isArray(value.soft_constraints)) {
    throw new Error("export_binding scenario rule settings must be arrays");
  }
  // The project parser owns detailed scenario validation. Here we enforce JSON shape
  // and required linkage while preserving every setting byte-for-byte.
  requireNonEmpty(value.id, "export_binding.scenario.id");
  requireNonEmpty(value.name, "export_binding.scenario.name");
  requireNonEmpty(value.resource_layer_id, "export_binding.scenario.resource_layer_id");
  requireNonEmpty(value.resource_value_property, "export_binding.scenario.resource_value_property");
  return value as unknown as Scenario;
}

function parseSourceLayerSnapshot(value: JsonValue, path: string): ProjectLayerReference {
  if (!isJsonObject(value)) throw new Error(`${path} must be an object`);
  requireExactKeys(
    value,
    ["artifact_reference", "artifact_sha256", "coordinate_reference_system", "metadata"],
    path,
  );
  const digest = requireNonEmpty(value.artifact_sha256, `${path}.artifact_sha256`);
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error(`${path}.artifact_sha256 must be 64 lowercase hexadecimal characters`);
  }
  if (!isSupportedCrs(value.coordinate_reference_system)) {
    throw new Error(`${path}.coordinate_reference_system must be a supported exact EPSG identifier`);
  }
  const metadata = parseLayerMetadata(value.metadata, `${path}.metadata`);
  assertTransformationChain(metadata, value.coordinate_reference_system, `${path}.metadata.transformations`);
  return {
    artifact_reference: requireNonEmpty(value.artifact_reference, `${path}.artifact_reference`),
    artifact_sha256: digest,
    coordinate_reference_system: value.coordinate_reference_system,
    metadata,
  };
}

function comparePart(
  kind: RoundTripMismatchKind,
  expected: unknown,
  actual: unknown,
  mismatches: RoundTripMismatch[],
): void {
  if (!isJsonValue(expected) || !isJsonValue(actual)) {
    mismatches.push({ kind, message: `${kind} contains a non-JSON value` });
    return;
  }
  if (stableStringify(expected, false) !== stableStringify(actual, false)) {
    mismatches.push({ kind, message: `${kind} changed during export/re-import` });
  }
}

function requireExactKeys(value: JsonObject, expected: readonly string[], path: string): void {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (keys.length !== sortedExpected.length || keys.some((key, index) => key !== sortedExpected[index])) {
    throw new Error(`${path} has missing or unexpected fields`);
  }
}

function requireNonEmpty(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function requireTimestamp(value: unknown, path: string): string {
  const timestamp = requireNonEmpty(value, path);
  const date = new Date(timestamp);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== timestamp) {
    throw new Error(`${path} must be a canonical UTC ISO-8601 timestamp`);
  }
  return timestamp;
}
