import { DatabaseSync, type StatementSync } from "node:sqlite";
import type {
  GeoPackageMetadataRecord,
  GeoPackageMetadataReference,
} from "../core/formats/geopackage/metadata.js";
import type {
  GeoPackageAttributeValue,
  GeoPackageColumn,
  GeoPackageContentRegistration,
  GeoPackageExtensionRecord,
  GeoPackageGeometryRegistration,
  GeoPackageReadPort,
  GeoPackageRow,
  GeoPackageSrsRecord,
} from "../core/formats/geopackage/reader.js";

/** Local read-only node:sqlite implementation; no SQL crosses IPC. */
export class NodeSqliteGeoPackagePort implements GeoPackageReadPort {
  readonly #database: DatabaseSync;

  public constructor(path: string) {
    this.#database = new DatabaseSync(path, {
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
      readOnly: true,
      timeout: 5_000,
    });
  }

  public applicationId(): number {
    return requiredInteger(this.get("PRAGMA application_id"), "application_id");
  }

  public columns(tableName: string): readonly GeoPackageColumn[] {
    return this.all(
      'SELECT cid, name, type, "notnull" AS not_null, dflt_value, pk FROM pragma_table_info(?)',
      [tableName],
    ).map((row) => ({
      defaultValue: optionalValue(row.dflt_value, "dflt_value"),
      name: requiredString(row.name, "name"),
      notNull: requiredIntegerValue(row.not_null, "not_null") !== 0,
      primaryKeyOrder: requiredIntegerValue(row.pk, "pk"),
      type: requiredString(row.type, "type"),
    }));
  }

  public contents(): readonly GeoPackageContentRegistration[] {
    return this.all(
      "SELECT table_name, data_type, identifier, description, last_change, " +
        "min_x, min_y, max_x, max_y, srs_id FROM gpkg_contents",
    ).map((row) => ({
      dataType: requiredString(row.data_type, "data_type"),
      description: nullableString(row.description, "description"),
      identifier: nullableString(row.identifier, "identifier"),
      lastChange: requiredString(row.last_change, "last_change"),
      maxX: nullableNumber(row.max_x, "max_x"),
      maxY: nullableNumber(row.max_y, "max_y"),
      minX: nullableNumber(row.min_x, "min_x"),
      minY: nullableNumber(row.min_y, "min_y"),
      srsId: nullableInteger(row.srs_id, "srs_id"),
      tableName: requiredString(row.table_name, "table_name"),
    }));
  }

  public geometryColumns(): readonly GeoPackageGeometryRegistration[] {
    return this.all(
      "SELECT table_name, column_name, geometry_type_name, srs_id, z, m FROM gpkg_geometry_columns",
    ).map((row) => ({
      columnName: requiredString(row.column_name, "column_name"),
      geometryTypeName: requiredString(row.geometry_type_name, "geometry_type_name"),
      m: dimensionRequirement(row.m, "m"),
      srsId: requiredIntegerValue(row.srs_id, "srs_id"),
      tableName: requiredString(row.table_name, "table_name"),
      z: dimensionRequirement(row.z, "z"),
    }));
  }

  public extensions(): readonly GeoPackageExtensionRecord[] | null {
    if (!this.hasTable("gpkg_extensions")) return null;
    return this.all(
      "SELECT table_name, column_name, extension_name, definition, scope FROM gpkg_extensions",
    ).map((row) => ({
      columnName: nullableString(row.column_name, "column_name"),
      definition: requiredString(row.definition, "definition"),
      extensionName: requiredString(row.extension_name, "extension_name"),
      scope: extensionScope(row.scope),
      tableName: nullableString(row.table_name, "table_name"),
    }));
  }

  public metadata(): readonly GeoPackageMetadataRecord[] | null {
    if (!this.hasTable("gpkg_metadata")) return null;
    return this.all("SELECT id, md_scope, md_standard_uri, mime_type, metadata FROM gpkg_metadata").map(
      (row) => ({
        id: requiredIntegerValue(row.id, "id"),
        mdScope: requiredString(row.md_scope, "md_scope"),
        mdStandardUri: requiredString(row.md_standard_uri, "md_standard_uri"),
        metadata: requiredString(row.metadata, "metadata"),
        mimeType: requiredString(row.mime_type, "mime_type"),
      }),
    );
  }

  public metadataReferences(): readonly GeoPackageMetadataReference[] | null {
    if (!this.hasTable("gpkg_metadata_reference")) return null;
    return this.all(
      "SELECT reference_scope, table_name, column_name, row_id_value, timestamp, " +
        "md_file_id, md_parent_id FROM gpkg_metadata_reference",
    ).map((row) => ({
      columnName: nullableString(row.column_name, "column_name"),
      mdFileId: requiredIntegerValue(row.md_file_id, "md_file_id"),
      parentMdFileId: nullableInteger(row.md_parent_id, "md_parent_id"),
      referenceScope: referenceScope(row.reference_scope),
      rowIdValue: nullableInteger(row.row_id_value, "row_id_value"),
      tableName: nullableString(row.table_name, "table_name"),
      timestamp: requiredString(row.timestamp, "timestamp"),
    }));
  }

  public primaryKeyUsesAutoincrement(tableName: string): boolean {
    const row = this.get("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?", [tableName]);
    if (row === undefined) throw new TypeError(`${tableName}.sqlite_schema row is missing`);
    const definition = requiredString(row.sql, `${tableName}.sqlite_schema.sql`);
    return /\bAUTOINCREMENT\b/i.test(sqlCodeOnly(definition));
  }

  public *rows(tableName: string, columns: readonly string[]): Iterable<GeoPackageRow> {
    const registered = new Set(this.columns(tableName).map((column) => column.name));
    if (columns.length === 0 || columns.some((column) => !registered.has(column))) {
      throw new Error(`GeoPackage table ${JSON.stringify(tableName)} requested an unknown column`);
    }
    const selectColumns = columns.map(quoteIdentifier).join(", ");
    const statement = this.prepare(
      `SELECT ${selectColumns} FROM ${quoteIdentifier(tableName)} ORDER BY ${quoteIdentifier(
        primaryKeyName(this.columns(tableName), tableName),
      )}`,
    );
    for (const raw of statement.iterate()) {
      const row: Record<string, GeoPackageAttributeValue> = {};
      for (const column of columns) {
        row[column] = normalizeValue(raw[column], `${tableName}.${column}`);
      }
      yield row;
    }
  }

  public spatialReferenceSystems(): readonly GeoPackageSrsRecord[] {
    return this.all(
      "SELECT srs_name, srs_id, organization, organization_coordsys_id, definition, description " +
        "FROM gpkg_spatial_ref_sys",
    ).map((row) => ({
      definition: requiredString(row.definition, "definition"),
      description: nullableString(row.description, "description"),
      organization: requiredString(row.organization, "organization"),
      organizationCoordinatesId: requiredIntegerValue(
        row.organization_coordsys_id,
        "organization_coordsys_id",
      ),
      srsId: requiredIntegerValue(row.srs_id, "srs_id"),
      srsName: requiredString(row.srs_name, "srs_name"),
    }));
  }

  public userVersion(): number {
    return requiredInteger(this.get("PRAGMA user_version"), "user_version");
  }

  public close(): void {
    this.#database.close();
  }

  private all(sql: string, bindings: readonly (bigint | null | number | string | Uint8Array)[] = []) {
    return this.prepare(sql).all(...bindings);
  }

  private get(sql: string, bindings: readonly (bigint | null | number | string | Uint8Array)[] = []) {
    return this.prepare(sql).get(...bindings);
  }

  private hasTable(tableName: string): boolean {
    return (
      this.get("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name=?", [tableName]) !==
      undefined
    );
  }

  private prepare(sql: string): StatementSync {
    const statement = this.#database.prepare(sql);
    statement.setReadBigInts(true);
    return statement;
  }
}

function sqlCodeOnly(definition: string): string {
  let code = "";
  let index = 0;
  while (index < definition.length) {
    const current = definition[index];
    const next = definition[index + 1];
    if (current === "-" && next === "-") {
      index += 2;
      while (index < definition.length && definition[index] !== "\n") index += 1;
      code += " ";
      continue;
    }
    if (current === "/" && next === "*") {
      const end = definition.indexOf("*/", index + 2);
      if (end < 0) return "";
      index = end + 2;
      code += " ";
      continue;
    }
    if (current === "'" || current === '"' || current === "`") {
      const quote = current;
      index += 1;
      while (index < definition.length) {
        if (definition[index] !== quote) {
          index += 1;
          continue;
        }
        if (definition[index + 1] === quote) {
          index += 2;
          continue;
        }
        index += 1;
        break;
      }
      code += " ";
      continue;
    }
    if (current === "[") {
      const end = definition.indexOf("]", index + 1);
      if (end < 0) return "";
      index = end + 1;
      code += " ";
      continue;
    }
    code += current;
    index += 1;
  }
  return code;
}

function primaryKeyName(columns: readonly GeoPackageColumn[], tableName: string): string {
  const primaryKeys = columns.filter((column) => column.primaryKeyOrder > 0);
  if (primaryKeys.length !== 1 || primaryKeys[0] === undefined) {
    throw new Error(`GeoPackage table ${JSON.stringify(tableName)} must have exactly one primary key`);
  }
  return primaryKeys[0].name;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function normalizeValue(value: unknown, path: string): GeoPackageAttributeValue {
  if (value === null || typeof value === "bigint" || typeof value === "number" || typeof value === "string") {
    return value;
  }
  if (value instanceof Uint8Array) return new Uint8Array(value);
  throw new TypeError(`${path} has unsupported SQLite value type ${typeof value}`);
}

function requiredInteger(row: Record<string, unknown> | undefined, column: string): number {
  if (row === undefined) throw new TypeError(`SQLite query returned no ${column} row`);
  return requiredIntegerValue(row[column], column);
}

function requiredIntegerValue(value: unknown, path: string): number {
  if (typeof value === "bigint" && value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER) {
    return Number(value);
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  throw new TypeError(`${path} must be a safe integer`);
}

function nullableInteger(value: unknown, path: string): number | null {
  return value === null ? null : requiredIntegerValue(value, path);
}

function nullableNumber(value: unknown, path: string): number | null {
  if (value === null) return null;
  if (typeof value === "bigint" && value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER) {
    return Number(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new TypeError(`${path} must be null or finite number`);
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string") throw new TypeError(`${path} must be text`);
  return value;
}

function nullableString(value: unknown, path: string): string | null {
  return value === null ? null : requiredString(value, path);
}

function optionalValue(value: unknown, path: string): GeoPackageAttributeValue {
  return value === undefined ? null : normalizeValue(value, path);
}

function dimensionRequirement(value: unknown, path: string): 0 | 1 | 2 {
  const parsed = requiredIntegerValue(value, path);
  if (parsed !== 0 && parsed !== 1 && parsed !== 2) {
    throw new TypeError(`${path} must be 0, 1, or 2`);
  }
  return parsed;
}

function referenceScope(value: unknown): GeoPackageMetadataReference["referenceScope"] {
  if (
    value === "column" ||
    value === "row" ||
    value === "row/col" ||
    value === "table" ||
    value === "geopackage"
  ) {
    return value;
  }
  throw new TypeError(`reference_scope ${JSON.stringify(value)} is invalid`);
}

function extensionScope(value: unknown): GeoPackageExtensionRecord["scope"] {
  if (value === "read-write" || value === "write-only") return value;
  throw new TypeError(`GeoPackage extension scope ${JSON.stringify(value)} is invalid`);
}
