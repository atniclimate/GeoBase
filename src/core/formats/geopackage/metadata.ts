import type { JsonValue } from "../../../shared/json.js";
import { isJsonValue } from "../../../shared/json.js";

export const WA_TRIBAL_CONTEXT_METADATA_URI = "urn:atni:geobase:wa-tribal-context:1.0";

export interface GeoPackageMetadataRecord {
  id: number;
  mdScope: string;
  mdStandardUri: string;
  metadata: string;
  mimeType: string;
}

export interface GeoPackageMetadataReference {
  columnName: string | null;
  mdFileId: number;
  parentMdFileId: number | null;
  referenceScope: "column" | "row" | "row/col" | "table" | "geopackage";
  rowIdValue: number | null;
  tableName: string | null;
  timestamp: string;
}

export class GeoPackageMetadataError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GeoPackageMetadataError";
  }
}

/** Finds and parses one deterministic JSON metadata root from standard GeoPackage tables. */
export function parseGeoPackageJsonMetadata(
  records: readonly GeoPackageMetadataRecord[],
  references: readonly GeoPackageMetadataReference[],
  standardUri: string,
): JsonValue {
  const matches = records.filter((record) => record.mdStandardUri === standardUri);
  if (matches.length !== 1) {
    throw new GeoPackageMetadataError(
      `expected exactly one metadata record for ${standardUri}; found ${matches.length}`,
    );
  }
  const record = matches[0];
  if (record === undefined) {
    throw new GeoPackageMetadataError(`metadata record ${standardUri} is unavailable`);
  }
  if (record.mdScope !== "dataset") {
    throw new GeoPackageMetadataError(
      `metadata record ${standardUri} has scope ${record.mdScope}; expected dataset`,
    );
  }
  if (record.mimeType !== "application/json") {
    throw new GeoPackageMetadataError(
      `metadata record ${standardUri} has MIME type ${record.mimeType}; expected application/json`,
    );
  }
  const recordReferences = references.filter((reference) => reference.mdFileId === record.id);
  if (recordReferences.length !== 1) {
    throw new GeoPackageMetadataError(`metadata record ${standardUri} must have exactly one reference`);
  }
  const packageReference = recordReferences[0];
  if (
    packageReference === undefined ||
    packageReference.referenceScope !== "geopackage" ||
    packageReference.tableName !== null ||
    packageReference.columnName !== null ||
    packageReference.rowIdValue !== null ||
    packageReference.parentMdFileId !== null
  ) {
    throw new GeoPackageMetadataError(
      `metadata record ${standardUri} must use one unparented GeoPackage-scope reference with null table, column, and row fields`,
    );
  }
  const referenceTimestamp = new Date(packageReference.timestamp);
  if (
    !Number.isFinite(referenceTimestamp.valueOf()) ||
    referenceTimestamp.toISOString() !== packageReference.timestamp
  ) {
    throw new GeoPackageMetadataError(
      `metadata record ${standardUri} reference timestamp must be canonical UTC ISO-8601`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(record.metadata) as unknown;
  } catch (error) {
    throw new GeoPackageMetadataError(
      `metadata record ${standardUri} is not valid JSON: ${
        error instanceof Error ? error.message : "parse failure"
      }`,
    );
  }
  if (!isJsonValue(parsed)) {
    throw new GeoPackageMetadataError(
      `metadata record ${standardUri} contains a non-finite or unsupported JSON value`,
    );
  }
  return parsed;
}
