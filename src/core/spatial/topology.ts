import type { Geometry } from "geojson";
import GeometryFactory from "jsts/org/locationtech/jts/geom/GeometryFactory.js";
import PrecisionModel from "jsts/org/locationtech/jts/geom/PrecisionModel.js";
import GeoJSONReader from "jsts/org/locationtech/jts/io/GeoJSONReader.js";
import GeoJSONWriter from "jsts/org/locationtech/jts/io/GeoJSONWriter.js";
import BufferOp from "jsts/org/locationtech/jts/operation/buffer/BufferOp.js";
import BufferParameters from "jsts/org/locationtech/jts/operation/buffer/BufferParameters.js";
import OverlayOp from "jsts/org/locationtech/jts/operation/overlay/OverlayOp.js";
import RelateOp from "jsts/org/locationtech/jts/operation/relate/RelateOp.js";
import IsValidOp from "jsts/org/locationtech/jts/operation/valid/IsValidOp.js";
import type JstsGeometry from "jsts/org/locationtech/jts/geom/Geometry.js";
import {
  canonicalizePolygonalGeometry,
  requirePolygonalGeometry,
  type PolygonalGeometry,
} from "./polygon.js";

export interface PlanarBufferParameters {
  distanceMetres: number;
  endCap: "round";
  join: "round";
  mitreLimit: number;
  quadrantSegments: number;
  simplifyFactor: number;
  singleSided: false;
}

export interface PlanarValidityVerdict {
  reason: string | null;
  valid: boolean;
}

/** Renderer-independent topology seam; every input coordinate is already projected metres. */
export interface PlanarTopologyEngine {
  readonly implementation: string;
  readonly version: string;
  area(geometry: PolygonalGeometry): number;
  buffer(geometry: PolygonalGeometry, parameters: PlanarBufferParameters): PolygonalGeometry;
  covers(left: PolygonalGeometry, right: PolygonalGeometry): boolean;
  difference(left: PolygonalGeometry, right: PolygonalGeometry): PolygonalGeometry;
  equalsTopologically(left: PolygonalGeometry, right: PolygonalGeometry): boolean;
  intersectionArea(left: PolygonalGeometry, right: PolygonalGeometry): number;
  intersects(left: PolygonalGeometry, right: PolygonalGeometry): boolean;
  touches(left: PolygonalGeometry, right: PolygonalGeometry): boolean;
  validate(geometry: PolygonalGeometry): PlanarValidityVerdict;
}

export const JSTS_TOPOLOGY_VERSION = "2.12.1" as const;

/** Creates the pinned JSTS adapter used for deterministic projected topology. */
export function createJstsPlanarTopologyEngine(): PlanarTopologyEngine {
  const factory = new GeometryFactory(new PrecisionModel(), 5070);
  const reader = new GeoJSONReader(factory);
  const writer = new GeoJSONWriter();

  const read = (geometry: PolygonalGeometry): JstsGeometry => reader.read(geometry) as JstsGeometry;
  const write = (geometry: JstsGeometry, path: string): PolygonalGeometry => {
    const value = writer.write(geometry) as Geometry;
    return canonicalizePolygonalGeometry(requirePolygonalGeometry(value, path));
  };

  return {
    area(geometry) {
      const area = read(geometry).getArea();
      if (!Number.isFinite(area)) throw new Error("JSTS returned a non-finite area");
      return area;
    },
    buffer(geometry, parameters) {
      assertBufferParameters(parameters);
      const options = new BufferParameters();
      options.setQuadrantSegments(parameters.quadrantSegments);
      options.setEndCapStyle(BufferParameters.CAP_ROUND);
      options.setJoinStyle(BufferParameters.JOIN_ROUND);
      options.setMitreLimit(parameters.mitreLimit);
      options.setSimplifyFactor(parameters.simplifyFactor);
      options.setSingleSided(parameters.singleSided);
      return write(
        BufferOp.bufferOp(read(geometry), parameters.distanceMetres, options) as JstsGeometry,
        "JSTS buffer result",
      );
    },
    covers(left, right) {
      return Boolean(RelateOp.covers(read(left), read(right)));
    },
    difference(left, right) {
      return write(OverlayOp.difference(read(left), read(right)) as JstsGeometry, "JSTS difference result");
    },
    equalsTopologically(left, right) {
      return Boolean(RelateOp.equalsTopo(read(left), read(right)));
    },
    implementation: "JSTS",
    intersectionArea(left, right) {
      const area = (OverlayOp.intersection(read(left), read(right)) as JstsGeometry).getArea();
      if (!Number.isFinite(area)) throw new Error("JSTS returned a non-finite intersection area");
      return area;
    },
    intersects(left, right) {
      return Boolean(RelateOp.intersects(read(left), read(right)));
    },
    touches(left, right) {
      return Boolean(RelateOp.touches(read(left), read(right)));
    },
    validate(geometry) {
      const operation = new IsValidOp(read(geometry));
      const valid = operation.isValid();
      const error = valid ? null : operation.getValidationError();
      return {
        reason: error === null ? null : String(error),
        valid,
      };
    },
    version: JSTS_TOPOLOGY_VERSION,
  };
}

function assertBufferParameters(parameters: PlanarBufferParameters): void {
  if (!Number.isFinite(parameters.distanceMetres) || parameters.distanceMetres <= 0) {
    throw new TypeError("buffer distance must be a finite positive number of metres");
  }
  if (!Number.isSafeInteger(parameters.quadrantSegments) || parameters.quadrantSegments < 1) {
    throw new TypeError("buffer quadrantSegments must be a positive integer");
  }
  if (!Number.isFinite(parameters.mitreLimit) || parameters.mitreLimit <= 0) {
    throw new TypeError("buffer mitreLimit must be finite and positive");
  }
  if (!Number.isFinite(parameters.simplifyFactor) || parameters.simplifyFactor < 0) {
    throw new TypeError("buffer simplifyFactor must be finite and non-negative");
  }
  if (parameters.endCap !== "round" || parameters.join !== "round" || parameters.singleSided !== false) {
    throw new TypeError("only the pinned round, double-sided buffer contract is supported");
  }
}
