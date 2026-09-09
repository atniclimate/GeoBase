import type { Polygon, Position } from "geojson";
import { transformGeometry } from "../core/crs";

/** Geographic rectangle, 64 segments per edge before the explicit EPSG:5070 transformation. */
export function createRstepAoi(values: readonly string[]): Polygon {
  if (values.length !== 4 || values.some((value) => value.trim() === ""))
    throw new Error("Every AOI bound is required; missing is not zero.");
  const [west, south, east, north] = values.map(Number);
  if (
    west === undefined ||
    south === undefined ||
    east === undefined ||
    north === undefined ||
    ![west, south, east, north].every(Number.isFinite) ||
    west >= east ||
    south >= north ||
    east - west > 5 ||
    north - south > 5
  )
    throw new Error("AOI requires finite ordered bounds spanning at most five degrees per axis.");
  const corners: [number, number][] = [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ];
  const ring: Position[] = [];
  for (let edge = 0; edge < 4; edge += 1) {
    const start = corners[edge],
      end = corners[edge + 1];
    if (start === undefined || end === undefined) throw new Error("AOI edge is missing.");
    for (let step = 0; step < 64; step += 1)
      ring.push([start[0] + ((end[0] - start[0]) * step) / 64, start[1] + ((end[1] - start[1]) * step) / 64]);
  }
  ring.push([west, south]);
  return transformGeometry({ type: "Polygon", coordinates: [ring] }, "EPSG:4326", "EPSG:5070") as Polygon;
}
