export const WASHINGTON_FEDERALLY_RECOGNIZED_NATION_COUNT = 29 as const;

export type NationRegistryReviewStatus = "agent_prepared_owner_review_pending" | "human_reviewed";

export interface NationSourceIdentifier {
  identifier: string;
  source_id: string;
}

export interface NationRegistryRecord {
  formal_name: string | null;
  goia_name: string;
  nation_id: string;
  review: {
    note: string;
    reviewed_at: string;
    reviewed_by: string;
    status: NationRegistryReviewStatus;
  };
  source_identifiers: readonly NationSourceIdentifier[];
}

export class NationRegistryError extends Error {
  public readonly path: string;

  public constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "NationRegistryError";
    this.path = path;
  }
}

/** Validates, sorts, and returns the complete external 29-Nation registry. */
export function validateNationRegistry(records: readonly NationRegistryRecord[]): NationRegistryRecord[] {
  if (records.length !== WASHINGTON_FEDERALLY_RECOGNIZED_NATION_COUNT) {
    throw new NationRegistryError(
      "registry",
      `must contain exactly ${WASHINGTON_FEDERALLY_RECOGNIZED_NATION_COUNT} records; found ${records.length}`,
    );
  }
  const ids = new Set<string>();
  const goiaNames = new Set<string>();
  for (const [index, record] of records.entries()) {
    const path = `registry[${index}]`;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(record.nation_id)) {
      throw new NationRegistryError(`${path}.nation_id`, "must be a stable lowercase kebab-case id");
    }
    if (ids.has(record.nation_id)) {
      throw new NationRegistryError(`${path}.nation_id`, `duplicates ${record.nation_id}`);
    }
    requireNonEmpty(record.goia_name, `${path}.goia_name`);
    const normalizedGoiaName = record.goia_name.trim().toLocaleLowerCase("en-US");
    if (goiaNames.has(normalizedGoiaName)) {
      throw new NationRegistryError(`${path}.goia_name`, `duplicates ${record.goia_name}`);
    }
    if (record.formal_name !== null) requireNonEmpty(record.formal_name, `${path}.formal_name`);
    if (
      record.review.status !== "agent_prepared_owner_review_pending" &&
      record.review.status !== "human_reviewed"
    ) {
      throw new NationRegistryError(`${path}.review.status`, "is not a supported review status");
    }
    requireNonEmpty(record.review.note, `${path}.review.note`);
    requireNonEmpty(record.review.reviewed_by, `${path}.review.reviewed_by`);
    requireTimestamp(record.review.reviewed_at, `${path}.review.reviewed_at`);
    if (record.source_identifiers.length === 0) {
      throw new NationRegistryError(`${path}.source_identifiers`, "must contain a pinned identifier");
    }
    const identifierKeys = new Set<string>();
    for (const [identifierIndex, identifier] of record.source_identifiers.entries()) {
      const identifierPath = `${path}.source_identifiers[${identifierIndex}]`;
      requireNonEmpty(identifier.identifier, `${identifierPath}.identifier`);
      requireNonEmpty(identifier.source_id, `${identifierPath}.source_id`);
      const key = `${identifier.source_id}\u0000${identifier.identifier}`;
      if (identifierKeys.has(key)) {
        throw new NationRegistryError(identifierPath, "duplicates a source identifier in this record");
      }
      identifierKeys.add(key);
    }
    ids.add(record.nation_id);
    goiaNames.add(normalizedGoiaName);
  }
  return [...records].sort((left, right) => compareCodePoints(left.nation_id, right.nation_id));
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireNonEmpty(value: string, path: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new NationRegistryError(path, "must be a non-empty string");
  }
}

function requireTimestamp(value: string, path: string): void {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== value) {
    throw new NationRegistryError(path, "must be a canonical UTC ISO-8601 timestamp");
  }
}
