import type { MultiPolygon, Polygon } from "geojson";
import GeometryFactory from "jsts/org/locationtech/jts/geom/GeometryFactory.js";
import PrecisionModel from "jsts/org/locationtech/jts/geom/PrecisionModel.js";
import GeoJSONReader from "jsts/org/locationtech/jts/io/GeoJSONReader.js";
import OverlayOp from "jsts/org/locationtech/jts/operation/overlay/OverlayOp.js";
import RelateOp from "jsts/org/locationtech/jts/operation/relate/RelateOp.js";
import type JstsGeometry from "jsts/org/locationtech/jts/geom/Geometry.js";

export type RstepPolygonal = Polygon | MultiPolygon;

const reader = new GeoJSONReader(new GeometryFactory(new PrecisionModel(), 5070));

function read(geometry: RstepPolygonal): JstsGeometry {
  return reader.read(geometry) as JstsGeometry;
}

function finiteArea(geometry: JstsGeometry): number {
  const area = geometry.getArea();
  if (!Number.isFinite(area) || area < 0) throw new Error("JSTS returned an invalid area");
  return area;
}

export function polygonalArea(geometry: RstepPolygonal): number {
  return finiteArea(read(geometry));
}

export function polygonalIntersectionArea(left: RstepPolygonal, right: RstepPolygonal): number {
  return finiteArea(OverlayOp.intersection(read(left), read(right)) as JstsGeometry);
}

export function polygonalCovers(coverage: RstepPolygonal, aoi: RstepPolygonal): boolean {
  return Boolean(RelateOp.covers(read(coverage), read(aoi)));
}

export function commonIntersectionArea(geometries: readonly RstepPolygonal[]): number {
  if (geometries.length === 0) return 0;
  let current = read(geometries[0] as RstepPolygonal);
  for (const geometry of geometries.slice(1)) {
    current = OverlayOp.intersection(current, read(geometry)) as JstsGeometry;
    if (finiteArea(current) === 0) return 0;
  }
  return finiteArea(current);
}

export function clippedUnionArea(aoi: RstepPolygonal, geometries: readonly RstepPolygonal[]): number {
  if (geometries.length === 0) return 0;
  let union = read(geometries[0] as RstepPolygonal);
  for (const geometry of geometries.slice(1)) union = OverlayOp.union(union, read(geometry)) as JstsGeometry;
  return finiteArea(OverlayOp.intersection(read(aoi), union) as JstsGeometry);
}
