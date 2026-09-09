import type { JsonObject, JsonValue } from "../../shared/json.js";
import { isJsonObject } from "../../shared/json.js";
import { stableStringify } from "../../shared/stable-json.js";
import { createWashingtonAoiSnapshot } from "../aoi/wa-buffer.js";
import { sha256Text } from "../hash.js";
import { WASHINGTON_SELECTED_AIANNH_FEATURE_COUNT } from "./census-aiannh.js";
import { isTribalGeometryCategory, type TribalGeometryCategory } from "./coverage.js";
import type { SourceReceipt } from "./custody.js";
import type { NationRegistryRecord } from "./nation-registry.js";
import type { TribalPresentationContext } from "./presentation.js";

export const WA_TRIBAL_SOURCE_PROFILE_SCHEMA_VERSION = "1.0.0" as const;
export const WA_TRIBAL_SOURCE_PROFILE_SOURCE_COUNT = 5 as const;
export const WA_TRIBAL_NATIVE_FEATURE_INVENTORY_COUNT = WASHINGTON_SELECTED_AIANNH_FEATURE_COUNT + 1;

export interface WaTribalSourceProfileReceipt {
  exact_bytes_sha256: string;
  feature_count: number;
  source_id: string;
}

export interface WaTribalBorderContextRecord {
  formal_name: string;
  source_feature_id: string;
}

export interface WaTribalSourceProfile {
  border_context_sha256: string;
  native_feature_inventory_sha256: string;
  registry_sha256: string;
  schema_version: typeof WA_TRIBAL_SOURCE_PROFILE_SCHEMA_VERSION;
  semantic_context_sha256: string;
  sources: readonly WaTribalSourceProfileReceipt[];
}

interface WaTribalNativeFeatureInventoryBase {
  source_attributes: JsonObject;
  source_feature_id: string;
  source_geometry_sha256: string;
}

export interface WaTribalStateNativeFeatureInventoryRecord extends WaTribalNativeFeatureInventoryBase {
  feature_role: "washington_state_source";
  source_table: "wa_state_source";
}

export interface WaTribalTribalNativeFeatureInventoryRecord extends WaTribalNativeFeatureInventoryBase {
  category: TribalGeometryCategory;
  feature_role: "tribal_feature";
  formal_nation_name: string | null;
  nation_id: string | null;
  registry_scope: "border_context" | "goia_29";
  source_name: string;
  source_table: "tribal_features";
}

export type WaTribalNativeFeatureInventoryRecord =
  | WaTribalStateNativeFeatureInventoryRecord
  | WaTribalTribalNativeFeatureInventoryRecord;

export interface VerifyWaTribalSourceProfileInput {
  borderContext: readonly WaTribalBorderContextRecord[];
  context: TribalPresentationContext;
  nativeFeatures: readonly WaTribalNativeFeatureInventoryRecord[];
  profile: WaTribalSourceProfile;
  registry: readonly NationRegistryRecord[];
  sourceReceipts: readonly Pick<SourceReceipt, "exact_bytes_sha256" | "feature_count" | "source_id">[];
}

export class WaTribalSourceProfileError extends Error {
  public constructor(
    public readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "WaTribalSourceProfileError";
  }
}

/** Strictly parses the tracked, non-coordinate trust profile for the five-source WA slice. */
export function parseWaTribalSourceProfile(value: unknown): WaTribalSourceProfile {
  const root = requireObject(value, "source_profile");
  requireExactKeys(
    root,
    [
      "border_context_sha256",
      "native_feature_inventory_sha256",
      "registry_sha256",
      "schema_version",
      "semantic_context_sha256",
      "sources",
    ],
    "source_profile",
  );
  if (root.schema_version !== WA_TRIBAL_SOURCE_PROFILE_SCHEMA_VERSION) {
    throw new WaTribalSourceProfileError(
      "source_profile.schema_version",
      `must equal ${WA_TRIBAL_SOURCE_PROFILE_SCHEMA_VERSION}`,
    );
  }
  const borderContextSha256 = requireSha256(
    root.border_context_sha256,
    "source_profile.border_context_sha256",
  );
  const nativeFeatureInventorySha256 = requireSha256(
    root.native_feature_inventory_sha256,
    "source_profile.native_feature_inventory_sha256",
  );
  const registrySha256 = requireSha256(root.registry_sha256, "source_profile.registry_sha256");
  const semanticContextSha256 = requireSha256(
    root.semantic_context_sha256,
    "source_profile.semantic_context_sha256",
  );
  if (!Array.isArray(root.sources)) {
    throw new WaTribalSourceProfileError("source_profile.sources", "must be an array");
  }
  if (root.sources.length !== WA_TRIBAL_SOURCE_PROFILE_SOURCE_COUNT) {
    throw new WaTribalSourceProfileError(
      "source_profile.sources",
      `must contain exactly ${WA_TRIBAL_SOURCE_PROFILE_SOURCE_COUNT} source receipts`,
    );
  }
  const seen = new Set<string>();
  const sources = root.sources.map((value, index): WaTribalSourceProfileReceipt => {
    const path = `source_profile.sources[${index}]`;
    const source = requireObject(value, path);
    requireExactKeys(source, ["exact_bytes_sha256", "feature_count", "source_id"], path);
    const sourceId = requireSourceId(source.source_id, `${path}.source_id`);
    if (seen.has(sourceId)) {
      throw new WaTribalSourceProfileError(`${path}.source_id`, `duplicates ${sourceId}`);
    }
    seen.add(sourceId);
    return {
      exact_bytes_sha256: requireSha256(source.exact_bytes_sha256, `${path}.exact_bytes_sha256`),
      feature_count: requirePositiveInteger(source.feature_count, `${path}.feature_count`),
      source_id: sourceId,
    };
  });
  return {
    border_context_sha256: borderContextSha256,
    native_feature_inventory_sha256: nativeFeatureInventorySha256,
    registry_sha256: registrySha256,
    schema_version: WA_TRIBAL_SOURCE_PROFILE_SCHEMA_VERSION,
    semantic_context_sha256: semanticContextSha256,
    sources: sources.sort((left, right) => compareCodePoints(left.source_id, right.source_id)),
  };
}

/**
 * Builds the stable trust representation of a freshly validated presentation context.
 * Runtime CRS derivatives are represented by their verified hashes, bounds, and lineage
 * instead of cross-V8 floating-point coordinate arrays.
 */
export function createWaTribalSemanticContextSnapshot(context: TribalPresentationContext): JsonObject {
  const semanticContext = structuredClone(context) as unknown as JsonObject;
  delete semanticContext.artifact_sha256;
  semanticContext.aoi = createWashingtonAoiSnapshot(context.aoi);
  semanticContext.features = context.features.map((feature) => {
    const semanticFeature = structuredClone(feature) as unknown as JsonObject;
    delete semanticFeature.geometry;
    return semanticFeature;
  });
  return semanticContext;
}

/** Hashes the stable, complete semantic trust representation of a freshly validated context. */
export function createWaTribalSemanticContextSha256(context: TribalPresentationContext): Promise<string> {
  return sha256Text(stableStringify(createWaTribalSemanticContextSnapshot(context) as JsonValue, false));
}

/** Hashes the canonical two-record border identity array used by the trusted profile. */
export function createWaTribalBorderContextSha256(
  borderContext: readonly WaTribalBorderContextRecord[],
): Promise<string> {
  const canonical = validateBorderContext(borderContext);
  return sha256Text(stableStringify(canonical as unknown as JsonValue, false));
}

/** Hashes the canonical validated-registry JSON representation used by the trusted profile. */
export function createWaTribalRegistrySha256(registry: readonly NationRegistryRecord[]): Promise<string> {
  return sha256Text(stableStringify(registry as unknown as JsonValue, false));
}

/** Hashes the canonical one-State plus 52-Tribal exact native-feature custody inventory. */
export async function createWaTribalNativeFeatureInventorySha256(
  records: readonly WaTribalNativeFeatureInventoryRecord[],
): Promise<string> {
  if (records.length !== WA_TRIBAL_NATIVE_FEATURE_INVENTORY_COUNT) {
    throw new WaTribalSourceProfileError(
      "native_feature_inventory",
      `must contain exactly one State source plus ${WASHINGTON_SELECTED_AIANNH_FEATURE_COUNT} Tribal features`,
    );
  }
  const stateRecords = records.filter((record) => record.feature_role === "washington_state_source");
  const tribalRecords = records.filter((record) => record.feature_role === "tribal_feature");
  if (stateRecords.length !== 1 || tribalRecords.length !== WASHINGTON_SELECTED_AIANNH_FEATURE_COUNT) {
    throw new WaTribalSourceProfileError(
      "native_feature_inventory",
      `must contain exactly one State source plus ${WASHINGTON_SELECTED_AIANNH_FEATURE_COUNT} Tribal features`,
    );
  }

  const seen = new Set<string>();
  const canonical = await Promise.all(
    records.map(async (record, index) => {
      const path = `native_feature_inventory[${index}]`;
      const inventoryKey = `${record.feature_role}\u0000${record.source_feature_id}`;
      if (seen.has(inventoryKey)) {
        throw new WaTribalSourceProfileError(
          `${path}.source_feature_id`,
          "duplicates a native feature record",
        );
      }
      seen.add(inventoryKey);
      const sourceGeometrySha256 = requireSha256(
        record.source_geometry_sha256,
        `${path}.source_geometry_sha256`,
      );
      const sourceAttributesSha256 = await sha256Text(
        stableStringify(record.source_attributes as JsonValue, false),
      );

      if (record.feature_role === "washington_state_source") {
        assertStateInventoryRecord(record, path);
        return {
          category: null,
          feature_role: record.feature_role,
          formal_nation_name: null,
          nation_id: null,
          registry_scope: null,
          source_attributes_sha256: sourceAttributesSha256,
          source_feature_id: record.source_feature_id,
          source_geometry_sha256: sourceGeometrySha256,
          source_name: "Washington",
          source_table: record.source_table,
        };
      }

      assertTribalInventoryRecord(record, path);
      return {
        category: record.category,
        feature_role: record.feature_role,
        formal_nation_name: record.formal_nation_name,
        nation_id: record.nation_id,
        registry_scope: record.registry_scope,
        source_attributes_sha256: sourceAttributesSha256,
        source_feature_id: record.source_feature_id,
        source_geometry_sha256: sourceGeometrySha256,
        source_name: record.source_name,
        source_table: record.source_table,
      };
    }),
  );
  canonical.sort((left, right) => {
    const role = compareCodePoints(left.feature_role, right.feature_role);
    return role === 0 ? compareCodePoints(left.source_feature_id, right.source_feature_id) : role;
  });
  return sha256Text(stableStringify(canonical as unknown as JsonValue, false));
}

/** Verifies exact five-source receipt inventory and the canonical embedded registry digest. */
export async function verifyWaTribalSourceProfile(input: VerifyWaTribalSourceProfileInput): Promise<void> {
  const profile = parseWaTribalSourceProfile(input.profile);
  const semanticContextSha256 = await createWaTribalSemanticContextSha256(input.context);
  if (semanticContextSha256 !== profile.semantic_context_sha256) {
    throw new WaTribalSourceProfileError(
      "semantic_context",
      "canonical validated semantic-context SHA-256 does not match the trusted source profile",
    );
  }
  const borderContextSha256 = await createWaTribalBorderContextSha256(input.borderContext);
  if (borderContextSha256 !== profile.border_context_sha256) {
    throw new WaTribalSourceProfileError(
      "border_context",
      "canonical border-context SHA-256 does not match the trusted source profile",
    );
  }
  const registrySha256 = await createWaTribalRegistrySha256(input.registry);
  if (registrySha256 !== profile.registry_sha256) {
    throw new WaTribalSourceProfileError(
      "registry",
      "canonical registry SHA-256 does not match the trusted source profile",
    );
  }
  const nativeFeatureInventorySha256 = await createWaTribalNativeFeatureInventorySha256(input.nativeFeatures);
  if (nativeFeatureInventorySha256 !== profile.native_feature_inventory_sha256) {
    throw new WaTribalSourceProfileError(
      "native_feature_inventory",
      "canonical State/Tribal native-feature SHA-256 does not match the trusted source profile",
    );
  }
  if (input.sourceReceipts.length !== WA_TRIBAL_SOURCE_PROFILE_SOURCE_COUNT) {
    throw new WaTribalSourceProfileError(
      "custody.source_receipts",
      `must contain exactly ${WA_TRIBAL_SOURCE_PROFILE_SOURCE_COUNT} trusted source receipts`,
    );
  }
  const actual = input.sourceReceipts
    .map((receipt, index): WaTribalSourceProfileReceipt => {
      if (receipt.feature_count === null) {
        throw new WaTribalSourceProfileError(
          `custody.source_receipts[${index}].feature_count`,
          "must be explicit for the trusted source profile",
        );
      }
      return {
        exact_bytes_sha256: receipt.exact_bytes_sha256,
        feature_count: receipt.feature_count,
        source_id: receipt.source_id,
      };
    })
    .sort((left, right) => compareCodePoints(left.source_id, right.source_id));
  if (
    stableStringify(actual as unknown as JsonValue, false) !==
    stableStringify(profile.sources as unknown as JsonValue, false)
  ) {
    throw new WaTribalSourceProfileError(
      "custody.source_receipts",
      "ID, exact-byte SHA-256, or feature-count inventory does not match the trusted source profile",
    );
  }
}

function assertStateInventoryRecord(record: WaTribalStateNativeFeatureInventoryRecord, path: string): void {
  if (record.source_table !== "wa_state_source" || record.source_feature_id !== "53") {
    throw new WaTribalSourceProfileError(path, "State source must bind wa_state_source feature 53");
  }
  for (const [field, expected] of [
    ["STATEFP", "53"],
    ["GEOID", "53"],
    ["STUSPS", "WA"],
    ["NAME", "Washington"],
  ] as const) {
    if (record.source_attributes[field] !== expected) {
      throw new WaTribalSourceProfileError(`${path}.source_attributes.${field}`, `must equal ${expected}`);
    }
  }
}

function assertTribalInventoryRecord(record: WaTribalTribalNativeFeatureInventoryRecord, path: string): void {
  if (record.source_table !== "tribal_features") {
    throw new WaTribalSourceProfileError(`${path}.source_table`, "must equal tribal_features");
  }
  if (!/^\d{4}[RT]$/.test(record.source_feature_id)) {
    throw new WaTribalSourceProfileError(`${path}.source_feature_id`, "must be a Census AIANNH GEOID");
  }
  if (!isTribalGeometryCategory(record.category)) {
    throw new WaTribalSourceProfileError(`${path}.category`, "must be a supported Tribal category");
  }
  if (typeof record.source_name !== "string" || record.source_name.trim().length === 0) {
    throw new WaTribalSourceProfileError(`${path}.source_name`, "must be non-empty text");
  }
  if (record.source_attributes.NAMELSAD !== record.source_name) {
    throw new WaTribalSourceProfileError(`${path}.source_name`, "must equal source_attributes.NAMELSAD");
  }
  if (
    record.formal_nation_name !== null &&
    (typeof record.formal_nation_name !== "string" || record.formal_nation_name.trim().length === 0)
  ) {
    throw new WaTribalSourceProfileError(`${path}.formal_nation_name`, "must be null or non-empty text");
  }
  if (record.registry_scope === "goia_29") {
    if (typeof record.nation_id !== "string" || record.nation_id.trim().length === 0) {
      throw new WaTribalSourceProfileError(`${path}.nation_id`, "GOIA feature must bind a Nation ID");
    }
    return;
  }
  if (record.registry_scope !== "border_context") {
    throw new WaTribalSourceProfileError(`${path}.registry_scope`, "is unsupported");
  }
  if (record.nation_id !== null || record.formal_nation_name === null) {
    throw new WaTribalSourceProfileError(
      path,
      "border-context feature must omit Nation ID and bind a formal Nation name",
    );
  }
}

function validateBorderContext(
  records: readonly WaTribalBorderContextRecord[],
): WaTribalBorderContextRecord[] {
  if (records.length !== 2) {
    throw new WaTribalSourceProfileError("border_context", "must contain exactly two identity records");
  }
  const sourceIds = new Set<string>();
  const canonical = records.map((record, index) => {
    const path = `border_context[${index}]`;
    if (!/^\d{4}[RT]$/.test(record.source_feature_id)) {
      throw new WaTribalSourceProfileError(`${path}.source_feature_id`, "must be a Census AIANNH GEOID");
    }
    if (sourceIds.has(record.source_feature_id)) {
      throw new WaTribalSourceProfileError(`${path}.source_feature_id`, "duplicates a border identity");
    }
    if (typeof record.formal_name !== "string" || record.formal_name.trim().length === 0) {
      throw new WaTribalSourceProfileError(`${path}.formal_name`, "must be non-empty text");
    }
    sourceIds.add(record.source_feature_id);
    return { formal_name: record.formal_name, source_feature_id: record.source_feature_id };
  });
  return canonical.sort((left, right) => compareCodePoints(left.source_feature_id, right.source_feature_id));
}

function requireObject(value: unknown, path: string): JsonObject {
  if (!isJsonObject(value)) throw new WaTribalSourceProfileError(path, "must be a JSON object");
  return value;
}

function requireExactKeys(value: JsonObject, expected: readonly string[], path: string): void {
  const keys = Object.keys(value).sort(compareCodePoints);
  const wanted = [...expected].sort(compareCodePoints);
  if (stableStringify(keys, false) !== stableStringify(wanted, false)) {
    throw new WaTribalSourceProfileError(path, "has missing or unexpected fields");
  }
}

function requireSha256(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new WaTribalSourceProfileError(path, "must be a lowercase SHA-256 digest");
  }
  return value;
}

function requireSourceId(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    throw new WaTribalSourceProfileError(path, "must be a lowercase kebab-case source ID");
  }
  return value;
}

function requirePositiveInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new WaTribalSourceProfileError(path, "must be a positive safe integer");
  }
  return value;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
