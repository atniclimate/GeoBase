import type { WashingtonTechnicalAoi } from "../aoi/wa-buffer.js";
import { transformGeometry } from "../crs.js";
import { geometryBounds } from "../formats/geopackage/writer.js";
import { canonicalizePolygonalGeometry, type PolygonalGeometry } from "../spatial/polygon.js";
import type { PlanarTopologyEngine } from "../spatial/topology.js";

export interface NativeTribalFeature<T = unknown> {
  coordinate_reference_system: "EPSG:4269";
  geometry: PolygonalGeometry;
  payload: T;
  source_feature_id: string;
  source_geometry_sha256: string;
}

export interface TribalFeatureAoiRelation {
  intersects_overflow_only: boolean;
  intersects_state: boolean;
  touches_state: boolean;
}

export interface SelectedWholeTribalFeature<T = unknown> extends NativeTribalFeature<T> {
  relation: TribalFeatureAoiRelation;
}

/**
 * Projects one exact native polygon into the current runtime's topology coordinate view.
 * State and Tribal features must use this same operation before relation predicates so
 * shared source vertices remain coincident across JavaScript engines.
 */
export function projectNad83PolygonalForTribalTopology(geometry: PolygonalGeometry): PolygonalGeometry {
  return canonicalizePolygonalGeometry(
    transformGeometry(geometry, "EPSG:4269", "EPSG:5070") as PolygonalGeometry,
  );
}

/**
 * Selects complete source features by full projected topology. No clipping or geometry repair occurs.
 */
export function selectWholeTribalFeatures<T>(
  features: Iterable<NativeTribalFeature<T>>,
  aoi: WashingtonTechnicalAoi,
  engine: PlanarTopologyEngine,
): SelectedWholeTribalFeature<T>[] {
  const selected: SelectedWholeTribalFeature<T>[] = [];
  const relationMetricState = projectNad83PolygonalForTribalTopology(aoi.source.wa_state);
  for (const feature of features) {
    if (feature.source_feature_id.trim().length === 0) {
      throw new TypeError("source feature id must be non-empty");
    }
    if (!/^[a-f0-9]{64}$/.test(feature.source_geometry_sha256)) {
      throw new TypeError(`source feature ${feature.source_feature_id} has an invalid geometry SHA-256`);
    }
    if (feature.coordinate_reference_system !== "EPSG:4269") {
      throw new TypeError(
        `source feature ${feature.source_feature_id} must carry registered EPSG:4269 coordinates`,
      );
    }
    if (!boundsIntersect(geometryBounds(feature.geometry), aoi.source_selection.bounds)) continue;
    const projected = projectNad83PolygonalForTribalTopology(feature.geometry);
    const intersectsState = engine.intersects(projected, relationMetricState);
    const intersectsOverflow = engine.intersects(projected, aoi.metric.wa_overflow_100m);
    if (!intersectsState && !intersectsOverflow) continue;
    selected.push({
      ...feature,
      relation: {
        intersects_overflow_only: intersectsOverflow && !intersectsState,
        intersects_state: intersectsState,
        touches_state: engine.touches(projected, relationMetricState),
      },
    });
  }
  return selected.sort((left, right) => compareCodePoints(left.source_feature_id, right.source_feature_id));
}

function boundsIntersect(
  left: { maxX: number; maxY: number; minX: number; minY: number },
  right: { maxX: number; maxY: number; minX: number; minY: number },
): boolean {
  return !(
    left.maxX < right.minX ||
    left.minX > right.maxX ||
    left.maxY < right.minY ||
    left.minY > right.maxY
  );
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
