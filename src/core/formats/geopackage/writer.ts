import type { Geometry, Position } from "geojson";
import { parseGeoPackageGeometry } from "./geometry-header.js";

export interface GeoPackageGeometryBounds {
  maxX: number;
  maxY: number;
  minX: number;
  minY: number;
}

/**
 * Serializes an XY GeoJSON geometry as standard little-endian GeoPackage binary.
 * The deterministic XY envelope is always present and no extended WKB flags are used.
 */
export function serializeGeoPackageGeometry(geometry: Geometry, srsId: number): Uint8Array {
  if (!Number.isSafeInteger(srsId) || srsId < -0x8000_0000 || srsId > 0x7fff_ffff) {
    throw new TypeError("GeoPackage geometry SRS id must be a signed 32-bit integer");
  }
  const bounds = geometryBounds(geometry);
  const writer = new BinaryWriter();
  writer.uint8(0x47);
  writer.uint8(0x50);
  writer.uint8(0);
  // Bit 0: little endian. Bits 1-3: XY envelope (indicator 1). All other bits: zero.
  writer.uint8(0x03);
  writer.int32(srsId);
  writer.float64(bounds.minX);
  writer.float64(bounds.maxX);
  writer.float64(bounds.minY);
  writer.float64(bounds.maxY);
  writeWkbGeometry(writer, geometry);
  const bytes = writer.finish();
  const parsed = parseGeoPackageGeometry(bytes, srsId);
  if (parsed.geometry.type !== geometry.type) {
    throw new Error(`GeoPackage writer self-check changed ${geometry.type} to ${parsed.geometry.type}`);
  }
  return bytes;
}

/** Computes finite XY bounds without altering geometry coordinates. */
export function geometryBounds(geometry: Geometry): GeoPackageGeometryBounds {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  const visit = (position: Position): void => {
    if (position.length !== 2) {
      throw new TypeError(`GeoPackage XY writer received a ${position.length}-dimensional position`);
    }
    const x = position[0];
    const y = position[1];
    if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) {
      throw new TypeError("GeoPackage XY writer received a non-finite position");
    }
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };

  visitGeometryPositions(geometry, visit);
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) {
    throw new TypeError("GeoPackage writer cannot serialize an empty geometry");
  }
  return { maxX, maxY, minX, minY };
}

function writeWkbGeometry(writer: BinaryWriter, geometry: Geometry): void {
  writer.uint8(1);
  writer.uint32(wkbType(geometry));
  switch (geometry.type) {
    case "Point":
      writePosition(writer, geometry.coordinates);
      return;
    case "LineString":
    case "MultiPoint":
      if (geometry.type === "LineString") {
        writePositions(writer, geometry.coordinates);
      } else {
        writer.uint32(geometry.coordinates.length);
        for (const position of geometry.coordinates) {
          writeWkbGeometry(writer, { coordinates: position, type: "Point" });
        }
      }
      return;
    case "Polygon":
      writePolygon(writer, geometry.coordinates);
      return;
    case "MultiLineString":
      writer.uint32(geometry.coordinates.length);
      for (const coordinates of geometry.coordinates) {
        writeWkbGeometry(writer, { coordinates, type: "LineString" });
      }
      return;
    case "MultiPolygon":
      writer.uint32(geometry.coordinates.length);
      for (const coordinates of geometry.coordinates) {
        writeWkbGeometry(writer, { coordinates, type: "Polygon" });
      }
      return;
    case "GeometryCollection":
      writer.uint32(geometry.geometries.length);
      for (const member of geometry.geometries) {
        writeWkbGeometry(writer, member);
      }
      return;
  }
}

function wkbType(geometry: Geometry): number {
  switch (geometry.type) {
    case "Point":
      return 1;
    case "LineString":
      return 2;
    case "Polygon":
      return 3;
    case "MultiPoint":
      return 4;
    case "MultiLineString":
      return 5;
    case "MultiPolygon":
      return 6;
    case "GeometryCollection":
      return 7;
  }
}

function writePolygon(writer: BinaryWriter, coordinates: Position[][]): void {
  writer.uint32(coordinates.length);
  for (const ring of coordinates) {
    writePositions(writer, ring);
  }
}

function writePositions(writer: BinaryWriter, positions: Position[]): void {
  writer.uint32(positions.length);
  for (const position of positions) {
    writePosition(writer, position);
  }
}

function writePosition(writer: BinaryWriter, position: Position): void {
  if (position.length !== 2) {
    throw new TypeError(`GeoPackage XY writer received a ${position.length}-dimensional position`);
  }
  const x = position[0];
  const y = position[1];
  if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new TypeError("GeoPackage XY writer received a non-finite position");
  }
  writer.float64(x);
  writer.float64(y);
}

function visitGeometryPositions(geometry: Geometry, visitor: (position: Position) => void): void {
  const visit = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
      visitor(value as Position);
      return;
    }
    value.forEach(visit);
  };

  if (geometry.type === "GeometryCollection") {
    geometry.geometries.forEach((member) => {
      visitGeometryPositions(member, visitor);
    });
  } else {
    visit(geometry.coordinates);
  }
}

class BinaryWriter {
  private buffer = new ArrayBuffer(1024);
  private length = 0;

  public finish(): Uint8Array {
    return new Uint8Array(this.buffer.slice(0, this.length));
  }

  public float64(value: number): void {
    this.ensure(8);
    new DataView(this.buffer).setFloat64(this.length, value, true);
    this.length += 8;
  }

  public int32(value: number): void {
    this.ensure(4);
    new DataView(this.buffer).setInt32(this.length, value, true);
    this.length += 4;
  }

  public uint32(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
      throw new RangeError(`WKB count/type ${value} is outside uint32`);
    }
    this.ensure(4);
    new DataView(this.buffer).setUint32(this.length, value, true);
    this.length += 4;
  }

  public uint8(value: number): void {
    this.ensure(1);
    new DataView(this.buffer).setUint8(this.length, value);
    this.length += 1;
  }

  private ensure(additional: number): void {
    const required = this.length + additional;
    if (required <= this.buffer.byteLength) return;
    let nextLength = this.buffer.byteLength;
    while (nextLength < required) nextLength *= 2;
    const next = new Uint8Array(nextLength);
    next.set(new Uint8Array(this.buffer, 0, this.length));
    this.buffer = next.buffer;
  }
}
