import type { Geometry, MultiPolygon, Polygon, Position } from "geojson";
import { startRstepPanel } from "./rstep-panel";
import hardFixtureText from "../../fixtures/synthetic-wa-hard-exclusion.geojson?raw";
import resourceFixtureText from "../../fixtures/synthetic-wa-resource.geojson?raw";
import softFixtureText from "../../fixtures/synthetic-wa-soft-constraint.geojson?raw";
import { type BaselinePresentation, verifyBaselineBinding } from "../core/baseline/manifest";
import {
  type AnalysisResult,
  analysisResultToOpportunityFeature,
  analyzeScenario,
  attachProjectWaTribalContext,
  type CandidatePolygon,
  compareOpportunityRoundTrip,
  createCandidate,
  createProject,
  createProjectLayerReference,
  createProjectWaTribalContextBinding,
  deleteCandidate,
  editCandidateGeometry,
  exportOpportunityGeoJson,
  type ImportedGeoJsonLayer,
  importAtniGeoJson,
  importOpportunityGeoJson,
  loadTsdfSource,
  type NationCoverageRow,
  type NationRegistryRecord,
  type OpportunityExport,
  type OpportunityState,
  type ProjectDocument,
  parseProject,
  renameCandidate,
  type Scenario,
  serializeProject,
  sha256Hex,
  type TribalGeometryCategory,
  type TribalPresentationContext,
  type TribalPresentationFeature,
  verifyProjectLayerReference,
  verifyProjectWaTribalContextBinding,
} from "../core/index.ts";
import { attachProjectBaseline } from "../core/project";
import {
  CesiumScene,
  type DisplayCandidate,
  type DisplayPolygon,
  type LongitudeLatitude,
} from "./cesium-scene";
import { type DisplayRing, polygonDisplayParts } from "./display-geometry";
import { renderDemPanel, renderDemProbe } from "./local-dem-panel";

type WorkflowState = "empty" | "error" | "loading" | "success";

type TribalVisibilityKey =
  | "border_context"
  | "federal_reservation_exterior"
  | "off_reservation_trust_land"
  | "tdsa_statistical_area"
  | "wa_state"
  | "wa_technical_buffer";

type RenderedTribalCategory =
  | "federal_reservation_exterior"
  | "off_reservation_trust_land"
  | "tdsa_statistical_area";

interface InteriorHoleInspection {
  category: RenderedTribalCategory;
  clearance_metres: number;
  coordinate: LongitudeLatitude;
  source_feature_id: string;
}

type FixtureDefinition = {
  kind: "hard" | "resource" | "soft";
  reference: string;
  text: string;
};

type FixtureSet = {
  all: ImportedGeoJsonLayer[];
  hard: ImportedGeoJsonLayer;
  resource: ImportedGeoJsonLayer;
  soft: ImportedGeoJsonLayer;
};

const FIXTURE_DEFINITIONS: readonly FixtureDefinition[] = [
  {
    kind: "resource",
    reference: "fixtures/synthetic-wa-resource.geojson",
    text: resourceFixtureText,
  },
  {
    kind: "hard",
    reference: "fixtures/synthetic-wa-hard-exclusion.geojson",
    text: hardFixtureText,
  },
  {
    kind: "soft",
    reference: "fixtures/synthetic-wa-soft-constraint.geojson",
    text: softFixtureText,
  },
];

const encoder = new TextEncoder();
const MEAN_METRES_PER_DEGREE_LATITUDE = 111_320;
const INTERIOR_HOLE_SCANLINES = 128;
const INTERIOR_HOLE_REFINEMENT_STEPS = 8;
const SOURCE_FEATURE_MINIMUM_CAMERA_DISTANCE_METRES = 750;

let project: ProjectDocument | null = null;
let baseline: BaselinePresentation | null = null;
let baselineSessionRestricted = false;
let actionInFlight = false;
let fixtures: FixtureSet | null = null;
let analysisResults: AnalysisResult[] = [];
let selectedResultId: string | null = null;
let selectedCandidateId: string | null = null;
let draftVertices: LongitudeLatitude[] = [];
let drawing = false;
let lastExport: OpportunityExport | null = null;
let tribalContext: TribalPresentationContext | null = null;
let selectedNationId: string | null = null;
let interiorHoleInspections = new Map<string, InteriorHoleInspection>();

const tribalVisibility: Record<TribalVisibilityKey, boolean> = {
  border_context: true,
  federal_reservation_exterior: true,
  off_reservation_trust_land: true,
  tdsa_statistical_area: true,
  wa_state: true,
  wa_technical_buffer: true,
};

const projectName = requiredElement<HTMLElement>("project-name");
const scenarioName = requiredElement<HTMLElement>("scenario-name");
const analysisCrs = requiredElement<HTMLElement>("analysis-crs");
const governanceMode = requiredElement<HTMLElement>("governance-mode");
const layerCount = requiredElement<HTMLElement>("layer-count");
const layerList = requiredElement<HTMLElement>("layer-list");
const hardEnabled = requiredElement<HTMLInputElement>("hard-enabled");
const softEnabled = requiredElement<HTMLInputElement>("soft-enabled");
const runAnalysisButton = requiredElement<HTMLButtonElement>("run-analysis");
const exportButton = requiredElement<HTMLButtonElement>("export-geojson");
const startDrawingButton = requiredElement<HTMLButtonElement>("start-drawing");
const finishDrawingButton = requiredElement<HTMLButtonElement>("finish-drawing");
const cancelDrawingButton = requiredElement<HTMLButtonElement>("cancel-drawing");
const drawInstruction = requiredElement<HTMLElement>("draw-instruction");
const draftCount = requiredElement<HTMLElement>("draft-count");
const terrainEnabled = requiredElement<HTMLInputElement>("terrain-enabled");
const terrainChip = requiredElement<HTMLElement>("terrain-chip");
const analysisSummary = requiredElement<HTMLElement>("analysis-summary");
const analysisResultsContainer = requiredElement<HTMLElement>("analysis-results");
const reasonInspector = requiredElement<HTMLElement>("reason-inspector");
const reasonTitle = requiredElement<HTMLElement>("reason-title");
const reasonList = requiredElement<HTMLOListElement>("reason-list");
const candidateCount = requiredElement<HTMLElement>("candidate-count");
const candidateList = requiredElement<HTMLElement>("candidate-list");
const candidateEditor = requiredElement<HTMLFormElement>("candidate-editor");
const candidateNameInput = requiredElement<HTMLInputElement>("candidate-name");
const vertexEditor = requiredElement<HTMLElement>("vertex-editor");
const workflowStatus = requiredElement<HTMLElement>("workflow-status");
const workflowStatusText = requiredElement<HTMLElement>("workflow-status-text");
const roundTripReceipt = requiredElement<HTMLElement>("roundtrip-receipt");
const roundTripReceiptText = requiredElement<HTMLElement>("roundtrip-receipt-text");
const loadWaTribalContextButton = requiredElement<HTMLButtonElement>("load-wa-tribal-context");
const waContextSummary = requiredElement<HTMLElement>("wa-context-summary");
const tribalLegend = requiredElement<HTMLElement>("tribal-legend");
const technicalBufferDisclaimer = requiredElement<HTMLElement>("technical-buffer-disclaimer");
const coverageSummary = requiredElement<HTMLElement>("coverage-summary");
const coverageList = requiredElement<HTMLElement>("coverage-list");
const tribalInspector = requiredElement<HTMLElement>("tribal-inspector");
const tribalInspectorTitle = requiredElement<HTMLElement>("tribal-inspector-title");
const tribalInspectorDetails = requiredElement<HTMLElement>("tribal-inspector-details");
const waSourceAttribution = requiredElement<HTMLElement>("wa-source-attribution");
const waMapAttributionTitle = requiredElement<HTMLElement>("wa-map-attribution-title");
const waMapAttribution = requiredElement<HTMLElement>("wa-map-attribution");

const scene = new CesiumScene(requiredElement<HTMLElement>("cesium-container"), {
  onDrawVertex: handleDrawVertex,
});

export function startApplication(): void {
  startRstepPanel(scene);
  requiredElement<HTMLElement>("build-version").textContent = `${__APP_VERSION__} • ${__APP_COMMIT__}`;

  requiredElement<HTMLButtonElement>("new-project").addEventListener("click", () => {
    void performAction(clearWorkspace);
  });
  requiredElement<HTMLButtonElement>("load-fixtures").addEventListener("click", () => {
    void performAction(loadFreshProject);
  });
  loadWaTribalContextButton.addEventListener("click", () => {
    void performAction(loadWaTribalContext);
  });
  requiredElement<HTMLButtonElement>("open-dem-package").addEventListener("click", () => {
    void performAction(loadLocalDem);
  });
  requiredElement<HTMLButtonElement>("cancel-dem-load").addEventListener("click", () => {
    void window.geobase.cancelBaselineLoad();
  });
  requiredElement<HTMLButtonElement>("dem-coverage-view").addEventListener("click", () =>
    scene.focusBaselineCoverage(),
  );
  requiredElement<HTMLFormElement>("dem-probe-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void performAction(inspectDemCell);
  });
  requiredElement<HTMLButtonElement>("validate-error").addEventListener("click", () => {
    void demonstrateValidationError();
  });
  requiredElement<HTMLButtonElement>("open-project").addEventListener("click", () => {
    void performAction(openProject);
  });
  requiredElement<HTMLButtonElement>("save-project").addEventListener("click", () => {
    void performAction(saveProject);
  });
  exportButton.addEventListener("click", () => {
    void performAction(exportGeoJson);
  });
  requiredElement<HTMLButtonElement>("import-geojson").addEventListener("click", () => {
    void performAction(reimportGeoJson);
  });
  runAnalysisButton.addEventListener("click", () => {
    void performAction(runAnalysis);
  });
  hardEnabled.addEventListener("change", () => updateRuleSelection("hard", hardEnabled.checked));
  softEnabled.addEventListener("change", () => updateRuleSelection("soft", softEnabled.checked));
  for (const checkbox of tribalLegend.querySelectorAll<HTMLInputElement>("[data-tribal-visibility]")) {
    checkbox.addEventListener("change", () => {
      const key = checkbox.dataset.tribalVisibility;
      if (!isTribalVisibilityKey(key)) throw new Error(`unsupported Tribal visibility key ${String(key)}`);
      tribalVisibility[key] = checkbox.checked;
      renderMapLayers();
    });
  }
  terrainEnabled.addEventListener("change", updateTerrain);
  requiredElement<HTMLButtonElement>("reset-camera").addEventListener("click", () => scene.resetCamera());
  startDrawingButton.addEventListener("click", startDrawing);
  finishDrawingButton.addEventListener("click", () => {
    void performAction(finishDrawing);
  });
  cancelDrawingButton.addEventListener("click", cancelDrawing);
  candidateEditor.addEventListener("submit", (event) => {
    event.preventDefault();
    void performAction(renameSelectedCandidate);
  });
  requiredElement<HTMLButtonElement>("apply-vertices").addEventListener("click", () => {
    void performAction(applyVertexEdits);
  });
  requiredElement<HTMLButtonElement>("delete-candidate").addEventListener("click", () => {
    void performAction(deleteSelectedCandidate);
  });
  window.addEventListener("beforeunload", () => scene.destroy(), { once: true });

  renderWorkspace();
  document.body.dataset.appReady = "ready";
}

async function performAction(action: () => Promise<void> | void): Promise<void> {
  if (actionInFlight) return;
  actionInFlight = true;
  delete document.body.dataset.lastError;
  try {
    await action();
  } catch (error) {
    setStatus("error", `Error — ${messageFrom(error)}`);
    document.body.dataset.lastError = messageFrom(error);
  } finally {
    actionInFlight = false;
  }
}

async function loadLocalDem(): Promise<void> {
  setStatus(
    "loading",
    "Loading — select manifest.json from a local DEM package. Validating native values, masks, metadata and exact bytes…",
  );
  const cancel = requiredElement<HTMLButtonElement>("cancel-dem-load");
  cancel.hidden = false;
  try {
    const loadedFixtures = fixtures ?? (await loadFixtureSet());
    const baseProject = project ?? createFreshProjectDocument(loadedFixtures, new Date().toISOString());
    const result = await window.geobase.openBaselinePackage();
    if (result.canceled) {
      setStatus("empty", "DEM selection canceled — previous workspace retained.");
      return;
    }
    baselineSessionRestricted = true;
    let nextProject: ProjectDocument;
    const prepared = scene.prepareBaseline(result.baseline.display);
    try {
      nextProject = attachProjectBaseline(baseProject, result.baseline.binding, new Date().toISOString());
      await window.geobase.completePackageActivation(result.activationToken, serializeProject(nextProject));
    } catch (error) {
      prepared?.destroy();
      throw error;
    } finally {
      await window.geobase.discardPackageActivation(result.activationToken);
    }
    scene.commitPreparedBaseline(prepared);
    baseline = result.baseline;
    stopDrawing();
    project = nextProject;
    fixtures = loadedFixtures;
    lastExport = null;
    resetRoundTripReceipt();
    renderDemPanel(baseline);
    renderWorkspace();
    updateTerrainLabel();
    scene.resetCamera();
    setStatus(
      "success",
      `Success — ${baseline.manifest.kind} DEM ${baseline.manifest.edition} validated: ${result.verifiedBytes} bytes in ${(result.openingMilliseconds / 1000).toFixed(2)} s. Native values and source metadata are available; relative relief is a separate display.`,
    );
  } finally {
    cancel.hidden = true;
  }
}

async function inspectDemCell(): Promise<void> {
  if (baseline === null) throw new Error("Open a DEM package before inspecting native values.");
  const output = requiredElement<HTMLElement>("dem-probe-result");
  const rowInput = requiredElement<HTMLInputElement>("dem-probe-row");
  const columnInput = requiredElement<HTMLInputElement>("dem-probe-column");
  const row = rowInput.valueAsNumber;
  const column = columnInput.valueAsNumber;
  if (!Number.isSafeInteger(row) || !Number.isSafeInteger(column))
    throw new Error("Native row and column must be integers.");
  output.dataset.pending = "true";
  try {
    renderDemProbe(await window.geobase.probeBaseline({ row, column }));
  } finally {
    output.dataset.pending = "false";
  }
}

async function loadFreshProject(): Promise<void> {
  setStatus("loading", "Loading — validating bundled synthetic GeoJSON bytes and CRS metadata…");
  await yieldForVisibleState();
  const loaded = await loadFixtureSet();
  const createdAt = new Date().toISOString();
  const freshProject = createFreshProjectDocument(loaded, createdAt);
  await window.geobase.releaseBaselinePackage();
  project = freshProject;
  baseline = null;
  scene.setBaseline(null);
  renderDemPanel(null);
  updateTerrainLabel();
  fixtures = loaded;
  tribalContext = null;
  interiorHoleInspections = new Map();
  selectedNationId = null;
  analysisResults = [];
  selectedResultId = null;
  selectedCandidateId = null;
  lastExport = null;
  resetContextReceipts();
  resetRoundTripReceipt();
  renderWorkspace();
  setStatus(
    "success",
    "Success — 3 bundled synthetic layers passed the real GeoJSON, CRS, geometry, metadata, and hash adapter.",
  );
}

function createFreshProjectDocument(loaded: FixtureSet, createdAt: string): ProjectDocument {
  const scenario = createSyntheticScenario(loaded);
  return createProject({
    activeScenarioId: scenario.id,
    applicationCommit: __APP_COMMIT__,
    applicationVersion: __APP_VERSION__,
    createdAt,
    layers: FIXTURE_DEFINITIONS.map((definition) => {
      const imported = layerForKind(loaded, definition.kind);
      return createProjectLayerReference(imported, definition.reference);
    }),
    name: "Synthetic WA-region siting workspace",
    projectId: "synthetic-wa-workspace",
    scenarios: [scenario],
  });
}

async function loadWaTribalContext(): Promise<void> {
  setStatus(
    "loading",
    "Loading — select the local derived WA / Tribal GeoPackage for exact-byte, custody, CRS, AOI, and 29-Nation validation…",
  );
  await yieldForVisibleState();
  const result = await window.geobase.openWaTribalContext();
  if (result.canceled) {
    setStatus("empty", "WA / Tribal context open canceled — workspace was not changed.");
    return;
  }
  if (result.context.artifact_sha256 !== result.exactBytesSha256) {
    throw new Error("validated context artifact SHA-256 does not match the exact selected package bytes");
  }

  const loadedFixtures = fixtures ?? (await loadFixtureSet());
  const baseProject = project ?? createFreshProjectDocument(loadedFixtures, new Date().toISOString());
  const binding = createProjectWaTribalContextBinding(result.context);
  const updatedProject = attachProjectWaTribalContext(baseProject, binding, new Date().toISOString());
  const nextInteriorHoleInspections = buildInteriorHoleInspections(result.context);

  project = updatedProject;
  fixtures = loadedFixtures;
  tribalContext = result.context;
  interiorHoleInspections = nextInteriorHoleInspections;
  selectedNationId = result.context.coverage[0]?.nation_id ?? null;
  lastExport = null;
  resetRoundTripReceipt();
  resetContextReceipts();
  document.body.dataset.waContext = "verified";
  document.body.dataset.waContextExactBytes = "verified";
  document.body.dataset.waCoverage = "verified";
  document.body.dataset.waContextFeatures = String(result.context.features.length);
  document.body.dataset.waContextNations = String(result.context.coverage.length);
  document.body.dataset.waContextBytes = String(result.bytesRead);
  renderWorkspace();
  scene.focusWashingtonContext();
  setStatus(
    "success",
    `Success — validated ${result.bytesRead} exact local GeoPackage bytes, ${result.context.features.length} whole source features, and all ${result.context.coverage.length} Nation coverage rows. T3 context remains local and export-blocked.`,
  );
}

async function loadFixtureSet(): Promise<FixtureSet> {
  const imported = await Promise.all(
    FIXTURE_DEFINITIONS.map(async (definition) => ({
      definition,
      layer: await importAtniGeoJson(encoder.encode(definition.text)),
    })),
  );
  const resource = requireImportedRole(imported, "resource", "resource");
  const hard = requireImportedRole(imported, "hard", "hard_exclusion");
  const soft = requireImportedRole(imported, "soft", "soft_constraint");
  return { all: [resource, hard, soft], hard, resource, soft };
}

function requireImportedRole(
  imported: readonly { definition: FixtureDefinition; layer: ImportedGeoJsonLayer }[],
  kind: FixtureDefinition["kind"],
  role: ImportedGeoJsonLayer["metadata"]["layer"]["role"],
): ImportedGeoJsonLayer {
  const match = imported.find((entry) => entry.definition.kind === kind)?.layer;
  if (match === undefined) throw new Error(`bundled ${kind} fixture did not load`);
  if (match.metadata.layer.role !== role) {
    throw new Error(`bundled ${kind} fixture has role ${match.metadata.layer.role}, expected ${role}`);
  }
  return match;
}

function createSyntheticScenario(loaded: FixtureSet): Scenario {
  return {
    hard_exclusions: [
      {
        description: "Synthetic hard exclusion intersection",
        enabled: true,
        layer_id: loaded.hard.metadata.layer.id,
        rule_id: "synthetic-hard-intersection",
      },
    ],
    id: "synthetic-baseline",
    name: "Synthetic baseline",
    resource_layer_id: loaded.resource.metadata.layer.id,
    resource_value_property: "resource_value",
    soft_constraints: [
      {
        description: "Synthetic 50 percent soft penalty",
        enabled: true,
        layer_id: loaded.soft.metadata.layer.id,
        penalty_fraction: 0.5,
        rule_id: "synthetic-soft-penalty",
      },
    ],
  };
}

async function demonstrateValidationError(): Promise<void> {
  setStatus("loading", "Loading — sending a deliberately missing-CRS sample through the real adapter…");
  await yieldForVisibleState();
  const malformed = JSON.parse(resourceFixtureText) as {
    atni_geobase: { coordinate_reference_system: unknown };
  };
  malformed.atni_geobase.coordinate_reference_system = null;
  try {
    await importAtniGeoJson(encoder.encode(JSON.stringify(malformed)));
    throw new Error("missing-CRS sample was unexpectedly accepted");
  } catch (error) {
    const code = "code" in Object(error) ? String((error as { code?: unknown }).code) : "ERROR";
    if (code !== "CRS_MISSING") throw error;
    document.body.dataset.validationError = code;
    setStatus(
      "error",
      `Error — ${code}: authoritative CRS is absent. The adapter rejected the artifact; no fallback was assumed.`,
    );
  }
}

function updateRuleSelection(kind: "hard" | "soft", enabled: boolean): void {
  if (project === null) return;
  const active = activeScenario(project);
  const changed: Scenario = {
    ...active,
    hard_exclusions:
      kind === "hard" ? active.hard_exclusions.map((rule) => ({ ...rule, enabled })) : active.hard_exclusions,
    soft_constraints:
      kind === "soft"
        ? active.soft_constraints.map((rule) => ({ ...rule, enabled }))
        : active.soft_constraints,
  };
  project = validateProjectUpdate({
    ...project,
    scenarios: project.scenarios.map((scenario) => (scenario.id === changed.id ? changed : scenario)),
    updated_at: new Date().toISOString(),
  });
  analysisResults = [];
  selectedResultId = null;
  lastExport = null;
  resetRoundTripReceipt();
  renderWorkspace();
  setStatus(
    "success",
    `${kind === "hard" ? "Hard exclusion" : "Soft penalty"} ${enabled ? "selected" : "not selected"}; analysis is stale and must be run again.`,
  );
}

async function runAnalysis(): Promise<void> {
  if (project === null || fixtures === null) throw new Error("load the bundled layers first");
  setStatus("loading", "Loading — running deterministic geometry intersections and reason tracing…");
  await yieldForVisibleState();
  analysisResults = analyzeScenario({
    constraintLayers: fixtures.all,
    resourceLayer: fixtures.resource,
    scenario: activeScenario(project),
  });
  selectedResultId = analysisResults[0]?.feature_id ?? null;
  lastExport = null;
  resetRoundTripReceipt();
  renderWorkspace();
  const states = new Set(analysisResults.map((result) => result.state));
  document.body.dataset.analysisStates = [...states].sort().join(",");
  setStatus(
    "success",
    `Success — analyzed ${analysisResults.length} cells with a complete trace for every configured rule.`,
  );
}

function startDrawing(): void {
  if (project === null) {
    setStatus("error", "Error — load a project before drawing a candidate.");
    return;
  }
  drawing = true;
  draftVertices = [];
  scene.setDraftVertices(draftVertices);
  scene.setDrawingEnabled(true);
  renderDrawingState();
  setStatus("success", "Drawing — globe navigation is paused while Cesium converts clicks to coordinates.");
}

function handleDrawVertex(coordinate: LongitudeLatitude): void {
  if (!drawing) return;
  draftVertices = [...draftVertices, coordinate];
  scene.setDraftVertices(draftVertices);
  renderDrawingState();
  document.body.dataset.draftVertices = String(draftVertices.length);
}

function finishDrawing(): void {
  if (project === null || draftVertices.length < 3) return;
  const timestamp = new Date().toISOString();
  const id = nextCandidateId(project);
  const first = draftVertices[0];
  if (first === undefined) return;
  const ring: Position[] = [...draftVertices.map(([x, y]) => [x, y]), [...first]];
  project = createCandidate(project, {
    coordinateReferenceSystem: "EPSG:4326",
    createdAt: timestamp,
    geometry: { coordinates: [ring], type: "Polygon" },
    id,
    name: `Candidate ${project.candidates.length + 1}`,
    properties: {
      input_method: "cesium_globe_click",
      scientific_status: "user-authored geometry; not a suitability determination",
      synthetic_context: true,
    },
    scenarioId: project.active_scenario_id,
  });
  selectedCandidateId = id;
  stopDrawing();
  renderWorkspace();
  setStatus(
    "success",
    `Success — ${draftVertices.length} Cesium globe picks created candidate ${id} in EPSG:4326.`,
  );
}

function cancelDrawing(): void {
  stopDrawing();
  renderDrawingState();
  setStatus("success", "Drawing canceled — canonical project state was not changed.");
}

function stopDrawing(): void {
  drawing = false;
  draftVertices = [];
  scene.setDraftVertices([]);
  scene.setDrawingEnabled(false);
  document.body.dataset.draftVertices = "0";
}

function renderDrawingState(): void {
  startDrawingButton.disabled = project === null || drawing || baseline !== null;
  startDrawingButton.title =
    baseline === null ? "" : "Candidate globe picking is unavailable in the local DEM relief view.";
  finishDrawingButton.disabled = !drawing || draftVertices.length < 3;
  cancelDrawingButton.disabled = !drawing;
  drawInstruction.hidden = !drawing;
  draftCount.textContent = `${draftVertices.length} ${draftVertices.length === 1 ? "vertex" : "vertices"}`;
}

function renameSelectedCandidate(): void {
  if (project === null || selectedCandidateId === null) return;
  project = renameCandidate(
    project,
    selectedCandidateId,
    candidateNameInput.value.trim(),
    new Date().toISOString(),
  );
  renderCandidates();
  setStatus("success", `Success — renamed ${selectedCandidateId}; canonical project state updated.`);
}

function applyVertexEdits(): void {
  if (project === null || selectedCandidateId === null) return;
  const candidate = selectedCandidate(project);
  if (candidate === null || candidate.geometry.type !== "Polygon") {
    throw new Error("numeric editor currently supports Polygon candidates only");
  }
  const rows = [...vertexEditor.querySelectorAll<HTMLElement>(".vertex-row")];
  const coordinates: Position[] = rows.map((row, index) => {
    const longitude = Number(requiredDescendant<HTMLInputElement>(row, '[data-axis="longitude"]').value);
    const latitude = Number(requiredDescendant<HTMLInputElement>(row, '[data-axis="latitude"]').value);
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      throw new Error(`vertex ${index + 1} longitude must be from -180 through 180`);
    }
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      throw new Error(`vertex ${index + 1} latitude must be from -90 through 90`);
    }
    return [longitude, latitude];
  });
  if (coordinates.length < 3) throw new Error("a candidate requires at least three vertices");
  const first = coordinates[0];
  if (first === undefined) throw new Error("a candidate requires a first vertex");
  const geometry: Polygon = { coordinates: [[...coordinates, [...first]]], type: "Polygon" };
  project = editCandidateGeometry(project, selectedCandidateId, geometry, new Date().toISOString());
  renderCandidates();
  setStatus(
    "success",
    `Success — applied ${coordinates.length} numeric EPSG:4326 vertex edits to ${selectedCandidateId}.`,
  );
}

function deleteSelectedCandidate(): void {
  if (project === null || selectedCandidateId === null) return;
  const deletedId = selectedCandidateId;
  project = deleteCandidate(project, deletedId, new Date().toISOString());
  selectedCandidateId = project.candidates[0]?.id ?? null;
  renderCandidates();
  setStatus("success", `Success — deleted ${deletedId} from canonical project state.`);
}

async function saveProject(): Promise<void> {
  if (project === null) throw new Error("load or open a project before saving");
  setStatus("loading", "Loading — validating and serializing the project for an explicit local save…");
  await yieldForVisibleState();
  const serialized = serializeProject(project);
  const result = await window.geobase.saveProject(
    serialized,
    baseline === null ? "synthetic-wa.atnigeobase.json" : `${baseline.manifest.package_id}.atnigeobase.json`,
  );
  if (result.canceled) {
    setStatus("empty", "Save canceled — no file was written.");
    return;
  }
  document.body.dataset.projectSaved = "true";
  document.body.dataset.projectSavedBytes = String(result.bytesWritten);
  setStatus(
    "success",
    `Success — project saved explicitly (${result.bytesWritten} UTF-8 bytes); governance bypass state is embedded.`,
  );
}

async function openProject(): Promise<void> {
  setStatus("loading", "Loading — waiting for a user-selected local project…");
  await yieldForVisibleState();
  const result = await window.geobase.openProject();
  if (result.canceled) {
    setStatus("empty", "Open canceled — workspace was not changed.");
    return;
  }
  try {
    await verifySelectedTextBytes(result.contents, result.exactBytesSha256, "project");
    const parsed = parseProject(result.contents);
    if (serializeProject(parsed) !== result.contents) {
      throw new Error("project bytes are valid but not canonical deterministic serialization");
    }
    const loaded = await loadFixtureSet();
    verifyBundledLayerReferences(parsed, loaded);
    const reopenedBaseline = result.baseline ?? null;
    if (
      parsed.baseline_context !== undefined &&
      (reopenedBaseline === null || !verifyBaselineBinding(parsed.baseline_context, reopenedBaseline.binding))
    ) {
      throw new Error("Exact-edition DEM project binding was not verified. Previous workspace retained.");
    }
    let reopenedTribalContext: TribalPresentationContext | null = null;
    if (parsed.wa_tribal_context !== null) {
      setStatus(
        "loading",
        "Loading — project binding found; select the WA / Tribal GeoPackage again for fresh exact-byte and custody verification…",
      );
      await yieldForVisibleState();
      const contextResult = await window.geobase.openWaTribalContext(result.activationToken);
      if (contextResult.canceled) {
        setStatus(
          "empty",
          "Context selection canceled — the existing workspace was not changed and the project was not reopened.",
        );
        return;
      }
      if (contextResult.context.artifact_sha256 !== contextResult.exactBytesSha256) {
        throw new Error("fresh context artifact SHA-256 does not match the exact selected package bytes");
      }
      const verification = verifyProjectWaTribalContextBinding(
        parsed.wa_tribal_context,
        contextResult.context,
      );
      if (!verification.verified) {
        throw new Error(
          `fresh WA / Tribal context failed project binding: ${verification.mismatches
            .map((mismatch) => `${mismatch.field}: ${mismatch.message}`)
            .join("; ")}`,
        );
      }
      reopenedTribalContext = contextResult.context;
    }
    const nextInteriorHoleInspections =
      reopenedTribalContext === null ? new Map() : buildInteriorHoleInspections(reopenedTribalContext);
    const nextAnalysisResults = analyzeScenario({
      constraintLayers: loaded.all,
      resourceLayer: loaded.resource,
      scenario: activeScenario(parsed),
    });
    const prepared = scene.prepareBaseline(reopenedBaseline?.display ?? null);
    try {
      await window.geobase.completePackageActivation(result.activationToken, result.contents);
    } catch (error) {
      prepared?.destroy();
      throw error;
    }
    scene.commitPreparedBaseline(prepared);
    baseline = reopenedBaseline;
    if (baseline !== null) stopDrawing();
    if (baseline !== null) baselineSessionRestricted = true;
    renderDemPanel(baseline);
    updateTerrainLabel();
    project = parsed;
    fixtures = loaded;
    tribalContext = reopenedTribalContext;
    interiorHoleInspections = nextInteriorHoleInspections;
    analysisResults = nextAnalysisResults;
    selectedResultId = analysisResults[0]?.feature_id ?? null;
    selectedCandidateId = parsed.candidates[0]?.id ?? null;
    selectedNationId = reopenedTribalContext?.coverage[0]?.nation_id ?? null;
    lastExport = null;
    resetRoundTripReceipt();
    resetContextReceipts();
    if (reopenedTribalContext !== null) {
      document.body.dataset.waContext = "verified";
      document.body.dataset.waContextReopen = "verified";
      document.body.dataset.waContextExactBytes = "verified";
      document.body.dataset.waCoverage = "verified";
      document.body.dataset.waContextFeatures = String(reopenedTribalContext.features.length);
      document.body.dataset.waContextNations = String(reopenedTribalContext.coverage.length);
    }
    renderWorkspace();
    if (reopenedTribalContext !== null) scene.focusWashingtonContext();
    if (baseline !== null) scene.resetCamera();
    document.body.dataset.projectReopen = "verified";
    document.body.dataset.projectExactBytes = "verified";
    setStatus(
      "success",
      `Success — reopened ${result.bytesRead} exact selected, canonical project bytes; all 3 bundled layer references${reopenedTribalContext === null ? "" : ", the fresh WA / Tribal package binding,"} and development-bypass facts matched. Analysis was deterministically recomputed.`,
    );
  } finally {
    await window.geobase.discardPackageActivation(result.activationToken);
  }
}

function verifyBundledLayerReferences(opened: ProjectDocument, loaded: FixtureSet): void {
  if (opened.layers.length !== FIXTURE_DEFINITIONS.length) {
    throw new Error("this development slice reopens exactly the three bundled synthetic layers");
  }
  for (const definition of FIXTURE_DEFINITIONS) {
    const imported = layerForKind(loaded, definition.kind);
    const reference = opened.layers.find((layer) => layer.artifact_reference === definition.reference);
    if (reference === undefined) {
      throw new Error(`project does not reference supported bundled layer ${definition.reference}`);
    }
    const verification = verifyProjectLayerReference(reference, imported, definition.reference);
    if (!verification.verified) {
      const details = verification.mismatches
        .map((mismatch) => `${mismatch.field}: ${mismatch.message}`)
        .join("; ");
      throw new Error(`bundled layer reference failed verification for ${definition.reference}: ${details}`);
    }
  }
}

async function exportGeoJson(): Promise<void> {
  if (baselineSessionRestricted)
    throw new Error("The local DEM T3 session forbids export before serialization.");
  if (project === null || fixtures === null || analysisResults.length === 0) {
    throw new Error("run analysis before exporting all analysis-result polygons");
  }
  if (tribalContext !== null && !contextExportAllowed(tribalContext)) {
    throw new Error(
      `export blocked by artifact-loaded ${tribalContext.custody.classification.effective_tier_id} behavior; the WA / Tribal context and a project bound to it remain local only`,
    );
  }
  const currentFixtures = fixtures;
  setStatus("loading", "Loading — binding results, reasons, provenance, scenario, CRS, and bypass state…");
  await yieldForVisibleState();
  const generated = await exportOpportunityGeoJson({
    features: analysisResults.map((result) =>
      analysisResultToOpportunityFeature(
        result,
        currentFixtures.resource.metadata.coordinate_reference_system,
      ),
    ),
    generatedAt: new Date().toISOString(),
    generatedBy: {
      applicationCommit: __APP_COMMIT__,
      applicationVersion: __APP_VERSION__,
    },
    project,
    scenarioId: project.active_scenario_id,
  });
  const result = await window.geobase.exportGeoJson(
    generated.text,
    "synthetic-wa-opportunity.geobase-export.geojson",
  );
  if (result.canceled) {
    setStatus("empty", "Export canceled — no file was written.");
    return;
  }
  lastExport = generated;
  roundTripReceipt.dataset.state = "not-run";
  roundTripReceiptText.textContent =
    "Export written; choose Re-import GeoJSON to verify actual selected-file bytes.";
  document.body.dataset.geojsonExported = "true";
  setStatus(
    "success",
    `Success — exported all ${analysisResults.length} analysis-result polygons (${result.bytesWritten} bytes, SHA-256 ${generated.sha256.slice(0, 12)}…). Re-import is still required.`,
  );
}

async function reimportGeoJson(): Promise<void> {
  if (lastExport === null) throw new Error("export this analysis before round-trip verification");
  setStatus("loading", "Loading — re-importing user-selected GeoJSON bytes for an independent comparison…");
  await yieldForVisibleState();
  const selected = await window.geobase.importGeoJson();
  if (selected.canceled) {
    setStatus("empty", "Re-import canceled — no round-trip claim was made.");
    return;
  }
  await verifySelectedTextBytes(selected.contents, selected.exactBytesSha256, "GeoJSON");
  const imported = await importOpportunityGeoJson(encoder.encode(selected.contents));
  if (imported.exact_bytes_sha256 !== selected.exactBytesSha256) {
    throw new Error("GeoJSON adapter digest does not match the exact selected-byte SHA-256");
  }
  if (selected.exactBytesSha256 !== lastExport.sha256) {
    throw new Error("selected GeoJSON bytes are not byte-for-byte identical to the generated export");
  }
  if (
    imported.binding.generated_by.application_version !== __APP_VERSION__ ||
    imported.binding.generated_by.application_commit !== __APP_COMMIT__
  ) {
    throw new Error("selected GeoJSON generated-by identity does not match this application build");
  }
  const comparison = compareOpportunityRoundTrip(lastExport.document, imported);
  if (!comparison.equivalent) {
    roundTripReceipt.dataset.state = "error";
    roundTripReceiptText.textContent = comparison.mismatches
      .map((mismatch) => `${mismatch.kind}: ${mismatch.message}`)
      .join("; ");
    throw new Error("GeoJSON round-trip comparison found material mismatches");
  }
  roundTripReceipt.dataset.state = "verified";
  roundTripReceiptText.textContent =
    "All behavior-bearing comparison groups verified from the selected file: geometry, attributes, CRS/history, provenance custody and build identity, scenario linkage, and bypass facts are equivalent.";
  document.body.dataset.roundtrip = "verified";
  document.body.dataset.geojsonExactBytes = "verified";
  document.body.dataset.roundtripGeneratedBy = "verified";
  setStatus(
    "success",
    `Success — re-imported ${selected.bytesRead} exact selected bytes; generated-by identity and all behavior-bearing comparison groups are equivalent.`,
  );
}

async function clearWorkspace(): Promise<void> {
  await window.geobase.releaseBaselinePackage();
  stopDrawing();
  project = null;
  baseline = null;
  scene.setBaseline(null);
  renderDemPanel(null);
  updateTerrainLabel();
  fixtures = null;
  analysisResults = [];
  selectedResultId = null;
  selectedCandidateId = null;
  tribalContext = null;
  interiorHoleInspections = new Map();
  selectedNationId = null;
  lastExport = null;
  delete document.body.dataset.analysisStates;
  delete document.body.dataset.geojsonExactBytes;
  delete document.body.dataset.projectExactBytes;
  delete document.body.dataset.projectReopen;
  delete document.body.dataset.roundtripGeneratedBy;
  resetContextReceipts();
  resetRoundTripReceipt();
  renderWorkspace();
  setStatus(
    "empty",
    "Empty — project, layers, WA / Tribal context, results, and candidates were cleared from memory.",
  );
}

async function verifySelectedTextBytes(
  contents: string,
  exactBytesSha256: string,
  label: string,
): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(exactBytesSha256)) {
    throw new Error(`${label} exact selected-byte SHA-256 is malformed`);
  }
  const reencodedSha256 = await sha256Hex(encoder.encode(contents));
  if (reencodedSha256 !== exactBytesSha256) {
    throw new Error(`${label} text changed while crossing the selected-file IPC boundary`);
  }
}

function renderWorkspace(): void {
  const active = project === null ? null : activeScenario(project);
  projectName.textContent = project?.name ?? "Untitled synthetic workspace";
  scenarioName.textContent = active?.name ?? "Synthetic baseline";
  analysisCrs.textContent = "EPSG:4326 • topology-only";
  analysisCrs.title =
    "EPSG:4326 native coordinates; topology-only intersections; no metric area, distance, or buffer calculation";
  governanceMode.textContent = project?.governance.governance_mode ?? "development_bypass";
  hardEnabled.checked = active?.hard_exclusions[0]?.enabled ?? true;
  softEnabled.checked = active?.soft_constraints[0]?.enabled ?? true;
  hardEnabled.disabled = project === null;
  softEnabled.disabled = project === null;
  runAnalysisButton.disabled = project === null;
  startDrawingButton.disabled = project === null || drawing || baseline !== null;
  const currentTribalContext = tribalContext;
  const contextBlocksExport = currentTribalContext !== null && !contextExportAllowed(currentTribalContext);
  exportButton.disabled = analysisResults.length === 0 || contextBlocksExport || baselineSessionRestricted;
  exportButton.title = contextBlocksExport
    ? `${currentTribalContext?.custody.classification.effective_tier_id ?? "classified"} package behavior forbids export while this context is attached`
    : "";
  document.body.dataset.waContextExport = contextBlocksExport ? "blocked-by-artifact-tier" : "not-blocked";
  if (baselineSessionRestricted)
    exportButton.title = "A local DEM was opened. This T3 session remains local and export-blocked.";
  renderWaTribalContext();
  renderCoverageMatrix();
  renderLayers();
  renderResults();
  renderCandidates();
  renderDrawingState();
  renderMapLayers();
}

function renderLayers(): void {
  layerList.replaceChildren();
  if (fixtures === null) {
    layerList.append(
      emptyCard(
        "No layers loaded",
        "Load the three bundled fixtures to exercise the real CRS and GeoJSON adapter.",
      ),
    );
    layerCount.textContent = "0";
    return;
  }
  layerCount.textContent = String(fixtures.all.length);
  for (const imported of fixtures.all) layerList.append(createLayerCard(imported));
}

function createLayerCard(imported: ImportedGeoJsonLayer): HTMLElement {
  const metadata = imported.metadata.layer;
  const kind = layerDisplayKind(metadata.role);
  const card = createElement("article", "layer-card");
  card.dataset.kind = kind;
  const header = createElement("header");
  header.append(createElement("h3", undefined, metadata.name));
  header.append(createElement("span", "layer-status", "VALIDATED"));
  card.append(header);
  const details = createElement("dl");
  addDefinition(details, "Role", humanRole(metadata.role));
  addDefinition(details, "CRS", imported.metadata.coordinate_reference_system);
  addDefinition(details, "Units", `${metadata.units.quantity} — ${metadata.units.unit}`);
  addDefinition(
    details,
    "Resolution",
    `${metadata.native_resolution.description}${metadata.native_resolution.value === null ? "" : ` (${metadata.native_resolution.value} ${metadata.native_resolution.unit})`}`,
  );
  addDefinition(
    details,
    "Provenance",
    `${metadata.provenance.source_title}; ${metadata.provenance.source_organization}; ${metadata.provenance.license}`,
  );
  addDefinition(details, "Hash", `${imported.exact_bytes_sha256.slice(0, 16)}… exact source bytes`);
  addDefinition(details, "Uncertainty", metadata.uncertainty.description);
  addDefinition(details, "Absence", metadata.absence_semantics.missing);
  addDefinition(details, "Limitations", metadata.provenance.limitations.join(" "));
  card.append(details);
  return card;
}

function renderWaTribalContext(): void {
  for (const checkbox of tribalLegend.querySelectorAll<HTMLInputElement>("[data-tribal-visibility]")) {
    const key = checkbox.dataset.tribalVisibility;
    if (!isTribalVisibilityKey(key)) throw new Error(`unsupported Tribal visibility key ${String(key)}`);
    checkbox.disabled = tribalContext === null;
    checkbox.checked = tribalVisibility[key];
  }

  if (tribalContext === null) {
    waContextSummary.textContent = "Not loaded";
    technicalBufferDisclaimer.textContent =
      "No WA / Tribal package loaded. The technical overflow is never a legal boundary.";
    waSourceAttribution.textContent =
      "Source custody, vintage, attribution, limitations, and classification will appear after local validation.";
    waMapAttributionTitle.hidden = true;
    waMapAttribution.hidden = true;
    return;
  }

  const categoryCounts = countTribalFeatures(tribalContext.features);
  const borderCount = tribalContext.features.filter(
    (feature) => feature.registry_scope === "border_context",
  ).length;
  const validatorConflicts = tribalContext.features.filter(
    (feature) => feature.validity.disposition === "validator_conflict_retained_unmodified",
  ).length;
  waContextSummary.textContent = `${tribalContext.coverage.length} Nations · ${tribalContext.features.length} whole features`;
  technicalBufferDisclaimer.textContent = `${tribalContext.aoi.disclaimer} Independent geodesic audit: maximum absolute deviation ${tribalContext.aoi.independent_geodesic_audit?.max_absolute_deviation_metres.toFixed(3) ?? "unknown"} m against a ${tribalContext.aoi.independent_geodesic_audit?.tolerance_metres.toFixed(1) ?? "unknown"} m tolerance.`;

  waSourceAttribution.replaceChildren();
  waSourceAttribution.append(
    createElement(
      "strong",
      undefined,
      `${tribalContext.custody.classification.effective_tier_id} · ${tribalContext.artifact_reference}`,
    ),
    createElement(
      "span",
      undefined,
      `Exact package SHA-256 ${tribalContext.artifact_sha256}. ${categoryCounts.federal_reservation_exterior ?? 0} reservation, ${categoryCounts.off_reservation_trust_land ?? 0} trust-land, and ${categoryCounts.tdsa_statistical_area ?? 0} TDSA features; ${borderCount} of those features are border context outside the GOIA 29 denominator.`,
    ),
    createElement(
      "span",
      undefined,
      `${validatorConflicts} source geometries have a documented Turf/GEOS validator conflict and remain byte-for-byte unmodified.`,
    ),
  );
  for (const receipt of tribalContext.custody.source_receipts) {
    waSourceAttribution.append(
      createElement(
        "span",
        undefined,
        `${receipt.publisher}: ${receipt.source_title}; vintage ${receipt.vintage ?? "unknown"}; as of ${receipt.as_of ?? "unknown"}; ${receipt.license}.`,
      ),
    );
  }
  waSourceAttribution.append(
    createElement("span", undefined, `Attribution: ${tribalContext.custody.attribution.join(" ")}`),
    createElement("span", undefined, `Limitations: ${tribalContext.custody.limitations.join(" ")}`),
    createElement(
      "span",
      undefined,
      `Stewardship: ${tribalContext.custody.stewardship.note} Consent: ${tribalContext.custody.consent.status} — ${tribalContext.custody.consent.note}`,
    ),
  );

  waMapAttributionTitle.hidden = false;
  waMapAttribution.hidden = false;
  waMapAttribution.textContent = `2025 U.S. Census source geometry · ${tribalContext.features.length} whole features · ${tribalContext.custody.classification.effective_tier_id} local-only · ${validatorConflicts} validator conflicts retained unmodified. The 100 m overflow is technical, not legal.`;
  document.body.dataset.waReservations = String(categoryCounts.federal_reservation_exterior ?? 0);
  document.body.dataset.waTrustLands = String(categoryCounts.off_reservation_trust_land ?? 0);
  document.body.dataset.waTdsa = String(categoryCounts.tdsa_statistical_area ?? 0);
  document.body.dataset.waBorderContext = String(borderCount);
  document.body.dataset.waValidatorConflicts = String(validatorConflicts);
}

function renderCoverageMatrix(): void {
  coverageList.replaceChildren();
  if (tribalContext === null) {
    coverageSummary.textContent = "Not loaded";
    coverageList.append(
      emptyCard(
        "No coverage matrix",
        "Open the validated local WA / Tribal package to inspect all 29 Nations.",
      ),
    );
    tribalInspectorTitle.textContent = "Nothing selected";
    tribalInspectorDetails.replaceChildren(
      createElement(
        "p",
        undefined,
        "Select a Nation to inspect each distinct component and its explicit status.",
      ),
    );
    return;
  }

  if (!tribalContext.coverage.some((row) => row.nation_id === selectedNationId)) {
    selectedNationId = tribalContext.coverage[0]?.nation_id ?? null;
  }
  const registryById = new Map(tribalContext.registry.map((record) => [record.nation_id, record]));
  const summaryCounts = new Map<NationCoverageRow["summary"], number>();
  for (const row of tribalContext.coverage) {
    summaryCounts.set(row.summary, (summaryCounts.get(row.summary) ?? 0) + 1);
    const registry = registryById.get(row.nation_id);
    if (registry === undefined) throw new Error(`coverage Nation ${row.nation_id} is missing from registry`);
    const button = createElement("button", "coverage-button");
    button.type = "button";
    button.dataset.nationId = row.nation_id;
    button.dataset.summary = row.summary;
    button.dataset.reservationFeatures = String(coverageFeatureCount(row, "federal_reservation_exterior"));
    button.dataset.trustFeatures = String(coverageFeatureCount(row, "off_reservation_trust_land"));
    button.dataset.tdsaFeatures = String(coverageFeatureCount(row, "tdsa_statistical_area"));
    button.dataset.hasInteriorHole = String(interiorHoleInspections.has(row.nation_id));
    button.setAttribute("aria-pressed", String(row.nation_id === selectedNationId));
    button.append(
      createElement("span", "coverage-name", registry.formal_name ?? registry.goia_name),
      createElement("span", "coverage-status", humanCoverageSummary(row.summary)),
    );
    button.addEventListener("click", () => selectNationCoverage(row.nation_id));
    coverageList.append(button);
  }
  coverageSummary.textContent = `${tribalContext.coverage.length} / 29 explicit · ${[
    ...summaryCounts.entries(),
  ]
    .map(([summary, count]) => `${humanCoverageSummary(summary)} ${count}`)
    .join(" · ")}`;
  renderTribalInspector(registryById);
}

function selectNationCoverage(nationId: string): void {
  selectedNationId = nationId;
  renderCoverageMatrix();
  focusNationCoverage(nationId);
  tribalInspector.focus();
}

function coverageFeatureCount(row: NationCoverageRow, category: TribalGeometryCategory): number {
  return row.components.find((component) => component.category === category)?.feature_references.length ?? 0;
}

function focusNationCoverage(nationId: string): void {
  if (tribalContext === null) return;
  const features = tribalContext.features.filter((feature) => feature.nation_id === nationId);
  focusTribalFeatures(features);
}

function focusTribalFeatures(
  features: readonly TribalPresentationFeature[],
  minimumCameraDistanceMetres?: number,
): void {
  if (features.length === 0) return;
  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  for (const feature of features) {
    for (const part of polygonDisplayParts(feature.geometry)) {
      for (const ring of part.rings) {
        for (const [longitude, latitude] of ring) {
          west = Math.min(west, longitude);
          south = Math.min(south, latitude);
          east = Math.max(east, longitude);
          north = Math.max(north, latitude);
        }
      }
    }
  }
  if ([west, south, east, north].every(Number.isFinite)) {
    scene.focusLongitudeLatitudeBounds([west, south, east, north], minimumCameraDistanceMetres);
  }
}

function renderTribalInspector(registryById?: ReadonlyMap<string, NationRegistryRecord>): void {
  if (tribalContext === null || selectedNationId === null) return;
  const registryMap =
    registryById ?? new Map(tribalContext.registry.map((record) => [record.nation_id, record]));
  const record = registryMap.get(selectedNationId);
  const row = tribalContext.coverage.find((entry) => entry.nation_id === selectedNationId);
  if (record === undefined || row === undefined) {
    throw new Error(`selected Nation ${selectedNationId} is missing from the validated context`);
  }

  tribalInspectorTitle.textContent = record.formal_name ?? record.goia_name;
  tribalInspectorDetails.className = "tribal-inspector-details";
  tribalInspectorDetails.replaceChildren();
  const identity = createElement("dl");
  addDefinition(identity, "GOIA label", record.goia_name);
  addDefinition(identity, "Coverage", humanCoverageSummary(row.summary));
  addDefinition(identity, "Review", `${record.review.status.replaceAll("_", " ")} — ${record.review.note}`);
  tribalInspectorDetails.append(identity);

  if (row.summary === "statistical_only") {
    tribalInspectorDetails.append(
      createElement(
        "p",
        "statistical-warning",
        "Statistical only — the Samish TDSA is a Census statistical geography, not legal land, ownership, jurisdiction, reservation, trust land, or a complete land base.",
      ),
    );
  }

  const componentList = createElement("dl");
  for (const component of row.components) {
    addDefinition(
      componentList,
      humanTribalCategory(component.category),
      `${component.status.replaceAll("_", " ")} · ${component.note}${
        component.feature_references.length === 0
          ? ""
          : ` · ${component.feature_references.length} exact source feature${component.feature_references.length === 1 ? "" : "s"}`
      }`,
    );
  }
  tribalInspectorDetails.append(componentList);

  const nationFeatures = tribalContext.features.filter((feature) => feature.nation_id === selectedNationId);
  const conflicts = nationFeatures.filter(
    (feature) => feature.validity.disposition === "validator_conflict_retained_unmodified",
  );
  if (conflicts.length > 0) {
    tribalInspectorDetails.append(
      createElement(
        "p",
        "gap-warning",
        `${conflicts.length} feature${conflicts.length === 1 ? " has" : "s have"} a pinned Turf/GEOS validity disagreement. Exact official source geometry is retained without repair or omission.`,
      ),
    );
  }

  if (nationFeatures.length > 0) {
    tribalInspectorDetails.append(
      createElement(
        "p",
        "source-feature-note",
        "Inspect one complete Census source feature at a time. The action isolates its typed category for presentation evidence; it does not imply ownership, jurisdiction, or a complete land base.",
      ),
    );
    const featureList = createElement("div", "source-feature-list");
    for (const feature of [...nationFeatures].sort((left, right) =>
      left.source_feature_id < right.source_feature_id
        ? -1
        : left.source_feature_id > right.source_feature_id
          ? 1
          : 0,
    )) {
      const action = createElement(
        "button",
        "button-subtle source-feature-action",
        `${feature.source_feature_id} · ${humanTribalCategory(feature.category)} · ${feature.source_name}`,
      );
      action.type = "button";
      action.dataset.inspectSourceFeature = feature.source_feature_id;
      action.dataset.targetCategory = feature.category;
      action.addEventListener("click", () => inspectSourceFeature(feature));
      featureList.append(action);
    }
    tribalInspectorDetails.append(featureList);
  }

  const interiorHoleInspection = interiorHoleInspections.get(selectedNationId);
  if (interiorHoleInspection !== undefined) {
    const explanation = createElement(
      "p",
      "interior-hole-note",
      "A validated source polygon for this Nation contains an interior ring. The inspection action isolates its category, disables synthetic terrain, and centers one robust interior point for a visible render check. It does not claim that every interior ring was inspected.",
    );
    const action = createElement("button", "button-subtle interior-hole-action");
    action.type = "button";
    action.dataset.inspectInteriorHole = "true";
    action.dataset.targetCategory = interiorHoleInspection.category;
    action.textContent = "Inspect representative interior hole";
    action.addEventListener("click", () => inspectInteriorHole(interiorHoleInspection));
    tribalInspectorDetails.append(explanation, action);
  }
}

function inspectInteriorHole(inspection: InteriorHoleInspection): void {
  for (const key of Object.keys(tribalVisibility) as TribalVisibilityKey[]) {
    tribalVisibility[key] = key === inspection.category;
  }
  terrainEnabled.checked = false;
  scene.setTerrainEnabled(false);
  terrainChip.textContent = "Terrain off • WGS84 ellipsoid";
  document.body.dataset.terrain = "off";
  document.body.dataset.interiorHoleInspection = "ready";
  document.body.dataset.interiorHoleCategory = inspection.category;
  renderWorkspace();
  scene.focusLongitudeLatitudePoint(inspection.coordinate, inspection.clearance_metres);
  setStatus(
    "success",
    `Success — isolated ${humanTribalCategory(inspection.category).toLowerCase()} and centered a robust point inside one validated source interior ring. This is a representative render check only.`,
  );
}

function inspectSourceFeature(feature: TribalPresentationFeature): void {
  if (!isRenderedTribalCategory(feature.category)) {
    throw new Error(`source feature ${feature.source_feature_id} has no supported presentation category`);
  }
  for (const key of Object.keys(tribalVisibility) as TribalVisibilityKey[]) {
    tribalVisibility[key] = key === feature.category;
  }
  terrainEnabled.checked = false;
  scene.setTerrainEnabled(false);
  terrainChip.textContent = "Terrain off • WGS84 ellipsoid";
  document.body.dataset.terrain = "off";
  document.body.dataset.sourceFeatureInspection = "ready";
  document.body.dataset.sourceFeatureId = feature.source_feature_id;
  document.body.dataset.sourceFeatureCategory = feature.category;
  renderWorkspace();
  focusTribalFeatures([feature], SOURCE_FEATURE_MINIMUM_CAMERA_DISTANCE_METRES);
  setStatus(
    "success",
    `Success — isolated and framed complete source feature ${feature.source_feature_id} as ${humanTribalCategory(feature.category).toLowerCase()}. This is a Census representation check, not a legal or ownership claim.`,
  );
}

function renderResults(): void {
  analysisResultsContainer.replaceChildren();
  if (analysisResults.length === 0) {
    analysisResultsContainer.append(
      emptyCard(
        "No result yet",
        "Load inputs and run the scenario. Missing data remains unknown, never suitable.",
      ),
    );
    analysisSummary.textContent = "Not run";
    reasonTitle.textContent = "Nothing selected";
    reasonList.replaceChildren(
      createElement("li", undefined, "Select a result to inspect every deterministic rule decision."),
    );
    return;
  }

  const counts = countStates(analysisResults);
  analysisSummary.textContent = `${analysisResults.length} cells • ${Object.entries(counts)
    .map(([state, count]) => `${state} ${count}`)
    .join(" · ")}`;
  for (const result of analysisResults) {
    const button = createElement("button", "result-button");
    button.setAttribute("type", "button");
    button.dataset.resultId = result.feature_id;
    button.dataset.state = result.state;
    button.setAttribute("aria-pressed", String(result.feature_id === selectedResultId));
    button.append(createElement("span", "result-label", result.feature_id));
    button.append(createElement("span", "result-state", result.state));
    button.addEventListener("click", () => selectResult(result.feature_id));
    analysisResultsContainer.append(button);
  }
  renderReasonInspector();
}

function selectResult(id: string): void {
  selectedResultId = id;
  renderResults();
  reasonInspector.focus();
}

function renderReasonInspector(): void {
  const result = analysisResults.find((entry) => entry.feature_id === selectedResultId);
  if (result === undefined) return;
  reasonTitle.textContent = `${result.feature_id} — ${result.state}`;
  reasonList.replaceChildren();
  for (const reason of result.reasons) {
    const selected = reason.selected ? "selected" : "not selected";
    reasonList.append(
      createElement(
        "li",
        undefined,
        `${reason.sequence + 1}. ${reason.code} (${selected}) — ${reason.message}`,
      ),
    );
  }
}

function renderCandidates(): void {
  candidateList.replaceChildren();
  const candidates = project?.candidates ?? [];
  candidateCount.textContent = String(candidates.length);
  if (candidates.length === 0) {
    candidateList.append(emptyCard("No candidates", "Use real Cesium globe clicks to create one."));
    candidateEditor.hidden = true;
    scene.renderCandidates([]);
    return;
  }
  if (!candidates.some((candidate) => candidate.id === selectedCandidateId)) {
    selectedCandidateId = candidates[0]?.id ?? null;
  }
  for (const candidate of candidates) {
    const button = createElement("button", "candidate-button");
    button.setAttribute("type", "button");
    button.dataset.candidateId = candidate.id;
    button.setAttribute("aria-pressed", String(candidate.id === selectedCandidateId));
    button.append(createElement("span", "candidate-label", candidate.name));
    button.append(createElement("span", "muted", `${vertexCount(candidate)} vertices`));
    button.addEventListener("click", () => {
      selectedCandidateId = candidate.id;
      renderCandidates();
    });
    candidateList.append(button);
  }
  renderCandidateEditor();
  scene.renderCandidates(
    candidates.flatMap((candidate) => displayCandidatesFor(candidate, candidate.id === selectedCandidateId)),
  );
}

function renderCandidateEditor(): void {
  if (project === null) return;
  const candidate = selectedCandidate(project);
  if (candidate === null) {
    candidateEditor.hidden = true;
    return;
  }
  candidateEditor.hidden = false;
  candidateNameInput.value = candidate.name;
  vertexEditor.replaceChildren();
  const coordinates = editableCoordinates(candidate);
  coordinates.forEach((coordinate, index) => {
    const row = createElement("div", "vertex-row");
    row.dataset.vertexIndex = String(index);
    row.append(createElement("span", undefined, String(index + 1)));
    row.append(numericCoordinateInput("longitude", coordinate[0], index));
    row.append(numericCoordinateInput("latitude", coordinate[1], index));
    vertexEditor.append(row);
  });
}

function numericCoordinateInput(
  axis: "latitude" | "longitude",
  value: number,
  index: number,
): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "number";
  input.step = "0.000001";
  input.dataset.axis = axis;
  input.value = String(value);
  input.setAttribute("aria-label", `Vertex ${index + 1} ${axis}`);
  input.min = axis === "longitude" ? "-180" : "-90";
  input.max = axis === "longitude" ? "180" : "90";
  input.required = true;
  return input;
}

function displayPolygons(): DisplayPolygon[] {
  const polygons: DisplayPolygon[] = [];
  if (fixtures !== null) {
    for (const imported of fixtures.all) {
      const kind = layerDisplayKind(imported.metadata.layer.role);
      const enabled = kind === "hard" ? hardEnabled.checked : kind === "soft" ? softEnabled.checked : true;
      for (const feature of imported.document.features) {
        for (const [index, part] of polygonParts(feature.geometry).entries()) {
          polygons.push({
            id: `fixture-${imported.metadata.layer.id}-${String(feature.id)}-${index}`,
            kind,
            label: `${imported.metadata.layer.name} / ${String(feature.id)}`,
            rings: part.rings,
            visible: enabled,
          });
        }
      }
    }
  }
  for (const result of analysisResults) {
    for (const [index, part] of polygonDisplayParts(result.geometry).entries()) {
      polygons.push({
        id: `result-${result.feature_id}-${index}`,
        kind: result.state === "unavailable" ? "unknown" : result.state,
        label: `${result.feature_id}: ${result.state}`,
        rings: part.rings,
        visible: true,
      });
    }
  }
  if (tribalContext !== null) polygons.push(...displayPolygonsForTribalContext(tribalContext));
  return polygons;
}

function displayCandidatesFor(candidate: CandidatePolygon, selected: boolean): DisplayCandidate[] {
  return polygonDisplayParts(candidate.geometry).map((part, index) => ({
    id: `${candidate.id}-${index}`,
    name: candidate.name,
    rings: part.rings,
    selected,
  }));
}

function displayPolygonsForTribalContext(context: TribalPresentationContext): DisplayPolygon[] {
  const polygons: DisplayPolygon[] = [];
  for (const [index, part] of polygonDisplayParts(context.aoi.presentation.wa_state).entries()) {
    polygons.push({
      id: `wa-state-${index}`,
      kind: "wa_state",
      label: "Washington State — 2025 Census exterior",
      rings: part.rings,
      visible: tribalVisibility.wa_state,
    });
  }
  for (const [index, part] of polygonDisplayParts(context.aoi.presentation.wa_overflow_100m).entries()) {
    polygons.push({
      id: `wa-technical-buffer-${index}`,
      kind: "wa_technical_buffer",
      label: "Nominal 100 metre exterior technical overflow — not a legal boundary",
      rings: part.rings,
      visible: tribalVisibility.wa_technical_buffer,
    });
  }
  for (const feature of context.features) {
    const kind = feature.registry_scope === "border_context" ? "border_context" : feature.category;
    const visible =
      feature.registry_scope === "border_context"
        ? tribalVisibility.border_context
        : isRenderedTribalCategory(feature.category)
          ? tribalVisibility[feature.category]
          : false;
    for (const [index, part] of polygonDisplayParts(feature.geometry).entries()) {
      polygons.push({
        id: `wa-tribal-${feature.source_feature_id}-${index}`,
        kind,
        label: tribalFeatureLabel(feature),
        rings: part.rings,
        visible,
      });
    }
  }
  return polygons;
}

function buildInteriorHoleInspections(
  context: TribalPresentationContext,
): Map<string, InteriorHoleInspection> {
  const inspections = new Map<string, InteriorHoleInspection>();
  for (const feature of context.features) {
    if (
      feature.registry_scope !== "goia_29" ||
      feature.nation_id === null ||
      !isRenderedTribalCategory(feature.category)
    ) {
      continue;
    }
    for (const part of polygonDisplayParts(feature.geometry)) {
      for (const hole of part.rings.slice(1)) {
        const point = robustInteriorPoint(hole);
        if (point === null || pointCoveredByTribalCategory(context, feature.category, point.coordinate)) {
          continue;
        }
        const existing = inspections.get(feature.nation_id);
        if (existing === undefined || point.clearance_metres > existing.clearance_metres) {
          inspections.set(feature.nation_id, {
            category: feature.category,
            clearance_metres: point.clearance_metres,
            coordinate: point.coordinate,
            source_feature_id: feature.source_feature_id,
          });
        }
      }
    }
  }
  return inspections;
}

function pointCoveredByTribalCategory(
  context: TribalPresentationContext,
  category: RenderedTribalCategory,
  coordinate: LongitudeLatitude,
): boolean {
  for (const feature of context.features) {
    if (feature.category !== category) continue;
    for (const part of polygonDisplayParts(feature.geometry)) {
      if (displayPartContainsPoint(part.rings, coordinate)) return true;
    }
  }
  return false;
}

function displayPartContainsPoint(rings: readonly DisplayRing[], coordinate: LongitudeLatitude): boolean {
  const exterior = rings[0];
  if (exterior === undefined || !pointInRing(coordinate, exterior)) return false;
  return !rings.slice(1).some((hole) => pointInRing(coordinate, hole));
}

function robustInteriorPoint(
  ring: DisplayRing,
): { clearance_metres: number; coordinate: LongitudeLatitude } | null {
  if (ring.length < 4) return null;
  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  for (const [longitude, latitude] of ring) {
    west = Math.min(west, longitude);
    south = Math.min(south, latitude);
    east = Math.max(east, longitude);
    north = Math.max(north, latitude);
  }
  const longitudeSpan = east - west;
  const latitudeSpan = north - south;
  if (!(longitudeSpan > 0) || !(latitudeSpan > 0)) return null;

  let best: { clearance_metres: number; coordinate: LongitudeLatitude } | null = null;
  const consider = (coordinate: LongitudeLatitude): void => {
    const clearanceMetres = interiorClearanceMetres(coordinate, ring);
    if (clearanceMetres <= 0 || (best !== null && clearanceMetres <= best.clearance_metres)) return;
    best = { clearance_metres: clearanceMetres, coordinate };
  };

  const centroid = polygonRingCentroid(ring);
  if (centroid !== null) consider(centroid);
  consider([(west + east) / 2, (south + north) / 2]);

  for (let scanline = 0; scanline < INTERIOR_HOLE_SCANLINES; scanline += 1) {
    const latitude = south + ((scanline + 0.5) / INTERIOR_HOLE_SCANLINES) * latitudeSpan;
    const intersections: number[] = [];
    for (let index = 0; index < ring.length; index += 1) {
      const start = ring[index];
      const end = ring[(index + 1) % ring.length];
      if (start === undefined || end === undefined) continue;
      if (start[1] > latitude === end[1] > latitude) continue;
      intersections.push(start[0] + ((latitude - start[1]) * (end[0] - start[0])) / (end[1] - start[1]));
    }
    intersections.sort((left, right) => left - right);
    for (let index = 0; index + 1 < intersections.length; index += 2) {
      const left = intersections[index];
      const right = intersections[index + 1];
      if (left !== undefined && right !== undefined && right > left) {
        consider([(left + right) / 2, latitude]);
      }
    }
  }

  if (best === null) return null;
  let longitudeStep = longitudeSpan / INTERIOR_HOLE_SCANLINES;
  let latitudeStep = latitudeSpan / INTERIOR_HOLE_SCANLINES;
  for (let refinement = 0; refinement < INTERIOR_HOLE_REFINEMENT_STEPS; refinement += 1) {
    const origin = (best as { clearance_metres: number; coordinate: LongitudeLatitude }).coordinate;
    for (let longitudeOffset = -2; longitudeOffset <= 2; longitudeOffset += 1) {
      for (let latitudeOffset = -2; latitudeOffset <= 2; latitudeOffset += 1) {
        consider([origin[0] + longitudeOffset * longitudeStep, origin[1] + latitudeOffset * latitudeStep]);
      }
    }
    longitudeStep /= 2;
    latitudeStep /= 2;
  }
  return best;
}

function polygonRingCentroid(ring: DisplayRing): LongitudeLatitude | null {
  let twiceArea = 0;
  let longitudeNumerator = 0;
  let latitudeNumerator = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const start = ring[index];
    const end = ring[(index + 1) % ring.length];
    if (start === undefined || end === undefined) continue;
    const cross = start[0] * end[1] - end[0] * start[1];
    twiceArea += cross;
    longitudeNumerator += (start[0] + end[0]) * cross;
    latitudeNumerator += (start[1] + end[1]) * cross;
  }
  if (Math.abs(twiceArea) <= Number.EPSILON) return null;
  return [longitudeNumerator / (3 * twiceArea), latitudeNumerator / (3 * twiceArea)];
}

function interiorClearanceMetres(coordinate: LongitudeLatitude, ring: DisplayRing): number {
  if (!pointInRing(coordinate, ring)) return -1;
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 0; index < ring.length; index += 1) {
    const start = ring[index];
    const end = ring[(index + 1) % ring.length];
    if (start === undefined || end === undefined) continue;
    minimum = Math.min(minimum, pointToSegmentDistanceMetres(coordinate, start, end));
  }
  return minimum;
}

function pointToSegmentDistanceMetres(
  point: LongitudeLatitude,
  start: LongitudeLatitude,
  end: LongitudeLatitude,
): number {
  const longitudeScale = MEAN_METRES_PER_DEGREE_LATITUDE * Math.cos((point[1] * Math.PI) / 180);
  const startX = (start[0] - point[0]) * longitudeScale;
  const startY = (start[1] - point[1]) * MEAN_METRES_PER_DEGREE_LATITUDE;
  const endX = (end[0] - point[0]) * longitudeScale;
  const endY = (end[1] - point[1]) * MEAN_METRES_PER_DEGREE_LATITUDE;
  const deltaX = endX - startX;
  const deltaY = endY - startY;
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;
  if (lengthSquared === 0) return Math.hypot(startX, startY);
  const projection = Math.max(0, Math.min(1, -(startX * deltaX + startY * deltaY) / lengthSquared));
  return Math.hypot(startX + projection * deltaX, startY + projection * deltaY);
}

function pointInRing(point: LongitudeLatitude, ring: DisplayRing): boolean {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const currentPosition = ring[index];
    const previousPosition = ring[previous];
    if (currentPosition === undefined || previousPosition === undefined) continue;
    const crosses =
      currentPosition[1] > point[1] !== previousPosition[1] > point[1] &&
      point[0] <
        ((previousPosition[0] - currentPosition[0]) * (point[1] - currentPosition[1])) /
          (previousPosition[1] - currentPosition[1]) +
          currentPosition[0];
    if (crosses) inside = !inside;
  }
  return inside;
}

function renderMapLayers(): void {
  scene.renderPolygons(
    baseline === null
      ? displayPolygons()
      : tribalContext === null
        ? []
        : displayPolygonsForTribalContext(tribalContext),
  );
}

function tribalFeatureLabel(feature: TribalPresentationFeature): string {
  const scope =
    feature.registry_scope === "border_context"
      ? "Border context outside the GOIA 29 denominator"
      : humanTribalCategory(feature.category);
  const statistical = feature.category === "tdsa_statistical_area" ? " — statistical, not legal land" : "";
  return `${feature.formal_nation_name ?? feature.source_name} · ${scope}${statistical} · ${feature.source_feature_id}`;
}

function countTribalFeatures(
  features: readonly TribalPresentationFeature[],
): Partial<Record<TribalGeometryCategory, number>> {
  const counts: Partial<Record<TribalGeometryCategory, number>> = {};
  for (const feature of features) counts[feature.category] = (counts[feature.category] ?? 0) + 1;
  return counts;
}

function isRenderedTribalCategory(category: TribalGeometryCategory): category is RenderedTribalCategory {
  return (
    category === "federal_reservation_exterior" ||
    category === "off_reservation_trust_land" ||
    category === "tdsa_statistical_area"
  );
}

function isTribalVisibilityKey(value: unknown): value is TribalVisibilityKey {
  return (
    value === "border_context" ||
    value === "federal_reservation_exterior" ||
    value === "off_reservation_trust_land" ||
    value === "tdsa_statistical_area" ||
    value === "wa_state" ||
    value === "wa_technical_buffer"
  );
}

function humanTribalCategory(category: TribalGeometryCategory): string {
  switch (category) {
    case "federal_reservation_exterior":
      return "Federal reservation exterior";
    case "off_reservation_trust_land":
      return "Off-reservation trust land";
    case "tdsa_statistical_area":
      return "TDSA / statistical area";
    case "bia_land_area_representation":
      return "BIA Land Area Representation";
    case "authorized_tract_parcel_land_status":
      return "Authorized tract / parcel land status";
    case "treaty_area":
      return "Treaty area";
    case "ceded_land_area":
      return "Ceded-land area";
    case "tribe_approved_usual_and_accustomed_area":
      return "Tribe-approved usual and accustomed area";
    case "agreement_specific_co_management":
      return "Agreement-specific co-management";
  }
}

function humanCoverageSummary(summary: NationCoverageRow["summary"]): string {
  switch (summary) {
    case "legal_area_present":
      return "legal area present";
    case "statistical_only":
      return "statistical only";
    case "no_public_geometry":
      return "no public geometry";
    case "source_conflict":
      return "source conflict";
    case "unknown":
      return "unknown";
  }
}

function contextExportAllowed(context: TribalPresentationContext): boolean {
  const tsdfSource = loadTsdfSource(context.custody.classification.tsdf_source);
  return tsdfSource.resolve(context.custody.classification.effective_tier_id).behavior.export_allowed;
}

function polygonParts(geometry: Geometry): ReturnType<typeof polygonDisplayParts> {
  if (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon") return [];
  return polygonDisplayParts(geometry as Polygon | MultiPolygon);
}

function editableCoordinates(candidate: CandidatePolygon): LongitudeLatitude[] {
  const parts = polygonDisplayParts(candidate.geometry);
  const exterior = parts[0]?.rings[0] ?? [];
  return exterior.slice(0, -1);
}

function vertexCount(candidate: CandidatePolygon): number {
  return editableCoordinates(candidate).length;
}

function selectedCandidate(document: ProjectDocument): CandidatePolygon | null {
  return document.candidates.find((candidate) => candidate.id === selectedCandidateId) ?? null;
}

function nextCandidateId(document: ProjectDocument): string {
  let sequence = 1;
  while (document.candidates.some((candidate) => candidate.id === `candidate-${sequence}`)) {
    sequence += 1;
  }
  return `candidate-${sequence}`;
}

function activeScenario(document: ProjectDocument): Scenario {
  const scenario = document.scenarios.find((candidate) => candidate.id === document.active_scenario_id);
  if (scenario === undefined) throw new Error(`active scenario ${document.active_scenario_id} is missing`);
  return scenario;
}

function validateProjectUpdate(value: ProjectDocument): ProjectDocument {
  return parseProject(serializeProject(value));
}

function layerForKind(set: FixtureSet, kind: FixtureDefinition["kind"]): ImportedGeoJsonLayer {
  switch (kind) {
    case "resource":
      return set.resource;
    case "hard":
      return set.hard;
    case "soft":
      return set.soft;
  }
}

function layerDisplayKind(
  role: ImportedGeoJsonLayer["metadata"]["layer"]["role"],
): "hard" | "resource" | "soft" {
  if (role === "hard_exclusion") return "hard";
  if (role === "soft_constraint") return "soft";
  return "resource";
}

function humanRole(role: ImportedGeoJsonLayer["metadata"]["layer"]["role"]): string {
  switch (role) {
    case "hard_exclusion":
      return "Hard exclusion";
    case "soft_constraint":
      return "Soft penalty";
    case "resource":
      return "Synthetic resource condition surface";
    case "context":
      return "Context";
    case "opportunity_result":
      return "Opportunity result";
  }
}

function countStates(results: readonly AnalysisResult[]): Partial<Record<OpportunityState, number>> {
  const counts: Partial<Record<OpportunityState, number>> = {};
  for (const result of results) counts[result.state] = (counts[result.state] ?? 0) + 1;
  return counts;
}

function updateTerrain(): void {
  scene.setTerrainEnabled(terrainEnabled.checked);
  updateTerrainLabel();
  if (baseline !== null) {
    setStatus(
      "success",
      terrainEnabled.checked
        ? "Local DEM relative relief enabled at ×1. Native source queries are unchanged; dark holes and outside remain unavailable."
        : "Local DEM display hidden. Native source values remain available in the inspector.",
    );
    return;
  }
  setStatus(
    "success",
    terrainEnabled.checked
      ? "Success — deterministic synthetic terrain provider enabled; heights are not measured elevation."
      : "Success — synthetic terrain disabled; Cesium is rendering the WGS84 ellipsoid.",
  );
}

function updateTerrainLabel(): void {
  if (baseline !== null) {
    terrainChip.textContent = terrainEnabled.checked
      ? `${baseline.manifest.kind} DEM • relative relief ×1`
      : "Local DEM display off • no elevation shown";
    document.body.dataset.terrain = terrainEnabled.checked ? "on" : "off";
    return;
  }
  terrainChip.textContent = terrainEnabled.checked
    ? "Terrain on • synthetic / not measured"
    : "Terrain off • WGS84 ellipsoid";
  document.body.dataset.terrain = terrainEnabled.checked ? "on" : "off";
}

function resetRoundTripReceipt(): void {
  roundTripReceipt.dataset.state = "not-run";
  roundTripReceiptText.textContent = "Not verified — export and re-import a user-selected file.";
  delete document.body.dataset.roundtrip;
}

function resetContextReceipts(): void {
  for (const key of [
    "waContext",
    "waContextBytes",
    "waContextExactBytes",
    "waContextFeatures",
    "waContextNations",
    "waContextReopen",
    "waCoverage",
    "waReservations",
    "waTrustLands",
    "waTdsa",
    "waBorderContext",
    "waValidatorConflicts",
    "interiorHoleInspection",
    "interiorHoleCategory",
    "sourceFeatureInspection",
    "sourceFeatureId",
    "sourceFeatureCategory",
  ] as const) {
    delete document.body.dataset[key];
  }
}

function setStatus(state: WorkflowState, message: string): void {
  workflowStatus.dataset.state = state;
  workflowStatusText.textContent = message;
  document.body.dataset.workflowState = state;
}

async function yieldForVisibleState(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

function emptyCard(title: string, detail: string): HTMLElement {
  const card = createElement("div", "empty-card");
  card.append(createElement("strong", undefined, title));
  card.append(createElement("p", undefined, detail));
  return card;
}

function addDefinition(list: HTMLElement, term: string, definition: string): void {
  list.append(createElement("dt", undefined, term));
  list.append(createElement("dd", undefined, definition));
}

function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className !== undefined) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`required renderer element #${id} is missing`);
  return element as T;
}

function requiredDescendant<T extends HTMLElement>(root: HTMLElement, selector: string): T {
  const element = root.querySelector(selector);
  if (element === null) throw new Error(`required renderer element ${selector} is missing`);
  return element as T;
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
