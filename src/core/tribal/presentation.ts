import type { JsonObject, JsonValue } from "../../shared/json.js";
import { stableStringify } from "../../shared/stable-json.js";
import type { WashingtonTechnicalAoi } from "../aoi/wa-buffer.js";
import { inspectGeometry } from "../geometry.js";
import { sha256Text } from "../hash.js";
import type { PolygonalGeometry } from "../spatial/polygon.js";
import {
  buildCensusAiannhRegistryCrosswalk,
  validateCensusAiannhFeatureBinding,
  WASHINGTON_BORDER_CONTEXT_AIANNH_COMPONENT_COUNT,
  WASHINGTON_GOIA_AIANNH_COMPONENT_COUNT,
  WASHINGTON_SELECTED_AIANNH_FEATURE_COUNT,
} from "./census-aiannh.js";
import {
  isTribalGeometryCategory,
  type NationCoverageRow,
  type TribalGeometryCategory,
  validateNationCoverage,
} from "./coverage.js";
import type { ArtifactCustodyMetadata } from "./custody.js";
import type { NationRegistryRecord } from "./nation-registry.js";
import { validateNationRegistry } from "./nation-registry.js";
import type { TribalFeatureAoiRelation } from "./selection.js";

export const REQUIRED_CENSUS_TRIBAL_ATTRIBUTES = [
  "AIANNHCE",
  "AIANNHNS",
  "GEOID",
  "GEOIDFQ",
  "NAME",
  "NAMELSAD",
  "LSAD",
  "CLASSFP",
  "COMPTYP",
  "AIANNHR",
  "MTFCC",
  "FUNCSTAT",
  "ALAND",
  "AWATER",
  "INTPTLAT",
  "INTPTLON",
] as const;

export interface TribalPresentationTransformation extends JsonObject {
  coordinate_engine: "proj4js 2.21.0";
  operation_definition: "+proj=longlat +datum=NAD83 +no_defs +type=crs -> +proj=longlat +datum=WGS84 +no_defs +type=crs";
  performed_at: string;
  purpose: "RFC 7946 presentation derivative for tribal_features; native EPSG:4269 geometry remains authoritative and whole";
  source_axis_order: "longitude-latitude";
  source_crs: "EPSG:4269";
  target_axis_order: "longitude-latitude";
  target_crs: "EPSG:4326";
}

/** Returns the closed, deterministic lineage record for each Tribal presentation derivative. */
export function createTribalPresentationTransformation(
  performedAt: string,
): TribalPresentationTransformation {
  return {
    coordinate_engine: "proj4js 2.21.0",
    operation_definition:
      "+proj=longlat +datum=NAD83 +no_defs +type=crs -> +proj=longlat +datum=WGS84 +no_defs +type=crs",
    performed_at: performedAt,
    purpose:
      "RFC 7946 presentation derivative for tribal_features; native EPSG:4269 geometry remains authoritative and whole",
    source_axis_order: "longitude-latitude",
    source_crs: "EPSG:4269",
    target_axis_order: "longitude-latitude",
    target_crs: "EPSG:4326",
  };
}

export interface GeometryValidatorVerdict {
  engine: string;
  reason: string | null;
  valid: boolean;
  version: string;
}

export interface TribalGeometryValidityDisposition {
  disposition: "accepted_unmodified_source" | "validator_conflict_retained_unmodified";
  independent: GeometryValidatorVerdict;
  note: string;
  successor: GeometryValidatorVerdict;
}

export interface TribalPresentationFeature {
  category: TribalGeometryCategory;
  formal_nation_name: string | null;
  geometry: PolygonalGeometry;
  nation_id: string | null;
  presentation_geometry_sha256: string;
  registry_scope: "border_context" | "goia_29";
  relation: TribalFeatureAoiRelation;
  source_attributes: JsonObject;
  source_attributes_sha256: string;
  source_feature_id: string;
  source_geometry_sha256: string;
  source_name: string;
  validity: TribalGeometryValidityDisposition;
}

export interface TribalPresentationContext {
  aoi: WashingtonTechnicalAoi;
  artifact_reference: string;
  artifact_sha256: string;
  coordinate_reference_system: "EPSG:4326";
  coverage: readonly NationCoverageRow[];
  custody: ArtifactCustodyMetadata;
  features: readonly TribalPresentationFeature[];
  registry: readonly NationRegistryRecord[];
  schema_version: "1.0.0";
}

export interface BuildTribalPresentationContextInput {
  aoi: WashingtonTechnicalAoi;
  artifactReference: string;
  artifactSha256: string;
  coverage: readonly NationCoverageRow[];
  custody: ArtifactCustodyMetadata;
  features: readonly TribalPresentationFeature[];
  registry: readonly NationRegistryRecord[];
}

export class TribalPresentationError extends Error {
  public readonly path: string;

  public constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "TribalPresentationError";
    this.path = path;
  }
}

/** Constructs the only DTO accepted by project binding and Cesium presentation. */
export async function buildTribalPresentationContext(
  input: BuildTribalPresentationContextInput,
): Promise<TribalPresentationContext> {
  if (!/^[a-f0-9]{64}$/.test(input.artifactSha256)) {
    throw new TribalPresentationError("artifact_sha256", "must be a lowercase SHA-256 digest");
  }
  if (
    input.artifactReference.trim().length === 0 ||
    /[\\/]/.test(input.artifactReference) ||
    /^[a-zA-Z]:/.test(input.artifactReference)
  ) {
    throw new TribalPresentationError(
      "artifact_reference",
      "must be a portable logical reference without a local or UNC path",
    );
  }
  if (input.custody.artifact_id !== input.artifactReference) {
    throw new TribalPresentationError(
      "artifact_reference",
      `does not match custody artifact id ${input.custody.artifact_id}`,
    );
  }
  if (input.aoi.independent_geodesic_audit === null) {
    throw new TribalPresentationError(
      "aoi.independent_geodesic_audit",
      "production presentation requires an independent audit bound to the metric buffer",
    );
  }

  const registry = validateNationRegistry(input.registry);
  const coverage = validateNationCoverage(input.coverage, registry);
  const censusCrosswalk = buildCensusAiannhRegistryCrosswalk(registry);
  const registryById = new Map(registry.map((record) => [record.nation_id, record]));
  const seenFeatureIds = new Set<string>();
  const features: TribalPresentationFeature[] = [];

  for (const [index, feature] of input.features.entries()) {
    const path = `features[${index}]`;
    if (feature.source_feature_id.trim().length === 0) {
      throw new TribalPresentationError(`${path}.source_feature_id`, "must be non-empty");
    }
    if (seenFeatureIds.has(feature.source_feature_id)) {
      throw new TribalPresentationError(
        `${path}.source_feature_id`,
        `duplicates ${feature.source_feature_id}`,
      );
    }
    if (!isTribalGeometryCategory(feature.category)) {
      throw new TribalPresentationError(`${path}.category`, "is not supported");
    }
    if (
      feature.category !== "federal_reservation_exterior" &&
      feature.category !== "off_reservation_trust_land" &&
      feature.category !== "tdsa_statistical_area"
    ) {
      throw new TribalPresentationError(
        `${path}.category`,
        "the first source slice may only contain accepted Census reservation, trust, or TDSA geometry",
      );
    }
    if (feature.registry_scope === "goia_29") {
      if (feature.nation_id === null || !registryById.has(feature.nation_id)) {
        throw new TribalPresentationError(
          `${path}.nation_id`,
          "GOIA-scope feature must link one registry Nation",
        );
      }
    } else if (feature.registry_scope === "border_context") {
      if (feature.nation_id !== null) {
        throw new TribalPresentationError(
          `${path}.nation_id`,
          "border context must not enter the GOIA 29 denominator",
        );
      }
    } else {
      throw new TribalPresentationError(`${path}.registry_scope`, "is not supported");
    }
    requireSha256(feature.source_geometry_sha256, `${path}.source_geometry_sha256`);
    requireSha256(feature.source_attributes_sha256, `${path}.source_attributes_sha256`);
    requireSha256(feature.presentation_geometry_sha256, `${path}.presentation_geometry_sha256`);
    requireSourceAttributes(feature.source_attributes, path);
    validateCensusAiannhFeatureBinding(feature, censusCrosswalk, path);
    if (feature.source_name !== feature.source_attributes.NAMELSAD) {
      throw new TribalPresentationError(
        `${path}.source_name`,
        "must equal the preserved Census NAMELSAD source name",
      );
    }
    requireRelation(feature.relation, `${path}.relation`);
    requireValidity(feature.validity, `${path}.validity`);

    const structuralFailures = inspectGeometry(feature.geometry, "EPSG:4326");
    const topologyFailure = structuralFailures.find((failure) => failure.code === "TOPOLOGY_INVALID");
    const nonTopologyFailures = structuralFailures.filter((failure) => failure.code !== "TOPOLOGY_INVALID");
    if (nonTopologyFailures.length > 0) {
      throw new TribalPresentationError(
        `${path}.geometry`,
        nonTopologyFailures.map((failure) => `${failure.path}: ${failure.message}`).join("; "),
      );
    }
    if (feature.validity.successor.valid === (topologyFailure !== undefined)) {
      throw new TribalPresentationError(
        `${path}.validity.successor.valid`,
        "does not reproduce the pinned successor validator verdict",
      );
    }
    const presentationHash = await sha256Text(
      stableStringify(feature.geometry as unknown as JsonValue, false),
    );
    if (presentationHash !== feature.presentation_geometry_sha256) {
      throw new TribalPresentationError(
        `${path}.presentation_geometry_sha256`,
        "does not match canonical presentation geometry",
      );
    }
    const attributesHash = await sha256Text(stableStringify(feature.source_attributes as JsonValue, false));
    if (attributesHash !== feature.source_attributes_sha256) {
      throw new TribalPresentationError(
        `${path}.source_attributes_sha256`,
        "does not match canonical preserved attributes",
      );
    }
    seenFeatureIds.add(feature.source_feature_id);
    features.push(feature);
  }

  const goiaFeatureCount = features.filter((feature) => feature.registry_scope === "goia_29").length;
  const borderFeatureCount = features.filter((feature) => feature.registry_scope === "border_context").length;
  if (
    features.length !== WASHINGTON_SELECTED_AIANNH_FEATURE_COUNT ||
    goiaFeatureCount !== WASHINGTON_GOIA_AIANNH_COMPONENT_COUNT ||
    borderFeatureCount !== WASHINGTON_BORDER_CONTEXT_AIANNH_COMPONENT_COUNT
  ) {
    throw new TribalPresentationError(
      "features",
      `must contain exactly ${WASHINGTON_GOIA_AIANNH_COMPONENT_COUNT} GOIA components plus ${WASHINGTON_BORDER_CONTEXT_AIANNH_COMPONENT_COUNT} border-context components`,
    );
  }

  assertCoverageReferences(coverage, features);
  assertComponentDispositions(input.custody, coverage, features);
  features.sort(
    (left, right) =>
      compareCodePoints(left.category, right.category) ||
      compareCodePoints(left.source_feature_id, right.source_feature_id),
  );

  return {
    aoi: input.aoi,
    artifact_reference: input.artifactReference,
    artifact_sha256: input.artifactSha256,
    coordinate_reference_system: "EPSG:4326",
    coverage,
    custody: input.custody,
    features,
    registry,
    schema_version: "1.0.0",
  };
}

function assertComponentDispositions(
  custody: ArtifactCustodyMetadata,
  coverage: readonly NationCoverageRow[],
  features: readonly TribalPresentationFeature[],
): void {
  const dispositions = new Map(custody.component_sources.map((component) => [component.category, component]));
  for (const [category, component] of dispositions) {
    const categoryFeatures = features.filter((feature) => feature.category === category);
    const publicCells = coverage.filter((row) =>
      row.components.some((cell) => cell.category === category && cell.status === "public_geometry_present"),
    );
    if (component.disposition === "accepted") {
      if (categoryFeatures.length === 0 || publicCells.length === 0) {
        throw new TribalPresentationError(
          "custody.component_sources",
          `accepted category ${category} must have presentation features and public coverage cells`,
        );
      }
    } else if (categoryFeatures.length > 0 || publicCells.length > 0) {
      throw new TribalPresentationError(
        "custody.component_sources",
        `${component.disposition} category ${category} must not carry presentation geometry`,
      );
    }
  }
}

function requireSourceAttributes(attributes: JsonObject, featurePath: string): void {
  for (const key of REQUIRED_CENSUS_TRIBAL_ATTRIBUTES) {
    if (!Object.hasOwn(attributes, key)) {
      throw new TribalPresentationError(`${featurePath}.source_attributes.${key}`, "is missing");
    }
  }
}

function requireRelation(relation: TribalFeatureAoiRelation, path: string): void {
  for (const key of ["intersects_state", "touches_state", "intersects_overflow_only"] as const) {
    if (typeof relation[key] !== "boolean") {
      throw new TribalPresentationError(`${path}.${key}`, "must be boolean");
    }
  }
  if (!relation.intersects_state && !relation.intersects_overflow_only) {
    throw new TribalPresentationError(path, "feature must intersect state or the exterior overflow");
  }
  if (relation.intersects_overflow_only && relation.intersects_state) {
    throw new TribalPresentationError(path, "overflow-only and state intersection are mutually exclusive");
  }
  if (relation.touches_state && !relation.intersects_state) {
    throw new TribalPresentationError(path, "touches_state implies intersects_state under OGC semantics");
  }
}

function requireValidity(validity: TribalGeometryValidityDisposition, path: string): void {
  if (validity.note.trim().length === 0) {
    throw new TribalPresentationError(`${path}.note`, "must document the source-bound disposition");
  }
  for (const [name, verdict] of [
    ["successor", validity.successor],
    ["independent", validity.independent],
  ] as const) {
    if (verdict.engine.trim().length === 0 || verdict.version.trim().length === 0) {
      throw new TribalPresentationError(`${path}.${name}`, "must identify validator and version");
    }
    if (typeof verdict.valid !== "boolean") {
      throw new TribalPresentationError(`${path}.${name}.valid`, "must be boolean");
    }
    if (verdict.reason !== null && verdict.reason.trim().length === 0) {
      throw new TribalPresentationError(`${path}.${name}.reason`, "must be null or non-empty");
    }
  }
  if (!validity.independent.valid && !validity.successor.valid) {
    throw new TribalPresentationError(path, "both pinned validators reject the unmodified source geometry");
  }
  const conflict = validity.independent.valid !== validity.successor.valid;
  if (conflict !== (validity.disposition === "validator_conflict_retained_unmodified")) {
    throw new TribalPresentationError(path, "disposition does not match the validator verdicts");
  }
}

function assertCoverageReferences(
  coverage: readonly NationCoverageRow[],
  features: readonly TribalPresentationFeature[],
): void {
  const featuresById = new Map(features.map((feature) => [feature.source_feature_id, feature]));
  const referenced = new Set<string>();
  for (const [rowIndex, row] of coverage.entries()) {
    for (const [cellIndex, cell] of row.components.entries()) {
      for (const [referenceIndex, reference] of cell.feature_references.entries()) {
        const path = `coverage[${rowIndex}].components[${cellIndex}].feature_references[${referenceIndex}]`;
        const feature = featuresById.get(reference.source_feature_id);
        if (feature === undefined) {
          throw new TribalPresentationError(path, "references a missing presentation feature");
        }
        if (
          feature.nation_id !== row.nation_id ||
          feature.category !== cell.category ||
          feature.source_geometry_sha256 !== reference.source_geometry_sha256
        ) {
          throw new TribalPresentationError(path, "does not match feature Nation, category, or source hash");
        }
        referenced.add(feature.source_feature_id);
      }
    }
  }
  for (const feature of features) {
    if (feature.registry_scope === "goia_29" && !referenced.has(feature.source_feature_id)) {
      throw new TribalPresentationError(
        "coverage",
        `does not reference GOIA-scope feature ${feature.source_feature_id}`,
      );
    }
  }
}

function requireSha256(value: string, path: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new TribalPresentationError(path, "must be a lowercase SHA-256 digest");
  }
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
