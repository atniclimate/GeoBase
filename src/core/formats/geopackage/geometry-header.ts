import type { Geometry, Position } from "geojson";

const ENVELOPE_DOUBLE_COUNTS = [0, 4, 6, 6, 8] as const;
const MAX_WKB_MEMBERS = 10_000_000;

export type GeoPackageGeometryErrorCode =
  | "EMPTY_GEOMETRY"
  | "ENVELOPE_MISMATCH"
  | "HEADER_INVALID"
  | "SRS_CONTRADICTORY"
  | "TRAILING_BYTES"
  | "TRUNCATED"
  | "WKB_INVALID"
  | "WKB_UNSUPPORTED";

export class GeoPackageGeometryError extends Error {
  public readonly code: GeoPackageGeometryErrorCode;
  public readonly offset: number;

  public constructor(code: GeoPackageGeometryErrorCode, offset: number, message: string) {
    super(`GeoPackage geometry byte ${offset}: ${message}`);
    this.code = code;
    this.name = "GeoPackageGeometryError";
    this.offset = offset;
  }
}

export interface GeoPackageEnvelope {
  maxX: number;
  maxY: number;
  minX: number;
  minY: number;
  values: readonly number[];
}

export interface ParsedGeoPackageGeometry {
  coordinateLayout: CoordinateLayout;
  dimensions: 2 | 3 | 4;
  envelope: GeoPackageEnvelope | null;
  geometry: Geometry;
  headerLength: number;
  srsId: number;
  wkbLength: number;
}

export type CoordinateLayout = "XY" | "XYM" | "XYZ" | "XYZM";

/**
 * Parses one standard GeoPackage geometry binary and its WKB payload.
 * Extended GeoPackage binary is rejected because its type system is extension-specific.
 */
export function parseGeoPackageGeometry(bytes: Uint8Array, expectedSrsId?: number): ParsedGeoPackageGeometry {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 8) {
    throw new GeoPackageGeometryError("TRUNCATED", 0, "header requires at least eight bytes");
  }
  if (bytes[0] !== 0x47 || bytes[1] !== 0x50) {
    throw new GeoPackageGeometryError("HEADER_INVALID", 0, 'magic bytes must equal "GP"');
  }
  if (bytes[2] !== 0) {
    throw new GeoPackageGeometryError("HEADER_INVALID", 2, "only GeoPackage binary version 0 is supported");
  }

  const flags = bytes[3] as number;
  if ((flags & 0xc0) !== 0) {
    throw new GeoPackageGeometryError("HEADER_INVALID", 3, "reserved flag bits must be zero");
  }
  if ((flags & 0x20) !== 0) {
    throw new GeoPackageGeometryError(
      "WKB_UNSUPPORTED",
      3,
      "extended GeoPackage binary is not accepted by the standard geometry reader",
    );
  }
  if ((flags & 0x10) !== 0) {
    throw new GeoPackageGeometryError("EMPTY_GEOMETRY", 3, "empty GeoPackage geometries are not accepted");
  }

  const littleEndian = (flags & 0x01) === 1;
  const envelopeCode = (flags >> 1) & 0x07;
  const envelopeDoubleCount = ENVELOPE_DOUBLE_COUNTS[envelopeCode];
  if (envelopeDoubleCount === undefined) {
    throw new GeoPackageGeometryError("HEADER_INVALID", 3, `unknown envelope indicator ${envelopeCode}`);
  }
  const headerLength = 8 + envelopeDoubleCount * 8;
  if (bytes.byteLength <= headerLength) {
    throw new GeoPackageGeometryError("TRUNCATED", bytes.byteLength, "WKB payload is missing");
  }

  const srsId = view.getInt32(4, littleEndian);
  if (expectedSrsId !== undefined && srsId !== expectedSrsId) {
    throw new GeoPackageGeometryError(
      "SRS_CONTRADICTORY",
      4,
      `binary header SRS ${srsId} disagrees with registered SRS ${expectedSrsId}`,
    );
  }

  const envelopeValues: number[] = [];
  for (let index = 0; index < envelopeDoubleCount; index += 1) {
    const value = view.getFloat64(8 + index * 8, littleEndian);
    if (!Number.isFinite(value)) {
      throw new GeoPackageGeometryError("HEADER_INVALID", 8 + index * 8, "envelope ordinate is not finite");
    }
    envelopeValues.push(value);
  }
  const envelope = parseEnvelope(envelopeValues);

  const cursor = new BinaryCursor(view, headerLength);
  const dimensionTracker: DimensionTracker = { layout: undefined, positionCount: 0 };
  const geometry = parseWkbGeometry(cursor, srsId, dimensionTracker);
  if (cursor.offset !== bytes.byteLength) {
    throw new GeoPackageGeometryError(
      "TRAILING_BYTES",
      cursor.offset,
      `${bytes.byteLength - cursor.offset} unparsed byte(s) follow the WKB geometry`,
    );
  }
  if (dimensionTracker.layout === undefined || dimensionTracker.positionCount === 0) {
    throw new GeoPackageGeometryError("EMPTY_GEOMETRY", headerLength, "WKB contains no positions");
  }
  assertEnvelopeLayout(envelopeCode, dimensionTracker.layout, headerLength);
  if (envelope !== null) {
    assertEnvelopeMatchesGeometry(envelope, geometry, dimensionTracker.layout, envelopeCode, headerLength);
  }

  return {
    coordinateLayout: dimensionTracker.layout,
    dimensions: dimensionsForLayout(dimensionTracker.layout),
    envelope,
    geometry,
    headerLength,
    srsId,
    wkbLength: bytes.byteLength - headerLength,
  };
}

interface DimensionTracker {
  layout: CoordinateLayout | undefined;
  positionCount: number;
}

interface WkbType {
  baseType: number;
  embeddedSrs: boolean;
  hasM: boolean;
  hasZ: boolean;
}

function parseWkbGeometry(
  cursor: BinaryCursor,
  expectedSrsId: number,
  dimensions: DimensionTracker,
): Geometry {
  const byteOrderOffset = cursor.offset;
  const order = cursor.uint8();
  if (order !== 0 && order !== 1) {
    throw new GeoPackageGeometryError("WKB_INVALID", byteOrderOffset, "WKB byte order must be 0 or 1");
  }
  const littleEndian = order === 1;
  const typeOffset = cursor.offset;
  const type = decodeWkbType(cursor.uint32(littleEndian), typeOffset);
  const coordinateLayout = layoutForType(type);
  trackLayout(dimensions, coordinateLayout, typeOffset);
  if (type.embeddedSrs) {
    const embeddedSrs = cursor.uint32(littleEndian);
    if (embeddedSrs !== expectedSrsId) {
      throw new GeoPackageGeometryError(
        "SRS_CONTRADICTORY",
        cursor.offset - 4,
        `EWKB SRS ${embeddedSrs} disagrees with GeoPackage header SRS ${expectedSrsId}`,
      );
    }
  }
  const coordinateDimensions = dimensionsForLayout(coordinateLayout);

  switch (type.baseType) {
    case 1:
      return {
        coordinates: readPosition(cursor, littleEndian, coordinateDimensions, dimensions),
        type: "Point",
      };
    case 2:
      return {
        coordinates: readPositions(cursor, littleEndian, coordinateDimensions, dimensions),
        type: "LineString",
      };
    case 3:
      return {
        coordinates: readPolygon(cursor, littleEndian, coordinateDimensions, dimensions),
        type: "Polygon",
      };
    case 4:
      return {
        coordinates: readNested(cursor, littleEndian, expectedSrsId, dimensions, "Point").map(
          (member) => member.coordinates,
        ),
        type: "MultiPoint",
      };
    case 5:
      return {
        coordinates: readNested(cursor, littleEndian, expectedSrsId, dimensions, "LineString").map(
          (member) => member.coordinates,
        ),
        type: "MultiLineString",
      };
    case 6:
      return {
        coordinates: readNested(cursor, littleEndian, expectedSrsId, dimensions, "Polygon").map(
          (member) => member.coordinates,
        ),
        type: "MultiPolygon",
      };
    case 7:
      return {
        geometries: readNested(cursor, littleEndian, expectedSrsId, dimensions),
        type: "GeometryCollection",
      };
    default:
      throw new GeoPackageGeometryError(
        "WKB_UNSUPPORTED",
        typeOffset,
        `unsupported WKB base geometry type ${type.baseType}`,
      );
  }
}

function readNested<T extends Geometry["type"]>(
  cursor: BinaryCursor,
  littleEndian: boolean,
  expectedSrsId: number,
  dimensions: DimensionTracker,
  expectedType?: T,
): Extract<Geometry, { type: T }>[] {
  const count = readCount(cursor, littleEndian);
  const members: Geometry[] = [];
  for (let index = 0; index < count; index += 1) {
    const member = parseWkbGeometry(cursor, expectedSrsId, dimensions);
    if (expectedType !== undefined && member.type !== expectedType) {
      throw new GeoPackageGeometryError(
        "WKB_INVALID",
        cursor.offset,
        `multi-geometry member is ${member.type}; expected ${expectedType}`,
      );
    }
    members.push(member);
  }
  return members as Extract<Geometry, { type: T }>[];
}

function readPolygon(
  cursor: BinaryCursor,
  littleEndian: boolean,
  coordinateDimensions: 2 | 3 | 4,
  dimensions: DimensionTracker,
): Position[][] {
  const ringCount = readCount(cursor, littleEndian);
  const rings: Position[][] = [];
  for (let index = 0; index < ringCount; index += 1) {
    rings.push(readPositions(cursor, littleEndian, coordinateDimensions, dimensions));
  }
  return rings;
}

function readPositions(
  cursor: BinaryCursor,
  littleEndian: boolean,
  coordinateDimensions: 2 | 3 | 4,
  dimensions: DimensionTracker,
): Position[] {
  const count = readCount(cursor, littleEndian);
  const positions: Position[] = [];
  for (let index = 0; index < count; index += 1) {
    positions.push(readPosition(cursor, littleEndian, coordinateDimensions, dimensions));
  }
  return positions;
}

function readPosition(
  cursor: BinaryCursor,
  littleEndian: boolean,
  coordinateDimensions: 2 | 3 | 4,
  dimensions: DimensionTracker,
): Position {
  dimensions.positionCount += 1;
  const position: number[] = [];
  for (let index = 0; index < coordinateDimensions; index += 1) {
    const ordinateOffset = cursor.offset;
    const ordinate = cursor.float64(littleEndian);
    if (!Number.isFinite(ordinate)) {
      throw new GeoPackageGeometryError("EMPTY_GEOMETRY", ordinateOffset, "position ordinate is not finite");
    }
    position.push(ordinate);
  }
  return position;
}

function layoutForType(type: WkbType): CoordinateLayout {
  if (type.hasZ && type.hasM) return "XYZM";
  if (type.hasZ) return "XYZ";
  if (type.hasM) return "XYM";
  return "XY";
}

function dimensionsForLayout(layout: CoordinateLayout): 2 | 3 | 4 {
  if (layout === "XY") return 2;
  if (layout === "XYZM") return 4;
  return 3;
}

function trackLayout(tracker: DimensionTracker, layout: CoordinateLayout, offset: number): void {
  if (tracker.layout === undefined) {
    tracker.layout = layout;
  } else if (tracker.layout !== layout) {
    throw new GeoPackageGeometryError(
      "WKB_INVALID",
      offset,
      `mixed coordinate layouts ${tracker.layout} and ${layout}`,
    );
  }
}

function readCount(cursor: BinaryCursor, littleEndian: boolean): number {
  const offset = cursor.offset;
  const count = cursor.uint32(littleEndian);
  if (count > MAX_WKB_MEMBERS) {
    throw new GeoPackageGeometryError(
      "WKB_INVALID",
      offset,
      `member count ${count} exceeds the defensive limit ${MAX_WKB_MEMBERS}`,
    );
  }
  return count;
}

function decodeWkbType(rawType: number, offset: number): WkbType {
  const unsigned = rawType >>> 0;
  const ewkbZ = (unsigned & 0x8000_0000) !== 0;
  const ewkbM = (unsigned & 0x4000_0000) !== 0;
  const embeddedSrs = (unsigned & 0x2000_0000) !== 0;
  const usesEwkbFlags = ewkbZ || ewkbM || embeddedSrs;
  let baseType = unsigned & 0x1fff_ffff;
  let hasZ = ewkbZ;
  let hasM = ewkbM;

  if (!usesEwkbFlags) {
    if (baseType >= 3000) {
      baseType -= 3000;
      hasZ = true;
      hasM = true;
    } else if (baseType >= 2000) {
      baseType -= 2000;
      hasM = true;
    } else if (baseType >= 1000) {
      baseType -= 1000;
      hasZ = true;
    }
  }
  if (baseType < 1 || baseType > 7) {
    throw new GeoPackageGeometryError("WKB_UNSUPPORTED", offset, `unsupported WKB type code ${unsigned}`);
  }
  return { baseType, embeddedSrs, hasM, hasZ };
}

function parseEnvelope(values: readonly number[]): GeoPackageEnvelope | null {
  if (values.length === 0) return null;
  const minX = values[0];
  const maxX = values[1];
  const minY = values[2];
  const maxY = values[3];
  if (minX === undefined || maxX === undefined || minY === undefined || maxY === undefined) {
    throw new GeoPackageGeometryError("HEADER_INVALID", 8, "XY envelope is incomplete");
  }
  if (minX > maxX || minY > maxY) {
    throw new GeoPackageGeometryError("HEADER_INVALID", 8, "envelope minimum exceeds maximum");
  }
  for (let index = 4; index < values.length; index += 2) {
    const minimum = values[index];
    const maximum = values[index + 1];
    if (minimum === undefined || maximum === undefined || minimum > maximum) {
      throw new GeoPackageGeometryError(
        "HEADER_INVALID",
        8 + index * 8,
        "extra-dimension envelope minimum exceeds maximum",
      );
    }
  }
  return { maxX, maxY, minX, minY, values };
}

function assertEnvelopeMatchesGeometry(
  envelope: GeoPackageEnvelope,
  geometry: Geometry,
  layout: CoordinateLayout,
  envelopeCode: number,
  offset: number,
): void {
  const actual = geometryOrdinateBounds(geometry, dimensionsForLayout(layout));
  const tolerance = Math.max(
    1e-9,
    Math.abs(envelope.minX) * 1e-12,
    Math.abs(envelope.maxX) * 1e-12,
    Math.abs(envelope.minY) * 1e-12,
    Math.abs(envelope.maxY) * 1e-12,
    Math.abs(actual[0]?.min ?? 0) * 1e-12,
    Math.abs(actual[0]?.max ?? 0) * 1e-12,
    Math.abs(actual[1]?.min ?? 0) * 1e-12,
    Math.abs(actual[1]?.max ?? 0) * 1e-12,
  );
  if (
    Math.abs((actual[0]?.min ?? Number.POSITIVE_INFINITY) - envelope.minX) > tolerance ||
    Math.abs((actual[0]?.max ?? Number.NEGATIVE_INFINITY) - envelope.maxX) > tolerance ||
    Math.abs((actual[1]?.min ?? Number.POSITIVE_INFINITY) - envelope.minY) > tolerance ||
    Math.abs((actual[1]?.max ?? Number.NEGATIVE_INFINITY) - envelope.maxY) > tolerance
  ) {
    throw new GeoPackageGeometryError(
      "ENVELOPE_MISMATCH",
      offset,
      "binary header envelope does not match decoded geometry bounds",
    );
  }
  const extraEnvelopeIndexes =
    envelopeCode === 2
      ? [[4, 5, 2] as const]
      : envelopeCode === 3
        ? [[4, 5, layout === "XYZM" ? 3 : 2] as const]
        : envelopeCode === 4
          ? ([
              [4, 5, 2],
              [6, 7, 3],
            ] as const)
          : [];
  for (const [minimumIndex, maximumIndex, ordinateIndex] of extraEnvelopeIndexes) {
    const minimum = envelope.values[minimumIndex];
    const maximum = envelope.values[maximumIndex];
    const ordinateBounds = actual[ordinateIndex];
    if (minimum === undefined || maximum === undefined || ordinateBounds === undefined) {
      throw new GeoPackageGeometryError(
        "ENVELOPE_MISMATCH",
        offset,
        "extra-dimension envelope is incomplete",
      );
    }
    const extraTolerance = Math.max(
      1e-9,
      Math.abs(minimum) * 1e-12,
      Math.abs(maximum) * 1e-12,
      Math.abs(ordinateBounds.min) * 1e-12,
      Math.abs(ordinateBounds.max) * 1e-12,
    );
    if (
      Math.abs(ordinateBounds.min - minimum) > extraTolerance ||
      Math.abs(ordinateBounds.max - maximum) > extraTolerance
    ) {
      throw new GeoPackageGeometryError(
        "ENVELOPE_MISMATCH",
        offset,
        `binary header envelope does not match decoded geometry ordinate ${ordinateIndex}`,
      );
    }
  }
}

interface OrdinateBounds {
  max: number;
  min: number;
}

function geometryOrdinateBounds(geometry: Geometry, dimensions: number): OrdinateBounds[] {
  const bounds = Array.from({ length: dimensions }, () => ({
    max: Number.NEGATIVE_INFINITY,
    min: Number.POSITIVE_INFINITY,
  }));

  const visit = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
      for (let index = 0; index < dimensions; index += 1) {
        const ordinate = value[index];
        const ordinateBounds = bounds[index];
        if (typeof ordinate !== "number" || ordinateBounds === undefined) continue;
        ordinateBounds.min = Math.min(ordinateBounds.min, ordinate);
        ordinateBounds.max = Math.max(ordinateBounds.max, ordinate);
      }
      return;
    }
    value.forEach(visit);
  };

  if (geometry.type === "GeometryCollection") {
    geometry.geometries.forEach((member) => {
      const memberBoundsByOrdinate = geometryOrdinateBounds(member, dimensions);
      memberBoundsByOrdinate.forEach((memberBounds, index) => {
        const aggregate = bounds[index];
        if (aggregate === undefined) return;
        aggregate.min = Math.min(aggregate.min, memberBounds.min);
        aggregate.max = Math.max(aggregate.max, memberBounds.max);
      });
    });
  } else {
    visit(geometry.coordinates);
  }
  if (bounds.some((ordinate) => !Number.isFinite(ordinate.min) || !Number.isFinite(ordinate.max))) {
    throw new GeoPackageGeometryError("EMPTY_GEOMETRY", 0, "geometry contains no finite positions");
  }
  return bounds;
}

function assertEnvelopeLayout(envelopeCode: number, layout: CoordinateLayout, offset: number): void {
  if (envelopeCode === 2 && layout !== "XYZ" && layout !== "XYZM") {
    throw new GeoPackageGeometryError("ENVELOPE_MISMATCH", offset, "XYZ envelope requires Z coordinates");
  }
  if (envelopeCode === 3 && layout !== "XYM" && layout !== "XYZM") {
    throw new GeoPackageGeometryError("ENVELOPE_MISMATCH", offset, "XYM envelope requires M coordinates");
  }
  if (envelopeCode === 4 && layout !== "XYZM") {
    throw new GeoPackageGeometryError("ENVELOPE_MISMATCH", offset, "XYZM envelope requires XYZM coordinates");
  }
}

class BinaryCursor {
  public offset: number;
  private readonly view: DataView;

  public constructor(view: DataView, offset: number) {
    this.view = view;
    this.offset = offset;
  }

  public float64(littleEndian: boolean): number {
    this.ensure(8);
    const value = this.view.getFloat64(this.offset, littleEndian);
    this.offset += 8;
    return value;
  }

  public uint32(littleEndian: boolean): number {
    this.ensure(4);
    const value = this.view.getUint32(this.offset, littleEndian);
    this.offset += 4;
    return value;
  }

  public uint8(): number {
    this.ensure(1);
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  private ensure(length: number): void {
    if (this.offset + length > this.view.byteLength) {
      throw new GeoPackageGeometryError("TRUNCATED", this.offset, `need ${length} more byte(s)`);
    }
  }
}
