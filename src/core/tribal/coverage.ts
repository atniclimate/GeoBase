import type { NationRegistryRecord } from "./nation-registry.js";

export const TRIBAL_GEOMETRY_CATEGORIES = [
  "federal_reservation_exterior",
  "off_reservation_trust_land",
  "tdsa_statistical_area",
  "bia_land_area_representation",
  "authorized_tract_parcel_land_status",
  "treaty_area",
  "ceded_land_area",
  "tribe_approved_usual_and_accustomed_area",
  "agreement_specific_co_management",
] as const;

export type TribalGeometryCategory = (typeof TRIBAL_GEOMETRY_CATEGORIES)[number];

export type CoverageStatus =
  | "no_public_geometry"
  | "not_applicable"
  | "not_public"
  | "public_geometry_present"
  | "source_conflict"
  | "unavailable"
  | "unknown";

export type NationCoverageSummary =
  | "legal_area_present"
  | "no_public_geometry"
  | "source_conflict"
  | "statistical_only"
  | "unknown";

export interface CoverageFeatureReference {
  source_feature_id: string;
  source_geometry_sha256: string;
}

export interface CoverageCell {
  category: TribalGeometryCategory;
  feature_references: readonly CoverageFeatureReference[];
  note: string;
  status: CoverageStatus;
}

export interface NationCoverageRow {
  components: readonly CoverageCell[];
  nation_id: string;
  summary: NationCoverageSummary;
}

export class NationCoverageError extends Error {
  public readonly path: string;

  public constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "NationCoverageError";
    this.path = path;
  }
}

/** Validates the full Nation × component Cartesian matrix without converting absence to zero. */
export function validateNationCoverage(
  rows: readonly NationCoverageRow[],
  registry: readonly NationRegistryRecord[],
): NationCoverageRow[] {
  if (rows.length !== registry.length) {
    throw new NationCoverageError(
      "coverage",
      `must contain one row per registry record; found ${rows.length} for ${registry.length}`,
    );
  }
  const registryIds = new Set(registry.map((record) => record.nation_id));
  const seen = new Set<string>();
  for (const [rowIndex, row] of rows.entries()) {
    const path = `coverage[${rowIndex}]`;
    if (!registryIds.has(row.nation_id)) {
      throw new NationCoverageError(`${path}.nation_id`, `${row.nation_id} is absent from the registry`);
    }
    if (seen.has(row.nation_id)) {
      throw new NationCoverageError(`${path}.nation_id`, `duplicates ${row.nation_id}`);
    }
    if (row.components.length !== TRIBAL_GEOMETRY_CATEGORIES.length) {
      throw new NationCoverageError(
        `${path}.components`,
        `must contain all ${TRIBAL_GEOMETRY_CATEGORIES.length} component categories`,
      );
    }
    const categorySet = new Set<TribalGeometryCategory>();
    for (const [cellIndex, cell] of row.components.entries()) {
      const cellPath = `${path}.components[${cellIndex}]`;
      if (!isTribalGeometryCategory(cell.category)) {
        throw new NationCoverageError(`${cellPath}.category`, "is not a supported category");
      }
      if (categorySet.has(cell.category)) {
        throw new NationCoverageError(`${cellPath}.category`, `duplicates ${cell.category}`);
      }
      if (!isCoverageStatus(cell.status)) {
        throw new NationCoverageError(`${cellPath}.status`, "is not a supported explicit status");
      }
      if (cell.note.trim().length === 0) {
        throw new NationCoverageError(`${cellPath}.note`, "must explain the status or limitation");
      }
      if (cell.status === "public_geometry_present" && cell.feature_references.length === 0) {
        throw new NationCoverageError(
          `${cellPath}.feature_references`,
          "present geometry requires at least one exact source reference",
        );
      }
      if (cell.status !== "public_geometry_present" && cell.feature_references.length !== 0) {
        throw new NationCoverageError(
          `${cellPath}.feature_references`,
          `${cell.status} must not carry geometry references`,
        );
      }
      const featureIds = new Set<string>();
      for (const [featureIndex, feature] of cell.feature_references.entries()) {
        const featurePath = `${cellPath}.feature_references[${featureIndex}]`;
        if (feature.source_feature_id.trim().length === 0) {
          throw new NationCoverageError(`${featurePath}.source_feature_id`, "must be non-empty");
        }
        if (!/^[a-f0-9]{64}$/.test(feature.source_geometry_sha256)) {
          throw new NationCoverageError(
            `${featurePath}.source_geometry_sha256`,
            "must be a lowercase SHA-256 digest",
          );
        }
        if (featureIds.has(feature.source_feature_id)) {
          throw new NationCoverageError(featurePath, "duplicates a feature reference in this component");
        }
        featureIds.add(feature.source_feature_id);
      }
      categorySet.add(cell.category);
    }
    for (const category of TRIBAL_GEOMETRY_CATEGORIES) {
      if (!categorySet.has(category)) {
        throw new NationCoverageError(`${path}.components`, `is missing ${category}`);
      }
    }
    assertSummary(row, path);
    seen.add(row.nation_id);
  }
  for (const registryId of registryIds) {
    if (!seen.has(registryId)) {
      throw new NationCoverageError("coverage", `is missing Nation ${registryId}`);
    }
  }
  return [...rows]
    .map((row) => ({
      ...row,
      components: [...row.components].sort(
        (left, right) =>
          TRIBAL_GEOMETRY_CATEGORIES.indexOf(left.category) -
          TRIBAL_GEOMETRY_CATEGORIES.indexOf(right.category),
      ),
    }))
    .sort((left, right) => compareCodePoints(left.nation_id, right.nation_id));
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isTribalGeometryCategory(value: unknown): value is TribalGeometryCategory {
  return TRIBAL_GEOMETRY_CATEGORIES.includes(value as TribalGeometryCategory);
}

function isCoverageStatus(value: unknown): value is CoverageStatus {
  return (
    value === "no_public_geometry" ||
    value === "not_applicable" ||
    value === "not_public" ||
    value === "public_geometry_present" ||
    value === "source_conflict" ||
    value === "unavailable" ||
    value === "unknown"
  );
}

function assertSummary(row: NationCoverageRow, path: string): void {
  const status = (category: TribalGeometryCategory): CoverageStatus => {
    const cell = row.components.find((component) => component.category === category);
    if (cell === undefined) throw new NationCoverageError(`${path}.components`, `is missing ${category}`);
    return cell.status;
  };
  const legalPresent =
    status("federal_reservation_exterior") === "public_geometry_present" ||
    status("off_reservation_trust_land") === "public_geometry_present";
  const statisticalPresent = status("tdsa_statistical_area") === "public_geometry_present";
  const sourceConflict = row.components.some((component) => component.status === "source_conflict");
  const knownNoPublicGeometry = row.components.every(
    (component) =>
      component.status === "no_public_geometry" ||
      component.status === "not_applicable" ||
      component.status === "not_public",
  );
  const expected: NationCoverageSummary = legalPresent
    ? "legal_area_present"
    : statisticalPresent
      ? "statistical_only"
      : sourceConflict
        ? "source_conflict"
        : knownNoPublicGeometry
          ? "no_public_geometry"
          : "unknown";
  if (row.summary !== expected) {
    throw new NationCoverageError(
      `${path}.summary`,
      `must equal ${expected}, derived from the complete component statuses`,
    );
  }
}
