import { assertDevelopmentBypassState, type DevelopmentBypassState } from "../../shared/governance.js";
import type { JsonObject, JsonValue } from "../../shared/json.js";
import { isJsonObject, isJsonValue } from "../../shared/json.js";
import { loadTsdfSource, type TsdfSourceRecord } from "../governance/tsdf-source.js";
import {
  isTribalGeometryCategory,
  TRIBAL_GEOMETRY_CATEGORIES,
  type TribalGeometryCategory,
} from "./coverage.js";

export type ConsentState = "not_applicable" | "unknown";

export interface SourceArchiveMemberReceipt {
  bytes: number;
  path: string;
  sha256: string;
}

export interface SourceReceipt {
  archive_members: readonly SourceArchiveMemberReceipt[];
  as_of: string | null;
  authority_limits: readonly string[];
  consent_state: ConsentState;
  content_type: string;
  exact_bytes: number;
  exact_bytes_sha256: string;
  feature_count: number | null;
  license: string;
  native_bounds: readonly [number, number, number, number] | null;
  native_crs: {
    code: string | null;
    wkt_sha256: string | null;
  };
  publisher: string;
  resolution_accuracy_statement: string;
  retrieved_at: string;
  schema_fields: readonly string[];
  source_id: string;
  source_title: string;
  source_uri: string;
  steward: string;
  terms: string;
  vintage: string | null;
}

export interface ArtifactClassification {
  basis: string;
  effective_tier_id: string;
  source_tier_ids: readonly (string | null)[];
  tsdf_source: TsdfSourceRecord;
}

export interface ComponentSourceDisposition {
  category: TribalGeometryCategory;
  disposition: "accepted" | "deferred" | "not_sourced";
  reason: string;
  source_ids: readonly string[];
}

export interface ArtifactCustodyMetadata {
  artifact_id: string;
  attribution: readonly string[];
  classification: ArtifactClassification;
  component_sources: readonly ComponentSourceDisposition[];
  consent: {
    note: string;
    status: ConsentState;
  };
  generated_at: string;
  governance: DevelopmentBypassState;
  limitations: readonly string[];
  schema_version: "1.0.0";
  source_receipts: readonly SourceReceipt[];
  stewardship: {
    geometry_owner_claimed: false;
    note: string;
    ownership_or_authority_limits: readonly string[];
  };
  transformation_history: readonly JsonObject[];
}

export class ArtifactCustodyError extends Error {
  public readonly path: string;

  public constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ArtifactCustodyError";
    this.path = path;
  }
}

/** Strictly parses the custody root embedded in standard GeoPackage metadata. */
export function parseArtifactCustodyMetadata(value: unknown): ArtifactCustodyMetadata {
  const root = object(value, "custody");
  exactKeys(
    root,
    [
      "artifact_id",
      "attribution",
      "classification",
      "component_sources",
      "consent",
      "generated_at",
      "governance",
      "limitations",
      "schema_version",
      "source_receipts",
      "stewardship",
      "transformation_history",
    ],
    "custody",
  );
  if (root.schema_version !== "1.0.0") {
    throw new ArtifactCustodyError("custody.schema_version", 'must equal "1.0.0"');
  }
  const artifactId = nonEmpty(root.artifact_id, "custody.artifact_id");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(artifactId)) {
    throw new ArtifactCustodyError("custody.artifact_id", "must be lowercase kebab-case");
  }
  timestamp(root.generated_at, "custody.generated_at");
  assertDevelopmentBypassState(root.governance);

  const classificationObject = object(root.classification, "custody.classification");
  exactKeys(
    classificationObject,
    ["basis", "effective_tier_id", "source_tier_ids", "tsdf_source"],
    "custody.classification",
  );
  const tsdfRecord = parseTsdfSourceRecord(
    classificationObject.tsdf_source,
    "custody.classification.tsdf_source",
  );
  const tsdfSource = loadTsdfSource(tsdfRecord);
  const sourceTierIds = array(
    classificationObject.source_tier_ids,
    "custody.classification.source_tier_ids",
  ).map((tier, index) =>
    tier === null ? null : nonEmpty(tier, `custody.classification.source_tier_ids[${index}]`),
  );
  const statedEffectiveTier = nonEmpty(
    classificationObject.effective_tier_id,
    "custody.classification.effective_tier_id",
  );

  const sourceReceipts = array(root.source_receipts, "custody.source_receipts").map((receipt, index) =>
    parseSourceReceipt(receipt, `custody.source_receipts[${index}]`),
  );
  if (sourceReceipts.length === 0) {
    throw new ArtifactCustodyError("custody.source_receipts", "must preserve at least one source receipt");
  }
  if (sourceTierIds.length !== sourceReceipts.length) {
    throw new ArtifactCustodyError(
      "custody.classification.source_tier_ids",
      "must contain exactly one explicit tier or null default for every source receipt",
    );
  }
  const effectiveTier = tsdfSource.effectiveTier(sourceTierIds);
  if (effectiveTier.id !== statedEffectiveTier) {
    throw new ArtifactCustodyError(
      "custody.classification.effective_tier_id",
      `states ${statedEffectiveTier}; loaded TsdfSource resolves ${effectiveTier.id}`,
    );
  }
  const sourceIds = new Set<string>();
  for (const [index, receipt] of sourceReceipts.entries()) {
    if (sourceIds.has(receipt.source_id)) {
      throw new ArtifactCustodyError(
        `custody.source_receipts[${index}].source_id`,
        `duplicates ${receipt.source_id}`,
      );
    }
    sourceIds.add(receipt.source_id);
  }

  const componentSources = array(root.component_sources, "custody.component_sources").map(
    (disposition, index) =>
      parseComponentSourceDisposition(disposition, `custody.component_sources[${index}]`, sourceIds),
  );
  const componentCategories = new Set(componentSources.map((component) => component.category));
  if (
    componentCategories.size !== componentSources.length ||
    componentCategories.size !== TRIBAL_GEOMETRY_CATEGORIES.length ||
    TRIBAL_GEOMETRY_CATEGORIES.some((category) => !componentCategories.has(category))
  ) {
    throw new ArtifactCustodyError(
      "custody.component_sources",
      "must contain each supported component category exactly once",
    );
  }

  const consentObject = object(root.consent, "custody.consent");
  exactKeys(consentObject, ["note", "status"], "custody.consent");
  const stewardshipObject = object(root.stewardship, "custody.stewardship");
  exactKeys(
    stewardshipObject,
    ["geometry_owner_claimed", "note", "ownership_or_authority_limits"],
    "custody.stewardship",
  );
  if (stewardshipObject.geometry_owner_claimed !== false) {
    throw new ArtifactCustodyError(
      "custody.stewardship.geometry_owner_claimed",
      "must remain false; the artifact does not establish ownership",
    );
  }

  return {
    artifact_id: artifactId,
    attribution: stringArray(root.attribution, "custody.attribution", true),
    classification: {
      basis: nonEmpty(classificationObject.basis, "custody.classification.basis"),
      effective_tier_id: statedEffectiveTier,
      source_tier_ids: sourceTierIds,
      tsdf_source: tsdfRecord,
    },
    component_sources: componentSources,
    consent: {
      note: nonEmpty(consentObject.note, "custody.consent.note"),
      status: consentState(consentObject.status, "custody.consent.status"),
    },
    generated_at: root.generated_at as string,
    governance: root.governance,
    limitations: stringArray(root.limitations, "custody.limitations", true),
    schema_version: "1.0.0",
    source_receipts: sourceReceipts,
    stewardship: {
      geometry_owner_claimed: false,
      note: nonEmpty(stewardshipObject.note, "custody.stewardship.note"),
      ownership_or_authority_limits: stringArray(
        stewardshipObject.ownership_or_authority_limits,
        "custody.stewardship.ownership_or_authority_limits",
        true,
      ),
    },
    transformation_history: array(root.transformation_history, "custody.transformation_history").map(
      (entry, index) => object(entry, `custody.transformation_history[${index}]`),
    ),
  };
}

function parseSourceReceipt(value: unknown, path: string): SourceReceipt {
  const source = object(value, path);
  exactKeys(
    source,
    [
      "archive_members",
      "as_of",
      "authority_limits",
      "consent_state",
      "content_type",
      "exact_bytes",
      "exact_bytes_sha256",
      "feature_count",
      "license",
      "native_bounds",
      "native_crs",
      "publisher",
      "resolution_accuracy_statement",
      "retrieved_at",
      "schema_fields",
      "source_id",
      "source_title",
      "source_uri",
      "steward",
      "terms",
      "vintage",
    ],
    path,
  );
  const nativeCrs = object(source.native_crs, `${path}.native_crs`);
  exactKeys(nativeCrs, ["code", "wkt_sha256"], `${path}.native_crs`);
  const archiveMembers = array(source.archive_members, `${path}.archive_members`).map((member, index) => {
    const memberPath = `${path}.archive_members[${index}]`;
    const memberObject = object(member, memberPath);
    exactKeys(memberObject, ["bytes", "path", "sha256"], memberPath);
    return {
      bytes: nonNegativeInteger(memberObject.bytes, `${memberPath}.bytes`),
      path: nonEmpty(memberObject.path, `${memberPath}.path`),
      sha256: sha256(memberObject.sha256, `${memberPath}.sha256`),
    };
  });
  const bounds = parseBounds(source.native_bounds, `${path}.native_bounds`);
  const featureCount = nullableNonNegativeInteger(source.feature_count, `${path}.feature_count`);
  timestamp(source.retrieved_at, `${path}.retrieved_at`);
  return {
    archive_members: archiveMembers,
    as_of: nullableNonEmpty(source.as_of, `${path}.as_of`),
    authority_limits: stringArray(source.authority_limits, `${path}.authority_limits`, true),
    consent_state: consentState(source.consent_state, `${path}.consent_state`),
    content_type: nonEmpty(source.content_type, `${path}.content_type`),
    exact_bytes: nonNegativeInteger(source.exact_bytes, `${path}.exact_bytes`),
    exact_bytes_sha256: sha256(source.exact_bytes_sha256, `${path}.exact_bytes_sha256`),
    feature_count: featureCount,
    license: nonEmpty(source.license, `${path}.license`),
    native_bounds: bounds,
    native_crs: {
      code: nullableNonEmpty(nativeCrs.code, `${path}.native_crs.code`),
      wkt_sha256:
        nativeCrs.wkt_sha256 === null ? null : sha256(nativeCrs.wkt_sha256, `${path}.native_crs.wkt_sha256`),
    },
    publisher: nonEmpty(source.publisher, `${path}.publisher`),
    resolution_accuracy_statement: nonEmpty(
      source.resolution_accuracy_statement,
      `${path}.resolution_accuracy_statement`,
    ),
    retrieved_at: source.retrieved_at as string,
    schema_fields: stringArray(source.schema_fields, `${path}.schema_fields`, false),
    source_id: nonEmpty(source.source_id, `${path}.source_id`),
    source_title: nonEmpty(source.source_title, `${path}.source_title`),
    source_uri: nonEmpty(source.source_uri, `${path}.source_uri`),
    steward: nonEmpty(source.steward, `${path}.steward`),
    terms: nonEmpty(source.terms, `${path}.terms`),
    vintage: nullableNonEmpty(source.vintage, `${path}.vintage`),
  };
}

function parseComponentSourceDisposition(
  value: unknown,
  path: string,
  knownSourceIds: ReadonlySet<string>,
): ComponentSourceDisposition {
  const disposition = object(value, path);
  exactKeys(disposition, ["category", "disposition", "reason", "source_ids"], path);
  if (!isTribalGeometryCategory(disposition.category)) {
    throw new ArtifactCustodyError(`${path}.category`, "is not a supported component category");
  }
  if (
    disposition.disposition !== "accepted" &&
    disposition.disposition !== "deferred" &&
    disposition.disposition !== "not_sourced"
  ) {
    throw new ArtifactCustodyError(`${path}.disposition`, "is not accepted, deferred, or not_sourced");
  }
  const ids = stringArray(disposition.source_ids, `${path}.source_ids`, false);
  for (const sourceId of ids) {
    if (!knownSourceIds.has(sourceId)) {
      throw new ArtifactCustodyError(`${path}.source_ids`, `references unknown source ${sourceId}`);
    }
  }
  if (disposition.disposition === "accepted" && ids.length === 0) {
    throw new ArtifactCustodyError(`${path}.source_ids`, "accepted component requires a source receipt");
  }
  return {
    category: disposition.category,
    disposition: disposition.disposition,
    reason: nonEmpty(disposition.reason, `${path}.reason`),
    source_ids: ids,
  };
}

function parseTsdfSourceRecord(value: unknown, path: string): TsdfSourceRecord {
  const source = object(value, path);
  exactKeys(source, ["default_tier_id", "framework_version", "source_sha256", "source_title", "tiers"], path);
  const tiers = array(source.tiers, `${path}.tiers`).map((tier, index) => {
    const tierPath = `${path}.tiers[${index}]`;
    const tierObject = object(tier, tierPath);
    exactKeys(tierObject, ["behavior", "description", "id", "label", "restrictiveness_order"], tierPath);
    const behavior = object(tierObject.behavior, `${tierPath}.behavior`);
    exactKeys(
      behavior,
      ["export_allowed", "network_allowed", "public_distribution_allowed"],
      `${tierPath}.behavior`,
    );
    return {
      behavior: {
        export_allowed: bool(behavior.export_allowed, `${tierPath}.behavior.export_allowed`),
        network_allowed: bool(behavior.network_allowed, `${tierPath}.behavior.network_allowed`),
        public_distribution_allowed: bool(
          behavior.public_distribution_allowed,
          `${tierPath}.behavior.public_distribution_allowed`,
        ),
      },
      description: nonEmpty(tierObject.description, `${tierPath}.description`),
      id: nonEmpty(tierObject.id, `${tierPath}.id`),
      label: nonEmpty(tierObject.label, `${tierPath}.label`),
      restrictiveness_order: nonNegativeInteger(
        tierObject.restrictiveness_order,
        `${tierPath}.restrictiveness_order`,
      ),
    };
  });
  return {
    default_tier_id: nonEmpty(source.default_tier_id, `${path}.default_tier_id`),
    framework_version: nonEmpty(source.framework_version, `${path}.framework_version`),
    source_sha256: sha256(source.source_sha256, `${path}.source_sha256`),
    source_title: nonEmpty(source.source_title, `${path}.source_title`),
    tiers,
  };
}

function object(value: unknown, path: string): JsonObject {
  if (!isJsonObject(value)) throw new ArtifactCustodyError(path, "must be a JSON object");
  return value;
}

function array(value: unknown, path: string): JsonValue[] {
  if (!Array.isArray(value) || !value.every(isJsonValue)) {
    throw new ArtifactCustodyError(path, "must be a JSON array");
  }
  return value;
}

function exactKeys(value: JsonObject, expected: readonly string[], path: string): void {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new ArtifactCustodyError(path, "has missing or unexpected fields");
  }
}

function nonEmpty(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ArtifactCustodyError(path, "must be a non-empty string");
  }
  return value;
}

function nullableNonEmpty(value: unknown, path: string): string | null {
  return value === null ? null : nonEmpty(value, path);
}

function sha256(value: unknown, path: string): string {
  const digest = nonEmpty(value, path);
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new ArtifactCustodyError(path, "must be a lowercase SHA-256 digest");
  }
  return digest;
}

function timestamp(value: unknown, path: string): void {
  const text = nonEmpty(value, path);
  const date = new Date(text);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== text) {
    throw new ArtifactCustodyError(path, "must be a canonical UTC ISO-8601 timestamp");
  }
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ArtifactCustodyError(path, "must be a non-negative safe integer");
  }
  return value;
}

function nullableNonNegativeInteger(value: unknown, path: string): number | null {
  return value === null ? null : nonNegativeInteger(value, path);
}

function stringArray(value: unknown, path: string, requireMember: boolean): string[] {
  const values = array(value, path).map((member, index) => nonEmpty(member, `${path}[${index}]`));
  if (requireMember && values.length === 0) {
    throw new ArtifactCustodyError(path, "must not be empty");
  }
  return values;
}

function consentState(value: unknown, path: string): ConsentState {
  if (value !== "not_applicable" && value !== "unknown") {
    throw new ArtifactCustodyError(path, 'must be "unknown" or "not_applicable"');
  }
  return value;
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new ArtifactCustodyError(path, "must be boolean");
  return value;
}

function parseBounds(value: unknown, path: string): [number, number, number, number] | null {
  if (value === null) return null;
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    !value.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))
  ) {
    throw new ArtifactCustodyError(path, "must be null or four finite bounds coordinates");
  }
  const [minX, minY, maxX, maxY] = value as number[];
  if (minX === undefined || minY === undefined || maxX === undefined || maxY === undefined) {
    throw new ArtifactCustodyError(path, "bounds are incomplete");
  }
  if (minX > maxX || minY > maxY) throw new ArtifactCustodyError(path, "minimum exceeds maximum");
  return [minX, minY, maxX, maxY];
}
