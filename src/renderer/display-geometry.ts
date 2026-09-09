import type { MultiPolygon, Polygon, Position } from "geojson";

export type LongitudeLatitude = readonly [longitude: number, latitude: number];

export type DisplayRing = readonly LongitudeLatitude[];

export interface DisplayPolygonPart {
  readonly rings: readonly DisplayRing[];
}

/**
 * Converts canonical polygonal GeoJSON into disposable two-dimensional render parts.
 * Every polygon member and every interior ring is retained; extra source dimensions
 * remain the responsibility of the canonical geometry rather than the Cesium view.
 */
export function polygonDisplayParts(geometry: MultiPolygon | Polygon): DisplayPolygonPart[] {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;

  return polygons.map((rings, polygonIndex) => ({
    rings: rings.map((ring, ringIndex) => displayRing(ring, polygonIndex, ringIndex)),
  }));
}

function displayRing(
  ring: readonly Position[],
  polygonIndex: number,
  ringIndex: number,
): LongitudeLatitude[] {
  return ring.map((position, positionIndex) => {
    const longitude = position[0];
    const latitude = position[1];
    if (
      typeof longitude !== "number" ||
      !Number.isFinite(longitude) ||
      typeof latitude !== "number" ||
      !Number.isFinite(latitude)
    ) {
      throw new TypeError(
        `polygon ${polygonIndex} ring ${ringIndex} position ${positionIndex} must contain finite longitude and latitude`,
      );
    }
    return [longitude, latitude];
  });
}
