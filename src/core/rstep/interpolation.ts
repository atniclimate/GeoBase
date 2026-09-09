import type { Geometry, MultiPolygon, Point, Polygon } from "geojson";
import type JstsGeometry from "jsts/org/locationtech/jts/geom/Geometry.js";
import GeometryFactory from "jsts/org/locationtech/jts/geom/GeometryFactory.js";
import PrecisionModel from "jsts/org/locationtech/jts/geom/PrecisionModel.js";
import GeoJSONReader from "jsts/org/locationtech/jts/io/GeoJSONReader.js";
import RelateOp from "jsts/org/locationtech/jts/operation/relate/RelateOp.js";
import { assertPositionInCrs, visitGeometryPositions } from "../crs.js";
import { serializeSourceLayer } from "../source-layer/parser.js";
import {
  SOURCE_LAYER_LIMITS,
  type FeatureMeasurement,
  type ParsedSourceLayer,
  type SourceAbsenceCode,
  type SourceLayerDocument,
  type SourceMeasurementStatus,
} from "../source-layer/types.js";
import { requirePolygonalGeometry } from "../spatial/polygon.js";
import { createJstsPlanarTopologyEngine } from "../spatial/topology.js";

export interface InterpolationSelection {
  quantity: string;
  unit: string;
  period: string;
  support: string;
  status: SourceMeasurementStatus;
}

export interface InterpolationOptions {
  selection: InterpolationSelection;
  cellSizeMetres: number;
  radiusMetres: number;
}

export interface InterpolationPoint {
  value: number | null;
  absence: SourceAbsenceCode | null;
  neighborCount: number;
}

export interface InterpolationCell extends InterpolationPoint {
  geometry: Polygon;
}

export interface InterpolationSurface {
  cells: InterpolationCell[];
  minimum: number | null;
  maximum: number | null;
  validCells: number;
  maskedCells: number;
  options: InterpolationOptions;
  sourceSha256: string;
  warnings: string[];
}

type XY = readonly [number, number];
interface Sample {
  id: string;
  xy: XY;
  value: number;
}
interface CoveragePart {
  geometry: JstsGeometry;
  samples: Sample[];
}
interface PreparedInterpolation {
  parts: CoveragePart[];
  options: InterpolationOptions;
}
const MAX_CELLS = 1_024;
const MAX_SAMPLES = 1_000;
const MAX_NEIGHBORS = 16;
const MAX_RADIUS_METRES = 100_000;
const reader = new GeoJSONReader(new GeometryFactory(new PrecisionModel(), 5070));
const topology = createJstsPlanarTopologyEngine();

/** Eligible measurement tuples only; this does not establish spatial admission or model accuracy. */
export function interpolationSelections(layer: ParsedSourceLayer): InterpolationSelection[] {
  if (layer.document.kind !== "resource") return [];
  const selections = new Map<string, InterpolationSelection>();
  for (const feature of layer.document.features) {
    for (const measurement of feature.measurements) {
      const selection = select(measurement);
      if (eligible(selection)) selections.set(selectionKey(selection), selection);
    }
  }
  return [...selections.entries()].sort(([a], [b]) => compareText(a, b)).map(([, value]) => value);
}

/** Disposable, bounded IDW p=2 estimates at cell centers; never area means or screening inputs. */
export function interpolateResourceLayer(
  layer: ParsedSourceLayer,
  aoi: Polygon | MultiPolygon,
  options: InterpolationOptions,
): InterpolationSurface {
  const prepared = prepare(layer, options);
  const geometry = requirePolygonalGeometry(aoi, "interpolation AOI");
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let vertices = 0;
  visitGeometryPositions(geometry, (position) => {
    vertices += 1;
    if (vertices > SOURCE_LAYER_LIMITS.vertices) throw new Error("Interpolation AOI vertex limit exceeded");
    assertXY(position);
    minX = Math.min(minX, position[0] as number);
    minY = Math.min(minY, position[1] as number);
    maxX = Math.max(maxX, position[0] as number);
    maxY = Math.max(maxY, position[1] as number);
  });
  if (vertices === 0 || !topology.validate(geometry).valid || topology.area(geometry) <= 0)
    throw new Error("Interpolation AOI must be a valid positive-area EPSG:5070 polygon");
  const size = prepared.options.cellSizeMetres;
  // The lattice is anchored to the analysis CRS origin, never camera pixels or source row order.
  const firstColumn = Math.floor(minX / size);
  const lastColumn = Math.ceil(maxX / size);
  const firstRow = Math.floor(minY / size);
  const lastRow = Math.ceil(maxY / size);
  const columns = lastColumn - firstColumn;
  const rows = lastRow - firstRow;
  const count = columns * rows;
  if (
    ![firstColumn, lastColumn, firstRow, lastRow, count].every(Number.isSafeInteger) ||
    columns <= 0 ||
    rows <= 0 ||
    count > MAX_CELLS
  )
    throw new Error(`Interpolation grid exceeds ${MAX_CELLS} cells or representable lattice coordinates`);
  assertXY([firstColumn * size, firstRow * size]);
  assertXY([lastColumn * size, lastRow * size]);

  const aoiGeometry = read(geometry);
  const cells: InterpolationCell[] = [];
  let minimum: number | null = null;
  let maximum: number | null = null;
  let validCells = 0;
  for (let row = firstRow; row < lastRow; row += 1) {
    for (let column = firstColumn; column < lastColumn; column += 1) {
      const west = column * size;
      const south = row * size;
      const east = (column + 1) * size;
      const north = (row + 1) * size;
      if (!(east > west && north > south)) throw new Error("Interpolation lattice precision is unavailable");
      const cell: Polygon = {
        type: "Polygon",
        coordinates: [
          [
            [west, south],
            [east, south],
            [east, north],
            [west, north],
            [west, south],
          ],
        ],
      };
      const cellGeometry = read(cell);
      const estimate = covers(aoiGeometry, cellGeometry)
        ? estimateAt(prepared, [west + (east - west) / 2, south + (north - south) / 2], cellGeometry)
        : missing("outside_spatial_coverage");
      if (estimate.value !== null) {
        validCells += 1;
        minimum = minimum === null ? estimate.value : Math.min(minimum, estimate.value);
        maximum = maximum === null ? estimate.value : Math.max(maximum, estimate.value);
      }
      cells.push({ geometry: cell, ...estimate });
    }
  }
  return {
    cells,
    minimum,
    maximum,
    validCells,
    maskedCells: cells.length - validCells,
    options: prepared.options,
    sourceSha256: layer.exactSha256,
    warnings: [
      "Exploratory IDW display estimates, power 2; no wind-flow, capacity, yield or suitability model.",
      "Distances are EPSG:5070 projected metres; cell-center estimates are not area averages.",
      "Declared source coverage and support are retained assertions; interpolation accuracy is unvalidated.",
      "Cells outside full AOI, coverage or actual-neighbor hull support remain unavailable; no gap filling.",
    ],
  };
}

/** Native-point reproduction and independent numerical probes; no Cesium or display-object reads. */
export function interpolateResourcePoint(
  layer: ParsedSourceLayer,
  xy: XY,
  options: InterpolationOptions,
): InterpolationPoint {
  assertXY(xy);
  return estimateAt(prepare(layer, options), xy);
}

function prepare(layer: ParsedSourceLayer, supplied: InterpolationOptions): PreparedInterpolation {
  // Revalidate exact retained JSON and the supplied view synchronously. Hash custody is the parser's job.
  const retained = JSON.parse(layer.exactJson) as SourceLayerDocument;
  if (serializeSourceLayer(retained) !== serializeSourceLayer(layer.document))
    throw new Error("Supplied resource document contradicts its exact retained JSON");
  const document = retained;
  if (document.kind !== "resource") throw new Error("Interpolation requires a resource layer");
  if (!eligible(supplied.selection))
    throw new Error("Unsupported continuous wind-speed or irradiance quantity");
  if (document.coverage.completeness !== "complete")
    throw new Error(
      "Interpolation requires complete declared spatial coverage; reference samples are insufficient",
    );
  const resolution = document.measurement.native_resolution;
  if (
    resolution.value === null ||
    !Number.isFinite(resolution.value) ||
    resolution.value <= 0 ||
    !["m", "metre", "metres", "meter", "meters"].includes(resolution.unit)
  )
    throw new Error("Interpolation requires positive explicit native resolution in metres");
  if (
    !Number.isFinite(supplied.cellSizeMetres) ||
    supplied.cellSizeMetres <= 0 ||
    supplied.cellSizeMetres < resolution.value
  )
    throw new Error("Cell size must be finite, positive and no finer than native resolution");
  if (
    !Number.isFinite(supplied.radiusMetres) ||
    supplied.radiusMetres <= 0 ||
    supplied.radiusMetres > MAX_RADIUS_METRES
  )
    throw new Error(`Interpolation radius must be positive and at most ${MAX_RADIUS_METRES} metres`);
  if (document.features.length > MAX_SAMPLES)
    throw new Error(`Interpolation exceeds ${MAX_SAMPLES} source samples`);
  if (document.features.length < 3) throw new Error("Interpolation requires at least three distinct samples");
  const options: InterpolationOptions = {
    selection: { ...supplied.selection },
    cellSizeMetres: supplied.cellSizeMetres,
    radiusMetres: supplied.radiusMetres,
  };
  const geometries =
    document.coverage.geometry.type === "Polygon"
      ? [document.coverage.geometry]
      : document.coverage.geometry.coordinates.map((coordinates) => ({
          type: "Polygon" as const,
          coordinates,
        }));
  const parts: CoveragePart[] = geometries.map((geometry) => ({ geometry: read(geometry), samples: [] }));
  const positions = new Set<string>();
  const samples: Sample[] = [];
  const selectedKey = selectionKey(options.selection);
  for (const feature of document.features) {
    if (feature.analysis_geometry.type !== "Point") throw new Error("Interpolation requires point samples");
    const coordinate = feature.analysis_geometry.coordinates;
    assertXY(coordinate);
    const xy: XY = [coordinate[0] as number, coordinate[1] as number];
    const key = JSON.stringify(xy);
    if (positions.has(key))
      throw new Error("Duplicate sample positions are unsupported, including conflicting values");
    positions.add(key);
    const measurements = feature.measurements.filter((item) => selectionKey(item) === selectedKey);
    if (measurements.length !== 1)
      throw new Error("Missing, ambiguous or incompatible measurement tuple in the selected resource group");
    const measurement = measurements[0] as FeatureMeasurement;
    if (
      measurement.value === null ||
      !Number.isFinite(measurement.value) ||
      measurement.value < 0 ||
      (measurement.absence !== null && !(measurement.value === 0 && measurement.absence === "observed_zero"))
    )
      throw new Error(
        "Selected resource group contains null, invalid or absent values; no gap filling is permitted",
      );
    const sample: Sample = { id: feature.id, xy, value: measurement.value };
    const point = pointGeometry(xy);
    const containing = parts.filter((part) => covers(part.geometry, point));
    if (containing.length !== 1)
      throw new Error("Sample is outside or ambiguous between declared coverage parts");
    (containing[0] as CoveragePart).samples.push(sample);
    samples.push(sample);
  }
  if (hull(samples) === null) throw new Error("Interpolation requires at least three noncollinear samples");
  return { parts, options };
}

function estimateAt(prepared: PreparedInterpolation, xy: XY, cell?: JstsGeometry): InterpolationPoint {
  const target = cell ?? pointGeometry(xy);
  const containing = prepared.parts.filter((part) => covers(part.geometry, target));
  if (containing.length !== 1) return missing("outside_spatial_coverage");
  const radiusSquared = prepared.options.radiusMetres ** 2;
  const neighbors = (containing[0] as CoveragePart).samples
    .map((sample) => ({ sample, distanceSquared: (sample.xy[0] - xy[0]) ** 2 + (sample.xy[1] - xy[1]) ** 2 }))
    .filter((item) => item.distanceSquared <= radiusSquared)
    .sort((a, b) => a.distanceSquared - b.distanceSquared || compareText(a.sample.id, b.sample.id))
    .slice(0, MAX_NEIGHBORS);
  const nearest = neighbors[0];
  if (cell === undefined && nearest?.distanceSquared === 0) return observed(nearest.sample.value, 1);
  if (neighbors.length < 3) return missing("unavailable", neighbors.length);
  const supportedHull = hull(neighbors.map((item) => item.sample));
  if (supportedHull === null || !covers(read(supportedHull), target))
    return missing("unavailable", neighbors.length);
  if (nearest?.distanceSquared === 0) return observed(nearest.sample.value, neighbors.length);
  if (nearest === undefined) return missing("unavailable");
  // Scaling every inverse-square weight by the nearest squared distance avoids huge reciprocals.
  const anchor = nearest.sample.value;
  let weightedDelta = 0;
  let totalWeight = 0;
  for (const { sample, distanceSquared } of neighbors) {
    const weight = nearest.distanceSquared / distanceSquared;
    weightedDelta += weight * (sample.value - anchor);
    totalWeight += weight;
  }
  // A local anchor preserves constant fields exactly and reduces cancellation from large offsets.
  const value = anchor + weightedDelta / totalWeight;
  if (!Number.isFinite(value)) throw new Error("Interpolation numerical result is nonfinite");
  return observed(value, neighbors.length);
}

function hull(samples: readonly Sample[]): Polygon | null {
  const points = samples.map((sample) => sample.xy).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (points.length < 3) return null;
  const half = (ordered: readonly XY[]): XY[] => {
    const result: XY[] = [];
    for (const point of ordered) {
      while (
        result.length >= 2 &&
        cross(result[result.length - 2] as XY, result[result.length - 1] as XY, point) <= 0
      )
        result.pop();
      result.push(point);
    }
    return result;
  };
  const lower = half(points);
  const upper = half([...points].reverse());
  const ring = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  if (ring.length < 3) return null;
  return { type: "Polygon", coordinates: [[...ring, ring[0] as XY].map((xy) => [xy[0], xy[1]])] };
}
function cross(a: XY, b: XY, c: XY): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}
function eligible(value: InterpolationSelection): boolean {
  if (
    ![value.quantity, value.unit, value.period, value.support].every(
      (item) => typeof item === "string" && item.length > 0,
    )
  )
    return false;
  if (value.status !== "measured" && value.status !== "modeled") return false;
  return (
    (value.unit === "m/s" &&
      [
        "Wind speed at 50 m above mean grid elevation",
        "Wind speed at 100 m above ground",
        "wind_speed",
      ].includes(value.quantity)) ||
    (value.quantity === "All-sky surface shortwave downward irradiance" && value.unit === "kW-hr/m^2/day") ||
    (value.quantity === "solar_irradiance" && value.unit === "W/m^2")
  );
}
function select(value: InterpolationSelection): InterpolationSelection {
  return {
    quantity: value.quantity,
    unit: value.unit,
    period: value.period,
    support: value.support,
    status: value.status,
  };
}
function selectionKey(value: InterpolationSelection): string {
  return JSON.stringify([value.quantity, value.unit, value.period, value.support, value.status]);
}
function assertXY(xy: readonly number[]): void {
  if (xy.length !== 2) throw new Error("Interpolation requires an explicit EPSG:5070 XY view");
  assertPositionInCrs([...xy], "EPSG:5070");
}
function read(geometry: Geometry): JstsGeometry {
  return reader.read(geometry) as JstsGeometry;
}
function pointGeometry(xy: XY): JstsGeometry {
  const point: Point = { type: "Point", coordinates: [xy[0], xy[1]] };
  return read(point);
}
function covers(a: JstsGeometry, b: JstsGeometry): boolean {
  return Boolean(RelateOp.covers(a, b));
}
function missing(absence: SourceAbsenceCode, neighborCount = 0): InterpolationPoint {
  return { value: null, absence, neighborCount };
}
function observed(value: number, neighborCount: number): InterpolationPoint {
  return { value, absence: value === 0 ? "observed_zero" : null, neighborCount };
}
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
