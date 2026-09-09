import type { Geometry, Position } from "geojson";
import { isJsonObject, type JsonObject, type JsonValue } from "../../shared/json.js";
import { parseJson, stableStringify } from "../../shared/stable-json.js";
import { assertPositionInCrs, isSupportedCrs, transformPosition, visitGeometryPositions } from "../crs.js";
import { assertWktMatchesEpsg } from "../crs-wkt.js";
import { sha256Text } from "../hash.js";
import { requirePolygonalGeometry } from "../spatial/polygon.js";
import { createJstsPlanarTopologyEngine } from "../spatial/topology.js";
import {
  type CoverageCompleteness,
  type DataCenterContext,
  type DataCenterDemand,
  type DataCenterLifecycleStatus,
  type FeatureMeasurement,
  type ParsedSourceLayer,
  SOURCE_LAYER_LIMITS,
  SOURCE_LAYER_SCHEMA_VERSION,
  type SourceAbsenceCode,
  type SourceLayerDocument,
  type SourceLayerFeature,
  type SourceLayerKind,
  type SourceMeasurementStatus,
  type TriStateCode,
} from "./types.js";

const ABSENCE_CODES = new Set<SourceAbsenceCode>([
  "disputed",
  "incompatible",
  "invalid",
  "not_applicable",
  "not_collected",
  "observed_zero",
  "outside_spatial_coverage",
  "outside_temporal_coverage",
  "pending_review",
  "source_null",
  "suppressed",
  "unavailable",
  "withheld",
]);
const UNKNOWN_ABSENCE_CODES = new Set<SourceAbsenceCode>([
  "disputed",
  "incompatible",
  "invalid",
  "not_collected",
  "outside_spatial_coverage",
  "outside_temporal_coverage",
  "pending_review",
  "source_null",
  "suppressed",
  "unavailable",
  "withheld",
]);
const topology = createJstsPlanarTopologyEngine();
// Source-layer v1 accepts this complete pinned operator definition for EPSG:3857.
// Accepting a whole canonical definition avoids a second, partial WKT parser;
// other WKT forms remain unsupported until the shared semantic verifier supports them.
const EPSG_3857_OPERATOR_WKT =
  'PROJCS["WGS 84 / Pseudo-Mercator",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4326"]],PROJECTION["Mercator_1SP"],PARAMETER["central_meridian",0],PARAMETER["scale_factor",1],PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1,AUTHORITY["EPSG","9001"]],AXIS["Easting",EAST],AXIS["Northing",NORTH],EXTENSION["PROJ4","+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs"],AUTHORITY["EPSG","3857"]]';

export class SourceLayerValidationError extends Error {
  public readonly path: string;
  public constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "SourceLayerValidationError";
    this.path = path;
  }
}

export async function parseSourceLayer(text: string): Promise<ParsedSourceLayer> {
  const exactBytes = new TextEncoder().encode(text).byteLength;
  if (exactBytes > SOURCE_LAYER_LIMITS.jsonBytes) {
    fail("source-layer", `JSON exceeds ${SOURCE_LAYER_LIMITS.jsonBytes} bytes`);
  }
  const document = parseDocument(parseJson(text));
  return {
    document,
    exactJson: text,
    exactSha256: await sha256Text(text),
    exactBytes,
    featureCount: document.features.length,
    vertexCount: countDocumentVertices(document),
  };
}

export function serializeSourceLayer(document: SourceLayerDocument): string {
  return stableStringify(parseDocument(document as unknown as JsonValue) as unknown as JsonValue);
}

function parseDocument(value: unknown): SourceLayerDocument {
  const root = object(value, "source-layer", [
    "schema_version",
    "layer_id",
    "revision",
    "name",
    "kind",
    "source",
    "preparation",
    "native_crs",
    "analysis_crs",
    "coverage",
    "measurement",
    "absence_semantics",
    "custody",
    "features",
  ]);
  literal(root.schema_version, SOURCE_LAYER_SCHEMA_VERSION, "schema_version");
  const layerId = text(root.layer_id, "layer_id");
  const revision = text(root.revision, "revision");
  const kind = oneOf(
    root.kind,
    ["constraint", "context", "partner_overlay", "resource"],
    "kind",
  ) as SourceLayerKind;

  const source = object(root.source, "source", [
    "publisher",
    "title",
    "record_id",
    "edition",
    "published_at",
    "retrieved_at",
    "uri",
    "license",
    "terms_uri",
    "bytes",
    "sha256",
  ]);
  // Publisher edition and prepared-package revision are separate identities.
  const sourceEdition = text(source.edition, "source.edition");

  const preparation = object(root.preparation, "preparation", [
    "recipe_id",
    "prepared_at",
    "tools",
    "transformations",
    "limitations",
  ]);
  const tools = object(preparation.tools, "preparation.tools");
  const parsedTools: Record<string, string> = {};
  for (const [key, item] of Object.entries(tools)) parsedTools[key] = text(item, `preparation.tools.${key}`);
  if (Object.keys(parsedTools).length === 0) fail("preparation.tools", "must name at least one pinned tool");
  const transformations = array(preparation.transformations, "preparation.transformations").map(
    (item, index) => {
      const path = `preparation.transformations[${index}]`;
      const record = object(item, path, [
        "operation",
        "source_crs",
        "target_crs",
        "source_geometry_family",
        "target_geometry_family",
        "source_dimensions",
        "target_dimensions",
        "dimension_operation",
        "reason",
      ]);
      return {
        operation: text(record.operation, `${path}.operation`),
        source_crs: text(record.source_crs, `${path}.source_crs`),
        target_crs: text(record.target_crs, `${path}.target_crs`),
        source_geometry_family: text(record.source_geometry_family, `${path}.source_geometry_family`),
        target_geometry_family: text(record.target_geometry_family, `${path}.target_geometry_family`),
        source_dimensions: positiveInteger(record.source_dimensions, `${path}.source_dimensions`),
        target_dimensions: positiveInteger(record.target_dimensions, `${path}.target_dimensions`),
        dimension_operation: oneOf(
          record.dimension_operation,
          ["preserved", "derived_xy_view", "constructed_support_geometry"],
          `${path}.dimension_operation`,
        ) as "constructed_support_geometry" | "derived_xy_view" | "preserved",
        reason: text(record.reason, `${path}.reason`),
      };
    },
  );
  const limitations = stringArray(preparation.limitations, "preparation.limitations");
  if (limitations.length === 0) fail("preparation.limitations", "must state at least one limitation");

  const nativeCrs = object(root.native_crs, "native_crs", ["code", "wkt"]);
  const nativeCode = text(nativeCrs.code, "native_crs.code");
  const nativeWkt = text(nativeCrs.wkt, "native_crs.wkt");
  validateNativeCrs(nativeCode, nativeWkt);
  const analysisCrs = literal(root.analysis_crs, "EPSG:5070", "analysis_crs");
  if (nativeCode !== "EPSG:5070") {
    const projected = transformations.some(
      (record) => record.source_crs === nativeCode && record.target_crs === "EPSG:5070",
    );
    if (!projected) fail("preparation.transformations", `must record ${nativeCode} to EPSG:5070 derivation`);
  }

  const coverage = object(root.coverage, "coverage", ["geometry", "completeness", "states", "statement"]);
  const coverageGeometry = requireProjectedPolygon(coverage.geometry, "coverage.geometry");
  assertGeometryBounds(coverageGeometry, "EPSG:5070", "coverage.geometry");
  const coverageVerdict = topology.validate(coverageGeometry);
  if (!coverageVerdict.valid)
    fail("coverage.geometry", `invalid coverage geometry: ${coverageVerdict.reason ?? "unknown"}`);
  const states = array(coverage.states, "coverage.states").map(
    (item, index) => oneOf(item, ["WA", "OR", "ID"], `coverage.states[${index}]`) as TriStateCode,
  );
  if (states.length === 0 || new Set(states).size !== states.length)
    fail("coverage.states", "must be non-empty and unique");

  const measurement = object(root.measurement, "measurement", [
    "status",
    "quantity",
    "unit",
    "native_resolution",
    "temporal_scope",
    "support",
  ]);
  const nativeResolution = object(measurement.native_resolution, "measurement.native_resolution", [
    "value",
    "unit",
    "description",
  ]);
  const resolutionValue = nullablePositiveNumber(
    nativeResolution.value,
    "measurement.native_resolution.value",
  );

  const absence = object(root.absence_semantics, "absence_semantics", [
    "missing",
    "outside_coverage",
    "zero",
  ]);
  const missingAbsence = absenceCode(absence.missing, "absence_semantics.missing");
  if (!UNKNOWN_ABSENCE_CODES.has(missingAbsence)) {
    fail(
      "absence_semantics.missing",
      "missing information must remain unknown, never zero or not applicable",
    );
  }
  literal(absence.outside_coverage, "outside_spatial_coverage", "absence_semantics.outside_coverage");
  literal(absence.zero, "observed_zero", "absence_semantics.zero");

  const custody = object(root.custody, "custody", [
    "source_classification",
    "effective_tier",
    "governance_mode",
    "governance_enforced",
    "public_distribution_allowed",
    "consent",
    "ownership",
  ]);
  literal(custody.source_classification, null, "custody.source_classification");
  literal(custody.effective_tier, "T3", "custody.effective_tier");
  literal(custody.governance_mode, "development_bypass", "custody.governance_mode");
  literal(custody.governance_enforced, false, "custody.governance_enforced");
  literal(custody.public_distribution_allowed, false, "custody.public_distribution_allowed");
  literal(custody.consent, null, "custody.consent");

  const featureValues = array(root.features, "features");
  if (featureValues.length > SOURCE_LAYER_LIMITS.features) {
    fail("features", `exceeds ${SOURCE_LAYER_LIMITS.features} features`);
  }
  const features = featureValues.map((item, index) =>
    parseFeature(item, `features[${index}]`, kind, transformations, nativeCode),
  );
  const ids = new Set<string>();
  for (const feature of features) {
    if (ids.has(feature.id)) fail("features", `duplicate feature id ${feature.id}`);
    ids.add(feature.id);
  }

  const document: SourceLayerDocument = {
    schema_version: SOURCE_LAYER_SCHEMA_VERSION,
    layer_id: layerId,
    revision,
    name: text(root.name, "name"),
    kind,
    source: {
      publisher: text(source.publisher, "source.publisher"),
      title: text(source.title, "source.title"),
      record_id: text(source.record_id, "source.record_id"),
      edition: sourceEdition,
      published_at: nullableTimestamp(source.published_at, "source.published_at"),
      retrieved_at: timestamp(source.retrieved_at, "source.retrieved_at"),
      uri: text(source.uri, "source.uri"),
      license: text(source.license, "source.license"),
      terms_uri: nullableText(source.terms_uri, "source.terms_uri"),
      bytes: nonNegativeInteger(source.bytes, "source.bytes"),
      sha256: digest(source.sha256, "source.sha256"),
    },
    preparation: {
      recipe_id: digest(preparation.recipe_id, "preparation.recipe_id"),
      prepared_at: timestamp(preparation.prepared_at, "preparation.prepared_at"),
      tools: parsedTools,
      transformations,
      limitations,
    },
    native_crs: { code: nativeCode, wkt: nativeWkt },
    analysis_crs: analysisCrs,
    coverage: {
      geometry: coverageGeometry,
      completeness: oneOf(
        coverage.completeness,
        ["complete", "incomplete", "unknown"],
        "coverage.completeness",
      ) as CoverageCompleteness,
      states,
      statement: text(coverage.statement, "coverage.statement"),
    },
    measurement: {
      status: oneOf(
        measurement.status,
        ["context", "designation", "measured", "modeled"],
        "measurement.status",
      ) as SourceMeasurementStatus,
      quantity: text(measurement.quantity, "measurement.quantity"),
      unit: text(measurement.unit, "measurement.unit"),
      native_resolution: {
        value: resolutionValue,
        unit: text(nativeResolution.unit, "measurement.native_resolution.unit"),
        description: text(nativeResolution.description, "measurement.native_resolution.description"),
      },
      temporal_scope: text(measurement.temporal_scope, "measurement.temporal_scope"),
      support: text(measurement.support, "measurement.support"),
    },
    absence_semantics: {
      missing: missingAbsence,
      outside_coverage: "outside_spatial_coverage",
      zero: "observed_zero",
    },
    custody: {
      source_classification: null,
      effective_tier: "T3",
      governance_mode: "development_bypass",
      governance_enforced: false,
      public_distribution_allowed: false,
      consent: null,
      ownership: text(custody.ownership, "custody.ownership"),
    },
    features,
  };

  const vertices = countDocumentVertices(document);
  if (vertices > SOURCE_LAYER_LIMITS.vertices)
    fail("source-layer", `exceeds ${SOURCE_LAYER_LIMITS.vertices} XY vertices`);
  return document;
}

function parseFeature(
  value: unknown,
  path: string,
  kind: SourceLayerKind,
  transformations: SourceLayerDocument["preparation"]["transformations"],
  nativeCode: string,
): SourceLayerFeature {
  const feature = object(value, path, [
    "id",
    "source_geometry",
    "analysis_geometry",
    "source_record",
    "source_properties",
    "absence",
    "measurements",
    "data_center",
  ]);
  const sourceGeometry = parseGeometry(feature.source_geometry, `${path}.source_geometry`, false);
  const analysisGeometry = parseGeometry(feature.analysis_geometry, `${path}.analysis_geometry`, true);
  const sourceDimensions = geometryDimensions(sourceGeometry);
  const analysisDimensions = geometryDimensions(analysisGeometry);
  const transformationDeclared = transformations.some(
    (record) =>
      record.source_crs === nativeCode &&
      record.target_crs === "EPSG:5070" &&
      record.source_geometry_family === sourceGeometry.type &&
      record.target_geometry_family === analysisGeometry.type &&
      sourceGeometry.type === analysisGeometry.type &&
      record.source_dimensions === sourceDimensions &&
      record.target_dimensions === analysisDimensions &&
      (sourceDimensions === analysisDimensions
        ? record.dimension_operation === "preserved"
        : sourceDimensions > analysisDimensions && record.dimension_operation === "derived_xy_view"),
  );
  if (!transformationDeclared) {
    fail(
      `${path}.analysis_geometry`,
      `geometry family/dimension derivation ${sourceGeometry.type}/${sourceDimensions} to ${analysisGeometry.type}/${analysisDimensions} is undeclared`,
    );
  }
  assertGeometryBounds(sourceGeometry, nativeCode, `${path}.source_geometry`);
  assertGeometryBounds(analysisGeometry, "EPSG:5070", `${path}.analysis_geometry`);
  assertPolygonValidity(analysisGeometry, `${path}.analysis_geometry`, "analysis");
  assertPolygonValidity(sourceGeometry, `${path}.source_geometry`, "native");
  assertCoordinateCorrespondence(sourceGeometry, analysisGeometry, nativeCode, path);
  const sourceRecord =
    feature.source_record === null ? null : object(feature.source_record, `${path}.source_record`);
  const sourceProperties = object(feature.source_properties, `${path}.source_properties`);
  enforceTextLimits(sourceRecord, `${path}.source_record`);
  enforceTextLimits(sourceProperties, `${path}.source_properties`);
  const absenceObject = object(feature.absence, `${path}.absence`);
  const absences: Record<string, SourceAbsenceCode> = {};
  for (const [key, item] of Object.entries(absenceObject)) {
    absences[key] = absenceCode(item, `${path}.absence.${key}`);
  }
  for (const [key, item] of Object.entries(sourceProperties)) {
    if (item === null && absences[key] === undefined)
      fail(`${path}.source_properties.${key}`, "null property requires a typed absence entry");
  }
  const measurements = array(feature.measurements, `${path}.measurements`).map((item, index) =>
    parseMeasurement(item, `${path}.measurements[${index}]`),
  );
  const dataCenter =
    feature.data_center === null ? null : parseDataCenter(feature.data_center, `${path}.data_center`);
  if (dataCenter !== null && kind !== "context")
    fail(`${path}.data_center`, "is allowed only on context layers");
  return {
    id: text(feature.id, `${path}.id`),
    source_geometry: sourceGeometry,
    analysis_geometry: analysisGeometry,
    source_record: sourceRecord,
    source_properties: sourceProperties,
    absence: absences,
    measurements,
    data_center: dataCenter,
  };
}

function parseMeasurement(value: unknown, path: string): FeatureMeasurement {
  const item = object(value, path, [
    "id",
    "quantity",
    "unit",
    "value",
    "absence",
    "period",
    "support",
    "status",
    "source_record_id",
  ]);
  const numericValue = item.value === null ? null : finiteNumber(item.value, `${path}.value`);
  const absence = item.absence === null ? null : absenceCode(item.absence, `${path}.absence`);
  if ((numericValue === null) === (absence === null))
    fail(path, "must provide exactly one of value or absence");
  return {
    id: text(item.id, `${path}.id`),
    quantity: text(item.quantity, `${path}.quantity`),
    unit: text(item.unit, `${path}.unit`),
    value: numericValue,
    absence,
    period: text(item.period, `${path}.period`),
    support: text(item.support, `${path}.support`),
    status: oneOf(
      item.status,
      ["context", "designation", "measured", "modeled"],
      `${path}.status`,
    ) as SourceMeasurementStatus,
    source_record_id: text(item.source_record_id, `${path}.source_record_id`),
  };
}

function parseDataCenter(value: unknown, path: string): DataCenterContext {
  const item = object(value, path, [
    "canonical_site_id",
    "representation",
    "relationship",
    "lifecycle_assertions",
    "demand",
  ]);
  const lifecycle = array(item.lifecycle_assertions, `${path}.lifecycle_assertions`).map((entry, index) => {
    const entryPath = `${path}.lifecycle_assertions[${index}]`;
    const record = object(entry, entryPath, ["status", "asserted_at", "source_record_id"]);
    return {
      status: lifecycleStatus(record.status, `${entryPath}.status`),
      asserted_at: timestamp(record.asserted_at, `${entryPath}.asserted_at`),
      source_record_id: text(record.source_record_id, `${entryPath}.source_record_id`),
    };
  });
  if (lifecycle.length === 0)
    fail(`${path}.lifecycle_assertions`, "must retain at least one status assertion");
  return {
    canonical_site_id: text(item.canonical_site_id, `${path}.canonical_site_id`),
    representation: oneOf(
      item.representation,
      ["point", "building", "campus"],
      `${path}.representation`,
    ) as DataCenterContext["representation"],
    relationship: oneOf(
      item.relationship,
      ["primary", "part_of", "related", "unknown"],
      `${path}.relationship`,
    ) as DataCenterContext["relationship"],
    lifecycle_assertions: lifecycle,
    demand: parseDemand(item.demand, `${path}.demand`),
  };
}

function parseDemand(value: unknown, path: string): DataCenterDemand {
  const item = object(value, path);
  if (item.status === "unknown") {
    exactKeys(item, ["status", "absence"], path);
    const absence = absenceCode(item.absence, `${path}.absence`);
    if (!UNKNOWN_ABSENCE_CODES.has(absence))
      fail(`${path}.absence`, "must describe unknown demand rather than zero/not-applicable");
    return { status: "unknown", absence };
  }
  exactKeys(
    item,
    ["status", "quantity", "unit", "value", "evidence_date", "source_record_id", "lifecycle_status"],
    path,
  );
  literal(item.status, "asserted", `${path}.status`);
  return {
    status: "asserted",
    quantity: text(item.quantity, `${path}.quantity`),
    unit: text(item.unit, `${path}.unit`),
    value: finiteNumber(item.value, `${path}.value`),
    evidence_date: timestamp(item.evidence_date, `${path}.evidence_date`),
    source_record_id: text(item.source_record_id, `${path}.source_record_id`),
    lifecycle_status: lifecycleStatus(item.lifecycle_status, `${path}.lifecycle_status`),
  };
}

function lifecycleStatus(value: unknown, path: string): DataCenterLifecycleStatus {
  return oneOf(
    value,
    ["announced", "operating", "permitted", "proposed", "retired", "under_construction", "unknown"],
    path,
  ) as DataCenterLifecycleStatus;
}

function parseGeometry(value: unknown, path: string, exactXy: boolean): Geometry {
  const geometry = object(value, path);
  const type = text(geometry.type, `${path}.type`);
  if (type === "GeometryCollection") {
    exactKeys(geometry, ["type", "geometries"], path);
    const geometries = array(geometry.geometries, `${path}.geometries`).map((item, index) =>
      parseGeometry(item, `${path}.geometries[${index}]`, exactXy),
    );
    if (geometries.length === 0) fail(`${path}.geometries`, "must be a non-empty geometry collection");
    return { type: "GeometryCollection", geometries };
  }
  exactKeys(geometry, ["type", "coordinates"], path);
  const coordinates = geometry.coordinates;
  switch (type) {
    case "Point":
      validatePosition(coordinates, `${path}.coordinates`, exactXy);
      break;
    case "MultiPoint":
      validatePositionArray(coordinates, `${path}.coordinates`, exactXy, 1);
      break;
    case "LineString":
      validatePositionArray(coordinates, `${path}.coordinates`, exactXy, 2);
      break;
    case "MultiLineString":
      forEachNested(coordinates, `${path}.coordinates`, (item, itemPath) =>
        validatePositionArray(item, itemPath, exactXy, 2),
      );
      break;
    case "Polygon":
      validatePolygonCoordinates(coordinates, `${path}.coordinates`, exactXy);
      break;
    case "MultiPolygon":
      forEachNested(coordinates, `${path}.coordinates`, (item, itemPath) =>
        validatePolygonCoordinates(item, itemPath, exactXy),
      );
      break;
    default:
      fail(`${path}.type`, "unsupported GeoJSON geometry");
  }
  return { type, coordinates } as Geometry;
}

function validatePosition(value: unknown, path: string, exactXy: boolean): asserts value is number[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "number"))
    fail(path, "must be one coordinate position");
  if ((exactXy && value.length !== 2) || (!exactXy && (value.length < 2 || value.length > 4))) {
    fail(
      path,
      exactXy
        ? "analysis geometry must use exact XY positions"
        : "source positions must contain 2 through 4 ordinates",
    );
  }
  if (value.some((ordinate) => !Number.isFinite(ordinate))) fail(path, "coordinates must be finite");
}

function validatePositionArray(value: unknown, path: string, exactXy: boolean, minimum: number): void {
  if (!Array.isArray(value) || value.length < minimum)
    fail(path, `must contain at least ${minimum} positions`);
  value.forEach((item, index) => {
    validatePosition(item, `${path}[${index}]`, exactXy);
  });
}

function validatePolygonCoordinates(value: unknown, path: string, exactXy: boolean): void {
  forEachNested(value, path, (ring, ringPath) => {
    validatePositionArray(ring, ringPath, exactXy, 4);
    const positions = ring as number[][];
    const first = positions[0] as number[];
    const last = positions.at(-1) as number[];
    if (first.length !== last.length || first.some((ordinate, index) => ordinate !== last[index]))
      fail(ringPath, "polygon ring must be closed exactly");
  });
}

function forEachNested(value: unknown, path: string, visit: (item: JsonValue, path: string) => void): void {
  if (!Array.isArray(value) || value.length === 0) fail(path, "must be a non-empty coordinate array");
  value.forEach((item, index) => {
    visit(item, `${path}[${index}]`);
  });
}

function requireProjectedPolygon(value: unknown, path: string) {
  const geometry = parseGeometry(value, path, true);
  try {
    return requirePolygonalGeometry(geometry, path);
  } catch (error) {
    fail(path, error instanceof Error ? error.message : "must be polygonal");
  }
}

function countDocumentVertices(document: SourceLayerDocument): number {
  let count = countGeometryVertices(document.coverage.geometry);
  for (const feature of document.features) {
    count += countGeometryVertices(feature.source_geometry);
    count += countGeometryVertices(feature.analysis_geometry);
  }
  return count;
}

function countGeometryVertices(geometry: Geometry): number {
  if (geometry.type === "GeometryCollection")
    return geometry.geometries.reduce((sum, item) => sum + countGeometryVertices(item), 0);
  return countCoordinatePositions(geometry.coordinates as unknown as JsonValue);
}

function geometryDimensions(geometry: Geometry): number {
  if (geometry.type === "GeometryCollection") {
    const dimensions = new Set(geometry.geometries.map(geometryDimensions));
    if (dimensions.size !== 1)
      fail("geometry", "mixed coordinate dimensions require separate source records");
    return dimensions.values().next().value ?? 0;
  }
  return coordinateDimensions(geometry.coordinates as unknown as JsonValue);
}

function coordinateDimensions(value: unknown): number {
  if (!Array.isArray(value) || value.length === 0) return 0;
  if (typeof value[0] === "number") return value.length;
  const dimensions = new Set(value.map(coordinateDimensions));
  if (dimensions.size !== 1) fail("geometry", "mixed coordinate dimensions require separate source records");
  return dimensions.values().next().value ?? 0;
}

function validateNativeCrs(code: string, wkt: string): void {
  if (!isSupportedCrs(code)) fail("native_crs.code", "must be a supported exact EPSG identifier");
  const epsg = Number(code.slice("EPSG:".length));
  if (epsg === 3857) {
    validateEpsg3857Wkt(wkt);
    return;
  }
  try {
    assertWktMatchesEpsg(wkt, epsg);
  } catch (error) {
    fail("native_crs.wkt", error instanceof Error ? error.message : `does not match ${code}`);
  }
}

function validateEpsg3857Wkt(wkt: string): void {
  if (wkt.trim() !== EPSG_3857_OPERATOR_WKT) {
    fail(
      "native_crs.wkt",
      "is not the complete canonical EPSG:3857 operator WKT1 definition accepted by source-layer v1",
    );
  }
}

function assertPolygonValidity(geometry: Geometry, path: string, kind: "native" | "analysis"): void {
  if (geometry.type === "GeometryCollection") {
    geometry.geometries.forEach((member, index) => {
      assertPolygonValidity(member, `${path}.geometries[${index}]`, kind);
    });
  } else if (geometry.type === "Polygon" || geometry.type === "MultiPolygon") {
    const verdict = topology.validate(geometry);
    if (!verdict.valid) fail(path, `invalid ${kind} geometry: ${verdict.reason ?? "unknown"}`);
  }
}

function assertGeometryBounds(geometry: Geometry, code: string, path: string): void {
  if (!isSupportedCrs(code)) fail(path, `uses unsupported CRS ${code}`);
  try {
    visitGeometryPositions(geometry, (position) => assertPositionInCrs(position, code), path);
  } catch (error) {
    fail(path, error instanceof Error ? error.message : `coordinates contradict ${code}`);
  }
}

function assertCoordinateCorrespondence(
  source: Geometry,
  analysis: Geometry,
  sourceCode: string,
  path: string,
): void {
  if (!isSupportedCrs(sourceCode)) fail(`${path}.source_geometry`, `uses unsupported CRS ${sourceCode}`);
  assertCorrespondingStructure(source, analysis, path);
  const sourcePositions: Position[] = [];
  const analysisPositions: Position[] = [];
  visitGeometryPositions(source, (position) => sourcePositions.push(position));
  visitGeometryPositions(analysis, (position) => analysisPositions.push(position));
  if (sourcePositions.length !== analysisPositions.length) {
    fail(`${path}.analysis_geometry`, "coordinate count differs from the declared source-derived view");
  }
  for (let index = 0; index < sourcePositions.length; index += 1) {
    const expected = transformPosition(sourcePositions[index] as Position, sourceCode, "EPSG:5070");
    const actual = analysisPositions[index] as Position;
    if (
      Math.abs((expected[0] as number) - (actual[0] as number)) > 0.1 ||
      Math.abs((expected[1] as number) - (actual[1] as number)) > 0.1
    ) {
      fail(`${path}.analysis_geometry`, `coordinate ${index} contradicts the declared CRS transformation`);
    }
  }
}

function assertCorrespondingStructure(source: Geometry, analysis: Geometry, path: string): void {
  if (source.type !== analysis.type) fail(path, "source and analysis geometry family differs");
  if (source.type === "GeometryCollection" || analysis.type === "GeometryCollection") {
    if (
      source.type !== "GeometryCollection" ||
      analysis.type !== "GeometryCollection" ||
      source.geometries.length !== analysis.geometries.length
    ) {
      fail(path, "source and analysis collection structure differs");
    }
    source.geometries.forEach((member, index) => {
      assertCorrespondingStructure(member, analysis.geometries[index] as Geometry, `${path}[${index}]`);
    });
    return;
  }
  const compare = (left: unknown, right: unknown): void => {
    if (!Array.isArray(left) || !Array.isArray(right))
      fail(path, "source and analysis coordinate structure differs");
    if (typeof left[0] === "number" && typeof right[0] === "number") return;
    if (left.length !== right.length) fail(path, "source and analysis coordinate structure differs");
    left.forEach((member, index) => {
      compare(member, right[index]);
    });
  };
  compare(source.coordinates, analysis.coordinates);
}

function countCoordinatePositions(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  if (typeof value[0] === "number") return 1;
  return value.reduce((sum, item) => sum + countCoordinatePositions(item), 0);
}

function enforceTextLimits(value: unknown, path: string): void {
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value).byteLength;
    if (bytes > SOURCE_LAYER_LIMITS.propertyTextBytes)
      fail(path, `property text exceeds ${SOURCE_LAYER_LIMITS.propertyTextBytes} bytes`);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => {
      enforceTextLimits(item, `${path}[${index}]`);
    });
  } else if (isJsonObject(value)) {
    for (const [key, item] of Object.entries(value)) enforceTextLimits(item, `${path}.${key}`);
  }
}

function object(value: unknown, path: string, keys?: readonly string[]): JsonObject {
  if (!isJsonObject(value)) fail(path, "must be an object");
  if (keys !== undefined) exactKeys(value, keys, path);
  return value;
}
function exactKeys(value: JsonObject, keys: readonly string[], path: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    fail(path, "has missing or unexpected fields");
}
function array(value: unknown, path: string): JsonValue[] {
  if (!Array.isArray(value)) fail(path, "must be an array");
  return value;
}
function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) fail(path, "must be non-empty text");
  return value;
}
function nullableText(value: unknown, path: string): string | null {
  return value === null ? null : text(value, path);
}
function stringArray(value: unknown, path: string): string[] {
  return array(value, path).map((item, index) => text(item, `${path}[${index}]`));
}
function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "must be a finite number");
  return value;
}
function nullablePositiveNumber(value: unknown, path: string): number | null {
  if (value === null) return null;
  const number = finiteNumber(value, path);
  if (number <= 0) fail(path, "must be positive when present");
  return number;
}
function nonNegativeInteger(value: unknown, path: string): number {
  const number = finiteNumber(value, path);
  if (!Number.isSafeInteger(number) || number < 0) fail(path, "must be a non-negative safe integer");
  return number;
}
function positiveInteger(value: unknown, path: string): number {
  const number = nonNegativeInteger(value, path);
  if (number < 1 || number > 4) fail(path, "must be an integer from 1 through 4");
  return number;
}
function digest(value: unknown, path: string): string {
  const result = text(value, path);
  if (!/^[a-f0-9]{64}$/u.test(result)) fail(path, "must be a lowercase SHA-256 digest");
  return result;
}
function timestamp(value: unknown, path: string): string {
  const result = text(value, path);
  const date = new Date(result);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== result)
    fail(path, "must be a canonical UTC timestamp");
  return result;
}
function nullableTimestamp(value: unknown, path: string): string | null {
  return value === null ? null : timestamp(value, path);
}
function oneOf(value: unknown, allowed: readonly string[], path: string): string {
  if (typeof value !== "string" || !allowed.includes(value))
    fail(path, `must be one of ${allowed.join(", ")}`);
  return value;
}
function literal<T extends JsonValue>(value: unknown, expected: T, path: string): T {
  if (value !== expected) fail(path, `must equal ${String(expected)}`);
  return expected;
}
function absenceCode(value: unknown, path: string): SourceAbsenceCode {
  if (typeof value !== "string" || !ABSENCE_CODES.has(value as SourceAbsenceCode))
    fail(path, "is not an adopted absence code");
  return value as SourceAbsenceCode;
}
function fail(path: string, message: string): never {
  throw new SourceLayerValidationError(path, message);
}
