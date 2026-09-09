import type { JsonValue } from "../shared/json.js";
import { isJsonObject, isJsonValue } from "../shared/json.js";
import { isSupportedCrs, type SupportedCrsCode } from "./crs.js";

export type LayerRole = "context" | "hard_exclusion" | "opportunity_result" | "resource" | "soft_constraint";

export interface LayerUnits {
  /** Physical or modeled quantity represented by values on this layer. */
  quantity: string;
  /** Unambiguous unit label, or `dimensionless` where appropriate. */
  unit: string;
}

export interface NativeResolution {
  description: string;
  unit: string;
  /** Null only when a scalar resolution does not apply, such as authored vectors. */
  value: number | null;
}

export interface LayerProvenance {
  acquired_at: string | null;
  license: string;
  limitations: string[];
  source_organization: string;
  /** Hash of upstream source bytes when available; never a hash of an object containing itself. */
  source_sha256: string | null;
  source_title: string;
  source_uri: string | null;
  synthetic: boolean;
}

export interface LayerUncertainty {
  description: string;
  quantitative_attribute: string | null;
  representation: "attribute" | "not_quantified" | "range";
}

export interface AbsenceSemantics {
  missing: string;
  outside_coverage: string;
  zero: string;
}

export interface CoordinateTransformationRecord {
  operation: "proj4";
  performed_at: string;
  preserves_extra_dimensions: true;
  reason: string;
  source_crs: SupportedCrsCode;
  target_crs: SupportedCrsCode;
}

/** Source custody fields are opaque JSON so the adapter preserves, rather than interprets, them. */
export interface SourceCustodyMetadata {
  consent: JsonValue | null;
  governance: JsonValue | null;
  ownership: JsonValue | null;
  source_classification: JsonValue | null;
}

export interface LayerMetadata {
  absence_semantics: AbsenceSemantics;
  authoritative_source_crs: SupportedCrsCode;
  id: string;
  name: string;
  native_resolution: NativeResolution;
  provenance: LayerProvenance;
  role: LayerRole;
  source_custody: SourceCustodyMetadata;
  transformations: CoordinateTransformationRecord[];
  uncertainty: LayerUncertainty;
  units: LayerUnits;
}

export class LayerMetadataError extends Error {
  public readonly path: string;

  public constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "LayerMetadataError";
    this.path = path;
  }
}

/** Validates the full layer metadata custody contract and returns the same JSON value narrowed. */
export function parseLayerMetadata(value: unknown, path = "layer"): LayerMetadata {
  const object = requireObject(value, path);
  requireExactKeys(
    object,
    [
      "absence_semantics",
      "authoritative_source_crs",
      "id",
      "name",
      "native_resolution",
      "provenance",
      "role",
      "source_custody",
      "transformations",
      "uncertainty",
      "units",
    ],
    path,
  );

  const id = requireNonEmptyString(object.id, `${path}.id`);
  const name = requireNonEmptyString(object.name, `${path}.name`);
  const role = parseRole(object.role, `${path}.role`);
  const authoritativeSourceCrs = parseCrs(
    object.authoritative_source_crs,
    `${path}.authoritative_source_crs`,
  );

  return {
    absence_semantics: parseAbsenceSemantics(object.absence_semantics, `${path}.absence_semantics`),
    authoritative_source_crs: authoritativeSourceCrs,
    id,
    name,
    native_resolution: parseNativeResolution(object.native_resolution, `${path}.native_resolution`),
    provenance: parseProvenance(object.provenance, `${path}.provenance`),
    role,
    source_custody: parseSourceCustody(object.source_custody, `${path}.source_custody`),
    transformations: parseTransformations(object.transformations, `${path}.transformations`),
    uncertainty: parseUncertainty(object.uncertainty, `${path}.uncertainty`),
    units: parseUnits(object.units, `${path}.units`),
  };
}

/** Ensures current coordinate CRS follows an unbroken history from authoritative source CRS. */
export function assertTransformationChain(
  metadata: LayerMetadata,
  coordinateCrs: SupportedCrsCode,
  path = "layer.transformations",
): void {
  let expectedSource = metadata.authoritative_source_crs;
  for (const [index, transformation] of metadata.transformations.entries()) {
    if (transformation.source_crs !== expectedSource) {
      throw new LayerMetadataError(
        `${path}[${index}].source_crs`,
        `expected ${expectedSource} to continue the transformation chain, received ${transformation.source_crs}`,
      );
    }
    if (transformation.source_crs === transformation.target_crs) {
      throw new LayerMetadataError(
        `${path}[${index}]`,
        "source and target CRS are identical; relabel/no-op records are forbidden",
      );
    }
    expectedSource = transformation.target_crs;
  }

  if (expectedSource !== coordinateCrs) {
    throw new LayerMetadataError(
      path,
      `coordinate CRS ${coordinateCrs} contradicts the transformation chain ending in ${expectedSource}`,
    );
  }
}

function parseAbsenceSemantics(value: unknown, path: string): AbsenceSemantics {
  const object = requireObject(value, path);
  requireExactKeys(object, ["missing", "outside_coverage", "zero"], path);
  return {
    missing: requireNonEmptyString(object.missing, `${path}.missing`),
    outside_coverage: requireNonEmptyString(object.outside_coverage, `${path}.outside_coverage`),
    zero: requireNonEmptyString(object.zero, `${path}.zero`),
  };
}

function parseNativeResolution(value: unknown, path: string): NativeResolution {
  const object = requireObject(value, path);
  requireExactKeys(object, ["description", "unit", "value"], path);
  const resolution = object.value;
  if (resolution !== null && (typeof resolution !== "number" || resolution <= 0)) {
    throw new LayerMetadataError(`${path}.value`, "must be null or a finite number greater than zero");
  }
  return {
    description: requireNonEmptyString(object.description, `${path}.description`),
    unit: requireNonEmptyString(object.unit, `${path}.unit`),
    value: resolution,
  };
}

function parseProvenance(value: unknown, path: string): LayerProvenance {
  const object = requireObject(value, path);
  requireExactKeys(
    object,
    [
      "acquired_at",
      "license",
      "limitations",
      "source_organization",
      "source_sha256",
      "source_title",
      "source_uri",
      "synthetic",
    ],
    path,
  );
  if (typeof object.synthetic !== "boolean") {
    throw new LayerMetadataError(`${path}.synthetic`, "must be a boolean");
  }
  const limitations = requireStringArray(object.limitations, `${path}.limitations`);
  if (limitations.length === 0) {
    throw new LayerMetadataError(`${path}.limitations`, "must state at least one limitation");
  }

  return {
    acquired_at: requireNullableTimestamp(object.acquired_at, `${path}.acquired_at`),
    license: requireNonEmptyString(object.license, `${path}.license`),
    limitations,
    source_organization: requireNonEmptyString(object.source_organization, `${path}.source_organization`),
    source_sha256: requireNullableSha256(object.source_sha256, `${path}.source_sha256`),
    source_title: requireNonEmptyString(object.source_title, `${path}.source_title`),
    source_uri: requireNullableString(object.source_uri, `${path}.source_uri`),
    synthetic: object.synthetic,
  };
}

function parseSourceCustody(value: unknown, path: string): SourceCustodyMetadata {
  const object = requireObject(value, path);
  requireExactKeys(object, ["consent", "governance", "ownership", "source_classification"], path);
  for (const key of ["consent", "governance", "ownership", "source_classification"] as const) {
    if (!isJsonValue(object[key])) {
      throw new LayerMetadataError(`${path}.${key}`, "must be a JSON value or null");
    }
  }
  return {
    consent: object.consent as JsonValue,
    governance: object.governance as JsonValue,
    ownership: object.ownership as JsonValue,
    source_classification: object.source_classification as JsonValue,
  };
}

function parseTransformations(value: unknown, path: string): CoordinateTransformationRecord[] {
  if (!Array.isArray(value)) {
    throw new LayerMetadataError(path, "must be an array");
  }
  return value.map((member, index) => {
    const itemPath = `${path}[${index}]`;
    const object = requireObject(member, itemPath);
    requireExactKeys(
      object,
      ["operation", "performed_at", "preserves_extra_dimensions", "reason", "source_crs", "target_crs"],
      itemPath,
    );
    if (object.operation !== "proj4") {
      throw new LayerMetadataError(`${itemPath}.operation`, 'must equal "proj4"');
    }
    if (object.preserves_extra_dimensions !== true) {
      throw new LayerMetadataError(`${itemPath}.preserves_extra_dimensions`, "must equal true");
    }
    return {
      operation: "proj4",
      performed_at: requireTimestamp(object.performed_at, `${itemPath}.performed_at`),
      preserves_extra_dimensions: true,
      reason: requireNonEmptyString(object.reason, `${itemPath}.reason`),
      source_crs: parseCrs(object.source_crs, `${itemPath}.source_crs`),
      target_crs: parseCrs(object.target_crs, `${itemPath}.target_crs`),
    };
  });
}

function parseUncertainty(value: unknown, path: string): LayerUncertainty {
  const object = requireObject(value, path);
  requireExactKeys(object, ["description", "quantitative_attribute", "representation"], path);
  const representation = object.representation;
  if (representation !== "attribute" && representation !== "not_quantified" && representation !== "range") {
    throw new LayerMetadataError(
      `${path}.representation`,
      'must be "attribute", "not_quantified", or "range"',
    );
  }
  return {
    description: requireNonEmptyString(object.description, `${path}.description`),
    quantitative_attribute: requireNullableString(
      object.quantitative_attribute,
      `${path}.quantitative_attribute`,
    ),
    representation,
  };
}

function parseUnits(value: unknown, path: string): LayerUnits {
  const object = requireObject(value, path);
  requireExactKeys(object, ["quantity", "unit"], path);
  return {
    quantity: requireNonEmptyString(object.quantity, `${path}.quantity`),
    unit: requireNonEmptyString(object.unit, `${path}.unit`),
  };
}

function parseRole(value: unknown, path: string): LayerRole {
  if (
    value !== "context" &&
    value !== "hard_exclusion" &&
    value !== "opportunity_result" &&
    value !== "resource" &&
    value !== "soft_constraint"
  ) {
    throw new LayerMetadataError(path, "is not a supported layer role");
  }
  return value;
}

function parseCrs(value: unknown, path: string): SupportedCrsCode {
  if (!isSupportedCrs(value)) {
    throw new LayerMetadataError(path, "must be a supported exact EPSG identifier");
  }
  return value;
}

function requireObject(value: unknown, path: string): Record<string, JsonValue> {
  if (!isJsonObject(value)) {
    throw new LayerMetadataError(path, "must be a JSON object");
  }
  return value;
}

function requireExactKeys(
  object: Record<string, JsonValue>,
  expected: readonly string[],
  path: string,
): void {
  const keys = Object.keys(object).sort();
  const sortedExpected = [...expected].sort();
  if (keys.length !== sortedExpected.length || keys.some((key, index) => key !== sortedExpected[index])) {
    throw new LayerMetadataError(path, "has missing or unexpected fields");
  }
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new LayerMetadataError(path, "must be a non-empty string");
  }
  return value;
}

function requireNullableString(value: unknown, path: string): string | null {
  if (value === null) return null;
  return requireNonEmptyString(value, path);
}

function requireStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    throw new LayerMetadataError(path, "must be an array of strings");
  }
  return value.map((member, index) => requireNonEmptyString(member, `${path}[${index}]`));
}

function requireNullableSha256(value: unknown, path: string): string | null {
  if (value === null) return null;
  const digest = requireNonEmptyString(value, path);
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new LayerMetadataError(path, "must be null or 64 lowercase hexadecimal characters");
  }
  return digest;
}

function requireNullableTimestamp(value: unknown, path: string): string | null {
  if (value === null) return null;
  return requireTimestamp(value, path);
}

function requireTimestamp(value: unknown, path: string): string {
  const timestamp = requireNonEmptyString(value, path);
  const date = new Date(timestamp);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== timestamp) {
    throw new LayerMetadataError(path, "must be a canonical UTC ISO-8601 timestamp");
  }
  return timestamp;
}
