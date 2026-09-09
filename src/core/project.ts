import type { MultiPolygon, Polygon } from "geojson";
import {
  assertDevelopmentBypassState,
  createDevelopmentBypassState,
  type DevelopmentBypassState,
} from "../shared/governance.js";
import type { JsonObject, JsonValue } from "../shared/json.js";
import { isJsonObject } from "../shared/json.js";
import { parseJson, stableStringify } from "../shared/stable-json.js";
import {
  createWashingtonAoiSnapshot,
  parseWashingtonGeodesicAudit,
  WASHINGTON_BUFFER_PARAMETERS,
  WASHINGTON_TECHNICAL_BUFFER_DISCLAIMER,
} from "./aoi/wa-buffer.js";
import { type BaselineBinding, parseBaselineBinding } from "./baseline/manifest.js";
import { isSupportedCrs, type SupportedCrsCode } from "./crs.js";
import type { ImportedGeoJsonLayer } from "./geojson.js";
import { assertValidGeometry, GeometryValidationError } from "./geometry.js";
import {
  assertTransformationChain,
  type LayerMetadata,
  LayerMetadataError,
  parseLayerMetadata,
} from "./layer.js";
import {
  type CoverageStatus,
  isTribalGeometryCategory,
  type NationCoverageRow,
  type NationCoverageSummary,
  type TribalGeometryCategory,
  validateNationCoverage,
} from "./tribal/coverage.js";
import { type ArtifactCustodyMetadata, parseArtifactCustodyMetadata } from "./tribal/custody.js";
import {
  type NationRegistryRecord,
  validateNationRegistry,
  WASHINGTON_FEDERALLY_RECOGNIZED_NATION_COUNT,
} from "./tribal/nation-registry.js";
import type { TribalPresentationContext } from "./tribal/presentation.js";
import type { TribalFeatureAoiRelation } from "./tribal/selection.js";

export const PROJECT_SCHEMA_VERSION = "1.2.0" as const;
export const BASELINE_PROJECT_SCHEMA_VERSION = "1.3.0" as const;

export interface ProjectLayerReference {
  /** Portable path or project-local identifier; remote and UNC references are forbidden. */
  artifact_reference: string;
  /** SHA-256 of the exact imported artifact bytes. */
  artifact_sha256: string;
  /** CRS of coordinates in the referenced artifact, distinct from its authoritative source CRS. */
  coordinate_reference_system: SupportedCrsCode;
  metadata: LayerMetadata;
}

export type ProjectLayerReferenceMismatchField =
  | "artifact_reference"
  | "artifact_sha256"
  | "coordinate_reference_system"
  | "metadata";

export interface ProjectLayerReferenceMismatch {
  field: ProjectLayerReferenceMismatchField;
  message: string;
}

export interface ProjectLayerReferenceVerification {
  mismatches: ProjectLayerReferenceMismatch[];
  verified: boolean;
}

export interface ProjectWaTribalFeatureBinding {
  category: TribalGeometryCategory;
  nation_id: string | null;
  presentation_geometry_sha256: string;
  registry_scope: "border_context" | "goia_29";
  relation: TribalFeatureAoiRelation;
  source_attributes_sha256: string;
  source_feature_id: string;
  source_geometry_sha256: string;
}

export interface ProjectWaTribalContextBinding {
  aoi: JsonObject;
  artifact_reference: string;
  artifact_sha256: string;
  coverage: readonly NationCoverageRow[];
  custody: ArtifactCustodyMetadata;
  features: readonly ProjectWaTribalFeatureBinding[];
  registry: readonly NationRegistryRecord[];
}

export type ProjectWaTribalMismatchField =
  | "aoi"
  | "artifact_reference"
  | "artifact_sha256"
  | "coverage"
  | "custody"
  | "features"
  | "registry";

export interface ProjectWaTribalContextVerification {
  mismatches: readonly { field: ProjectWaTribalMismatchField; message: string }[];
  verified: boolean;
}

export interface HardExclusionSetting {
  description: string;
  enabled: boolean;
  layer_id: string;
  rule_id: string;
}

export interface SoftConstraintSetting {
  description: string;
  enabled: boolean;
  layer_id: string;
  /** Fraction removed from the resource value when geometry intersects, from 0 through 1. */
  penalty_fraction: number;
  rule_id: string;
}

export interface Scenario {
  hard_exclusions: HardExclusionSetting[];
  id: string;
  name: string;
  resource_layer_id: string;
  resource_value_property: string;
  soft_constraints: SoftConstraintSetting[];
}

export interface CandidatePolygon {
  coordinate_reference_system: SupportedCrsCode;
  created_at: string;
  geometry: MultiPolygon | Polygon;
  id: string;
  name: string;
  properties: JsonObject;
  scenario_id: string;
  updated_at: string;
}

export type ProjectDiagnosticSeverity = "error" | "info" | "warning";

export interface ProjectDiagnostic {
  code: string;
  layer_id: string | null;
  message: string;
  severity: ProjectDiagnosticSeverity;
}

export interface ProjectDocument {
  baseline_context?: BaselineBinding;
  active_scenario_id: string;
  candidates: CandidatePolygon[];
  created_at: string;
  diagnostics: ProjectDiagnostic[];
  governance: DevelopmentBypassState;
  layers: ProjectLayerReference[];
  name: string;
  project_id: string;
  scenarios: Scenario[];
  schema_version: typeof PROJECT_SCHEMA_VERSION | typeof BASELINE_PROJECT_SCHEMA_VERSION;
  updated_at: string;
  wa_tribal_context: ProjectWaTribalContextBinding | null;
}

export interface CreateProjectInput {
  activeScenarioId: string;
  applicationCommit: string;
  applicationVersion: string;
  createdAt: string;
  layers: ProjectLayerReference[];
  name: string;
  projectId: string;
  scenarios: Scenario[];
  waTribalContext?: ProjectWaTribalContextBinding | null;
}

export interface CreateCandidateInput {
  coordinateReferenceSystem: SupportedCrsCode;
  createdAt: string;
  geometry: MultiPolygon | Polygon;
  id: string;
  name: string;
  properties?: JsonObject;
  scenarioId: string;
}

export class ProjectValidationError extends Error {
  public readonly path: string;

  public constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ProjectValidationError";
    this.path = path;
  }
}

export function createProject(input: CreateProjectInput): ProjectDocument {
  const project: ProjectDocument = {
    active_scenario_id: input.activeScenarioId,
    candidates: [],
    created_at: input.createdAt,
    diagnostics: [],
    governance: createDevelopmentBypassState({
      applicationCommit: input.applicationCommit,
      applicationVersion: input.applicationVersion,
      stampedAt: input.createdAt,
    }),
    layers: input.layers,
    name: input.name,
    project_id: input.projectId,
    scenarios: input.scenarios,
    schema_version: PROJECT_SCHEMA_VERSION,
    updated_at: input.createdAt,
    wa_tribal_context: input.waTribalContext ?? null,
  };
  return validateProject(project as unknown);
}

/** Opt-in contract version; legacy 1.2.0 documents retain their exact shape. */
export function attachProjectBaseline(
  project: ProjectDocument,
  binding: BaselineBinding,
  updatedAt: string,
): ProjectDocument {
  requireTimestamp(updatedAt, "project.updated_at");
  return validateProject({
    ...project,
    baseline_context: parseBaselineBinding(binding),
    schema_version: BASELINE_PROJECT_SCHEMA_VERSION,
    updated_at: updatedAt,
  });
}

/** Creates a non-geometry, full-custody project binding, including numeric AOI bounds. */
export function createProjectWaTribalContextBinding(
  context: TribalPresentationContext,
): ProjectWaTribalContextBinding {
  const binding: ProjectWaTribalContextBinding = {
    aoi: createWashingtonAoiSnapshot(context.aoi),
    artifact_reference: context.artifact_reference,
    artifact_sha256: context.artifact_sha256,
    coverage: structuredClone(context.coverage),
    custody: structuredClone(context.custody),
    features: context.features
      .map((feature) => ({
        category: feature.category,
        nation_id: feature.nation_id,
        presentation_geometry_sha256: feature.presentation_geometry_sha256,
        registry_scope: feature.registry_scope,
        relation: structuredClone(feature.relation),
        source_attributes_sha256: feature.source_attributes_sha256,
        source_feature_id: feature.source_feature_id,
        source_geometry_sha256: feature.source_geometry_sha256,
      }))
      .sort(compareFeatureBindings),
    registry: structuredClone(context.registry),
  };
  return parseProjectWaTribalContextBinding(binding, "wa_tribal_context");
}

/** Compares every behavior-bearing context group after a fresh package import. */
export function verifyProjectWaTribalContextBinding(
  expected: ProjectWaTribalContextBinding,
  freshContext: TribalPresentationContext,
): ProjectWaTribalContextVerification {
  const parsedExpected = parseProjectWaTribalContextBinding(expected, "wa_tribal_context");
  const fresh = createProjectWaTribalContextBinding(freshContext);
  const mismatches: { field: ProjectWaTribalMismatchField; message: string }[] = [];
  for (const field of [
    "artifact_reference",
    "artifact_sha256",
    "custody",
    "aoi",
    "features",
    "registry",
    "coverage",
  ] as const) {
    if (
      stableStringify(parsedExpected[field] as unknown as JsonValue, false) !==
      stableStringify(fresh[field] as unknown as JsonValue, false)
    ) {
      mismatches.push({ field, message: `fresh WA/Tribal ${field} does not match the project binding` });
    }
  }
  return { mismatches, verified: mismatches.length === 0 };
}

/** Attaches a freshly verified context binding without storing a machine-local source path. */
export function attachProjectWaTribalContext(
  project: ProjectDocument,
  binding: ProjectWaTribalContextBinding,
  updatedAt: string,
): ProjectDocument {
  requireTimestamp(updatedAt, "project.updated_at");
  return validateProject({
    ...project,
    updated_at: updatedAt,
    wa_tribal_context: binding,
  });
}

/** Creates a portable project reference from an imported artifact and its exact-byte digest. */
export function createProjectLayerReference(
  imported: ImportedGeoJsonLayer,
  artifactReference: string,
): ProjectLayerReference {
  const reference: ProjectLayerReference = {
    artifact_reference: artifactReference,
    artifact_sha256: imported.exact_bytes_sha256,
    coordinate_reference_system: imported.metadata.coordinate_reference_system,
    metadata: imported.metadata.layer,
  };
  validateLayerReference(reference, "layer");
  return reference;
}

/**
 * Binds a persisted reference to a freshly imported artifact. Metadata is
 * compared as canonical JSON so object insertion order cannot hide a mismatch.
 */
export function verifyProjectLayerReference(
  reference: ProjectLayerReference,
  imported: ImportedGeoJsonLayer,
  artifactReference: string,
): ProjectLayerReferenceVerification {
  const mismatches: ProjectLayerReferenceMismatch[] = [];
  if (reference.artifact_reference !== artifactReference) {
    mismatches.push({
      field: "artifact_reference",
      message: `expected artifact reference ${JSON.stringify(reference.artifact_reference)}, received ${JSON.stringify(artifactReference)}`,
    });
  }
  if (reference.artifact_sha256 !== imported.exact_bytes_sha256) {
    mismatches.push({
      field: "artifact_sha256",
      message: "freshly imported exact-byte SHA-256 does not match the persisted reference",
    });
  }
  if (reference.coordinate_reference_system !== imported.metadata.coordinate_reference_system) {
    mismatches.push({
      field: "coordinate_reference_system",
      message: `expected artifact coordinate CRS ${reference.coordinate_reference_system}, received ${imported.metadata.coordinate_reference_system}`,
    });
  }
  if (
    stableStringify(reference.metadata as unknown as JsonValue, false) !==
    stableStringify(imported.metadata.layer as unknown as JsonValue, false)
  ) {
    mismatches.push({
      field: "metadata",
      message: "freshly imported canonical layer metadata does not match the persisted reference",
    });
  }
  return { mismatches, verified: mismatches.length === 0 };
}

/** Deterministic save format: sorted object keys, semantic array order, one final LF. */
export function serializeProject(project: ProjectDocument): string {
  const validated = validateProject(project as unknown);
  return stableStringify(validated as unknown as JsonValue);
}

export function parseProject(text: string): ProjectDocument {
  let value: JsonValue;
  try {
    value = parseJson(text);
  } catch (error) {
    throw new ProjectValidationError(
      "$",
      error instanceof Error ? error.message : "project is not valid JSON",
    );
  }
  return validateProject(value);
}

/** Adds a candidate immutably; caller supplies ids/timestamps for reproducibility. */
export function createCandidate(project: ProjectDocument, input: CreateCandidateInput): ProjectDocument {
  if (project.candidates.some((candidate) => candidate.id === input.id)) {
    throw new ProjectValidationError("candidate.id", `candidate ${input.id} already exists`);
  }
  if (!project.scenarios.some((scenario) => scenario.id === input.scenarioId)) {
    throw new ProjectValidationError("candidate.scenario_id", `scenario ${input.scenarioId} does not exist`);
  }
  assertCandidateGeometry(input.geometry, input.coordinateReferenceSystem, "candidate.geometry");
  requireTimestamp(input.createdAt, "candidate.created_at");
  requireNonEmptyString(input.id, "candidate.id");
  requireNonEmptyString(input.name, "candidate.name");
  if (input.properties !== undefined && !isJsonObject(input.properties)) {
    throw new ProjectValidationError("candidate.properties", "must be a JSON object");
  }

  const candidate: CandidatePolygon = {
    coordinate_reference_system: input.coordinateReferenceSystem,
    created_at: input.createdAt,
    geometry: input.geometry,
    id: input.id,
    name: input.name,
    properties: input.properties ?? {},
    scenario_id: input.scenarioId,
    updated_at: input.createdAt,
  };
  return validateProject({
    ...project,
    candidates: [...project.candidates, candidate],
    updated_at: input.createdAt,
  });
}

export function renameCandidate(
  project: ProjectDocument,
  candidateId: string,
  name: string,
  updatedAt: string,
): ProjectDocument {
  requireNonEmptyString(name, "candidate.name");
  return updateCandidate(project, candidateId, updatedAt, (candidate) => ({ ...candidate, name }));
}

export function editCandidateGeometry(
  project: ProjectDocument,
  candidateId: string,
  geometry: MultiPolygon | Polygon,
  updatedAt: string,
): ProjectDocument {
  const candidate = requireCandidate(project, candidateId);
  assertCandidateGeometry(geometry, candidate.coordinate_reference_system, "candidate.geometry");
  return updateCandidate(project, candidateId, updatedAt, (existing) => ({
    ...existing,
    geometry,
  }));
}

export function deleteCandidate(
  project: ProjectDocument,
  candidateId: string,
  updatedAt: string,
): ProjectDocument {
  requireCandidate(project, candidateId);
  requireTimestamp(updatedAt, "project.updated_at");
  return validateProject({
    ...project,
    candidates: project.candidates.filter((candidate) => candidate.id !== candidateId),
    updated_at: updatedAt,
  });
}

function updateCandidate(
  project: ProjectDocument,
  candidateId: string,
  updatedAt: string,
  updater: (candidate: CandidatePolygon) => CandidatePolygon,
): ProjectDocument {
  requireCandidate(project, candidateId);
  requireTimestamp(updatedAt, "candidate.updated_at");
  return validateProject({
    ...project,
    candidates: project.candidates.map((candidate) =>
      candidate.id === candidateId ? { ...updater(candidate), updated_at: updatedAt } : candidate,
    ),
    updated_at: updatedAt,
  });
}

function requireCandidate(project: ProjectDocument, id: string): CandidatePolygon {
  const candidate = project.candidates.find((member) => member.id === id);
  if (candidate === undefined) {
    throw new ProjectValidationError("candidate.id", `candidate ${id} does not exist`);
  }
  return candidate;
}

function validateProject(value: unknown): ProjectDocument {
  const hasBaselineVersion = isJsonObject(value) && value.schema_version === BASELINE_PROJECT_SCHEMA_VERSION;
  const object = requireObject(value, "$", [
    ...(hasBaselineVersion ? ["baseline_context"] : []),
    "active_scenario_id",
    "candidates",
    "created_at",
    "diagnostics",
    "governance",
    "layers",
    "name",
    "project_id",
    "scenarios",
    "schema_version",
    "updated_at",
    "wa_tribal_context",
  ]);
  if (
    object.schema_version !== PROJECT_SCHEMA_VERSION &&
    object.schema_version !== BASELINE_PROJECT_SCHEMA_VERSION
  ) {
    throw new ProjectValidationError(
      "$.schema_version",
      `must equal ${PROJECT_SCHEMA_VERSION} or ${BASELINE_PROJECT_SCHEMA_VERSION}`,
    );
  }
  try {
    assertDevelopmentBypassState(object.governance);
  } catch (error) {
    throw new ProjectValidationError(
      "$.governance",
      error instanceof Error ? error.message : "invalid development bypass state",
    );
  }

  const layers = requireArray(object.layers, "$.layers").map((layer, index) =>
    validateLayerReference(layer, `$.layers[${index}]`),
  );
  assertUnique(
    layers.map((layer) => layer.metadata.id),
    "$.layers",
    "layer id",
  );

  const scenarios = requireArray(object.scenarios, "$.scenarios").map((scenario, index) =>
    validateScenario(scenario, `$.scenarios[${index}]`),
  );
  assertUnique(
    scenarios.map((scenario) => scenario.id),
    "$.scenarios",
    "scenario id",
  );

  const layerIds = new Set(layers.map((layer) => layer.metadata.id));
  for (const [index, scenario] of scenarios.entries()) {
    if (!layerIds.has(scenario.resource_layer_id)) {
      throw new ProjectValidationError(
        `$.scenarios[${index}].resource_layer_id`,
        `references missing layer ${scenario.resource_layer_id}`,
      );
    }
    for (const [ruleIndex, rule] of scenario.hard_exclusions.entries()) {
      if (!layerIds.has(rule.layer_id)) {
        throw new ProjectValidationError(
          `$.scenarios[${index}].hard_exclusions[${ruleIndex}].layer_id`,
          `references missing layer ${rule.layer_id}`,
        );
      }
    }
    for (const [ruleIndex, rule] of scenario.soft_constraints.entries()) {
      if (!layerIds.has(rule.layer_id)) {
        throw new ProjectValidationError(
          `$.scenarios[${index}].soft_constraints[${ruleIndex}].layer_id`,
          `references missing layer ${rule.layer_id}`,
        );
      }
    }
  }

  const activeScenarioId = requireNonEmptyString(object.active_scenario_id, "$.active_scenario_id");
  if (!scenarios.some((scenario) => scenario.id === activeScenarioId)) {
    throw new ProjectValidationError(
      "$.active_scenario_id",
      `references missing scenario ${activeScenarioId}`,
    );
  }

  const candidates = requireArray(object.candidates, "$.candidates").map((candidate, index) =>
    validateCandidate(candidate, `$.candidates[${index}]`),
  );
  assertUnique(
    candidates.map((candidate) => candidate.id),
    "$.candidates",
    "candidate id",
  );
  const scenarioIds = new Set(scenarios.map((scenario) => scenario.id));
  candidates.forEach((candidate, index) => {
    if (!scenarioIds.has(candidate.scenario_id)) {
      throw new ProjectValidationError(
        `$.candidates[${index}].scenario_id`,
        `references missing scenario ${candidate.scenario_id}`,
      );
    }
  });

  const diagnostics = requireArray(object.diagnostics, "$.diagnostics").map((diagnostic, index) =>
    validateDiagnostic(diagnostic, `$.diagnostics[${index}]`),
  );
  const createdAt = requireTimestamp(object.created_at, "$.created_at");
  const updatedAt = requireTimestamp(object.updated_at, "$.updated_at");
  if (updatedAt < createdAt) {
    throw new ProjectValidationError("$.updated_at", "must not precede created_at");
  }

  return {
    ...(hasBaselineVersion ? { baseline_context: parseBaselineBinding(object.baseline_context) } : {}),
    active_scenario_id: activeScenarioId,
    candidates,
    created_at: createdAt,
    diagnostics,
    governance: object.governance as unknown as DevelopmentBypassState,
    layers,
    name: requireNonEmptyString(object.name, "$.name"),
    project_id: requireNonEmptyString(object.project_id, "$.project_id"),
    scenarios,
    schema_version: hasBaselineVersion ? BASELINE_PROJECT_SCHEMA_VERSION : PROJECT_SCHEMA_VERSION,
    updated_at: updatedAt,
    wa_tribal_context:
      object.wa_tribal_context === null
        ? null
        : parseProjectWaTribalContextBinding(object.wa_tribal_context, "$.wa_tribal_context"),
  };
}

/** Strictly parses and deterministically orders an in-project WA/Tribal custody binding. */
export function parseProjectWaTribalContextBinding(
  value: unknown,
  path = "wa_tribal_context",
): ProjectWaTribalContextBinding {
  const object = requireObject(value, path, [
    "aoi",
    "artifact_reference",
    "artifact_sha256",
    "coverage",
    "custody",
    "features",
    "registry",
  ]);
  const artifactReference = requireNonEmptyString(object.artifact_reference, `${path}.artifact_reference`);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(artifactReference)) {
    throw new ProjectValidationError(
      `${path}.artifact_reference`,
      "must be a portable lowercase kebab-case artifact id, not a path",
    );
  }
  const artifactSha256 = requireSha256(object.artifact_sha256, `${path}.artifact_sha256`);
  let custody: ArtifactCustodyMetadata;
  try {
    custody = parseArtifactCustodyMetadata(object.custody);
  } catch (error) {
    throw new ProjectValidationError(
      `${path}.custody`,
      error instanceof Error ? error.message : "invalid artifact custody",
    );
  }
  if (custody.artifact_id !== artifactReference) {
    throw new ProjectValidationError(
      `${path}.artifact_reference`,
      "must equal the embedded custody artifact id",
    );
  }
  const aoi = parseAoiSnapshot(object.aoi, `${path}.aoi`);

  const parsedRegistry = parseNationRegistry(object.registry, `${path}.registry`);
  const parsedCoverage = parseNationCoverage(object.coverage, `${path}.coverage`);
  let registry: NationRegistryRecord[];
  let coverage: NationCoverageRow[];
  try {
    registry = validateNationRegistry(parsedRegistry);
    coverage = validateNationCoverage(parsedCoverage, registry);
  } catch (error) {
    throw new ProjectValidationError(
      path,
      error instanceof Error ? error.message : "invalid Nation registry or coverage",
    );
  }
  const registryIds = new Set(registry.map((record) => record.nation_id));
  const features = requireArray(object.features, `${path}.features`)
    .map((feature, index) =>
      validateWaTribalFeatureBinding(feature, `${path}.features[${index}]`, registryIds),
    )
    .sort(compareFeatureBindings);
  assertUnique(
    features.map((feature) => feature.source_feature_id),
    `${path}.features`,
    "source feature id",
  );
  assertCoverageFeatureBindings(coverage, features, path);
  return {
    aoi,
    artifact_reference: artifactReference,
    artifact_sha256: artifactSha256,
    coverage,
    custody,
    features,
    registry,
  };
}

function validateWaTribalFeatureBinding(
  value: unknown,
  path: string,
  registryIds: ReadonlySet<string>,
): ProjectWaTribalFeatureBinding {
  const object = requireObject(value, path, [
    "category",
    "nation_id",
    "presentation_geometry_sha256",
    "registry_scope",
    "relation",
    "source_attributes_sha256",
    "source_feature_id",
    "source_geometry_sha256",
  ]);
  if (!isTribalGeometryCategory(object.category)) {
    throw new ProjectValidationError(`${path}.category`, "is not a supported component category");
  }
  if (object.registry_scope !== "goia_29" && object.registry_scope !== "border_context") {
    throw new ProjectValidationError(`${path}.registry_scope`, "is not supported");
  }
  const nationId =
    object.nation_id === null ? null : requireNonEmptyString(object.nation_id, `${path}.nation_id`);
  if (object.registry_scope === "goia_29" && (nationId === null || !registryIds.has(nationId))) {
    throw new ProjectValidationError(`${path}.nation_id`, "must link a GOIA registry Nation");
  }
  if (object.registry_scope === "border_context" && nationId !== null) {
    throw new ProjectValidationError(
      `${path}.nation_id`,
      "border context must not enter the GOIA denominator",
    );
  }
  const relationObject = requireObject(object.relation, `${path}.relation`, [
    "intersects_overflow_only",
    "intersects_state",
    "touches_state",
  ]);
  const relation: TribalFeatureAoiRelation = {
    intersects_overflow_only: requireBoolean(
      relationObject.intersects_overflow_only,
      `${path}.relation.intersects_overflow_only`,
    ),
    intersects_state: requireBoolean(relationObject.intersects_state, `${path}.relation.intersects_state`),
    touches_state: requireBoolean(relationObject.touches_state, `${path}.relation.touches_state`),
  };
  if (!relation.intersects_state && !relation.intersects_overflow_only) {
    throw new ProjectValidationError(`${path}.relation`, "must intersect state or exterior overflow");
  }
  if (relation.intersects_state && relation.intersects_overflow_only) {
    throw new ProjectValidationError(
      `${path}.relation`,
      "overflow-only and state intersection are mutually exclusive",
    );
  }
  if (relation.touches_state && !relation.intersects_state) {
    throw new ProjectValidationError(
      `${path}.relation`,
      "touches_state implies intersects_state under OGC semantics",
    );
  }
  return {
    category: object.category,
    nation_id: nationId,
    presentation_geometry_sha256: requireSha256(
      object.presentation_geometry_sha256,
      `${path}.presentation_geometry_sha256`,
    ),
    registry_scope: object.registry_scope,
    relation,
    source_attributes_sha256: requireSha256(
      object.source_attributes_sha256,
      `${path}.source_attributes_sha256`,
    ),
    source_feature_id: requireNonEmptyString(object.source_feature_id, `${path}.source_feature_id`),
    source_geometry_sha256: requireSha256(object.source_geometry_sha256, `${path}.source_geometry_sha256`),
  };
}

function parseAoiSnapshot(value: unknown, path: string): JsonObject {
  const aoi = requireObject(value, path, [
    "assertions",
    "buffer_parameters",
    "disclaimer",
    "independent_geodesic_audit",
    "metric",
    "presentation",
    "schema_version",
    "source",
    "source_selection",
    "topology",
    "transformations",
  ]);
  if (aoi.schema_version !== "1.0.0") {
    throw new ProjectValidationError(`${path}.schema_version`, "must equal 1.0.0");
  }
  const assertions = requireObject(aoi.assertions, `${path}.assertions`, [
    "buffer_covers_state",
    "state_overflow_interior_overlap_square_metres",
  ]);
  if (assertions.buffer_covers_state !== true) {
    throw new ProjectValidationError(`${path}.assertions.buffer_covers_state`, "must equal true");
  }
  requireNonNegativeFiniteNumber(
    assertions.state_overflow_interior_overlap_square_metres,
    `${path}.assertions.state_overflow_interior_overlap_square_metres`,
  );
  const parameters = requireObject(aoi.buffer_parameters, `${path}.buffer_parameters`, [
    "distanceMetres",
    "endCap",
    "join",
    "mitreLimit",
    "quadrantSegments",
    "simplifyFactor",
    "singleSided",
  ]);
  for (const key of Object.keys(
    WASHINGTON_BUFFER_PARAMETERS,
  ) as (keyof typeof WASHINGTON_BUFFER_PARAMETERS)[]) {
    if (parameters[key] !== WASHINGTON_BUFFER_PARAMETERS[key]) {
      throw new ProjectValidationError(
        `${path}.buffer_parameters.${key}`,
        `must equal ${JSON.stringify(WASHINGTON_BUFFER_PARAMETERS[key])}`,
      );
    }
  }
  if (aoi.disclaimer !== WASHINGTON_TECHNICAL_BUFFER_DISCLAIMER) {
    throw new ProjectValidationError(`${path}.disclaimer`, "is not the required technical warning");
  }
  let audit: ReturnType<typeof parseWashingtonGeodesicAudit>;
  try {
    audit = parseWashingtonGeodesicAudit(aoi.independent_geodesic_audit);
  } catch (error) {
    throw new ProjectValidationError(
      `${path}.independent_geodesic_audit`,
      error instanceof Error ? error.message : "invalid audit",
    );
  }
  const metric = requireObject(aoi.metric, `${path}.metric`, [
    "buffered_aoi_sha256",
    "bounds",
    "coordinate_reference_system",
    "overflow_area_square_metres",
    "wa_overflow_100m_sha256",
    "wa_state_sha256",
  ]);
  if (metric.coordinate_reference_system !== "EPSG:5070") {
    throw new ProjectValidationError(`${path}.metric.coordinate_reference_system`, "must equal EPSG:5070");
  }
  const metricBufferHash = requireSha256(metric.buffered_aoi_sha256, `${path}.metric.buffered_aoi_sha256`);
  requireSha256(metric.wa_overflow_100m_sha256, `${path}.metric.wa_overflow_100m_sha256`);
  requireSha256(metric.wa_state_sha256, `${path}.metric.wa_state_sha256`);
  requirePositiveFiniteNumber(
    metric.overflow_area_square_metres,
    `${path}.metric.overflow_area_square_metres`,
  );
  parseAoiBoundsGroup(metric.bounds, `${path}.metric.bounds`);
  if (audit.metric_buffer_geometry_sha256 !== metricBufferHash) {
    throw new ProjectValidationError(
      `${path}.independent_geodesic_audit.metric_buffer_geometry_sha256`,
      "must equal metric.buffered_aoi_sha256",
    );
  }
  if (!audit.within_tolerance) {
    throw new ProjectValidationError(
      `${path}.independent_geodesic_audit.within_tolerance`,
      "must equal true for a production context binding",
    );
  }
  const presentation = requireObject(aoi.presentation, `${path}.presentation`, [
    "bounds",
    "coordinate_reference_system",
  ]);
  if (presentation.coordinate_reference_system !== "EPSG:4326") {
    throw new ProjectValidationError(
      `${path}.presentation.coordinate_reference_system`,
      "must equal EPSG:4326",
    );
  }
  parseAoiBoundsGroup(presentation.bounds, `${path}.presentation.bounds`);

  const source = requireObject(aoi.source, `${path}.source`, [
    "bounds",
    "coordinate_reference_system",
    "feature_id",
    "geometry_sha256",
    "source_archive_sha256",
    "source_table",
  ]);
  if (source.coordinate_reference_system !== "EPSG:4269") {
    throw new ProjectValidationError(`${path}.source.coordinate_reference_system`, "must equal EPSG:4269");
  }
  parseBounds(source.bounds, `${path}.source.bounds`);
  requireNonEmptyString(source.feature_id, `${path}.source.feature_id`);
  requireSha256(source.geometry_sha256, `${path}.source.geometry_sha256`);
  requireSha256(source.source_archive_sha256, `${path}.source.source_archive_sha256`);
  requireNonEmptyString(source.source_table, `${path}.source.source_table`);

  const sourceSelection = requireObject(aoi.source_selection, `${path}.source_selection`, [
    "bounds",
    "coordinate_reference_system",
  ]);
  if (sourceSelection.coordinate_reference_system !== "EPSG:4269") {
    throw new ProjectValidationError(
      `${path}.source_selection.coordinate_reference_system`,
      "must equal EPSG:4269",
    );
  }
  parseBounds(sourceSelection.bounds, `${path}.source_selection.bounds`);

  const topology = requireObject(aoi.topology, `${path}.topology`, ["implementation", "version"]);
  requireNonEmptyString(topology.implementation, `${path}.topology.implementation`);
  requireNonEmptyString(topology.version, `${path}.topology.version`);
  parseAoiTransformations(aoi.transformations, `${path}.transformations`);

  return structuredClone(aoi);
}

function parseAoiBoundsGroup(value: unknown, path: string): void {
  const group = requireObject(value, path, ["buffered_aoi", "wa_overflow_100m", "wa_state"]);
  parseBounds(group.buffered_aoi, `${path}.buffered_aoi`);
  parseBounds(group.wa_overflow_100m, `${path}.wa_overflow_100m`);
  parseBounds(group.wa_state, `${path}.wa_state`);
}

function parseBounds(value: unknown, path: string): void {
  const bounds = requireObject(value, path, ["maxX", "maxY", "minX", "minY"]);
  const minX = requireFiniteNumber(bounds.minX, `${path}.minX`);
  const minY = requireFiniteNumber(bounds.minY, `${path}.minY`);
  const maxX = requireFiniteNumber(bounds.maxX, `${path}.maxX`);
  const maxY = requireFiniteNumber(bounds.maxY, `${path}.maxY`);
  if (minX > maxX || minY > maxY) {
    throw new ProjectValidationError(path, "minimum bounds must not exceed maximum bounds");
  }
}

function parseAoiTransformations(value: unknown, path: string): void {
  const transformations = requireArray(value, path);
  const expected = [
    {
      source_axis_order: "longitude-latitude",
      source_crs: "EPSG:4269",
      target_axis_order: "east-north",
      target_crs: "EPSG:5070",
    },
    {
      source_axis_order: "east-north",
      source_crs: "EPSG:5070",
      target_axis_order: "longitude-latitude",
      target_crs: "EPSG:4326",
    },
    {
      source_axis_order: "east-north",
      source_crs: "EPSG:5070",
      target_axis_order: "longitude-latitude",
      target_crs: "EPSG:4269",
    },
  ] as const;
  if (transformations.length !== expected.length) {
    throw new ProjectValidationError(path, `must contain exactly ${expected.length} ordered CRS hops`);
  }
  let performedAt: string | undefined;
  transformations.forEach((value, index) => {
    const transformationPath = `${path}[${index}]`;
    const transformation = requireObject(value, transformationPath, [
      "coordinate_engine",
      "operation_definition",
      "performed_at",
      "source_axis_order",
      "source_crs",
      "target_axis_order",
      "target_crs",
    ]);
    const expectedHop = expected[index];
    if (expectedHop === undefined) throw new ProjectValidationError(transformationPath, "is unexpected");
    if (transformation.coordinate_engine !== "proj4js 2.21.0") {
      throw new ProjectValidationError(
        `${transformationPath}.coordinate_engine`,
        "must equal proj4js 2.21.0",
      );
    }
    requireNonEmptyString(transformation.operation_definition, `${transformationPath}.operation_definition`);
    const hopPerformedAt = requireTimestamp(
      transformation.performed_at,
      `${transformationPath}.performed_at`,
    );
    if (performedAt !== undefined && hopPerformedAt !== performedAt) {
      throw new ProjectValidationError(
        `${transformationPath}.performed_at`,
        "must match the other AOI CRS hops",
      );
    }
    performedAt = hopPerformedAt;
    for (const key of ["source_axis_order", "source_crs", "target_axis_order", "target_crs"] as const) {
      if (transformation[key] !== expectedHop[key]) {
        throw new ProjectValidationError(`${transformationPath}.${key}`, `must equal ${expectedHop[key]}`);
      }
    }
  });
}

function parseNationRegistry(value: unknown, path: string): NationRegistryRecord[] {
  const records = requireArray(value, path);
  if (records.length !== WASHINGTON_FEDERALLY_RECOGNIZED_NATION_COUNT) {
    throw new ProjectValidationError(
      path,
      `must contain exactly ${WASHINGTON_FEDERALLY_RECOGNIZED_NATION_COUNT} Nation records`,
    );
  }
  return records.map((value, index) => {
    const recordPath = `${path}[${index}]`;
    const record = requireObject(value, recordPath, [
      "formal_name",
      "goia_name",
      "nation_id",
      "review",
      "source_identifiers",
    ]);
    const review = requireObject(record.review, `${recordPath}.review`, [
      "note",
      "reviewed_at",
      "reviewed_by",
      "status",
    ]);
    if (review.status !== "agent_prepared_owner_review_pending" && review.status !== "human_reviewed") {
      throw new ProjectValidationError(`${recordPath}.review.status`, "is not supported");
    }
    const sourceIdentifiers = requireArray(record.source_identifiers, `${recordPath}.source_identifiers`)
      .map((value, identifierIndex) => {
        const identifierPath = `${recordPath}.source_identifiers[${identifierIndex}]`;
        const identifier = requireObject(value, identifierPath, ["identifier", "source_id"]);
        return {
          identifier: requireNonEmptyString(identifier.identifier, `${identifierPath}.identifier`),
          source_id: requireNonEmptyString(identifier.source_id, `${identifierPath}.source_id`),
        };
      })
      .sort(
        (left, right) =>
          compareCodePoints(left.source_id, right.source_id) ||
          compareCodePoints(left.identifier, right.identifier),
      );
    return {
      formal_name:
        record.formal_name === null
          ? null
          : requireNonEmptyString(record.formal_name, `${recordPath}.formal_name`),
      goia_name: requireNonEmptyString(record.goia_name, `${recordPath}.goia_name`),
      nation_id: requireNonEmptyString(record.nation_id, `${recordPath}.nation_id`),
      review: {
        note: requireNonEmptyString(review.note, `${recordPath}.review.note`),
        reviewed_at: requireTimestamp(review.reviewed_at, `${recordPath}.review.reviewed_at`),
        reviewed_by: requireNonEmptyString(review.reviewed_by, `${recordPath}.review.reviewed_by`),
        status: review.status,
      },
      source_identifiers: sourceIdentifiers,
    };
  });
}

function parseNationCoverage(value: unknown, path: string): NationCoverageRow[] {
  const rows = requireArray(value, path);
  if (rows.length !== WASHINGTON_FEDERALLY_RECOGNIZED_NATION_COUNT) {
    throw new ProjectValidationError(
      path,
      `must contain exactly ${WASHINGTON_FEDERALLY_RECOGNIZED_NATION_COUNT} unique Nation rows`,
    );
  }
  return rows.map((value, rowIndex) => {
    const rowPath = `${path}[${rowIndex}]`;
    const row = requireObject(value, rowPath, ["components", "nation_id", "summary"]);
    const summary = parseNationCoverageSummary(row.summary, `${rowPath}.summary`);
    const components = requireArray(row.components, `${rowPath}.components`).map((value, cellIndex) => {
      const cellPath = `${rowPath}.components[${cellIndex}]`;
      const cell = requireObject(value, cellPath, ["category", "feature_references", "note", "status"]);
      if (!isTribalGeometryCategory(cell.category)) {
        throw new ProjectValidationError(`${cellPath}.category`, "is not a supported component category");
      }
      const featureReferences = requireArray(cell.feature_references, `${cellPath}.feature_references`)
        .map((value, featureIndex) => {
          const featurePath = `${cellPath}.feature_references[${featureIndex}]`;
          const feature = requireObject(value, featurePath, ["source_feature_id", "source_geometry_sha256"]);
          return {
            source_feature_id: requireNonEmptyString(
              feature.source_feature_id,
              `${featurePath}.source_feature_id`,
            ),
            source_geometry_sha256: requireSha256(
              feature.source_geometry_sha256,
              `${featurePath}.source_geometry_sha256`,
            ),
          };
        })
        .sort(
          (left, right) =>
            compareCodePoints(left.source_feature_id, right.source_feature_id) ||
            compareCodePoints(left.source_geometry_sha256, right.source_geometry_sha256),
        );
      return {
        category: cell.category,
        feature_references: featureReferences,
        note: requireNonEmptyString(cell.note, `${cellPath}.note`),
        status: parseCoverageStatus(cell.status, `${cellPath}.status`),
      };
    });
    return {
      components,
      nation_id: requireNonEmptyString(row.nation_id, `${rowPath}.nation_id`),
      summary,
    };
  });
}

function parseCoverageStatus(value: unknown, path: string): CoverageStatus {
  if (
    value !== "no_public_geometry" &&
    value !== "not_applicable" &&
    value !== "not_public" &&
    value !== "public_geometry_present" &&
    value !== "source_conflict" &&
    value !== "unavailable" &&
    value !== "unknown"
  ) {
    throw new ProjectValidationError(path, "is not a supported explicit status");
  }
  return value;
}

function parseNationCoverageSummary(value: unknown, path: string): NationCoverageSummary {
  if (
    value !== "legal_area_present" &&
    value !== "no_public_geometry" &&
    value !== "source_conflict" &&
    value !== "statistical_only" &&
    value !== "unknown"
  ) {
    throw new ProjectValidationError(path, "is not a supported Nation coverage summary");
  }
  return value;
}

function assertCoverageFeatureBindings(
  coverage: readonly NationCoverageRow[],
  features: readonly ProjectWaTribalFeatureBinding[],
  path: string,
): void {
  const byId = new Map(features.map((feature) => [feature.source_feature_id, feature]));
  const referenced = new Set<string>();
  for (const row of coverage) {
    for (const cell of row.components) {
      for (const reference of cell.feature_references) {
        if (referenced.has(reference.source_feature_id)) {
          throw new ProjectValidationError(
            `${path}.coverage`,
            `feature reference ${reference.source_feature_id} appears more than once`,
          );
        }
        const feature = byId.get(reference.source_feature_id);
        if (
          feature === undefined ||
          feature.nation_id !== row.nation_id ||
          feature.category !== cell.category ||
          feature.source_geometry_sha256 !== reference.source_geometry_sha256
        ) {
          throw new ProjectValidationError(
            `${path}.coverage`,
            `feature reference ${reference.source_feature_id} is missing or contradictory`,
          );
        }
        referenced.add(feature.source_feature_id);
      }
    }
  }
  for (const feature of features) {
    if (feature.registry_scope === "goia_29" && !referenced.has(feature.source_feature_id)) {
      throw new ProjectValidationError(
        `${path}.coverage`,
        `does not bind GOIA feature ${feature.source_feature_id}`,
      );
    }
  }
}

function compareFeatureBindings(
  left: ProjectWaTribalFeatureBinding,
  right: ProjectWaTribalFeatureBinding,
): number {
  return (
    compareCodePoints(left.category, right.category) ||
    compareCodePoints(left.source_feature_id, right.source_feature_id)
  );
}

function validateLayerReference(value: unknown, path: string): ProjectLayerReference {
  const object = requireObject(value, path, [
    "artifact_reference",
    "artifact_sha256",
    "coordinate_reference_system",
    "metadata",
  ]);
  const artifactReference = requireNonEmptyString(object.artifact_reference, `${path}.artifact_reference`);
  assertLocalReference(artifactReference, `${path}.artifact_reference`);
  const digest = requireNonEmptyString(object.artifact_sha256, `${path}.artifact_sha256`);
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new ProjectValidationError(`${path}.artifact_sha256`, "must be 64 lowercase hex characters");
  }
  if (!isSupportedCrs(object.coordinate_reference_system)) {
    throw new ProjectValidationError(
      `${path}.coordinate_reference_system`,
      "must be a supported exact EPSG identifier",
    );
  }

  let metadata: LayerMetadata;
  try {
    metadata = parseLayerMetadata(object.metadata, `${path}.metadata`);
    assertTransformationChain(
      metadata,
      object.coordinate_reference_system,
      `${path}.metadata.transformations`,
    );
  } catch (error) {
    throw new ProjectValidationError(
      error instanceof LayerMetadataError ? error.path : path,
      error instanceof Error ? error.message : "invalid metadata",
    );
  }
  return {
    artifact_reference: artifactReference,
    artifact_sha256: digest,
    coordinate_reference_system: object.coordinate_reference_system,
    metadata,
  };
}

function validateScenario(value: unknown, path: string): Scenario {
  const object = requireObject(value, path, [
    "hard_exclusions",
    "id",
    "name",
    "resource_layer_id",
    "resource_value_property",
    "soft_constraints",
  ]);
  const hardExclusions = requireArray(object.hard_exclusions, `${path}.hard_exclusions`).map((rule, index) =>
    validateHardRule(rule, `${path}.hard_exclusions[${index}]`),
  );
  const softConstraints = requireArray(object.soft_constraints, `${path}.soft_constraints`).map(
    (rule, index) => validateSoftRule(rule, `${path}.soft_constraints[${index}]`),
  );
  assertUnique(
    [...hardExclusions, ...softConstraints].map((rule) => rule.rule_id),
    path,
    "rule id",
  );
  return {
    hard_exclusions: hardExclusions,
    id: requireNonEmptyString(object.id, `${path}.id`),
    name: requireNonEmptyString(object.name, `${path}.name`),
    resource_layer_id: requireNonEmptyString(object.resource_layer_id, `${path}.resource_layer_id`),
    resource_value_property: requireNonEmptyString(
      object.resource_value_property,
      `${path}.resource_value_property`,
    ),
    soft_constraints: softConstraints,
  };
}

function validateHardRule(value: unknown, path: string): HardExclusionSetting {
  const object = requireObject(value, path, ["description", "enabled", "layer_id", "rule_id"]);
  return {
    description: requireNonEmptyString(object.description, `${path}.description`),
    enabled: requireBoolean(object.enabled, `${path}.enabled`),
    layer_id: requireNonEmptyString(object.layer_id, `${path}.layer_id`),
    rule_id: requireNonEmptyString(object.rule_id, `${path}.rule_id`),
  };
}

function validateSoftRule(value: unknown, path: string): SoftConstraintSetting {
  const object = requireObject(value, path, [
    "description",
    "enabled",
    "layer_id",
    "penalty_fraction",
    "rule_id",
  ]);
  if (
    typeof object.penalty_fraction !== "number" ||
    object.penalty_fraction < 0 ||
    object.penalty_fraction > 1
  ) {
    throw new ProjectValidationError(`${path}.penalty_fraction`, "must be a number from 0 through 1");
  }
  return {
    description: requireNonEmptyString(object.description, `${path}.description`),
    enabled: requireBoolean(object.enabled, `${path}.enabled`),
    layer_id: requireNonEmptyString(object.layer_id, `${path}.layer_id`),
    penalty_fraction: object.penalty_fraction,
    rule_id: requireNonEmptyString(object.rule_id, `${path}.rule_id`),
  };
}

function validateCandidate(value: unknown, path: string): CandidatePolygon {
  const object = requireObject(value, path, [
    "coordinate_reference_system",
    "created_at",
    "geometry",
    "id",
    "name",
    "properties",
    "scenario_id",
    "updated_at",
  ]);
  if (!isSupportedCrs(object.coordinate_reference_system)) {
    throw new ProjectValidationError(
      `${path}.coordinate_reference_system`,
      "must be a supported exact EPSG identifier",
    );
  }
  if (!isJsonObject(object.geometry)) {
    throw new ProjectValidationError(`${path}.geometry`, "must be a Polygon or MultiPolygon");
  }
  const geometry = object.geometry as unknown as MultiPolygon | Polygon;
  assertCandidateGeometry(geometry, object.coordinate_reference_system, `${path}.geometry`);
  if (!isJsonObject(object.properties)) {
    throw new ProjectValidationError(`${path}.properties`, "must be a JSON object");
  }
  const createdAt = requireTimestamp(object.created_at, `${path}.created_at`);
  const updatedAt = requireTimestamp(object.updated_at, `${path}.updated_at`);
  if (updatedAt < createdAt) {
    throw new ProjectValidationError(`${path}.updated_at`, "must not precede created_at");
  }
  return {
    coordinate_reference_system: object.coordinate_reference_system,
    created_at: createdAt,
    geometry,
    id: requireNonEmptyString(object.id, `${path}.id`),
    name: requireNonEmptyString(object.name, `${path}.name`),
    properties: object.properties,
    scenario_id: requireNonEmptyString(object.scenario_id, `${path}.scenario_id`),
    updated_at: updatedAt,
  };
}

function validateDiagnostic(value: unknown, path: string): ProjectDiagnostic {
  const object = requireObject(value, path, ["code", "layer_id", "message", "severity"]);
  const severity = object.severity;
  if (severity !== "error" && severity !== "info" && severity !== "warning") {
    throw new ProjectValidationError(`${path}.severity`, "must be error, info, or warning");
  }
  return {
    code: requireNonEmptyString(object.code, `${path}.code`),
    layer_id: object.layer_id === null ? null : requireNonEmptyString(object.layer_id, `${path}.layer_id`),
    message: requireNonEmptyString(object.message, `${path}.message`),
    severity,
  };
}

function assertCandidateGeometry(
  geometry: MultiPolygon | Polygon,
  crs: SupportedCrsCode,
  path: string,
): void {
  if (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon") {
    throw new ProjectValidationError(path, "candidate geometry must be Polygon or MultiPolygon");
  }
  try {
    assertValidGeometry(geometry, crs);
  } catch (error) {
    throw new ProjectValidationError(
      path,
      error instanceof GeometryValidationError ? error.message : "candidate geometry is invalid",
    );
  }
}

function assertLocalReference(value: string, path: string): void {
  if (/^(?:[a-z][a-z0-9+.-]*:|\\\\|\/\/)/i.test(value)) {
    throw new ProjectValidationError(path, "must be a project-local reference, not a URI or network path");
  }
  if (/^[a-z]:[\\/]/i.test(value) || value.startsWith("/") || value.startsWith("\\")) {
    throw new ProjectValidationError(path, "must be project-relative, not an absolute path");
  }
  const segments = value.replaceAll("\\", "/").split("/");
  if (segments.includes("..")) {
    throw new ProjectValidationError(path, "must not escape the project directory");
  }
}

function requireObject(
  value: unknown,
  path: string,
  exactKeys: readonly string[],
): Record<string, JsonValue> {
  if (!isJsonObject(value)) {
    throw new ProjectValidationError(path, "must be a JSON object");
  }
  const keys = Object.keys(value).sort();
  const expected = [...exactKeys].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new ProjectValidationError(path, "has missing or unexpected fields");
  }
  return value;
}

function requireArray(value: unknown, path: string): JsonValue[] {
  if (!Array.isArray(value)) {
    throw new ProjectValidationError(path, "must be an array");
  }
  return value;
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProjectValidationError(path, "must be a non-empty string");
  }
  return value;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new ProjectValidationError(path, "must be a boolean");
  }
  return value;
}

function requireFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ProjectValidationError(path, "must be a finite number");
  }
  return value;
}

function requireNonNegativeFiniteNumber(value: unknown, path: string): number {
  const number = requireFiniteNumber(value, path);
  if (number < 0) throw new ProjectValidationError(path, "must be non-negative");
  return number;
}

function requirePositiveFiniteNumber(value: unknown, path: string): number {
  const number = requireFiniteNumber(value, path);
  if (number <= 0) throw new ProjectValidationError(path, "must be positive");
  return number;
}

function requireTimestamp(value: unknown, path: string): string {
  const timestamp = requireNonEmptyString(value, path);
  const date = new Date(timestamp);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== timestamp) {
    throw new ProjectValidationError(path, "must be a canonical UTC ISO-8601 timestamp");
  }
  return timestamp;
}

function requireSha256(value: unknown, path: string): string {
  const digest = requireNonEmptyString(value, path);
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new ProjectValidationError(path, "must be 64 lowercase hexadecimal characters");
  }
  return digest;
}

function assertUnique(values: readonly string[], path: string, label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new ProjectValidationError(path, `duplicate ${label} ${value}`);
    }
    seen.add(value);
  }
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
