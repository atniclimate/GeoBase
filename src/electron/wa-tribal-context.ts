import { createHash } from "node:crypto";
import { constants, createReadStream, existsSync, statSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Feature } from "geojson";
import {
  createWashingtonAoiSnapshot,
  parseWashingtonGeodesicAudit,
  verifyStoredWashingtonTechnicalAoi,
  type WashingtonAoiTransformation,
} from "../core/aoi/wa-buffer.js";
import { transformGeometry } from "../core/crs.js";
import {
  parseGeoPackageJsonMetadata,
  WA_TRIBAL_CONTEXT_METADATA_URI,
} from "../core/formats/geopackage/metadata.js";
import {
  discoverGeoPackage,
  type GeoPackageFeature,
  type GeoPackageFeatureTableRegistration,
  readFeatureTable,
} from "../core/formats/geopackage/reader.js";
import type { GeoPackageGeometryBounds } from "../core/formats/geopackage/writer.js";
import { loadTsdfSource, type TsdfSource } from "../core/governance/tsdf-source.js";
import { sha256Text } from "../core/hash.js";
import {
  canonicalizePolygonalGeometry,
  type PolygonalGeometry,
  requirePolygonalGeometry,
} from "../core/spatial/polygon.js";
import { createJstsPlanarTopologyEngine, type PlanarTopologyEngine } from "../core/spatial/topology.js";
import { CENSUS_2025_AIANNH_SOURCE_ID } from "../core/tribal/census-aiannh.js";
import {
  isTribalGeometryCategory,
  type NationCoverageRow,
  type TribalGeometryCategory,
} from "../core/tribal/coverage.js";
import {
  type ArtifactClassification,
  type ComponentSourceDisposition,
  parseArtifactCustodyMetadata,
  type SourceReceipt,
} from "../core/tribal/custody.js";
import type { NationRegistryRecord } from "../core/tribal/nation-registry.js";
import {
  buildTribalPresentationContext,
  createTribalPresentationTransformation,
  REQUIRED_CENSUS_TRIBAL_ATTRIBUTES,
  type TribalGeometryValidityDisposition,
  type TribalPresentationContext,
  type TribalPresentationFeature,
} from "../core/tribal/presentation.js";
import {
  projectNad83PolygonalForTribalTopology,
  type TribalFeatureAoiRelation,
} from "../core/tribal/selection.js";
import {
  verifyWaTribalSourceProfile,
  type WaTribalNativeFeatureInventoryRecord,
  type WaTribalSourceProfile,
} from "../core/tribal/source-profile.js";
import { isJsonObject, type JsonObject, type JsonValue } from "../shared/json.js";
import { stableStringify } from "../shared/stable-json.js";
import { resolveApprovedLocalDirectory } from "./local-files.js";
import { NodeSqliteGeoPackagePort } from "./node-sqlite-geopackage.js";

const EXPECTED_TABLES = [
  "tribal_features",
  "wa_buffered_aoi",
  "wa_overflow_100m",
  "wa_state",
  "wa_state_source",
] as const;

const CENSUS_2025_AIANNH_SHAPEFILE_SOURCE_ID = "census-2025-aiannh-shapefile";
const CENSUS_2025_AIANNH_SOURCE_FEATURE_COUNT = 867;
const CENSUS_2025_AIANNH_GPKG_SCHEMA_FIELDS = REQUIRED_CENSUS_TRIBAL_ATTRIBUTES.filter(
  (field) => field !== "AIANNHCE" && field !== "NAME" && field !== "LSAD",
);
const ACCEPTED_CENSUS_AIANNH_CATEGORIES = [
  "federal_reservation_exterior",
  "off_reservation_trust_land",
  "tdsa_statistical_area",
] as const satisfies readonly TribalGeometryCategory[];

type LoadedPolygonalFeature = Feature<PolygonalGeometry, JsonObject> & {
  geometryBlobSha256: string;
};

/** Hashes and strictly imports one local derived GeoPackage without exposing its path to the renderer. */
export async function loadWaTribalContextFromGeoPackage(
  path: string,
  trustedTsdfSource: TsdfSource,
  trustedSourceProfile: WaTribalSourceProfile,
): Promise<{ bytesRead: number; context: TribalPresentationContext; exactBytesSha256: string }> {
  assertNoSqliteSidecars(path);
  const initialStat = statSync(path);
  const exactBytesSha256 = await hashFile(path);
  const bytesRead = initialStat.size;
  const localTemporaryRoot = await resolveApprovedLocalDirectory(tmpdir());
  const snapshotDirectory = await mkdtemp(join(localTemporaryRoot, "atni-geobase-gpkg-"));
  const snapshotPath = join(snapshotDirectory, "selected-snapshot.gpkg");
  try {
    await copyFile(path, snapshotPath, constants.COPYFILE_EXCL);
    const snapshotStat = statSync(snapshotPath);
    if (snapshotStat.size !== bytesRead || (await hashFile(snapshotPath)) !== exactBytesSha256) {
      throw new Error("WA/Tribal package changed while its exact-byte snapshot was being created");
    }

    const port = new NodeSqliteGeoPackagePort(snapshotPath);
    let context: TribalPresentationContext;
    try {
      context = await readValidatedWaTribalContext(
        port,
        exactBytesSha256,
        trustedTsdfSource,
        trustedSourceProfile,
      );
    } finally {
      port.close();
    }

    assertNoSqliteSidecars(path);
    const verificationSha256 = await hashFile(path);
    const finalStat = statSync(path);
    if (
      verificationSha256 !== exactBytesSha256 ||
      finalStat.size !== initialStat.size ||
      finalStat.mtimeMs !== initialStat.mtimeMs
    ) {
      throw new Error("WA/Tribal package changed while it was being validated");
    }
    return {
      bytesRead,
      context,
      exactBytesSha256,
    };
  } finally {
    await rm(snapshotDirectory, { force: true, recursive: true });
  }
}

async function readValidatedWaTribalContext(
  port: NodeSqliteGeoPackagePort,
  exactBytesSha256: string,
  trustedTsdfSource: TsdfSource,
  trustedSourceProfile: WaTribalSourceProfile,
): Promise<TribalPresentationContext> {
  const catalog = discoverGeoPackage(port);
  const actualTables = catalog.featureTables.map((table) => table.content.tableName).sort(compareCodePoints);
  const expectedTables = [...EXPECTED_TABLES].sort(compareCodePoints);
  if (stableStringify(actualTables, false) !== stableStringify(expectedTables, false)) {
    throw new Error("WA/Tribal package feature-table inventory is missing or unexpected");
  }
  if (catalog.metadata === null || catalog.metadataReferences === null) {
    throw new Error("WA/Tribal package lacks required standard GeoPackage metadata tables");
  }
  const metadata = parseGeoPackageJsonMetadata(
    catalog.metadata,
    catalog.metadataReferences,
    WA_TRIBAL_CONTEXT_METADATA_URI,
  );
  const root = requireObject(metadata, "WA/Tribal metadata root");
  requireExactKeys(
    root,
    ["aoi_contract", "build_verification", "coverage", "custody", "registry", "schema_version"],
    "WA/Tribal metadata root",
  );
  if (root.schema_version !== "1.0.0") throw new Error("WA/Tribal metadata schema must equal 1.0.0");
  const custody = parseArtifactCustodyMetadata(root.custody);
  assertTrustedWaTribalTsdfProfile({
    classification: custody.classification,
    sourceReceiptCount: custody.source_receipts.length,
    trustedTsdfSource,
  });
  const storedAoi = requireObject(root.aoi_contract, "aoi_contract");
  const storedAoiSource = requireObject(storedAoi.source, "aoi_contract.source");
  const audit = parseWashingtonGeodesicAudit(storedAoi.independent_geodesic_audit);
  const topologyEngine = createJstsPlanarTopologyEngine();

  const sourceState = await onePolygonalFeature(port, table(catalog.featureTables, "wa_state_source"), 4269);
  const metricState = await onePolygonalFeature(port, table(catalog.featureTables, "wa_state"), 5070);
  const bufferedAoi = await onePolygonalFeature(port, table(catalog.featureTables, "wa_buffered_aoi"), 5070);
  const overflow = await onePolygonalFeature(port, table(catalog.featureTables, "wa_overflow_100m"), 5070);
  const sourceFeatureId = requireString(storedAoiSource.feature_id, "aoi_contract.source.feature_id");
  assertWashingtonStateSourceBinding(sourceState.properties, sourceFeatureId);
  const aoi = await verifyStoredWashingtonTechnicalAoi({
    bufferedAoi: bufferedAoi.geometry,
    independentGeodesicAudit: audit,
    metricState: metricState.geometry,
    overflow: overflow.geometry,
    performedAt: custody.generated_at,
    sourceArchiveSha256: requireSha256(
      storedAoiSource.source_archive_sha256,
      "aoi_contract.source.source_archive_sha256",
    ),
    sourceFeature: {
      geometry: sourceState.geometry,
      id: sourceFeatureId,
      properties: sourceState.properties,
      type: "Feature",
    },
    sourceGeometrySha256: requireSha256(
      storedAoiSource.geometry_sha256,
      "aoi_contract.source.geometry_sha256",
    ),
    sourceTable: requireString(storedAoiSource.source_table, "aoi_contract.source.source_table"),
    topologyEngine,
  });
  if (stableStringify(createWashingtonAoiSnapshot(aoi), false) !== stableStringify(storedAoi, false)) {
    throw new Error("verified stored AOI does not match the complete embedded AOI contract");
  }
  const relationMetricState = projectNad83PolygonalForTribalTopology(sourceState.geometry);
  assertWaTribalAoiCustodyCrosslinks({
    sourceArchiveSha256: aoi.source.source_archive_sha256,
    sourceBounds: aoi.source.bounds,
    sourceReceipts: custody.source_receipts,
    performedAt: custody.generated_at,
    transformationHistory: custody.transformation_history,
    transformations: aoi.transformations,
  });

  const registry = root.registry as unknown as NationRegistryRecord[];
  const coverage = root.coverage as unknown as NationCoverageRow[];
  const tribalFeatureTable = table(catalog.featureTables, "tribal_features");
  const features = await readTribalPresentationFeatures(
    port,
    tribalFeatureTable,
    relationMetricState,
    aoi.metric.wa_overflow_100m,
    topologyEngine,
  );
  verifyBuildVerification(root.build_verification, registry, features);
  const context = await buildTribalPresentationContext({
    aoi,
    artifactReference: custody.artifact_id,
    artifactSha256: exactBytesSha256,
    coverage,
    custody,
    features,
    registry,
  });
  assertWaTribalAiannhCustodyProfile({
    componentSources: context.custody.component_sources,
    registry: context.registry,
    retainedFeatureBounds: registeredBounds(tribalFeatureTable),
    sourceReceipts: context.custody.source_receipts,
  });
  await verifyWaTribalSourceProfile({
    borderContext: context.features
      .filter((feature) => feature.registry_scope === "border_context")
      .map((feature) => ({
        formal_name: requireString(feature.formal_nation_name, "border feature formal_nation_name"),
        source_feature_id: feature.source_feature_id,
      })),
    context,
    nativeFeatures: nativeFeatureInventory(sourceState, sourceFeatureId, context.features),
    profile: trustedSourceProfile,
    registry: context.registry,
    sourceReceipts: context.custody.source_receipts,
  });
  return context;
}

/** Binds the stored Washington geometry to its preserved Census state discriminator tuple. */
export function assertWashingtonStateSourceBinding(properties: JsonObject, featureId: string): void {
  for (const [field, expected] of [
    ["STATEFP", "53"],
    ["GEOID", "53"],
    ["STUSPS", "WA"],
    ["NAME", "Washington"],
  ] as const) {
    if (properties[field] !== expected) {
      throw new Error(`wa_state_source.${field} must equal ${expected}`);
    }
  }
  if (featureId !== properties.GEOID) {
    throw new Error("aoi_contract.source.feature_id must equal the preserved Washington GEOID");
  }
}

export interface WaTribalTrustedTsdfProfileInput {
  classification: ArtifactClassification;
  sourceReceiptCount: number;
  trustedTsdfSource: TsdfSource;
}

/** Rejects artifact-controlled tier semantics or classification assignments for this fail-closed slice. */
export function assertTrustedWaTribalTsdfProfile(input: WaTribalTrustedTsdfProfileInput): void {
  const trusted = loadTsdfSource(input.trustedTsdfSource.record);
  if (
    stableStringify(input.classification.tsdf_source as unknown as JsonValue, false) !==
    stableStringify(trusted.record as unknown as JsonValue, false)
  ) {
    throw new Error("embedded TSDF source does not match the trusted local authority");
  }
  if (
    input.classification.source_tier_ids.length !== input.sourceReceiptCount ||
    input.classification.source_tier_ids.some((tierId) => tierId !== null)
  ) {
    throw new Error("WA/Tribal source receipts must remain unclassified and use the trusted default tier");
  }
  const defaultTier = trusted.resolve(null);
  if (
    defaultTier.id !== "T3" ||
    defaultTier.behavior.export_allowed ||
    defaultTier.behavior.network_allowed ||
    defaultTier.behavior.public_distribution_allowed
  ) {
    throw new Error("trusted WA/RSTEP default tier must be fail-closed T3");
  }
  const effectiveTier = trusted.effectiveTier(input.classification.source_tier_ids);
  if (input.classification.effective_tier_id !== defaultTier.id || effectiveTier.id !== defaultTier.id) {
    throw new Error("WA/Tribal effective tier must equal the trusted default T3");
  }
}

type AiannhReceiptProfile = Pick<
  SourceReceipt,
  "as_of" | "feature_count" | "native_bounds" | "native_crs" | "schema_fields" | "source_id" | "vintage"
>;

export interface WaTribalAiannhCustodyProfileInput {
  componentSources: readonly Pick<ComponentSourceDisposition, "category" | "disposition" | "source_ids">[];
  registry: readonly Pick<NationRegistryRecord, "nation_id" | "source_identifiers">[];
  retainedFeatureBounds: GeoPackageGeometryBounds;
  sourceReceipts: readonly AiannhReceiptProfile[];
}

/** Binds the closed 2025 Census AIANNH presentation profile to its embedded source receipts. */
export function assertWaTribalAiannhCustodyProfile(input: WaTribalAiannhCustodyProfileInput): void {
  const gpkgReceipt = uniqueReceipt(input.sourceReceipts, CENSUS_2025_AIANNH_SOURCE_ID);
  const shapefileReceipt = uniqueReceipt(input.sourceReceipts, CENSUS_2025_AIANNH_SHAPEFILE_SOURCE_ID);
  assertAiannhReceiptProfile(gpkgReceipt, CENSUS_2025_AIANNH_GPKG_SCHEMA_FIELDS, input.retainedFeatureBounds);
  assertAiannhReceiptProfile(
    shapefileReceipt,
    REQUIRED_CENSUS_TRIBAL_ATTRIBUTES,
    input.retainedFeatureBounds,
  );
  if (
    stableStringify(gpkgReceipt.native_bounds as unknown as JsonValue, false) !==
    stableStringify(shapefileReceipt.native_bounds as unknown as JsonValue, false)
  ) {
    throw new Error("same-vintage Census AIANNH source receipts must declare the same native bounds");
  }

  for (const record of input.registry) {
    if (
      !record.source_identifiers.some(
        (identifier) =>
          identifier.source_id === CENSUS_2025_AIANNH_SOURCE_ID && identifier.identifier.startsWith("GEOID:"),
      )
    ) {
      throw new Error(`registry Nation ${record.nation_id} is not linked to the Census AIANNH GeoPackage`);
    }
  }

  const acceptedComponents = input.componentSources.filter(
    (component) => component.disposition === "accepted",
  );
  if (acceptedComponents.length !== ACCEPTED_CENSUS_AIANNH_CATEGORIES.length) {
    throw new Error("WA/Tribal custody must accept exactly the three supported Census AIANNH categories");
  }
  const expectedSourceIds = [CENSUS_2025_AIANNH_SOURCE_ID, CENSUS_2025_AIANNH_SHAPEFILE_SOURCE_ID].sort(
    compareCodePoints,
  );
  for (const category of ACCEPTED_CENSUS_AIANNH_CATEGORIES) {
    const components = acceptedComponents.filter((component) => component.category === category);
    if (
      components.length !== 1 ||
      stableStringify([...(components[0]?.source_ids ?? [])].sort(compareCodePoints), false) !==
        stableStringify(expectedSourceIds, false)
    ) {
      throw new Error(`accepted Census category ${category} must cite exactly both AIANNH source receipts`);
    }
  }
}

export interface WaTribalAoiCustodyCrosslinkInput {
  performedAt: string;
  sourceArchiveSha256: string;
  sourceBounds: GeoPackageGeometryBounds;
  sourceReceipts: readonly {
    exact_bytes_sha256: string;
    native_bounds: readonly [number, number, number, number] | null;
    native_crs: { code: string | null };
    source_id: string;
  }[];
  transformationHistory: readonly JsonObject[];
  transformations: readonly WashingtonAoiTransformation[];
}

/** Rejects contradictory source and CRS claims inside an otherwise valid WA/Tribal package. */
export function assertWaTribalAoiCustodyCrosslinks(input: WaTribalAoiCustodyCrosslinkInput): void {
  const expectedTransformationHistory: JsonObject[] = [
    ...input.transformations.map(
      (transformation) => JSON.parse(JSON.stringify(transformation)) as JsonObject,
    ),
    createTribalPresentationTransformation(input.performedAt),
  ];
  if (
    stableStringify(input.transformationHistory as unknown as JsonValue, false) !==
    stableStringify(expectedTransformationHistory, false)
  ) {
    throw new Error(
      "custody transformation history does not match the verified AOI and Tribal presentation transformations",
    );
  }

  const stateReceipts = input.sourceReceipts.filter(
    (receipt) => receipt.source_id === "census-2025-state-shapefile",
  );
  if (stateReceipts.length !== 1) {
    throw new Error("custody must contain exactly one census-2025-state-shapefile source receipt");
  }
  const stateReceipt = stateReceipts[0];
  if (stateReceipt === undefined) throw new Error("Washington state source receipt is unavailable");
  if (stateReceipt.exact_bytes_sha256 !== input.sourceArchiveSha256) {
    throw new Error("Washington AOI source archive SHA-256 does not match its custody receipt");
  }
  if (stateReceipt.native_crs.code !== "EPSG:4269") {
    throw new Error("Washington state source custody receipt must declare native EPSG:4269");
  }
  const receiptBounds = stateReceipt.native_bounds;
  if (
    receiptBounds === null ||
    receiptBounds.some((coordinate) => !Number.isFinite(coordinate)) ||
    receiptBounds[0] > input.sourceBounds.minX ||
    receiptBounds[1] > input.sourceBounds.minY ||
    receiptBounds[2] < input.sourceBounds.maxX ||
    receiptBounds[3] < input.sourceBounds.maxY
  ) {
    throw new Error("Washington state source custody bounds do not contain the verified source geometry");
  }
}

function assertNoSqliteSidecars(path: string): void {
  const sidecar = [`${path}-wal`, `${path}-shm`, `${path}-journal`].find(existsSync);
  if (sidecar !== undefined) {
    throw new Error(
      "WA/Tribal package has a SQLite journal sidecar; checkpoint and remove sidecars before exact-byte ingest",
    );
  }
}

async function readTribalPresentationFeatures(
  port: NodeSqliteGeoPackagePort,
  registration: GeoPackageFeatureTableRegistration,
  metricState: PolygonalGeometry,
  metricOverflow: PolygonalGeometry,
  topologyEngine: PlanarTopologyEngine,
): Promise<TribalPresentationFeature[]> {
  if (registration.geometry.srsId !== 4269 || registration.geometry.geometryTypeName !== "MULTIPOLYGON") {
    throw new Error("tribal_features must be registered as EPSG:4269 MULTIPOLYGON");
  }
  const rows = await readFeatureTable(port, registration, { featureIdColumn: "source_feature_id" });
  const features: TribalPresentationFeature[] = [];
  for (const [index, row] of rows.entries()) {
    const path = `tribal_features[${index}]`;
    if (row.geometry === null || row.geometryBlobSha256 === null) {
      throw new Error(`${path}.geom must be non-null`);
    }
    const nativeGeometry = requirePolygonalGeometry(row.geometry.geometry, `${path}.geom`);
    const sourceAttributes = parseJsonObjectAttribute(row, "source_attributes_json", path);
    const sourceFeatureId = attributeString(row, "source_feature_id", path);
    const sourceGeometrySha256 = attributeString(row, "source_geometry_sha256", path);
    if (sourceGeometrySha256 !== row.geometryBlobSha256) {
      throw new Error(`${path}.source_geometry_sha256 does not match the exact native BLOB`);
    }
    assertPreservedColumns(row, sourceAttributes, path);
    const presentationGeometry = canonicalizePolygonalGeometry(
      transformGeometry(nativeGeometry, "EPSG:4269", "EPSG:4326") as PolygonalGeometry,
    );
    const presentationGeometrySha256 = await sha256Text(
      stableStringify(presentationGeometry as unknown as JsonValue, false),
    );
    if (presentationGeometrySha256 !== attributeString(row, "presentation_geometry_sha256", path)) {
      throw new Error(`${path}.presentation_geometry_sha256 does not match the fresh transform`);
    }
    const categoryValue = attributeString(row, "category", path);
    if (!isTribalGeometryCategory(categoryValue)) throw new Error(`${path}.category is unsupported`);
    const registryScope = attributeString(row, "registry_scope", path);
    if (registryScope !== "goia_29" && registryScope !== "border_context") {
      throw new Error(`${path}.registry_scope is unsupported`);
    }
    const relationObject = requireObject(
      parseJsonObjectAttribute(row, "relation_json", path),
      `${path}.relation_json`,
    );
    requireExactKeys(
      relationObject,
      ["intersects_overflow_only", "intersects_state", "touches_state"],
      `${path}.relation_json`,
    );
    const storedRelation: TribalFeatureAoiRelation = {
      intersects_overflow_only: requireBoolean(
        relationObject.intersects_overflow_only,
        `${path}.relation_json.intersects_overflow_only`,
      ),
      intersects_state: requireBoolean(
        relationObject.intersects_state,
        `${path}.relation_json.intersects_state`,
      ),
      touches_state: requireBoolean(relationObject.touches_state, `${path}.relation_json.touches_state`),
    };
    const projectedNative = projectNad83PolygonalForTribalTopology(nativeGeometry);
    const intersectsState = topologyEngine.intersects(projectedNative, metricState);
    const intersectsOverflow = topologyEngine.intersects(projectedNative, metricOverflow);
    const verifiedRelation: TribalFeatureAoiRelation = {
      intersects_overflow_only: intersectsOverflow && !intersectsState,
      intersects_state: intersectsState,
      touches_state: topologyEngine.touches(projectedNative, metricState),
    };
    if (
      stableStringify(storedRelation as unknown as JsonValue, false) !==
      stableStringify(verifiedRelation as unknown as JsonValue, false)
    ) {
      throw new Error(`${path}.relation_json does not match fresh EPSG:5070 topology`);
    }
    features.push({
      category: categoryValue,
      formal_nation_name: nullableAttributeString(row, "formal_nation_name", path),
      geometry: presentationGeometry,
      nation_id: nullableAttributeString(row, "nation_id", path),
      presentation_geometry_sha256: presentationGeometrySha256,
      registry_scope: registryScope,
      relation: verifiedRelation,
      source_attributes: sourceAttributes,
      source_attributes_sha256: attributeString(row, "source_attributes_sha256", path),
      source_feature_id: sourceFeatureId,
      source_geometry_sha256: sourceGeometrySha256,
      source_name: requireString(sourceAttributes.NAMELSAD, `${path}.source_attributes.NAMELSAD`),
      validity: parseJsonObjectAttribute(
        row,
        "validity_json",
        path,
      ) as unknown as TribalGeometryValidityDisposition,
    });
  }
  return features;
}

function verifyBuildVerification(
  value: unknown,
  registry: readonly NationRegistryRecord[],
  features: readonly TribalPresentationFeature[],
): void {
  const path = "build_verification";
  const verification = requireObject(value, path);
  requireExactKeys(
    verification,
    [
      "field_provenance",
      "independent_selected_source_ids_sha256",
      "nation_count",
      "selected_feature_count",
      "source_geometry_retention",
    ],
    path,
  );
  const fieldProvenance = requireObject(verification.field_provenance, `${path}.field_provenance`);
  requireExactKeys(
    fieldProvenance,
    ["gpkg_primary_fields", "same_vintage_shapefile_joined_fields", "source_conflict_rule"],
    `${path}.field_provenance`,
  );
  requireExactStringArray(
    fieldProvenance.gpkg_primary_fields,
    [
      "AIANNHNS",
      "GEOID",
      "GEOIDFQ",
      "NAMELSAD",
      "CLASSFP",
      "COMPTYP",
      "AIANNHR",
      "MTFCC",
      "FUNCSTAT",
      "ALAND",
      "AWATER",
      "INTPTLAT",
      "INTPTLON",
    ],
    `${path}.field_provenance.gpkg_primary_fields`,
  );
  requireExactStringArray(
    fieldProvenance.same_vintage_shapefile_joined_fields,
    ["AIANNHCE", "NAME", "LSAD"],
    `${path}.field_provenance.same_vintage_shapefile_joined_fields`,
  );
  if (
    fieldProvenance.source_conflict_rule !==
    "Shared-field disagreements are preserved under SHAPEFILE_<field>; primary GPKG values are never overwritten."
  ) {
    throw new Error(`${path}.field_provenance.source_conflict_rule is unsupported`);
  }
  if (requireInteger(verification.nation_count, `${path}.nation_count`) !== registry.length) {
    throw new Error(`${path}.nation_count does not match the validated registry`);
  }
  if (
    requireInteger(verification.selected_feature_count, `${path}.selected_feature_count`) !== features.length
  ) {
    throw new Error(`${path}.selected_feature_count does not match the validated feature table`);
  }
  if (
    verification.source_geometry_retention !==
    "exact original GeoPackage BLOB copied for every selected feature"
  ) {
    throw new Error(`${path}.source_geometry_retention is unsupported`);
  }
  const selectedIdsDigest = createHash("sha256")
    .update(
      stableStringify(features.map((feature) => feature.source_feature_id).sort(compareCodePoints), false),
    )
    .digest("hex");
  if (
    requireSha256(
      verification.independent_selected_source_ids_sha256,
      `${path}.independent_selected_source_ids_sha256`,
    ) !== selectedIdsDigest
  ) {
    throw new Error(`${path}.independent_selected_source_ids_sha256 does not match selected features`);
  }
}

async function onePolygonalFeature(
  port: NodeSqliteGeoPackagePort,
  registration: GeoPackageFeatureTableRegistration,
  expectedSrs: number,
): Promise<LoadedPolygonalFeature> {
  const rows = await readFeatureTable(port, registration);
  if (
    registration.geometry.srsId !== expectedSrs ||
    rows.length !== 1 ||
    rows[0]?.geometry === null ||
    rows[0]?.geometryBlobSha256 === null
  ) {
    throw new Error(`${registration.content.tableName} must contain one EPSG:${expectedSrs} geometry`);
  }
  const row = rows[0];
  if (row?.geometry === null || row?.geometryBlobSha256 === null || row === undefined) {
    throw new Error("single geometry row is unavailable");
  }
  return {
    geometry: requirePolygonalGeometry(row.geometry.geometry, registration.content.tableName),
    geometryBlobSha256: row.geometryBlobSha256,
    id: String(row.primaryKey),
    properties: parseJsonObjectAttribute(row, "attributes_json", registration.content.tableName),
    type: "Feature",
  };
}

function nativeFeatureInventory(
  stateFeature: LoadedPolygonalFeature,
  stateSourceFeatureId: string,
  tribalFeatures: readonly TribalPresentationFeature[],
): WaTribalNativeFeatureInventoryRecord[] {
  return [
    {
      feature_role: "washington_state_source",
      source_attributes: stateFeature.properties,
      source_feature_id: stateSourceFeatureId,
      source_geometry_sha256: stateFeature.geometryBlobSha256,
      source_table: "wa_state_source",
    },
    ...tribalFeatures.map((feature) => ({
      category: feature.category,
      feature_role: "tribal_feature" as const,
      formal_nation_name: feature.formal_nation_name,
      nation_id: feature.nation_id,
      registry_scope: feature.registry_scope,
      source_attributes: feature.source_attributes,
      source_feature_id: feature.source_feature_id,
      source_geometry_sha256: feature.source_geometry_sha256,
      source_name: feature.source_name,
      source_table: "tribal_features" as const,
    })),
  ];
}

function assertPreservedColumns(row: GeoPackageFeature, attributes: JsonObject, path: string): void {
  for (const key of [
    "AIANNHCE",
    "AIANNHNS",
    "GEOID",
    "GEOIDFQ",
    "NAME",
    "NAMELSAD",
    "LSAD",
    "CLASSFP",
    "COMPTYP",
    "AIANNHR",
    "MTFCC",
    "FUNCSTAT",
    "ALAND",
    "AWATER",
    "INTPTLAT",
    "INTPTLON",
  ]) {
    const column = normalizeAttribute(row.attributes[key], `${path}.${key}`);
    if (stableStringify(column, false) !== stableStringify(attributes[key] ?? null, false)) {
      throw new Error(`${path}.${key} disagrees with preserved source_attributes_json`);
    }
  }
}

function parseJsonObjectAttribute(row: GeoPackageFeature, name: string, path: string): JsonObject {
  const text = attributeString(row, name, path);
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${path}.${name} is not valid JSON`);
  }
  return requireObject(value, `${path}.${name}`);
}

function attributeString(row: GeoPackageFeature, name: string, path: string): string {
  return requireString(row.attributes[name], `${path}.${name}`);
}

function nullableAttributeString(row: GeoPackageFeature, name: string, path: string): string | null {
  const value = row.attributes[name];
  return value === null ? null : requireString(value, `${path}.${name}`);
}

function normalizeAttribute(value: unknown, path: string): JsonValue {
  if (typeof value === "bigint") {
    return value.toString(10);
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  throw new Error(`${path} is not a JSON scalar`);
}

function table(
  registrations: readonly GeoPackageFeatureTableRegistration[],
  name: string,
): GeoPackageFeatureTableRegistration {
  const registration = registrations.find((candidate) => candidate.content.tableName === name);
  if (registration === undefined) throw new Error(`required GeoPackage table ${name} is absent`);
  return registration;
}

function registeredBounds(registration: GeoPackageFeatureTableRegistration): GeoPackageGeometryBounds {
  const { maxX, maxY, minX, minY } = registration.content;
  if (maxX === null || maxY === null || minX === null || minY === null) {
    throw new Error(`${registration.content.tableName} must register finite native geometry bounds`);
  }
  return { maxX, maxY, minX, minY };
}

function uniqueReceipt(receipts: readonly AiannhReceiptProfile[], sourceId: string): AiannhReceiptProfile {
  const matches = receipts.filter((receipt) => receipt.source_id === sourceId);
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new Error(`custody must contain exactly one ${sourceId} source receipt`);
  }
  return matches[0];
}

function assertAiannhReceiptProfile(
  receipt: AiannhReceiptProfile,
  expectedSchemaFields: readonly string[],
  retainedBounds: GeoPackageGeometryBounds,
): void {
  if (
    receipt.as_of !== "2025-01-01" ||
    receipt.vintage !== "2025 TIGER/Line" ||
    receipt.feature_count !== CENSUS_2025_AIANNH_SOURCE_FEATURE_COUNT
  ) {
    throw new Error(`${receipt.source_id} does not match the required 2025 Census 867-feature profile`);
  }
  if (receipt.native_crs.code !== "EPSG:4269" || receipt.native_crs.wkt_sha256 === null) {
    throw new Error(`${receipt.source_id} must preserve its explicit native EPSG:4269 WKT receipt`);
  }
  requireExactStringArray(receipt.schema_fields, expectedSchemaFields, `${receipt.source_id}.schema_fields`);
  const bounds = receipt.native_bounds;
  if (
    bounds === null ||
    bounds.some((coordinate) => !Number.isFinite(coordinate)) ||
    bounds[0] > retainedBounds.minX ||
    bounds[1] > retainedBounds.minY ||
    bounds[2] < retainedBounds.maxX ||
    bounds[3] < retainedBounds.maxY
  ) {
    throw new Error(`${receipt.source_id} native bounds do not contain every retained feature`);
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function requireObject(value: unknown, path: string): JsonObject {
  if (!isJsonObject(value)) throw new Error(`${path} must be a JSON object`);
  return value;
}

function requireExactKeys(value: JsonObject, expected: readonly string[], path: string): void {
  const keys = Object.keys(value).sort(compareCodePoints);
  const wanted = [...expected].sort(compareCodePoints);
  if (stableStringify(keys, false) !== stableStringify(wanted, false)) {
    throw new Error(`${path} has missing or unexpected fields`);
  }
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be non-empty text`);
  }
  return value;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${path} must be boolean`);
  return value;
}

function requireInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${path} must be a non-negative safe integer`);
  }
  return value;
}

function requireExactStringArray(value: unknown, expected: readonly string[], path: string): void {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${path} must be an array of strings`);
  }
  if (stableStringify(value, false) !== stableStringify([...expected], false)) {
    throw new Error(`${path} does not match the required field inventory`);
  }
}

function requireSha256(value: unknown, path: string): string {
  const digest = requireString(value, path);
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`${path} must be a lowercase SHA-256`);
  return digest;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
