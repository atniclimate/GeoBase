import type { Geometry, MultiPolygon, Polygon } from "geojson";
import type { JsonObject } from "../../shared/json.js";

export const SOURCE_LAYER_SCHEMA_VERSION = "geobase.source-layer/1" as const;
export const SOURCE_LAYER_LIMITS = Object.freeze({
  jsonBytes: 32 * 1024 * 1024,
  features: 10_000,
  vertices: 500_000,
  propertyTextBytes: 64 * 1024,
});

export type TriStateCode = "ID" | "OR" | "WA";
export type CoverageCompleteness = "complete" | "incomplete" | "unknown";
export type SourceLayerKind = "constraint" | "context" | "partner_overlay" | "resource";
export type SourceMeasurementStatus = "context" | "designation" | "measured" | "modeled";
export type SourceAbsenceCode =
  | "disputed"
  | "incompatible"
  | "invalid"
  | "not_applicable"
  | "not_collected"
  | "observed_zero"
  | "outside_spatial_coverage"
  | "outside_temporal_coverage"
  | "pending_review"
  | "source_null"
  | "suppressed"
  | "unavailable"
  | "withheld";

export interface SourceIdentity {
  publisher: string;
  title: string;
  record_id: string;
  edition: string;
  published_at: string | null;
  retrieved_at: string;
  uri: string;
  license: string;
  terms_uri: string | null;
  bytes: number;
  sha256: string;
}

export interface PreparationTransformation {
  operation: string;
  source_crs: string;
  target_crs: string;
  source_geometry_family: string;
  target_geometry_family: string;
  source_dimensions: number;
  target_dimensions: number;
  dimension_operation: "constructed_support_geometry" | "derived_xy_view" | "preserved";
  reason: string;
}

export interface PreparationIdentity {
  recipe_id: string;
  prepared_at: string;
  tools: Readonly<Record<string, string>>;
  transformations: PreparationTransformation[];
  limitations: string[];
}

export interface SourceCoverage {
  geometry: Polygon | MultiPolygon;
  completeness: CoverageCompleteness;
  states: TriStateCode[];
  statement: string;
}

export interface LayerMeasurementMetadata {
  status: SourceMeasurementStatus;
  quantity: string;
  unit: string;
  native_resolution: { value: number | null; unit: string; description: string };
  temporal_scope: string;
  support: string;
}

export interface SourceLayerCustody {
  source_classification: null;
  effective_tier: "T3";
  governance_mode: "development_bypass";
  governance_enforced: false;
  public_distribution_allowed: false;
  consent: null;
  ownership: string;
}

export interface FeatureMeasurement {
  id: string;
  quantity: string;
  unit: string;
  value: number | null;
  absence: SourceAbsenceCode | null;
  period: string;
  support: string;
  status: SourceMeasurementStatus;
  source_record_id: string;
}

export type DataCenterRepresentation = "building" | "campus" | "point";
export type DataCenterRelationship = "part_of" | "primary" | "related" | "unknown";
export type DataCenterLifecycleStatus =
  | "announced"
  | "operating"
  | "permitted"
  | "proposed"
  | "retired"
  | "under_construction"
  | "unknown";

export type DataCenterDemand =
  | { status: "unknown"; absence: SourceAbsenceCode }
  | {
      status: "asserted";
      quantity: string;
      unit: string;
      value: number;
      evidence_date: string;
      source_record_id: string;
      lifecycle_status: DataCenterLifecycleStatus;
    };

export interface DataCenterContext {
  canonical_site_id: string;
  representation: DataCenterRepresentation;
  relationship: DataCenterRelationship;
  lifecycle_assertions: {
    status: DataCenterLifecycleStatus;
    asserted_at: string;
    source_record_id: string;
  }[];
  demand: DataCenterDemand;
}

export interface SourceLayerFeature {
  id: string;
  /** Source-native geometry is retained without dimensional coercion. */
  source_geometry: Geometry;
  /** Explicit projected/rendering derivative. RSTEP topology accepts polygonal EPSG:5070 only. */
  analysis_geometry: Geometry;
  /** Optional exact raw source-record object, independent of normalized properties. */
  source_record: JsonObject | null;
  source_properties: JsonObject;
  /** Every null property must have an explicit typed absence entry with the same key. */
  absence: Readonly<Record<string, SourceAbsenceCode>>;
  measurements: FeatureMeasurement[];
  data_center: DataCenterContext | null;
}

export interface SourceLayerDocument {
  schema_version: typeof SOURCE_LAYER_SCHEMA_VERSION;
  layer_id: string;
  revision: string;
  name: string;
  kind: SourceLayerKind;
  source: SourceIdentity;
  preparation: PreparationIdentity;
  native_crs: { code: string; wkt: string };
  analysis_crs: "EPSG:5070";
  coverage: SourceCoverage;
  measurement: LayerMeasurementMetadata;
  absence_semantics: {
    missing: SourceAbsenceCode;
    outside_coverage: "outside_spatial_coverage";
    zero: "observed_zero";
  };
  custody: SourceLayerCustody;
  features: SourceLayerFeature[];
}

export interface ParsedSourceLayer {
  document: SourceLayerDocument;
  exactJson: string;
  exactSha256: string;
  exactBytes: number;
  featureCount: number;
  vertexCount: number;
}

export interface SourceLayerSummary {
  layer_id: string;
  revision: string;
  name: string;
  kind: SourceLayerKind;
  publisher: string;
  source_title: string;
  source_edition: string;
  coverage_completeness: CoverageCompleteness;
  states: TriStateCode[];
  feature_count: number;
  vertex_count: number;
  effective_tier: "T3";
  exact_sha256: string;
}
