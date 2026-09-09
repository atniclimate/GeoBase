import type { Feature, GeoJsonProperties, Geometry } from "geojson";
import { visitGeometryPositions } from "../../crs.js";
import { assertWktMatchesEpsg } from "../../crs-wkt.js";
import { sha256Hex } from "../../hash.js";
import { type ParsedGeoPackageGeometry, parseGeoPackageGeometry } from "./geometry-header.js";
import type { GeoPackageMetadataRecord, GeoPackageMetadataReference } from "./metadata.js";

export const GEOPACKAGE_APPLICATION_ID = 0x4750_4b47;

export type GeoPackageAttributeValue = bigint | null | number | string | Uint8Array;

export interface GeoPackageContentRegistration {
  dataType: string;
  description: string | null;
  identifier: string | null;
  lastChange: string;
  maxX: number | null;
  maxY: number | null;
  minX: number | null;
  minY: number | null;
  srsId: number | null;
  tableName: string;
}

export interface GeoPackageGeometryRegistration {
  columnName: string;
  geometryTypeName: string;
  m: 0 | 1 | 2;
  srsId: number;
  tableName: string;
  z: 0 | 1 | 2;
}

export interface GeoPackageExtensionRecord {
  columnName: string | null;
  definition: string;
  extensionName: string;
  scope: "read-write" | "write-only";
  tableName: string | null;
}

export interface GeoPackageSrsRecord {
  definition: string;
  description: string | null;
  organization: string;
  organizationCoordinatesId: number;
  srsId: number;
  srsName: string;
}

export interface GeoPackageColumn {
  defaultValue: GeoPackageAttributeValue;
  name: string;
  notNull: boolean;
  primaryKeyOrder: number;
  type: string;
}

export interface GeoPackageRow {
  readonly [column: string]: GeoPackageAttributeValue;
}

/** Read-only database boundary implemented by Electron's local node:sqlite adapter. */
export interface GeoPackageReadPort {
  applicationId(): number;
  columns(tableName: string): readonly GeoPackageColumn[];
  contents(): readonly GeoPackageContentRegistration[];
  geometryColumns(): readonly GeoPackageGeometryRegistration[];
  extensions(): readonly GeoPackageExtensionRecord[] | null;
  metadata(): readonly GeoPackageMetadataRecord[] | null;
  metadataReferences(): readonly GeoPackageMetadataReference[] | null;
  primaryKeyUsesAutoincrement(tableName: string): boolean;
  rows(tableName: string, columns: readonly string[]): Iterable<GeoPackageRow>;
  spatialReferenceSystems(): readonly GeoPackageSrsRecord[];
  userVersion(): number;
}

export interface GeoPackageFeatureTableRegistration {
  columns: readonly GeoPackageColumn[];
  content: GeoPackageContentRegistration;
  geometry: GeoPackageGeometryRegistration;
  primaryKey: GeoPackageColumn;
  srs: GeoPackageSrsRecord;
}

export interface GeoPackageCatalog {
  applicationId: number;
  featureTables: readonly GeoPackageFeatureTableRegistration[];
  extensions: readonly GeoPackageExtensionRecord[] | null;
  metadata: readonly GeoPackageMetadataRecord[] | null;
  metadataReferences: readonly GeoPackageMetadataReference[] | null;
  userVersion: number;
}

export interface GeoPackageFeature {
  /** Exact SQLite values; unsafe 64-bit integers remain bigint and BLOBs remain bytes. */
  attributes: Readonly<Record<string, GeoPackageAttributeValue>>;
  /** Explicit JSON presentation derivative; unsafe integers serialize as exact decimal strings. */
  feature: Feature<Geometry | null, GeoJsonProperties>;
  geometry: ParsedGeoPackageGeometry | null;
  /** Exact source BLOB byte view copied out of SQLite; null geometry remains null. */
  geometryBlob: Uint8Array | null;
  geometryBlobSha256: string | null;
  primaryKey: bigint | number;
}

export class GeoPackageReadError extends Error {
  public readonly path: string;

  public constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "GeoPackageReadError";
    this.path = path;
  }
}

/** Dynamically discovers and cross-validates every registered feature table. */
export function discoverGeoPackage(port: GeoPackageReadPort): GeoPackageCatalog {
  const applicationId = port.applicationId();
  if (applicationId !== GEOPACKAGE_APPLICATION_ID) {
    throw new GeoPackageReadError(
      "PRAGMA application_id",
      `expected ${GEOPACKAGE_APPLICATION_ID}, received ${applicationId}`,
    );
  }
  const userVersion = port.userVersion();
  if (!Number.isInteger(userVersion) || userVersion < 10_000 || userVersion >= 20_000) {
    throw new GeoPackageReadError(
      "PRAGMA user_version",
      `unsupported GeoPackage version integer ${userVersion}`,
    );
  }

  const contents = port.contents();
  const geometryColumns = port.geometryColumns();
  const extensions = port.extensions();
  const metadata = port.metadata();
  const metadataReferences = port.metadataReferences();
  if ((metadata === null) !== (metadataReferences === null)) {
    throw new GeoPackageReadError(
      "gpkg_metadata",
      "gpkg_metadata and gpkg_metadata_reference must either both exist or both be absent",
    );
  }
  if (metadata !== null && !hasRequiredMetadataExtensions(extensions)) {
    throw new GeoPackageReadError(
      "gpkg_extensions",
      "GeoPackage metadata tables require exact read-write extension declarations for both standard tables",
    );
  }
  validateExtensions(extensions);
  const spatialReferenceSystems = port.spatialReferenceSystems();
  validateMandatorySpatialReferenceSystems(spatialReferenceSystems);
  const srsById = new Map(spatialReferenceSystems.map((srs) => [srs.srsId, srs]));
  const geometryByTable = new Map<string, GeoPackageGeometryRegistration[]>();
  for (const geometry of geometryColumns) {
    const registered = geometryByTable.get(geometry.tableName) ?? [];
    registered.push(geometry);
    geometryByTable.set(geometry.tableName, registered);
  }

  const featureTables = contents
    .filter((content) => content.dataType === "features")
    .map((content): GeoPackageFeatureTableRegistration => {
      validateContentBounds(content);
      const geometries = geometryByTable.get(content.tableName) ?? [];
      if (geometries.length !== 1) {
        throw new GeoPackageReadError(
          `gpkg_geometry_columns.${content.tableName}`,
          `expected exactly one registered geometry column; found ${geometries.length}`,
        );
      }
      const geometry = geometries[0];
      if (geometry === undefined) {
        throw new GeoPackageReadError(content.tableName, "registered geometry is unavailable");
      }
      if (content.srsId === null || content.srsId !== geometry.srsId) {
        throw new GeoPackageReadError(
          `gpkg_contents.${content.tableName}.srs_id`,
          `contents SRS ${String(content.srsId)} disagrees with geometry registration ${geometry.srsId}`,
        );
      }
      const srs = srsById.get(geometry.srsId);
      if (srs === undefined) {
        throw new GeoPackageReadError(
          `gpkg_spatial_ref_sys.${geometry.srsId}`,
          "registered spatial reference system is missing",
        );
      }
      assertSrsAuthority(srs);

      const columns = port.columns(content.tableName);
      const geometryColumn = columns.find((column) => column.name === geometry.columnName);
      if (geometryColumn === undefined) {
        throw new GeoPackageReadError(
          `${content.tableName}.${geometry.columnName}`,
          "registered geometry column does not exist in the feature table",
        );
      }
      const primaryKeys = columns.filter((column) => column.primaryKeyOrder > 0);
      if (primaryKeys.length !== 1) {
        throw new GeoPackageReadError(
          content.tableName,
          `expected one primary-key column; found ${primaryKeys.length}`,
        );
      }
      const primaryKey = primaryKeys[0];
      if (primaryKey === undefined) {
        throw new GeoPackageReadError(content.tableName, "primary key is unavailable");
      }
      if (!/^INTEGER\b/i.test(primaryKey.type.trim())) {
        throw new GeoPackageReadError(
          `${content.tableName}.${primaryKey.name}`,
          `GeoPackage feature primary key must have INTEGER declared type; received ${primaryKey.type}`,
        );
      }
      if (!port.primaryKeyUsesAutoincrement(content.tableName)) {
        throw new GeoPackageReadError(
          `${content.tableName}.${primaryKey.name}`,
          "GeoPackage feature primary key must use INTEGER PRIMARY KEY AUTOINCREMENT",
        );
      }
      return { columns, content, geometry, primaryKey, srs };
    })
    .sort((left, right) => compareCodePoints(left.content.tableName, right.content.tableName));

  for (const geometry of geometryColumns) {
    if (
      !contents.some((content) => content.tableName === geometry.tableName && content.dataType === "features")
    ) {
      throw new GeoPackageReadError(
        `gpkg_geometry_columns.${geometry.tableName}`,
        "geometry registration has no gpkg_contents row",
      );
    }
  }

  return {
    applicationId,
    extensions,
    featureTables,
    metadata,
    metadataReferences,
    userVersion,
  };
}

function validateExtensions(extensions: readonly GeoPackageExtensionRecord[] | null): void {
  if (extensions === null) return;
  for (const [index, extension] of extensions.entries()) {
    if (extension.extensionName !== "gpkg_rtree_index" && extension.extensionName !== "gpkg_metadata") {
      throw new GeoPackageReadError(
        `gpkg_extensions[${index}]`,
        `unsupported applicable extension ${extension.extensionName}`,
      );
    }
    if (!/^https?:\/\//i.test(extension.definition)) {
      throw new GeoPackageReadError(
        `gpkg_extensions[${index}].definition`,
        "extension definition must be an absolute HTTP(S) specification URI",
      );
    }
  }
}

function hasRequiredMetadataExtensions(extensions: readonly GeoPackageExtensionRecord[] | null): boolean {
  if (extensions === null) return false;
  const metadataDeclarations = extensions.filter((extension) => extension.extensionName === "gpkg_metadata");
  if (metadataDeclarations.length !== 2) return false;
  return ["gpkg_metadata", "gpkg_metadata_reference"].every(
    (tableName) =>
      metadataDeclarations.filter(
        (extension) =>
          extension.tableName === tableName &&
          extension.columnName === null &&
          extension.scope === "read-write" &&
          extension.definition === "http://www.geopackage.org/spec/#extension_metadata",
      ).length === 1,
  );
}

function validateMandatorySpatialReferenceSystems(records: readonly GeoPackageSrsRecord[]): void {
  for (const srsId of [-1, 0] as const) {
    const record = records.find((candidate) => candidate.srsId === srsId);
    if (
      record === undefined ||
      record.organization.toUpperCase() !== "NONE" ||
      record.organizationCoordinatesId !== srsId ||
      record.definition.toLowerCase() !== "undefined"
    ) {
      throw new GeoPackageReadError(
        `gpkg_spatial_ref_sys.${srsId}`,
        "mandatory undefined spatial reference system row is missing or contradictory",
      );
    }
  }
  const wgs84 = records.find((record) => record.srsId === 4326);
  if (wgs84 === undefined) {
    throw new GeoPackageReadError(
      "gpkg_spatial_ref_sys.4326",
      "mandatory EPSG:4326 spatial reference system row is missing",
    );
  }
  assertSrsAuthority(wgs84, { allowGeographicAuthorityAxisOrder: true });
}

export interface ReadFeatureTableOptions {
  /** Optional stable string identifier; the primary key remains preserved separately. */
  featureIdColumn?: string;
  requireGeometry?: boolean;
}

/** Reads one dynamically registered table while preserving null attributes and exact geometry BLOB hashes. */
export async function readFeatureTable(
  port: GeoPackageReadPort,
  registration: GeoPackageFeatureTableRegistration,
  options: ReadFeatureTableOptions = {},
): Promise<GeoPackageFeature[]> {
  const { columns, geometry, primaryKey } = registration;
  const attributeColumns = columns.filter((column) => column.name !== geometry.columnName);
  if (
    options.featureIdColumn !== undefined &&
    !attributeColumns.some((column) => column.name === options.featureIdColumn)
  ) {
    throw new GeoPackageReadError(
      `${registration.content.tableName}.${options.featureIdColumn}`,
      "requested feature identifier column is missing",
    );
  }
  const selectedColumns = columns.map((column) => column.name);
  const features: GeoPackageFeature[] = [];
  let actualBounds: { maxX: number; maxY: number; minX: number; minY: number } | null = null;
  let rowIndex = 0;
  for (const row of port.rows(registration.content.tableName, selectedColumns)) {
    const rowPath = `${registration.content.tableName}[${rowIndex}]`;
    const primaryKeyValue = row[primaryKey.name];
    if (typeof primaryKeyValue !== "bigint" && typeof primaryKeyValue !== "number") {
      throw new GeoPackageReadError(`${rowPath}.${primaryKey.name}`, "primary key must be numeric");
    }
    const geometryValue = row[geometry.columnName];
    if (geometryValue !== null && !(geometryValue instanceof Uint8Array)) {
      throw new GeoPackageReadError(`${rowPath}.${geometry.columnName}`, "geometry must be null or a BLOB");
    }
    if (geometryValue === null && options.requireGeometry !== false) {
      throw new GeoPackageReadError(`${rowPath}.${geometry.columnName}`, "geometry is null");
    }
    let parsed: ParsedGeoPackageGeometry | null = null;
    if (geometryValue instanceof Uint8Array) {
      try {
        parsed = parseGeoPackageGeometry(geometryValue, geometry.srsId);
      } catch (error) {
        throw new GeoPackageReadError(
          `${rowPath}.${geometry.columnName}`,
          error instanceof Error ? error.message : "geometry parse failed",
        );
      }
      assertDeclaredGeometryType(parsed.geometry, geometry.geometryTypeName, rowPath);
      assertDimensions(parsed, geometry, rowPath);
      const featureBounds = geometryXyBounds(parsed.geometry, rowPath);
      actualBounds =
        actualBounds === null
          ? featureBounds
          : {
              maxX: Math.max(actualBounds.maxX, featureBounds.maxX),
              maxY: Math.max(actualBounds.maxY, featureBounds.maxY),
              minX: Math.min(actualBounds.minX, featureBounds.minX),
              minY: Math.min(actualBounds.minY, featureBounds.minY),
            };
    }

    const attributes: Record<string, GeoPackageAttributeValue> = {};
    const jsonAttributes: Record<string, null | number | string> = {};
    for (const column of attributeColumns) {
      if (column.name === primaryKey.name) continue;
      const value = row[column.name];
      if (value === undefined) {
        throw new GeoPackageReadError(`${rowPath}.${column.name}`, "selected column is missing from row");
      }
      attributes[column.name] = value;
      if (value instanceof Uint8Array) {
        continue;
      }
      jsonAttributes[column.name] =
        typeof value === "bigint"
          ? Number.isSafeInteger(Number(value))
            ? Number(value)
            : value.toString(10)
          : value;
    }
    const featureIdValue =
      options.featureIdColumn === undefined ? primaryKeyValue : row[options.featureIdColumn];
    if (
      typeof featureIdValue !== "bigint" &&
      typeof featureIdValue !== "number" &&
      typeof featureIdValue !== "string"
    ) {
      throw new GeoPackageReadError(`${rowPath}.id`, "feature identifier must be text or numeric");
    }
    const feature: Feature<Geometry | null, GeoJsonProperties> = {
      geometry: parsed?.geometry ?? null,
      id: String(featureIdValue),
      properties: jsonAttributes,
      type: "Feature",
    };
    features.push({
      attributes,
      feature,
      geometry: parsed,
      geometryBlob: geometryValue === null ? null : Uint8Array.from(geometryValue),
      geometryBlobSha256: geometryValue === null ? null : await sha256Hex(geometryValue),
      primaryKey: primaryKeyValue,
    });
    rowIndex += 1;
  }
  assertActualBoundsMatchRegistration(registration.content, actualBounds);
  return features;
}

function validateContentBounds(content: GeoPackageContentRegistration): void {
  const values = [content.minX, content.minY, content.maxX, content.maxY];
  const nullCount = values.filter((value) => value === null).length;
  if (nullCount !== 0 && nullCount !== values.length) {
    throw new GeoPackageReadError(
      `gpkg_contents.${content.tableName}`,
      "feature bounds must be either four finite coordinates or four nulls",
    );
  }
  if (nullCount === values.length) return;
  if (values.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
    throw new GeoPackageReadError(
      `gpkg_contents.${content.tableName}`,
      "feature bounds must contain only finite coordinates",
    );
  }
  const [minX, minY, maxX, maxY] = values as number[];
  if (minX === undefined || minY === undefined || maxX === undefined || maxY === undefined) {
    throw new GeoPackageReadError(`gpkg_contents.${content.tableName}`, "feature bounds are incomplete");
  }
  if (minX > maxX || minY > maxY) {
    throw new GeoPackageReadError(
      `gpkg_contents.${content.tableName}`,
      "feature bounds minimum exceeds maximum",
    );
  }
}

function geometryXyBounds(
  geometry: Geometry,
  path: string,
): { maxX: number; maxY: number; minX: number; minY: number } {
  const bounds = {
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
  };
  visitGeometryPositions(
    geometry,
    (position, positionPath) => {
      const x = position[0];
      const y = position[1];
      if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) {
        throw new GeoPackageReadError(positionPath, "position must contain finite XY ordinates");
      }
      bounds.minX = Math.min(bounds.minX, x);
      bounds.minY = Math.min(bounds.minY, y);
      bounds.maxX = Math.max(bounds.maxX, x);
      bounds.maxY = Math.max(bounds.maxY, y);
    },
    `${path}.geometry`,
  );
  if (!Object.values(bounds).every(Number.isFinite)) {
    throw new GeoPackageReadError(`${path}.geometry`, "geometry has no finite XY extent");
  }
  return bounds;
}

function assertActualBoundsMatchRegistration(
  content: GeoPackageContentRegistration,
  actual: { maxX: number; maxY: number; minX: number; minY: number } | null,
): void {
  const registered =
    content.minX === null || content.minY === null || content.maxX === null || content.maxY === null
      ? null
      : { maxX: content.maxX, maxY: content.maxY, minX: content.minX, minY: content.minY };
  if (actual === null || registered === null) {
    if (actual !== registered) {
      throw new GeoPackageReadError(
        `gpkg_contents.${content.tableName}`,
        actual === null
          ? "registers bounds for a table with no non-null geometry"
          : "omits bounds for a table containing non-null geometry",
      );
    }
    return;
  }
  const scale = Math.max(
    1,
    ...Object.values(actual).map(Math.abs),
    ...Object.values(registered).map(Math.abs),
  );
  const tolerance = scale * 1e-12;
  for (const key of ["minX", "minY", "maxX", "maxY"] as const) {
    if (Math.abs(actual[key] - registered[key]) > tolerance) {
      throw new GeoPackageReadError(
        `gpkg_contents.${content.tableName}.${key}`,
        `registered bound ${registered[key]} disagrees with actual geometry bound ${actual[key]}`,
      );
    }
  }
}

function assertSrsAuthority(
  srs: GeoPackageSrsRecord,
  options: { allowGeographicAuthorityAxisOrder?: boolean } = {},
): void {
  if (srs.srsId <= 0) {
    throw new GeoPackageReadError(`gpkg_spatial_ref_sys.${srs.srsId}`, "undefined SRS is forbidden");
  }
  if (srs.organization.toUpperCase() !== "EPSG" || srs.organizationCoordinatesId !== srs.srsId) {
    throw new GeoPackageReadError(
      `gpkg_spatial_ref_sys.${srs.srsId}`,
      "SRS must carry a matching EPSG authority identifier",
    );
  }
  try {
    assertWktMatchesEpsg(srs.definition, srs.srsId, options);
  } catch (error) {
    throw new GeoPackageReadError(
      `gpkg_spatial_ref_sys.${srs.srsId}.definition`,
      error instanceof Error ? error.message : "WKT does not match its registered EPSG authority",
    );
  }
}

function assertDeclaredGeometryType(geometry: Geometry, declared: string, path: string): void {
  const normalized = declared.trim().toUpperCase();
  if (normalized === "GEOMETRY") return;
  if (normalized !== geometry.type.toUpperCase()) {
    throw new GeoPackageReadError(
      `${path}.geometry`,
      `decoded ${geometry.type} disagrees with declared geometry family ${declared}`,
    );
  }
}

function assertDimensions(
  parsed: ParsedGeoPackageGeometry,
  registration: GeoPackageGeometryRegistration,
  path: string,
): void {
  const hasZ = parsed.coordinateLayout === "XYZ" || parsed.coordinateLayout === "XYZM";
  const hasM = parsed.coordinateLayout === "XYM" || parsed.coordinateLayout === "XYZM";
  if (registration.z === 0 && hasZ) {
    throw new GeoPackageReadError(`${path}.geometry`, "registered geometry forbids Z but WKB contains Z");
  }
  if (registration.z === 1 && !hasZ) {
    throw new GeoPackageReadError(`${path}.geometry`, "registered geometry requires Z but WKB omits Z");
  }
  if (registration.m === 0 && hasM) {
    throw new GeoPackageReadError(`${path}.geometry`, "registered geometry forbids M but WKB contains M");
  }
  if (registration.m === 1 && !hasM) {
    throw new GeoPackageReadError(`${path}.geometry`, "registered geometry requires M but WKB omits M");
  }
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
