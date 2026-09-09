import type { Feature, FeatureCollection, GeoJsonProperties, Geometry } from "geojson";
import type { JsonObject, JsonValue } from "../shared/json.js";
import { isJsonObject, isJsonValue } from "../shared/json.js";
import { parseJson, stableStringify } from "../shared/stable-json.js";
import { isSupportedCrs, type SupportedCrsCode, transformGeometry } from "./crs.js";
import { assertValidGeometry, GeometryValidationError } from "./geometry.js";
import { sha256Hex } from "./hash.js";
import {
  assertTransformationChain,
  type CoordinateTransformationRecord,
  type LayerMetadata,
  LayerMetadataError,
  parseLayerMetadata,
} from "./layer.js";

export const ATNI_GEOJSON_SCHEMA_VERSION = "1.0.0" as const;

export type AtniArtifactKind = "opportunity_export" | "source_layer";

export interface AtniGeoJsonMetadata {
  artifact_kind: AtniArtifactKind;
  coordinate_reference_system: SupportedCrsCode;
  /** Null for a source layer; required export binding is validated by the export adapter. */
  export_binding: JsonObject | null;
  layer: LayerMetadata;
  schema_version: typeof ATNI_GEOJSON_SCHEMA_VERSION;
}

export interface AtniFeatureCollection extends FeatureCollection<Geometry, GeoJsonProperties> {
  atni_geobase: AtniGeoJsonMetadata;
}

export interface ImportedGeoJsonLayer {
  readonly document: AtniFeatureCollection;
  readonly exact_byte_length: number;
  readonly exact_bytes_sha256: string;
  readonly metadata: AtniGeoJsonMetadata;
}

export type GeoJsonImportErrorCode =
  | "CRS_CONTRADICTORY"
  | "CRS_MALFORMED"
  | "CRS_MISSING"
  | "FEATURE_INVALID"
  | "GEOMETRY_INVALID"
  | "JSON_INVALID"
  | "METADATA_MALFORMED"
  | "METADATA_MISSING";

export class GeoJsonImportError extends Error {
  public readonly code: GeoJsonImportErrorCode;
  public readonly path: string;

  public constructor(code: GeoJsonImportErrorCode, path: string, message: string) {
    super(`${path}: ${message}`);
    this.code = code;
    this.name = "GeoJsonImportError";
    this.path = path;
  }
}

/**
 * Parses exact UTF-8 bytes and requires authoritative, in-artifact ATNI metadata.
 * The returned digest describes the bytes before any JSON parsing or normalization.
 */
export async function importAtniGeoJson(bytes: Uint8Array): Promise<ImportedGeoJsonLayer> {
  const digestPromise = sha256Hex(bytes);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new GeoJsonImportError(
      "JSON_INVALID",
      "$",
      `artifact is not valid UTF-8: ${error instanceof Error ? error.message : "decode failure"}`,
    );
  }

  let value: JsonValue;
  try {
    value = parseJson(text);
  } catch (error) {
    throw new GeoJsonImportError(
      "JSON_INVALID",
      "$",
      error instanceof Error ? error.message : "invalid JSON",
    );
  }

  const document = parseFeatureCollection(value);
  const metadata = parseAtniMetadata(document);
  validateLegacyCrs(document, metadata.coordinate_reference_system);
  validateFeatures(document.features, metadata.coordinate_reference_system);

  return {
    document,
    exact_byte_length: bytes.byteLength,
    exact_bytes_sha256: await digestPromise,
    metadata,
  };
}

/** Deterministically serializes a validated ATNI FeatureCollection as UTF-8. */
export function serializeAtniGeoJson(document: AtniFeatureCollection): Uint8Array {
  const parsed = parseFeatureCollection(document as unknown as JsonValue);
  const metadata = parseAtniMetadata(parsed);
  validateLegacyCrs(parsed, metadata.coordinate_reference_system);
  validateFeatures(parsed.features, metadata.coordinate_reference_system);
  return new TextEncoder().encode(stableStringify(parsed as unknown as JsonValue));
}

export interface ReprojectGeoJsonOptions {
  performedAt: string;
  reason: string;
  targetCrs: SupportedCrsCode;
}

/**
 * Creates a transformed copy, updates the current coordinate CRS, and appends a
 * trace record. Source metadata remains unchanged and is never relabeled.
 */
export function reprojectAtniGeoJson(
  imported: ImportedGeoJsonLayer,
  options: ReprojectGeoJsonOptions,
): AtniFeatureCollection {
  const sourceCrs = imported.metadata.coordinate_reference_system;
  if (sourceCrs === options.targetCrs) {
    throw new GeoJsonImportError(
      "CRS_CONTRADICTORY",
      "$.atni_geobase.coordinate_reference_system",
      "source and target CRS are identical; a no-op must not be recorded as a transformation",
    );
  }
  requireTimestamp(options.performedAt, "options.performedAt");
  if (options.reason.trim().length === 0) {
    throw new GeoJsonImportError("METADATA_MALFORMED", "options.reason", "must not be empty");
  }

  const record: CoordinateTransformationRecord = {
    operation: "proj4",
    performed_at: options.performedAt,
    preserves_extra_dimensions: true,
    reason: options.reason,
    source_crs: sourceCrs,
    target_crs: options.targetCrs,
  };
  const layer: LayerMetadata = {
    ...imported.metadata.layer,
    transformations: [...imported.metadata.layer.transformations, record],
  };

  return {
    ...imported.document,
    atni_geobase: {
      ...imported.metadata,
      coordinate_reference_system: options.targetCrs,
      layer,
    },
    features: imported.document.features.map((feature) => ({
      ...feature,
      geometry: transformGeometry(feature.geometry, sourceCrs, options.targetCrs),
    })),
  };
}

function parseFeatureCollection(value: JsonValue): AtniFeatureCollection {
  if (!isJsonObject(value)) {
    throw new GeoJsonImportError("FEATURE_INVALID", "$", "GeoJSON root must be an object");
  }
  if (value.type !== "FeatureCollection") {
    throw new GeoJsonImportError("FEATURE_INVALID", "$.type", 'must equal "FeatureCollection"');
  }
  if (!Array.isArray(value.features)) {
    throw new GeoJsonImportError("FEATURE_INVALID", "$.features", "must be an array");
  }
  return value as unknown as AtniFeatureCollection;
}

function parseAtniMetadata(document: AtniFeatureCollection): AtniGeoJsonMetadata {
  const rawDocument = document as unknown as Record<string, unknown>;
  if (!("atni_geobase" in rawDocument)) {
    throw new GeoJsonImportError(
      "METADATA_MISSING",
      "$.atni_geobase",
      "authoritative in-artifact ATNI metadata is required",
    );
  }
  if (!isJsonObject(rawDocument.atni_geobase)) {
    throw new GeoJsonImportError("METADATA_MALFORMED", "$.atni_geobase", "must be an object");
  }
  const raw = rawDocument.atni_geobase;
  const expectedKeys = [
    "artifact_kind",
    "coordinate_reference_system",
    "export_binding",
    "layer",
    "schema_version",
  ];
  const actualKeys = Object.keys(raw).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== [...expectedKeys].sort()[index])
  ) {
    throw new GeoJsonImportError("METADATA_MALFORMED", "$.atni_geobase", "has missing or unexpected fields");
  }
  if (raw.schema_version !== ATNI_GEOJSON_SCHEMA_VERSION) {
    throw new GeoJsonImportError(
      "METADATA_MALFORMED",
      "$.atni_geobase.schema_version",
      `must equal ${ATNI_GEOJSON_SCHEMA_VERSION}`,
    );
  }
  if (raw.artifact_kind !== "source_layer" && raw.artifact_kind !== "opportunity_export") {
    throw new GeoJsonImportError(
      "METADATA_MALFORMED",
      "$.atni_geobase.artifact_kind",
      "is not a supported artifact kind",
    );
  }
  if (!("coordinate_reference_system" in raw) || raw.coordinate_reference_system === null) {
    throw new GeoJsonImportError(
      "CRS_MISSING",
      "$.atni_geobase.coordinate_reference_system",
      "authoritative coordinate CRS is required",
    );
  }
  if (!isSupportedCrs(raw.coordinate_reference_system)) {
    throw new GeoJsonImportError(
      "CRS_MALFORMED",
      "$.atni_geobase.coordinate_reference_system",
      "must be an exact supported EPSG identifier",
    );
  }
  if (raw.export_binding !== null && !isJsonObject(raw.export_binding)) {
    throw new GeoJsonImportError(
      "METADATA_MALFORMED",
      "$.atni_geobase.export_binding",
      "must be an object or null",
    );
  }

  let layer: LayerMetadata;
  try {
    layer = parseLayerMetadata(raw.layer, "$.atni_geobase.layer");
  } catch (error) {
    if (error instanceof LayerMetadataError && error.path.endsWith("authoritative_source_crs")) {
      const rawLayer = isJsonObject(raw.layer) ? raw.layer : undefined;
      const code =
        rawLayer !== undefined && "authoritative_source_crs" in rawLayer ? "CRS_MALFORMED" : "CRS_MISSING";
      throw new GeoJsonImportError(code, error.path, error.message);
    }
    throw new GeoJsonImportError(
      "METADATA_MALFORMED",
      error instanceof LayerMetadataError ? error.path : "$.atni_geobase.layer",
      error instanceof Error ? error.message : "invalid layer metadata",
    );
  }

  try {
    assertTransformationChain(layer, raw.coordinate_reference_system, "$.atni_geobase.layer.transformations");
  } catch (error) {
    throw new GeoJsonImportError(
      "CRS_CONTRADICTORY",
      error instanceof LayerMetadataError ? error.path : "$.atni_geobase",
      error instanceof Error ? error.message : "CRS declarations contradict one another",
    );
  }

  return {
    artifact_kind: raw.artifact_kind,
    coordinate_reference_system: raw.coordinate_reference_system,
    export_binding: raw.export_binding,
    layer,
    schema_version: ATNI_GEOJSON_SCHEMA_VERSION,
  };
}

function validateLegacyCrs(document: AtniFeatureCollection, authoritativeCrs: SupportedCrsCode): void {
  const raw = document as unknown as Record<string, unknown>;
  if (!("crs" in raw)) return;
  const legacy = raw.crs;
  if (!isJsonObject(legacy) || legacy.type !== "name" || !isJsonObject(legacy.properties)) {
    throw new GeoJsonImportError(
      "CRS_MALFORMED",
      "$.crs",
      'legacy CRS must use {type: "name", properties: {name: "EPSG:..."}}',
    );
  }
  const name = legacy.properties.name;
  if (!isSupportedCrs(name)) {
    throw new GeoJsonImportError(
      "CRS_MALFORMED",
      "$.crs.properties.name",
      "legacy CRS name is not a supported exact EPSG identifier",
    );
  }
  if (name !== authoritativeCrs) {
    throw new GeoJsonImportError(
      "CRS_CONTRADICTORY",
      "$.crs.properties.name",
      `legacy CRS ${name} contradicts authoritative coordinate CRS ${authoritativeCrs}`,
    );
  }
}

function validateFeatures(features: Feature<Geometry, GeoJsonProperties>[], crs: SupportedCrsCode): void {
  const featureIdIndexes = new Map<string, number>();
  features.forEach((feature, index) => {
    const path = `$.features[${index}]`;
    if (!isJsonObject(feature as unknown)) {
      throw new GeoJsonImportError("FEATURE_INVALID", path, "must be an object");
    }
    if (feature.type !== "Feature") {
      throw new GeoJsonImportError("FEATURE_INVALID", `${path}.type`, 'must equal "Feature"');
    }
    if (typeof feature.id !== "string" || feature.id.trim().length === 0) {
      throw new GeoJsonImportError(
        "FEATURE_INVALID",
        `${path}.id`,
        "stable non-empty string feature id is required",
      );
    }
    const firstIndex = featureIdIndexes.get(feature.id);
    if (firstIndex !== undefined) {
      throw new GeoJsonImportError(
        "FEATURE_INVALID",
        `${path}.id`,
        `duplicate feature id ${JSON.stringify(feature.id)}; first declared at $.features[${firstIndex}].id`,
      );
    }
    featureIdIndexes.set(feature.id, index);
    if (feature.geometry === null || !isJsonObject(feature.geometry as unknown)) {
      throw new GeoJsonImportError("FEATURE_INVALID", `${path}.geometry`, "non-null geometry is required");
    }
    if (!isJsonObject(feature.properties)) {
      throw new GeoJsonImportError(
        "FEATURE_INVALID",
        `${path}.properties`,
        "properties must be a JSON object, not null",
      );
    }
    if (!isJsonValue(feature.properties)) {
      throw new GeoJsonImportError(
        "FEATURE_INVALID",
        `${path}.properties`,
        "properties contain an unsupported JSON value",
      );
    }
    try {
      assertValidGeometry(feature.geometry, crs);
    } catch (error) {
      const message =
        error instanceof GeometryValidationError
          ? error.failures.map((failure) => `${failure.path}: ${failure.message}`).join("; ")
          : error instanceof Error
            ? error.message
            : "invalid geometry";
      throw new GeoJsonImportError("GEOMETRY_INVALID", `${path}.geometry`, message);
    }
  });
}

function requireTimestamp(value: string, path: string): void {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== value) {
    throw new GeoJsonImportError("METADATA_MALFORMED", path, "must be a canonical UTC ISO-8601 timestamp");
  }
}
