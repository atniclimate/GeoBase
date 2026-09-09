import type { MultiPolygon, Polygon, Position } from "geojson";

export type PolygonalGeometry = MultiPolygon | Polygon;

/** Returns a deterministic RFC 7946-oriented copy without rounding or simplifying coordinates. */
export function canonicalizePolygonalGeometry(geometry: PolygonalGeometry): PolygonalGeometry {
  if (geometry.type === "Polygon") {
    return { coordinates: canonicalizePolygon(geometry.coordinates), type: "Polygon" };
  }
  const polygons = geometry.coordinates.map(canonicalizePolygon);
  polygons.sort((left, right) => compareCodePoints(polygonKey(left), polygonKey(right)));
  return { coordinates: polygons, type: "MultiPolygon" };
}

/** Narrows a GeoJSON geometry to the only families accepted for area topology. */
export function requirePolygonalGeometry(value: unknown, path: string): PolygonalGeometry {
  if (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value.type === "Polygon" || value.type === "MultiPolygon")
  ) {
    return value as PolygonalGeometry;
  }
  throw new TypeError(`${path} must be a Polygon or MultiPolygon`);
}

function canonicalizePolygon(polygon: Position[][]): Position[][] {
  if (polygon.length === 0) throw new TypeError("polygon must contain an exterior ring");
  const exterior = polygon[0];
  if (exterior === undefined) throw new TypeError("polygon exterior ring is unavailable");
  const holes = polygon.slice(1).map((ring) => canonicalizeRing(ring, false));
  holes.sort((left, right) => compareCodePoints(ringKey(left), ringKey(right)));
  return [canonicalizeRing(exterior, true), ...holes];
}

function canonicalizeRing(ring: Position[], counterClockwise: boolean): Position[] {
  const normalized = ring.map(normalizePosition);
  if (normalized.length < 4 || !positionsEqual(normalized[0], normalized.at(-1))) {
    throw new TypeError("polygon ring must contain at least four positions and be closed");
  }
  let open = normalized.slice(0, -1);
  const area = signedArea(normalized);
  if (area === 0) throw new TypeError("polygon ring has zero coordinate-space area");
  if (area > 0 !== counterClockwise) open = open.reverse();
  const selected = rotate(open, leastCyclicRotation(open));
  return [...selected, [...(selected[0] as Position)]];
}

function rotate(positions: Position[], start: number): Position[] {
  return [...positions.slice(start), ...positions.slice(0, start)];
}

function comparePosition(left: Position, right: Position): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] as number) - (right[index] as number);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

/** Booth's algorithm over numeric positions; avoids quadratic repeated-minimum scans. */
function leastCyclicRotation(positions: Position[]): number {
  const count = positions.length;
  if (count === 0) throw new TypeError("polygon ring contains no positions");
  let left = 0;
  let right = 1;
  let offset = 0;
  while (left < count && right < count && offset < count) {
    const comparison = comparePosition(
      positions[(left + offset) % count] as Position,
      positions[(right + offset) % count] as Position,
    );
    if (comparison === 0) {
      offset += 1;
      continue;
    }
    if (comparison > 0) {
      left += offset + 1;
      if (left <= right) left = right + 1;
    } else {
      right += offset + 1;
      if (right <= left) right = left + 1;
    }
    offset = 0;
  }
  return Math.min(left, right) % count;
}

function normalizePosition(position: Position): Position {
  if (position.length !== 2) {
    throw new TypeError(
      `polygonal topology requires exact XY positions; received ${position.length} ordinates`,
    );
  }
  const x = position[0];
  const y = position[1];
  if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new TypeError("polygonal topology requires finite XY positions");
  }
  return [Object.is(x, -0) ? 0 : x, Object.is(y, -0) ? 0 : y];
}

function positionsEqual(left: Position | undefined, right: Position | undefined): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.length === right.length &&
    left.every((ordinate, index) => ordinate === right[index])
  );
}

function signedArea(ring: Position[]): number {
  let twiceArea = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const current = ring[index];
    const next = ring[index + 1];
    if (current === undefined || next === undefined) continue;
    twiceArea += (current[0] as number) * (next[1] as number);
    twiceArea -= (next[0] as number) * (current[1] as number);
  }
  return twiceArea / 2;
}

function ringKey(ring: Position[]): string {
  return JSON.stringify(ring);
}

function polygonKey(polygon: Position[][]): string {
  return JSON.stringify(polygon);
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
