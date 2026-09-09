import type { Feature } from "geojson";
import type { JsonObject, JsonValue } from "../../shared/json.js";
import { isJsonObject } from "../../shared/json.js";
import { stableStringify } from "../../shared/stable-json.js";
import { transformGeometry } from "../crs.js";
import { type GeoPackageGeometryBounds, geometryBounds } from "../formats/geopackage/writer.js";
import { assertValidGeometry } from "../geometry.js";
import { sha256Text } from "../hash.js";
import { canonicalizePolygonalGeometry, type PolygonalGeometry } from "../spatial/polygon.js";
import type { PlanarBufferParameters, PlanarTopologyEngine } from "../spatial/topology.js";

export const WASHINGTON_TECHNICAL_BUFFER_METRES = 100 as const;

export const WASHINGTON_BUFFER_PARAMETERS: PlanarBufferParameters = Object.freeze({
  distanceMetres: WASHINGTON_TECHNICAL_BUFFER_METRES,
  endCap: "round",
  join: "round",
  mitreLimit: 5,
  quadrantSegments: 16,
  simplifyFactor: 0,
  singleSided: false,
});

export const WASHINGTON_TECHNICAL_BUFFER_DISCLAIMER =
  "The nominal 100 metre overflow is only a data-edge and source-selection device. It is not a legal, jurisdictional, ownership, consultation, notice, treaty, or RSTEP 10 km notification boundary.";

export const MAXIMUM_WASHINGTON_GEODESIC_AUDIT_TOLERANCE_METRES = 5;

const GEODESIC_AUDIT_NUMERIC_TOLERANCE_METRES = 1e-9;

export interface WashingtonAoiTransformation {
  coordinate_engine: "proj4js 2.21.0";
  operation_definition: string;
  performed_at: string;
  source_axis_order: "east-north" | "longitude-latitude";
  source_crs: "EPSG:4269" | "EPSG:5070";
  target_axis_order: "east-north" | "longitude-latitude";
  target_crs: "EPSG:4269" | "EPSG:4326" | "EPSG:5070";
}

export interface WashingtonGeodesicAudit {
  audited_at: string;
  engine: string;
  max_absolute_deviation_metres: number;
  max_observed_offset_metres: number;
  mean_observed_offset_metres: number;
  method: string;
  metric_buffer_geometry_sha256: string;
  min_observed_offset_metres: number;
  rms_deviation_metres: number;
  sample_count: number;
  tolerance_metres: number;
  version: string;
  within_tolerance: boolean;
}

export interface WashingtonTechnicalAoi {
  assertions: {
    buffer_covers_state: true;
    state_overflow_interior_overlap_square_metres: number;
  };
  buffer_parameters: PlanarBufferParameters;
  disclaimer: typeof WASHINGTON_TECHNICAL_BUFFER_DISCLAIMER;
  metric: {
    buffered_aoi: PolygonalGeometry;
    buffered_aoi_sha256: string;
    bounds: {
      buffered_aoi: GeoPackageGeometryBounds;
      wa_overflow_100m: GeoPackageGeometryBounds;
      wa_state: GeoPackageGeometryBounds;
    };
    coordinate_reference_system: "EPSG:5070";
    overflow_area_square_metres: number;
    wa_overflow_100m: PolygonalGeometry;
    wa_overflow_100m_sha256: string;
    wa_state: PolygonalGeometry;
    wa_state_sha256: string;
  };
  independent_geodesic_audit: WashingtonGeodesicAudit | null;
  presentation: {
    buffered_aoi: PolygonalGeometry;
    coordinate_reference_system: "EPSG:4326";
    bounds: {
      buffered_aoi: GeoPackageGeometryBounds;
      wa_overflow_100m: GeoPackageGeometryBounds;
      wa_state: GeoPackageGeometryBounds;
    };
    wa_overflow_100m: PolygonalGeometry;
    wa_state: PolygonalGeometry;
  };
  schema_version: "1.0.0";
  source: {
    bounds: GeoPackageGeometryBounds;
    coordinate_reference_system: "EPSG:4269";
    feature_id: string;
    geometry_sha256: string;
    source_archive_sha256: string;
    source_table: string;
    wa_state: PolygonalGeometry;
  };
  source_selection: {
    buffered_aoi: PolygonalGeometry;
    bounds: GeoPackageGeometryBounds;
    coordinate_reference_system: "EPSG:4269";
  };
  topology: {
    implementation: string;
    version: string;
  };
  transformations: readonly WashingtonAoiTransformation[];
}

export interface BuildWashingtonTechnicalAoiInput {
  independentGeodesicAudit?: WashingtonGeodesicAudit | null;
  performedAt: string;
  sourceCoordinateReferenceSystem: "EPSG:4269";
  sourceArchiveSha256: string;
  sourceFeature: Feature<PolygonalGeometry>;
  sourceGeometrySha256: string;
  sourceTable: string;
  topologyEngine: PlanarTopologyEngine;
}

export interface VerifyStoredWashingtonTechnicalAoiInput {
  bufferedAoi: PolygonalGeometry;
  independentGeodesicAudit: WashingtonGeodesicAudit;
  metricState: PolygonalGeometry;
  overflow: PolygonalGeometry;
  performedAt: string;
  sourceArchiveSha256: string;
  sourceFeature: Feature<PolygonalGeometry>;
  sourceGeometrySha256: string;
  sourceTable: string;
  topologyEngine: PlanarTopologyEngine;
}

/** Returns the complete non-geometry AOI binding, including numeric bounds, for persisted custody. */
export function createWashingtonAoiSnapshot(aoi: WashingtonTechnicalAoi): JsonObject {
  return JSON.parse(
    JSON.stringify({
      assertions: aoi.assertions,
      buffer_parameters: aoi.buffer_parameters,
      disclaimer: aoi.disclaimer,
      independent_geodesic_audit: aoi.independent_geodesic_audit,
      metric: {
        buffered_aoi_sha256: aoi.metric.buffered_aoi_sha256,
        bounds: aoi.metric.bounds,
        coordinate_reference_system: aoi.metric.coordinate_reference_system,
        overflow_area_square_metres: aoi.metric.overflow_area_square_metres,
        wa_overflow_100m_sha256: aoi.metric.wa_overflow_100m_sha256,
        wa_state_sha256: aoi.metric.wa_state_sha256,
      },
      presentation: {
        bounds: aoi.presentation.bounds,
        coordinate_reference_system: aoi.presentation.coordinate_reference_system,
      },
      schema_version: aoi.schema_version,
      source: {
        bounds: aoi.source.bounds,
        coordinate_reference_system: aoi.source.coordinate_reference_system,
        feature_id: aoi.source.feature_id,
        geometry_sha256: aoi.source.geometry_sha256,
        source_archive_sha256: aoi.source.source_archive_sha256,
        source_table: aoi.source.source_table,
      },
      source_selection: {
        bounds: aoi.source_selection.bounds,
        coordinate_reference_system: aoi.source_selection.coordinate_reference_system,
      },
      topology: aoi.topology,
      transformations: aoi.transformations,
    }),
  ) as JsonObject;
}

/** Parses the independently generated non-geometry audit used to bind an AOI build. */
export function parseWashingtonGeodesicAudit(value: unknown): WashingtonGeodesicAudit {
  if (!isJsonObject(value)) throw new TypeError("geodesic audit must be a JSON object");
  const requiredKeys = [
    "audited_at",
    "engine",
    "max_absolute_deviation_metres",
    "max_observed_offset_metres",
    "mean_observed_offset_metres",
    "method",
    "metric_buffer_geometry_sha256",
    "min_observed_offset_metres",
    "rms_deviation_metres",
    "sample_count",
    "tolerance_metres",
    "version",
    "within_tolerance",
  ];
  const keys = Object.keys(value).sort();
  const expected = [...requiredKeys].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError("geodesic audit has missing or unexpected fields");
  }
  const audit = value as unknown as WashingtonGeodesicAudit;
  if (typeof audit.within_tolerance !== "boolean") {
    throw new TypeError("geodesic audit within_tolerance must be boolean");
  }
  validateGeodesicAudit(audit, audit.metric_buffer_geometry_sha256);
  return audit;
}

/** Builds and verifies Washington plus a deterministic exterior 100 m technical overflow. */
export async function buildWashingtonTechnicalAoi(
  input: BuildWashingtonTechnicalAoiInput,
): Promise<WashingtonTechnicalAoi> {
  requireCanonicalTimestamp(input.performedAt);
  requireSha256(input.sourceArchiveSha256, "sourceArchiveSha256");
  requireSha256(input.sourceGeometrySha256, "sourceGeometrySha256");
  if (input.sourceCoordinateReferenceSystem !== "EPSG:4269") {
    throw new TypeError("Washington source must carry its registered EPSG:4269 CRS");
  }
  if (input.sourceTable.trim().length === 0) throw new TypeError("sourceTable must be non-empty");
  if (input.sourceFeature.id === undefined || String(input.sourceFeature.id).trim().length === 0) {
    throw new TypeError("Washington source feature requires a stable source id");
  }

  const sourceNativeState = structuredClone(input.sourceFeature.geometry);
  const actualSourceHash = await hashGeometry(sourceNativeState);
  if (actualSourceHash !== input.sourceGeometrySha256) {
    throw new TypeError("sourceGeometrySha256 does not match the canonical Washington source geometry");
  }
  assertValidGeometry(sourceNativeState, "EPSG:4269");
  assertEngineValidity(input.topologyEngine, sourceNativeState, "source Washington state");

  const sourceState = canonicalizePolygonalGeometry(sourceNativeState);

  const metricState = canonicalizePolygonalGeometry(
    transformGeometry(sourceState, "EPSG:4269", "EPSG:5070") as PolygonalGeometry,
  );
  assertValidGeometry(metricState, "EPSG:5070");
  assertEngineValidity(input.topologyEngine, metricState, "projected Washington state");

  const buffered = input.topologyEngine.buffer(metricState, WASHINGTON_BUFFER_PARAMETERS);
  const overflow = input.topologyEngine.difference(buffered, metricState);
  assertValidGeometry(buffered, "EPSG:5070");
  assertValidGeometry(overflow, "EPSG:5070");
  assertEngineValidity(input.topologyEngine, buffered, "Washington technical buffer");
  assertEngineValidity(input.topologyEngine, overflow, "Washington exterior overflow");

  if (!input.topologyEngine.covers(buffered, metricState)) {
    throw new Error("Washington technical buffer does not cover the source state geometry");
  }
  const overflowArea = input.topologyEngine.area(overflow);
  if (!(overflowArea > 0)) throw new Error("Washington exterior overflow must have positive area");
  const overlapArea = input.topologyEngine.intersectionArea(metricState, overflow);
  const overlapTolerance = Math.max(1e-6, overflowArea * 1e-12);
  if (overlapArea > overlapTolerance) {
    throw new Error(
      `Washington state and exterior overflow interiors overlap by ${overlapArea} square metres`,
    );
  }

  const presentationState = transformPresentation(metricState);
  const presentationBuffer = transformPresentation(buffered);
  const presentationOverflow = transformPresentation(overflow);
  const sourceSelectionBuffer = canonicalizePolygonalGeometry(
    transformGeometry(buffered, "EPSG:5070", "EPSG:4269") as PolygonalGeometry,
  );
  assertValidGeometry(sourceSelectionBuffer, "EPSG:4269");

  const metricStateHash = await hashGeometry(metricState);
  const metricBufferHash = await hashGeometry(buffered);
  const metricOverflowHash = await hashGeometry(overflow);
  const audit = input.independentGeodesicAudit ?? null;
  if (audit !== null) {
    validateGeodesicAudit(audit, metricBufferHash);
    assertAuditNotAfterPerformedAt(audit, input.performedAt);
  }

  return {
    assertions: {
      buffer_covers_state: true,
      state_overflow_interior_overlap_square_metres: overlapArea,
    },
    buffer_parameters: WASHINGTON_BUFFER_PARAMETERS,
    disclaimer: WASHINGTON_TECHNICAL_BUFFER_DISCLAIMER,
    independent_geodesic_audit: audit,
    metric: {
      buffered_aoi: buffered,
      buffered_aoi_sha256: metricBufferHash,
      bounds: {
        buffered_aoi: geometryBounds(buffered),
        wa_overflow_100m: geometryBounds(overflow),
        wa_state: geometryBounds(metricState),
      },
      coordinate_reference_system: "EPSG:5070",
      overflow_area_square_metres: overflowArea,
      wa_overflow_100m: overflow,
      wa_overflow_100m_sha256: metricOverflowHash,
      wa_state: metricState,
      wa_state_sha256: metricStateHash,
    },
    presentation: {
      buffered_aoi: presentationBuffer,
      bounds: {
        buffered_aoi: geometryBounds(presentationBuffer),
        wa_overflow_100m: geometryBounds(presentationOverflow),
        wa_state: geometryBounds(presentationState),
      },
      coordinate_reference_system: "EPSG:4326",
      wa_overflow_100m: presentationOverflow,
      wa_state: presentationState,
    },
    schema_version: "1.0.0",
    source: {
      bounds: geometryBounds(sourceNativeState),
      coordinate_reference_system: "EPSG:4269",
      feature_id: String(input.sourceFeature.id),
      geometry_sha256: input.sourceGeometrySha256,
      source_archive_sha256: input.sourceArchiveSha256,
      source_table: input.sourceTable,
      wa_state: sourceNativeState,
    },
    source_selection: {
      buffered_aoi: sourceSelectionBuffer,
      bounds: geometryBounds(sourceSelectionBuffer),
      coordinate_reference_system: "EPSG:4269",
    },
    topology: {
      implementation: input.topologyEngine.implementation,
      version: input.topologyEngine.version,
    },
    transformations: washingtonTransformations(input.performedAt),
  };
}

/**
 * Verifies a derived package's exact stored metric geometries without rebuilding
 * floating buffer coordinates in a different JavaScript runtime. Buffer creation
 * remains a derivation-time operation; runtime verifies hashes, topology, CRS hops,
 * and the independently audited stored result.
 */
export async function verifyStoredWashingtonTechnicalAoi(
  input: VerifyStoredWashingtonTechnicalAoiInput,
): Promise<WashingtonTechnicalAoi> {
  requireCanonicalTimestamp(input.performedAt);
  requireSha256(input.sourceArchiveSha256, "sourceArchiveSha256");
  requireSha256(input.sourceGeometrySha256, "sourceGeometrySha256");
  if (input.sourceTable.trim().length === 0) throw new TypeError("sourceTable must be non-empty");
  if (input.sourceFeature.id === undefined || String(input.sourceFeature.id).trim().length === 0) {
    throw new TypeError("Washington source feature requires a stable source id");
  }

  const sourceNativeState = structuredClone(input.sourceFeature.geometry);
  if ((await hashGeometry(sourceNativeState)) !== input.sourceGeometrySha256) {
    throw new TypeError("sourceGeometrySha256 does not match the stored Washington source geometry");
  }
  assertValidGeometry(sourceNativeState, "EPSG:4269");
  assertEngineValidity(input.topologyEngine, sourceNativeState, "stored source Washington state");

  const metricState = canonicalizePolygonalGeometry(input.metricState);
  const buffered = canonicalizePolygonalGeometry(input.bufferedAoi);
  const overflow = canonicalizePolygonalGeometry(input.overflow);
  for (const [label, geometry] of [
    ["stored projected Washington state", metricState],
    ["stored Washington technical buffer", buffered],
    ["stored Washington exterior overflow", overflow],
  ] as const) {
    assertValidGeometry(geometry, "EPSG:5070");
    assertEngineValidity(input.topologyEngine, geometry, label);
  }

  const freshlyProjectedState = canonicalizePolygonalGeometry(
    transformGeometry(
      canonicalizePolygonalGeometry(sourceNativeState),
      "EPSG:4269",
      "EPSG:5070",
    ) as PolygonalGeometry,
  );
  const projectedStateDeviationMetres = maximumCoordinateDeviationMetres(freshlyProjectedState, metricState);
  if (projectedStateDeviationMetres > 1e-5) {
    throw new Error(
      `stored metric Washington state differs from the explicit source CRS transform by ${projectedStateDeviationMetres} metres`,
    );
  }
  if (!input.topologyEngine.covers(buffered, metricState)) {
    throw new Error("stored Washington technical buffer does not cover the metric state geometry");
  }
  if (!input.topologyEngine.covers(buffered, overflow)) {
    throw new Error("stored Washington technical buffer does not cover the exterior overflow geometry");
  }
  const bufferedArea = input.topologyEngine.area(buffered);
  const stateArea = input.topologyEngine.area(metricState);
  const overflowArea = input.topologyEngine.area(overflow);
  if (!(overflowArea > 0)) throw new Error("stored Washington exterior overflow must have positive area");
  if (!input.topologyEngine.touches(overflow, metricState)) {
    throw new Error("stored Washington exterior overflow must touch the state boundary");
  }
  const overlapArea = input.topologyEngine.intersectionArea(metricState, overflow);
  const overlapTolerance = Math.max(1e-6, overflowArea * 1e-12);
  if (overlapArea > overlapTolerance) {
    throw new Error(
      `stored Washington state and exterior overflow interiors overlap by ${overlapArea} square metres`,
    );
  }
  const areaClosureError = Math.abs(bufferedArea - stateArea - overflowArea + overlapArea);
  const areaClosureTolerance = Math.max(1e-4, bufferedArea * 1e-12);
  if (areaClosureError > areaClosureTolerance) {
    throw new Error(
      `stored state plus overflow do not close to the buffered AOI area; error ${areaClosureError} square metres`,
    );
  }

  const metricStateHash = await hashGeometry(metricState);
  const metricBufferHash = await hashGeometry(buffered);
  const metricOverflowHash = await hashGeometry(overflow);
  validateGeodesicAudit(input.independentGeodesicAudit, metricBufferHash);
  assertAuditNotAfterPerformedAt(input.independentGeodesicAudit, input.performedAt);

  const presentationState = transformPresentation(metricState);
  const presentationBuffer = transformPresentation(buffered);
  const presentationOverflow = transformPresentation(overflow);
  const sourceSelectionBuffer = canonicalizePolygonalGeometry(
    transformGeometry(buffered, "EPSG:5070", "EPSG:4269") as PolygonalGeometry,
  );
  assertValidGeometry(sourceSelectionBuffer, "EPSG:4269");

  return {
    assertions: {
      buffer_covers_state: true,
      state_overflow_interior_overlap_square_metres: overlapArea,
    },
    buffer_parameters: WASHINGTON_BUFFER_PARAMETERS,
    disclaimer: WASHINGTON_TECHNICAL_BUFFER_DISCLAIMER,
    independent_geodesic_audit: input.independentGeodesicAudit,
    metric: {
      buffered_aoi: buffered,
      buffered_aoi_sha256: metricBufferHash,
      bounds: {
        buffered_aoi: geometryBounds(buffered),
        wa_overflow_100m: geometryBounds(overflow),
        wa_state: geometryBounds(metricState),
      },
      coordinate_reference_system: "EPSG:5070",
      overflow_area_square_metres: overflowArea,
      wa_overflow_100m: overflow,
      wa_overflow_100m_sha256: metricOverflowHash,
      wa_state: metricState,
      wa_state_sha256: metricStateHash,
    },
    presentation: {
      buffered_aoi: presentationBuffer,
      bounds: {
        buffered_aoi: geometryBounds(presentationBuffer),
        wa_overflow_100m: geometryBounds(presentationOverflow),
        wa_state: geometryBounds(presentationState),
      },
      coordinate_reference_system: "EPSG:4326",
      wa_overflow_100m: presentationOverflow,
      wa_state: presentationState,
    },
    schema_version: "1.0.0",
    source: {
      bounds: geometryBounds(sourceNativeState),
      coordinate_reference_system: "EPSG:4269",
      feature_id: String(input.sourceFeature.id),
      geometry_sha256: input.sourceGeometrySha256,
      source_archive_sha256: input.sourceArchiveSha256,
      source_table: input.sourceTable,
      wa_state: sourceNativeState,
    },
    source_selection: {
      buffered_aoi: sourceSelectionBuffer,
      bounds: geometryBounds(sourceSelectionBuffer),
      coordinate_reference_system: "EPSG:4269",
    },
    topology: {
      implementation: input.topologyEngine.implementation,
      version: input.topologyEngine.version,
    },
    transformations: washingtonTransformations(input.performedAt),
  };
}

function washingtonTransformations(performedAt: string): WashingtonAoiTransformation[] {
  return [
    {
      coordinate_engine: "proj4js 2.21.0",
      operation_definition:
        "+proj=longlat +datum=NAD83 +no_defs +type=crs -> +proj=aea +lat_0=23 +lon_0=-96 +lat_1=29.5 +lat_2=45.5 +x_0=0 +y_0=0 +datum=NAD83 +units=m +no_defs +type=crs",
      performed_at: performedAt,
      source_axis_order: "longitude-latitude",
      source_crs: "EPSG:4269",
      target_axis_order: "east-north",
      target_crs: "EPSG:5070",
    },
    {
      coordinate_engine: "proj4js 2.21.0",
      operation_definition:
        "+proj=aea +lat_0=23 +lon_0=-96 +lat_1=29.5 +lat_2=45.5 +x_0=0 +y_0=0 +datum=NAD83 +units=m +no_defs +type=crs -> +proj=longlat +datum=WGS84 +no_defs +type=crs; presentation derivative only; NAD83/WGS84 realization uncertainty audited separately",
      performed_at: performedAt,
      source_axis_order: "east-north",
      source_crs: "EPSG:5070",
      target_axis_order: "longitude-latitude",
      target_crs: "EPSG:4326",
    },
    {
      coordinate_engine: "proj4js 2.21.0",
      operation_definition:
        "+proj=aea +lat_0=23 +lon_0=-96 +lat_1=29.5 +lat_2=45.5 +x_0=0 +y_0=0 +datum=NAD83 +units=m +no_defs +type=crs -> +proj=longlat +datum=NAD83 +no_defs +type=crs; source-selection derivative only",
      performed_at: performedAt,
      source_axis_order: "east-north",
      source_crs: "EPSG:5070",
      target_axis_order: "longitude-latitude",
      target_crs: "EPSG:4269",
    },
  ];
}

function maximumCoordinateDeviationMetres(left: PolygonalGeometry, right: PolygonalGeometry): number {
  if (left.type !== right.type) {
    throw new Error(`stored metric state type ${right.type} differs from transformed type ${left.type}`);
  }
  const leftPolygons = left.type === "Polygon" ? [left.coordinates] : left.coordinates;
  const rightPolygons = right.type === "Polygon" ? [right.coordinates] : right.coordinates;
  if (leftPolygons.length !== rightPolygons.length) {
    throw new Error("stored metric state polygon count differs from the explicit source CRS transform");
  }

  let maximum = 0;
  for (const [polygonIndex, leftPolygon] of leftPolygons.entries()) {
    const rightPolygon = rightPolygons[polygonIndex];
    if (rightPolygon === undefined || leftPolygon.length !== rightPolygon.length) {
      throw new Error(`stored metric state ring count differs at polygon ${polygonIndex}`);
    }
    for (const [ringIndex, leftRing] of leftPolygon.entries()) {
      const rightRing = rightPolygon[ringIndex];
      if (rightRing === undefined || leftRing.length !== rightRing.length) {
        throw new Error(
          `stored metric state coordinate count differs at polygon ${polygonIndex} ring ${ringIndex}`,
        );
      }
      for (const [positionIndex, leftPosition] of leftRing.entries()) {
        const rightPosition = rightRing[positionIndex];
        const leftX = leftPosition[0];
        const leftY = leftPosition[1];
        const rightX = rightPosition?.[0];
        const rightY = rightPosition?.[1];
        if (leftX === undefined || leftY === undefined || rightX === undefined || rightY === undefined) {
          throw new Error(
            `stored metric state position is incomplete at polygon ${polygonIndex} ring ${ringIndex} position ${positionIndex}`,
          );
        }
        maximum = Math.max(maximum, Math.hypot(leftX - rightX, leftY - rightY));
      }
    }
  }
  return maximum;
}

async function hashGeometry(geometry: PolygonalGeometry): Promise<string> {
  return sha256Text(stableStringify(geometry as unknown as JsonValue, false));
}

function validateGeodesicAudit(audit: WashingtonGeodesicAudit, expectedBufferHash: string): void {
  requireCanonicalTimestamp(audit.audited_at);
  requireSha256(
    audit.metric_buffer_geometry_sha256,
    "independentGeodesicAudit.metric_buffer_geometry_sha256",
  );
  if (audit.metric_buffer_geometry_sha256 !== expectedBufferHash) {
    throw new TypeError("independent geodesic audit is not bound to the generated metric buffer geometry");
  }
  if (
    audit.engine.trim().length === 0 ||
    audit.version.trim().length === 0 ||
    audit.method.trim().length === 0
  ) {
    throw new TypeError("independent geodesic audit must identify its engine, version, and method");
  }
  if (!Number.isSafeInteger(audit.sample_count) || audit.sample_count < 1) {
    throw new TypeError("independent geodesic audit sample_count must be positive");
  }
  for (const [name, value] of Object.entries({
    max_absolute_deviation_metres: audit.max_absolute_deviation_metres,
    max_observed_offset_metres: audit.max_observed_offset_metres,
    mean_observed_offset_metres: audit.mean_observed_offset_metres,
    min_observed_offset_metres: audit.min_observed_offset_metres,
    rms_deviation_metres: audit.rms_deviation_metres,
    tolerance_metres: audit.tolerance_metres,
  })) {
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError(`independent geodesic audit ${name} must be finite and non-negative`);
    }
  }
  if (
    audit.min_observed_offset_metres > audit.mean_observed_offset_metres ||
    audit.mean_observed_offset_metres > audit.max_observed_offset_metres
  ) {
    throw new TypeError("independent geodesic audit observed offsets must satisfy min <= mean <= max");
  }
  if (
    audit.rms_deviation_metres >
    audit.max_absolute_deviation_metres + GEODESIC_AUDIT_NUMERIC_TOLERANCE_METRES
  ) {
    throw new TypeError(
      "independent geodesic audit RMS deviation must not exceed its maximum absolute deviation",
    );
  }
  if (
    audit.rms_deviation_metres + GEODESIC_AUDIT_NUMERIC_TOLERANCE_METRES <
    Math.abs(audit.mean_observed_offset_metres - WASHINGTON_TECHNICAL_BUFFER_METRES)
  ) {
    throw new TypeError(
      "independent geodesic audit RMS deviation must not be less than its absolute mean deviation",
    );
  }
  const minimumOffsetDeviation = Math.abs(
    audit.min_observed_offset_metres - WASHINGTON_TECHNICAL_BUFFER_METRES,
  );
  const maximumOffsetDeviation = Math.abs(
    audit.max_observed_offset_metres - WASHINGTON_TECHNICAL_BUFFER_METRES,
  );
  if (
    audit.max_absolute_deviation_metres + GEODESIC_AUDIT_NUMERIC_TOLERANCE_METRES <
    Math.max(minimumOffsetDeviation, maximumOffsetDeviation)
  ) {
    throw new TypeError(
      "independent geodesic audit maximum absolute deviation understates its observed offset extrema",
    );
  }
  if (audit.within_tolerance !== audit.max_absolute_deviation_metres <= audit.tolerance_metres) {
    throw new TypeError("independent geodesic audit within_tolerance contradicts measured deviation");
  }
  if (!audit.within_tolerance) {
    throw new TypeError("independent geodesic audit must pass its stated tolerance");
  }
  if (
    audit.tolerance_metres <= 0 ||
    audit.tolerance_metres > MAXIMUM_WASHINGTON_GEODESIC_AUDIT_TOLERANCE_METRES
  ) {
    throw new TypeError(
      `independent geodesic audit tolerance must be greater than zero and at most ${MAXIMUM_WASHINGTON_GEODESIC_AUDIT_TOLERANCE_METRES} metres`,
    );
  }
}

function assertAuditNotAfterPerformedAt(audit: WashingtonGeodesicAudit, performedAt: string): void {
  if (Date.parse(audit.audited_at) > Date.parse(performedAt)) {
    throw new TypeError("independent geodesic audit must not postdate AOI construction");
  }
}

function transformPresentation(geometry: PolygonalGeometry): PolygonalGeometry {
  const transformed = canonicalizePolygonalGeometry(
    transformGeometry(geometry, "EPSG:5070", "EPSG:4326") as PolygonalGeometry,
  );
  assertValidGeometry(transformed, "EPSG:4326");
  return transformed;
}

function assertEngineValidity(
  engine: PlanarTopologyEngine,
  geometry: PolygonalGeometry,
  label: string,
): void {
  const verdict = engine.validate(geometry);
  if (!verdict.valid) {
    throw new Error(`${engine.implementation} rejects ${label}: ${verdict.reason ?? "unknown reason"}`);
  }
}

function requireSha256(value: string, path: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new TypeError(`${path} must be a lowercase SHA-256 digest`);
}

function requireCanonicalTimestamp(value: string): void {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new TypeError("performedAt must be a canonical UTC ISO-8601 timestamp");
  }
}
