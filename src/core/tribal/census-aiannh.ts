import type { JsonObject } from "../../shared/json.js";
import type { TribalGeometryCategory } from "./coverage.js";
import type { NationRegistryRecord } from "./nation-registry.js";
import { validateNationRegistry } from "./nation-registry.js";

export const CENSUS_2025_AIANNH_SOURCE_ID = "census-2025-aiannh-gpkg" as const;
export const WASHINGTON_GOIA_AIANNH_COMPONENT_COUNT = 50 as const;
export const WASHINGTON_BORDER_CONTEXT_AIANNH_COMPONENT_COUNT = 2 as const;
export const WASHINGTON_SELECTED_AIANNH_FEATURE_COUNT = 52 as const;

export type CensusAiannhRegistryScope = "border_context" | "goia_29";

export interface CensusAiannhFeatureBinding {
  category: TribalGeometryCategory;
  formal_nation_name: string | null;
  nation_id: string | null;
  registry_scope: CensusAiannhRegistryScope;
  source_attributes: JsonObject;
  source_feature_id: string;
}

export class CensusAiannhValidationError extends Error {
  public readonly path: string;

  public constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "CensusAiannhValidationError";
    this.path = path;
  }
}

/** Builds the exact Census GEOID to GOIA Nation crosswalk carried by the 29-row registry. */
export function buildCensusAiannhRegistryCrosswalk(
  records: readonly NationRegistryRecord[],
): ReadonlyMap<string, NationRegistryRecord> {
  const crosswalk = new Map<string, NationRegistryRecord>();
  for (const nation of validateNationRegistry(records)) {
    for (const identifier of nation.source_identifiers) {
      if (
        identifier.source_id !== CENSUS_2025_AIANNH_SOURCE_ID ||
        !identifier.identifier.startsWith("GEOID:")
      ) {
        continue;
      }
      const geoid = identifier.identifier.slice("GEOID:".length);
      if (!/^\d{4}[RT]$/.test(geoid)) {
        throw new CensusAiannhValidationError(
          `registry.${nation.nation_id}.source_identifiers`,
          `contains malformed Census AIANNH GEOID ${geoid}`,
        );
      }
      if (crosswalk.has(geoid)) {
        throw new CensusAiannhValidationError(
          `registry.${nation.nation_id}.source_identifiers`,
          `duplicates Census AIANNH GEOID ${geoid}`,
        );
      }
      crosswalk.set(geoid, nation);
    }
  }
  if (crosswalk.size !== WASHINGTON_GOIA_AIANNH_COMPONENT_COUNT) {
    throw new CensusAiannhValidationError(
      "registry",
      `must contain exactly ${WASHINGTON_GOIA_AIANNH_COMPONENT_COUNT} GOIA-associated Census AIANNH component GEOIDs; found ${crosswalk.size}`,
    );
  }
  return crosswalk;
}

/** Derives the closed presentation category from preserved native Census discriminators. */
export function classifyCensusAiannhAttributes(attributes: JsonObject, path: string): TribalGeometryCategory {
  const componentType = requireAttributeString(attributes.COMPTYP, `${path}.COMPTYP`);
  const mtfcc = requireAttributeString(attributes.MTFCC, `${path}.MTFCC`);
  const classFp = requireAttributeString(attributes.CLASSFP, `${path}.CLASSFP`);
  if (mtfcc === "G2160" && classFp === "D6" && componentType === "R") {
    return "tdsa_statistical_area";
  }
  if (mtfcc === "G2100" && (classFp === "D1" || classFp === "D2")) {
    if (componentType === "R") return "federal_reservation_exterior";
    if (componentType === "T") return "off_reservation_trust_land";
  }
  throw new CensusAiannhValidationError(
    path,
    `unsupported Census discriminator tuple MTFCC=${mtfcc}, CLASSFP=${classFp}, COMPTYP=${componentType}`,
  );
}

/** Recomputes and verifies category, GEOID, registry scope, Nation id, and formal-name binding. */
export function validateCensusAiannhFeatureBinding(
  feature: CensusAiannhFeatureBinding,
  crosswalk: ReadonlyMap<string, NationRegistryRecord>,
  path: string,
): void {
  const geoid = requireAttributeString(feature.source_attributes.GEOID, `${path}.source_attributes.GEOID`);
  if (feature.source_feature_id !== geoid) {
    throw new CensusAiannhValidationError(
      `${path}.source_feature_id`,
      `must equal preserved Census GEOID ${geoid}`,
    );
  }
  const expectedCategory = classifyCensusAiannhAttributes(
    feature.source_attributes,
    `${path}.source_attributes`,
  );
  if (feature.category !== expectedCategory) {
    throw new CensusAiannhValidationError(
      `${path}.category`,
      `must equal source-derived category ${expectedCategory}`,
    );
  }

  const nation = crosswalk.get(geoid);
  if (nation !== undefined) {
    if (feature.registry_scope !== "goia_29") {
      throw new CensusAiannhValidationError(
        `${path}.registry_scope`,
        `GEOID ${geoid} is present in the GOIA registry crosswalk`,
      );
    }
    if (feature.nation_id !== nation.nation_id) {
      throw new CensusAiannhValidationError(
        `${path}.nation_id`,
        `must equal crosswalk Nation ${nation.nation_id}`,
      );
    }
    if (feature.formal_nation_name !== nation.formal_name) {
      throw new CensusAiannhValidationError(
        `${path}.formal_nation_name`,
        "must equal the formal name preserved by the registry crosswalk",
      );
    }
    return;
  }

  if (feature.registry_scope !== "border_context") {
    throw new CensusAiannhValidationError(
      `${path}.registry_scope`,
      `GEOID ${geoid} is absent from the GOIA registry and must remain border context`,
    );
  }
  if (feature.nation_id !== null) {
    throw new CensusAiannhValidationError(
      `${path}.nation_id`,
      "border context must remain outside the GOIA 29-Nation denominator",
    );
  }
  if (feature.formal_nation_name === null || feature.formal_nation_name.trim().length === 0) {
    throw new CensusAiannhValidationError(
      `${path}.formal_nation_name`,
      "border context requires an explicit, non-empty formal identity",
    );
  }
}

function requireAttributeString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CensusAiannhValidationError(path, "must be non-empty source text");
  }
  return value;
}
