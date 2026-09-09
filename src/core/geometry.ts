import booleanValid from "@turf/boolean-valid";
import type { Feature, Geometry, Position } from "geojson";
import { assertPositionInCrs, type SupportedCrsCode, visitGeometryPositions } from "./crs.js";

export type GeometryFailureCode =
  | "COORDINATE_DIMENSION"
  | "COORDINATE_OUT_OF_BOUNDS"
  | "DEGENERATE_RING"
  | "EMPTY_GEOMETRY"
  | "INVALID_STRUCTURE"
  | "RING_NOT_CLOSED"
  | "TOPOLOGY_INVALID";

export interface GeometryFailure {
  readonly code: GeometryFailureCode;
  readonly message: string;
  readonly path: string;
}

export class GeometryValidationError extends Error {
  public readonly failures: readonly GeometryFailure[];

  public constructor(failures: readonly GeometryFailure[]) {
    super(failures.map((failure) => `${failure.path}: ${failure.message}`).join("; "));
    this.failures = failures;
    this.name = "GeometryValidationError";
  }
}

/** Returns actionable geometry and CRS failures instead of a boolean-only verdict. */
export function inspectGeometry(geometry: Geometry, crs: SupportedCrsCode): readonly GeometryFailure[] {
  const failures: GeometryFailure[] = [];
  let expectedDimensions: number | undefined;

  visitGeometryPositions(geometry, (position, path) => {
    if (position.length < 2) {
      failures.push({
        code: "COORDINATE_DIMENSION",
        message: "position must have at least two ordinates",
        path,
      });
      return;
    }

    if (expectedDimensions === undefined) {
      expectedDimensions = position.length;
    } else if (position.length !== expectedDimensions) {
      failures.push({
        code: "COORDINATE_DIMENSION",
        message: `position has ${position.length} dimensions; expected ${expectedDimensions}`,
        path,
      });
    }

    try {
      assertPositionInCrs(position, crs);
    } catch (error) {
      failures.push({
        code: "COORDINATE_OUT_OF_BOUNDS",
        message: error instanceof Error ? error.message : "coordinate is invalid for its CRS",
        path,
      });
    }
  });

  inspectStructure(geometry, "geometry", failures);

  if (failures.length === 0 && !booleanValid(asFeature(geometry))) {
    failures.push({
      code: "TOPOLOGY_INVALID",
      message: "geometry fails polygon topology validation; inspect ring containment and overlaps",
      path: "geometry",
    });
  }

  return failures;
}

export function assertValidGeometry(geometry: Geometry, crs: SupportedCrsCode): void {
  const failures = inspectGeometry(geometry, crs);
  if (failures.length > 0) {
    throw new GeometryValidationError(failures);
  }
}

function inspectStructure(geometry: Geometry, path: string, failures: GeometryFailure[]): void {
  switch (geometry.type) {
    case "Point":
      inspectPosition(geometry.coordinates, `${path}.coordinates`, failures);
      break;
    case "MultiPoint":
      if (geometry.coordinates.length === 0) {
        failures.push(emptyFailure(`${path}.coordinates`));
      }
      geometry.coordinates.forEach((position, index) => {
        inspectPosition(position, `${path}.coordinates[${index}]`, failures);
      });
      break;
    case "LineString":
      inspectLine(geometry.coordinates, `${path}.coordinates`, failures);
      break;
    case "MultiLineString":
      if (geometry.coordinates.length === 0) {
        failures.push(emptyFailure(`${path}.coordinates`));
      }
      geometry.coordinates.forEach((line, index) => {
        inspectLine(line, `${path}.coordinates[${index}]`, failures);
      });
      break;
    case "Polygon":
      inspectPolygon(geometry.coordinates, `${path}.coordinates`, failures);
      break;
    case "MultiPolygon":
      if (geometry.coordinates.length === 0) {
        failures.push(emptyFailure(`${path}.coordinates`));
      }
      geometry.coordinates.forEach((polygon, index) => {
        inspectPolygon(polygon, `${path}.coordinates[${index}]`, failures);
      });
      break;
    case "GeometryCollection":
      if (geometry.geometries.length === 0) {
        failures.push(emptyFailure(`${path}.geometries`));
      }
      geometry.geometries.forEach((member, index) => {
        inspectStructure(member, `${path}.geometries[${index}]`, failures);
      });
      break;
  }
}

function inspectPosition(position: Position, path: string, failures: GeometryFailure[]): void {
  if (position.length < 2 || position.some((ordinate) => !Number.isFinite(ordinate))) {
    failures.push({
      code: "INVALID_STRUCTURE",
      message: "position must contain at least two finite numeric ordinates",
      path,
    });
  }
}

function inspectLine(line: Position[], path: string, failures: GeometryFailure[]): void {
  if (line.length < 2) {
    failures.push({
      code: "INVALID_STRUCTURE",
      message: "line must contain at least two positions",
      path,
    });
  }
  line.forEach((position, index) => {
    inspectPosition(position, `${path}[${index}]`, failures);
  });
}

function inspectPolygon(polygon: Position[][], path: string, failures: GeometryFailure[]): void {
  if (polygon.length === 0) {
    failures.push(emptyFailure(path));
    return;
  }
  polygon.forEach((ring, index) => {
    inspectRing(ring, `${path}[${index}]`, failures);
  });
}

function inspectRing(ring: Position[], path: string, failures: GeometryFailure[]): void {
  if (ring.length < 4) {
    failures.push({
      code: "INVALID_STRUCTURE",
      message: "linear ring must contain at least four positions including closure",
      path,
    });
    return;
  }

  ring.forEach((position, index) => {
    inspectPosition(position, `${path}[${index}]`, failures);
  });

  const first = ring[0];
  const last = ring.at(-1);
  if (first === undefined || last === undefined || !positionsEqual(first, last)) {
    failures.push({
      code: "RING_NOT_CLOSED",
      message: "linear ring must end with the same complete position with which it starts",
      path,
    });
    return;
  }

  if (Math.abs(signedArea(ring)) <= Number.EPSILON) {
    failures.push({
      code: "DEGENERATE_RING",
      message: "linear ring encloses zero coordinate-space area",
      path,
    });
  }
}

function positionsEqual(left: Position, right: Position): boolean {
  return left.length === right.length && left.every((ordinate, index) => ordinate === right[index]);
}

function signedArea(ring: Position[]): number {
  let twiceArea = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const current = ring[index];
    const next = ring[index + 1];
    if (current === undefined || next === undefined) {
      continue;
    }
    twiceArea += (current[0] as number) * (next[1] as number);
    twiceArea -= (next[0] as number) * (current[1] as number);
  }
  return twiceArea / 2;
}

function emptyFailure(path: string): GeometryFailure {
  return { code: "EMPTY_GEOMETRY", message: "geometry member must not be empty", path };
}

function asFeature(geometry: Geometry): Feature<Geometry> {
  return { geometry, properties: {}, type: "Feature" };
}
