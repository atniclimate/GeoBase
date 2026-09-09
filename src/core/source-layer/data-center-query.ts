import type { Geometry, MultiPolygon, Polygon } from "geojson";
import type JstsGeometry from "jsts/org/locationtech/jts/geom/Geometry.js";
import GeometryFactory from "jsts/org/locationtech/jts/geom/GeometryFactory.js";
import PrecisionModel from "jsts/org/locationtech/jts/geom/PrecisionModel.js";
import GeoJSONReader from "jsts/org/locationtech/jts/io/GeoJSONReader.js";
import RelateOp from "jsts/org/locationtech/jts/operation/relate/RelateOp.js";
import { assertPositionInCrs, visitGeometryPositions } from "../crs.js";
import { canonicalizePolygonalGeometry } from "../spatial/polygon.js";
import { createJstsPlanarTopologyEngine } from "../spatial/topology.js";
import type { SourceLayerDocument } from "./types.js";

export interface DataCenterAoiQuery {
  /** Overlap includes a boundary touch; it does not imply positive areal overlap. */
  evaluation: "overlap" | "non_match" | "unknown";
  /** Exact source-layer feature IDs, sorted by Unicode code point. */
  matched_source_ids: string[];
  representations: number;
  canonical_sites: number;
  /** True only when the source declares complete coverage of the entire AOI. */
  coverage_complete: boolean;
}

const topology = createJstsPlanarTopologyEngine();
const reader = new GeoJSONReader(new GeometryFactory(new PrecisionModel(), 5070));

/**
 * Queries a parsed generic source-layer document without analysis-profile rules.
 * A match remains observable outside declared coverage when full source geometry
 * was retained. coverage_complete=false means negative evidence stays unknown;
 * zero matches become non_match only with complete whole-AOI source coverage.
 * Counts are mapped source representations/sites, never an exhaustive inventory,
 * load estimate, approval or exclusion score. The caller retains source custody.
 */
export function queryDataCenters(
  document: SourceLayerDocument,
  aoi: Polygon | MultiPolygon,
): DataCenterAoiQuery {
  if (document.analysis_crs !== "EPSG:5070") {
    throw new TypeError("Data-center queries require source-layer analysis geometry in EPSG:5070");
  }
  const queryPolygon = checkedPolygon(aoi, "data-center AOI");
  const coverage = checkedPolygon(document.coverage.geometry, "data-center coverage");
  const coverageComplete =
    document.coverage.completeness === "complete" &&
    Boolean(RelateOp.covers(read(coverage), read(queryPolygon)));
  const queryGeometry = read(queryPolygon);
  const ids: string[] = [];
  const sites = new Set<string>();
  for (const feature of document.features) {
    if (feature.data_center === null) continue;
    // RelateOp.intersects supports points, lines, multiparts and collections and
    // deliberately includes boundary-only touches. No polygon-area test is used.
    if (RelateOp.intersects(queryGeometry, read(feature.analysis_geometry))) {
      ids.push(feature.id);
      sites.add(feature.data_center.canonical_site_id);
    }
  }
  ids.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return {
    evaluation: ids.length > 0 ? "overlap" : coverageComplete ? "non_match" : "unknown",
    matched_source_ids: ids,
    representations: ids.length,
    canonical_sites: sites.size,
    coverage_complete: coverageComplete,
  };
}

function checkedPolygon(geometry: Polygon | MultiPolygon, label: string): Polygon | MultiPolygon {
  if (geometry?.type !== "Polygon" && geometry?.type !== "MultiPolygon") {
    throw new TypeError(`${label} must be a Polygon or MultiPolygon`);
  }
  // Canonicalization validates exact XY positions, cardinality and closed rings
  // without changing the caller's coordinates; validity additionally checks holes
  // and intersections. No rounding, repair, clipping or reprojection takes place.
  const polygon = canonicalizePolygonalGeometry(geometry);
  visitGeometryPositions(polygon, (position) => assertPositionInCrs(position, "EPSG:5070"));
  if (!topology.validate(polygon).valid || topology.area(polygon) <= 0) {
    throw new TypeError(`${label} must have valid positive-area EPSG:5070 geometry`);
  }
  return polygon;
}

function read(geometry: Geometry): JstsGeometry {
  if (geometry === null || geometry === undefined) {
    throw new TypeError("Data-center source analysis geometry is unavailable");
  }
  return reader.read(geometry) as JstsGeometry;
}
