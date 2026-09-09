import type { Geometry, Position } from "geojson";
import proj4 from "proj4";

export type SupportedCrsCode = "EPSG:4269" | "EPSG:4326" | "EPSG:5070" | "EPSG:32610" | "EPSG:3857";

export interface CrsBounds {
  readonly maxX: number;
  readonly maxY: number;
  readonly minX: number;
  readonly minY: number;
}

export interface CrsDefinition {
  readonly axisOrder: "east-north" | "longitude-latitude";
  readonly bounds: CrsBounds;
  readonly code: SupportedCrsCode;
  readonly definition: string;
  readonly name: string;
  readonly units: "degrees" | "metres";
}

export type CrsErrorCode = "INVALID_POSITION" | "OUT_OF_BOUNDS" | "TRANSFORM_FAILED" | "UNKNOWN_CRS";

export class CrsError extends Error {
  public readonly code: CrsErrorCode;

  public constructor(code: CrsErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "CrsError";
  }
}

const CRS_REGISTRY: Readonly<Record<SupportedCrsCode, CrsDefinition>> = {
  "EPSG:4269": {
    axisOrder: "longitude-latitude",
    bounds: { maxX: 180, maxY: 90, minX: -180, minY: -90 },
    code: "EPSG:4269",
    definition: "+proj=longlat +datum=NAD83 +no_defs +type=crs",
    name: "NAD83",
    units: "degrees",
  },
  "EPSG:4326": {
    axisOrder: "longitude-latitude",
    bounds: { maxX: 180, maxY: 90, minX: -180, minY: -90 },
    code: "EPSG:4326",
    definition: "+proj=longlat +datum=WGS84 +no_defs +type=crs",
    name: "WGS 84",
    units: "degrees",
  },
  "EPSG:32610": {
    axisOrder: "east-north",
    bounds: { maxX: 833_979, maxY: 9_329_006, minX: 166_021, minY: 0 },
    code: "EPSG:32610",
    definition: "+proj=utm +zone=10 +datum=WGS84 +units=m +no_defs +type=crs",
    name: "WGS 84 / UTM zone 10N",
    units: "metres",
  },
  "EPSG:3857": {
    axisOrder: "east-north",
    bounds: {
      maxX: 20_037_508.342789244,
      maxY: 20_037_508.342789244,
      minX: -20_037_508.342789244,
      minY: -20_037_508.342789244,
    },
    code: "EPSG:3857",
    definition:
      "+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +k=1 +x_0=0 +y_0=0 +units=m +nadgrids=@null +wktext +no_defs +type=crs",
    name: "WGS 84 / Pseudo-Mercator",
    units: "metres",
  },
  "EPSG:5070": {
    axisOrder: "east-north",
    bounds: { maxX: 3_500_000, maxY: 4_000_000, minX: -3_500_000, minY: 0 },
    code: "EPSG:5070",
    definition:
      "+proj=aea +lat_0=23 +lon_0=-96 +lat_1=29.5 +lat_2=45.5 +x_0=0 +y_0=0 +datum=NAD83 +units=m +no_defs +type=crs",
    name: "NAD83 / Conus Albers",
    units: "metres",
  },
};

for (const definition of Object.values(CRS_REGISTRY)) {
  proj4.defs(definition.code, definition.definition);
}

/** Returns the immutable definition for a supported, exact EPSG identifier. */
export function getCrsDefinition(code: string): CrsDefinition {
  if (!isSupportedCrs(code)) {
    throw new CrsError(
      "UNKNOWN_CRS",
      `unsupported CRS ${JSON.stringify(code)}; supported values are ${Object.keys(CRS_REGISTRY).join(", ")}`,
    );
  }
  return CRS_REGISTRY[code];
}

export function isSupportedCrs(code: unknown): code is SupportedCrsCode {
  return typeof code === "string" && Object.hasOwn(CRS_REGISTRY, code);
}

/** Validates coordinate dimensionality, finiteness, and authoritative CRS bounds. */
export function assertPositionInCrs(position: Position, crs: SupportedCrsCode): void {
  if (position.length < 2) {
    throw new CrsError("INVALID_POSITION", `${crs} position must contain at least x and y`);
  }
  if (position.some((ordinate) => !Number.isFinite(ordinate))) {
    throw new CrsError("INVALID_POSITION", `${crs} position contains a non-finite ordinate`);
  }

  const x = position[0];
  const y = position[1];
  if (x === undefined || y === undefined) {
    throw new CrsError("INVALID_POSITION", `${crs} position must contain x and y`);
  }

  const { bounds } = CRS_REGISTRY[crs];
  if (x < bounds.minX || x > bounds.maxX || y < bounds.minY || y > bounds.maxY) {
    throw new CrsError(
      "OUT_OF_BOUNDS",
      `${crs} position [${x}, ${y}] is outside supported bounds ` +
        `[${bounds.minX}, ${bounds.minY}, ${bounds.maxX}, ${bounds.maxY}]`,
    );
  }
}

/**
 * Transforms x/y with proj4, retaining every third and later ordinate byte-for-byte
 * as numeric values. Both the source and transformed coordinate are bounds checked.
 */
export function transformPosition(
  position: Position,
  sourceCrs: SupportedCrsCode,
  targetCrs: SupportedCrsCode,
): Position {
  assertPositionInCrs(position, sourceCrs);
  if (sourceCrs === targetCrs) {
    const copied = [...position];
    assertPositionInCrs(copied, targetCrs);
    return copied;
  }

  const x = position[0] as number;
  const y = position[1] as number;
  let transformed: [number, number];
  try {
    transformed = proj4(sourceCrs, targetCrs, [x, y]) as [number, number];
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown proj4 failure";
    throw new CrsError(
      "TRANSFORM_FAILED",
      `proj4 could not transform ${sourceCrs} to ${targetCrs}: ${detail}`,
    );
  }

  const result = [transformed[0], transformed[1], ...position.slice(2)];
  assertPositionInCrs(result, targetCrs);
  return result;
}

/** Walks every GeoJSON position without changing geometry family or foreign members. */
export function transformGeometry(
  geometry: Geometry,
  sourceCrs: SupportedCrsCode,
  targetCrs: SupportedCrsCode,
): Geometry {
  switch (geometry.type) {
    case "Point":
      return { ...geometry, coordinates: transformPosition(geometry.coordinates, sourceCrs, targetCrs) };
    case "MultiPoint":
    case "LineString":
      return {
        ...geometry,
        coordinates: geometry.coordinates.map((position) =>
          transformPosition(position, sourceCrs, targetCrs),
        ),
      };
    case "MultiLineString":
    case "Polygon":
      return {
        ...geometry,
        coordinates: geometry.coordinates.map((line) =>
          line.map((position) => transformPosition(position, sourceCrs, targetCrs)),
        ),
      };
    case "MultiPolygon":
      return {
        ...geometry,
        coordinates: geometry.coordinates.map((polygon) =>
          polygon.map((ring) => ring.map((position) => transformPosition(position, sourceCrs, targetCrs))),
        ),
      };
    case "GeometryCollection":
      return {
        ...geometry,
        geometries: geometry.geometries.map((member) => transformGeometry(member, sourceCrs, targetCrs)),
      };
  }
}

/** Calls the visitor for each position with a stable diagnostic path. */
export function visitGeometryPositions(
  geometry: Geometry,
  visitor: (position: Position, path: string) => void,
  rootPath = "geometry",
): void {
  const visitNested = (value: unknown, path: string): void => {
    if (!Array.isArray(value)) {
      return;
    }
    if (value.length >= 2 && value.every((member) => typeof member === "number")) {
      visitor(value as Position, path);
      return;
    }
    value.forEach((member, index) => {
      visitNested(member, `${path}[${index}]`);
    });
  };

  if (geometry.type === "GeometryCollection") {
    geometry.geometries.forEach((member, index) => {
      visitGeometryPositions(member, visitor, `${rootPath}.geometries[${index}]`);
    });
    return;
  }
  visitNested(geometry.coordinates, `${rootPath}.coordinates`);
}
