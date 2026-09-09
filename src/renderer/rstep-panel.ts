import type { MultiPolygon, Polygon } from "geojson";
import { transformGeometry, visitGeometryPositions } from "../core/crs";
import {
  createScenario,
  createSidecar,
  evaluateScreening,
  parseSidecar,
  replaySidecar,
  serializeSidecar,
  type OverlayPermission,
  type RstepScenario,
  type RstepSidecar,
  type ScreeningResult,
} from "../core/rstep/index";
import {
  parseSourceLayer,
  summarizeDataCenters,
  queryDataCenters,
  type ParsedSourceLayer,
} from "../core/source-layer/index";
import type { CesiumScene } from "./cesium-scene";
import { RstepMap, type RstepMapFeature } from "./rstep-map";
import { createRstepAoi } from "./rstep-aoi";
import {
  interpolateResourceLayer,
  interpolationSelections,
  type InterpolationSurface,
} from "../core/rstep/interpolation";
import { focusRstepArea, interpolationMapFeatures } from "./rstep-view";

const DEFAULT_BOUNDS = {
  WA: [-119.9, 47.1, -119.55, 47.4],
  OR: [-123.0, 45.51, -122.94, 45.555],
  ID: [-116.7, 43.4, -116.25, 43.65],
} as const;

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`Missing RSTEP control ${id}`);
  return found as T;
}
function text(tag: string, value: string): HTMLElement {
  const node = document.createElement(tag);
  node.textContent = value;
  return node;
}
function details(title: string, value: unknown): HTMLElement {
  const node = document.createElement("details");
  node.append(text("summary", title), text("pre", JSON.stringify(value, null, 2)));
  return node;
}

export function startRstepPanel(scene: CesiumScene): void {
  element("rstep-controls").innerHTML = `
    <p class="eyebrow">Independent local application</p><h2>RSTEP wind / solar</h2>
    <p>Bounded screening with retained evidence. Human review remains necessary.</p>
    <button id="rstep-open-layers" type="button" class="button-primary full-width">Open local source layers…</button>
    <button id="rstep-open" type="button">Open workspace…</button> <button id="rstep-save" type="button" disabled>Save workspace…</button>
    <p>Choose a local, non-cloud folder. A workspace retains the exact source layers and scenarios.</p>
    <details><summary>Import and replacement options</summary>
      <label><input id="rstep-replace-file" type="checkbox"> Explicitly replace an existing layer edition</label>
      <label>Overlay permission for this import<select id="rstep-overlay-authorization"><option value="unknown">Unknown — refuse partner overlay</option><option value="synthetic_authorized">Authorized synthetic fixture only</option><option value="public_fixture_authorized">Authorized public fixture only</option></select></label>
      <p>Permission records are retained; this build does not enforce consent or authorize real partner onboarding.</p>
    </details>
    <label>Demonstration state<select id="rstep-state"><option>WA</option><option>OR</option><option>ID</option></select></label>
    <label>Technology<select id="rstep-technology"><option value="wind">Wind</option><option value="solar">Solar</option></select></label>
    <fieldset><legend>AOI bounds — longitude / latitude (EPSG:4326)</legend><div class="rstep-bounds">
      <label>West<input id="rstep-west" type="number" step="any"></label><label>South<input id="rstep-south" type="number" step="any"></label>
      <label>East<input id="rstep-east" type="number" step="any"></label><label>North<input id="rstep-north" type="number" step="any"></label>
    </div></fieldset>
    <fieldset><legend>3D area view</legend>
      <button id="rstep-view-oblique" type="button">3D perspective</button>
      <button id="rstep-view-overhead" type="button">Overhead</button>
      <p>Frame the selected area on the ellipsoid. No measured relief or height adjustment is applied.</p>
    </fieldset>
    <fieldset><legend>Exploratory resource interpolation</legend>
      <label>Continuous source layer<select id="rstep-interpolation-layer"></select></label>
      <label>Measurement and period<select id="rstep-interpolation-measurement"></select></label>
      <label>Display cell size (metres)<input id="rstep-interpolation-cell" type="number" min="1" step="any" value="500"></label>
      <label>Neighbor radius (projected metres)<input id="rstep-interpolation-radius" type="number" min="1" max="100000" step="any" value="5000"></label>
      <button id="rstep-interpolate" type="button">Preview interpolation</button>
      <label><input id="rstep-interpolation-visible" type="checkbox" checked> Show interpolated values</label>
      <p>Inverse-distance weighting (power 2), limited to supported neighbors. Cell size cannot be finer than declared native resolution. This display does not calculate wind capacity or change screening results. View settings last for this session.</p>
      <p id="rstep-interpolation-status" role="status" aria-live="polite" data-state="empty">Select a qualified local continuous layer. Reference points alone may be insufficient.</p>
    </fieldset>
    <label>Selected constraint and overlay treatment<select id="rstep-treatment"><option value="context">Show overlap as context</option><option value="exclude">Exclude overlap by scenario assumption</option><option value="review">Flag overlap for review</option></select></label>
    <p>Inventory designations do not establish a legal prohibition. This setting is an explicit scenario assumption.</p>
    <details><summary>Coverage and assessment gaps</summary><p>These packages cover bounded demonstration areas. Grid and interconnection capacity, wetland/habitat layers, vegetation, and permit enrichments are not installed in this starter stack. Slope, legal applicability, and development feasibility remain unassessed. State selection does not establish statewide coverage or Tribal authority.</p><p>Resource summaries describe the retained reference points and source support; they do not resample or estimate resource at a newly selected AOI.</p></details>
    <button id="rstep-recompute" type="button" class="button-primary full-width">Recompute screening</button>
    <label>Saved scenario snapshot<select id="rstep-scenario"><option value="">No scenario yet</option></select></label>
    <label><input id="rstep-visibility" type="checkbox" checked> Show source and AOI vectors</label>
    <label><input id="rstep-datacenters" type="checkbox" checked> Show data-center context independently</label>
    <p>Map: white AOI; amber constraints; green context; cyan resource reference points; violet data centers. Full source geometry is shown, including portions outside the AOI. Ellipsoid reference surface; no measured terrain.</p>
    <div id="rstep-status" role="status" aria-live="polite" data-state="empty">Open qualified local packages to begin.</div>
    <h3>Selected sources</h3><div id="rstep-layers"></div>`;
  element("rstep-inspection").innerHTML =
    `<h2>Evidence and findings</h2><div id="rstep-results"><p>No screening result.</p></div><h3>Interpolated display values</h3><div id="rstep-interpolation-output"><p>No interpolation preview.</p></div><h3>Resource reference summaries</h3><div id="rstep-resources"></div><h3>Data-center context</h3><div id="rstep-data-center-inspection"></div><h3>Source record inspector</h3><div id="rstep-source-inspector"><p>Select a source record in the layer list.</p></div>`;

  const map = new RstepMap(scene);
  let active = false;
  let busy = false;
  let layers: ParsedSourceLayer[] = [];
  let permissions = new Map<string, OverlayPermission>();
  let enabled = new Map<string, boolean>();
  let scenarios: RstepScenario[] = [];
  let currentScenario: RstepScenario | null = null;
  let sidecar: RstepSidecar | null = null;
  let result: ScreeningResult | null = null;
  let sequence = 0;
  let retainedAoi: Polygon | MultiPolygon | null = null;
  let surface: InterpolationSurface | null = null;
  const value = (id: string) => element<HTMLSelectElement>(id).value;
  const checked = (id: string) => element<HTMLInputElement>(id).checked;
  const state = () => value("rstep-state") as "WA" | "OR" | "ID";
  const selectedLayers = () => layers.filter((layer) => layer.document.coverage.states.includes(state()));

  function status(kind: string, message: string): void {
    element("rstep-status").dataset.state = kind;
    element("rstep-status").textContent = message;
    element<HTMLButtonElement>("rstep-save").disabled = kind !== "current" && kind !== "saved";
  }
  function stale(): void {
    sidecar = null;
    invalidateInterpolation();
    refreshInterpolationChoices();
    status("stale", "Inputs changed. Previous findings are stale; recompute before saving.");
  }
  function invalidateInterpolation(): void {
    surface = null;
    const message = element("rstep-interpolation-status");
    message.dataset.state = "empty";
    message.dataset.validCells = "0";
    message.dataset.maskedCells = "0";
    message.textContent = "View inputs changed. Preview again to derive supported display values.";
    element("rstep-interpolation-output").replaceChildren(text("p", "No current interpolation preview."));
  }
  function interpolationLayer(): ParsedSourceLayer | undefined {
    return selectedLayers().find(
      (layer) =>
        layer.document.layer_id === value("rstep-interpolation-layer") &&
        enabled.get(layer.document.layer_id) !== false,
    );
  }
  function refreshInterpolationMeasurements(): void {
    const select = element<HTMLSelectElement>("rstep-interpolation-measurement");
    const prior = select.value;
    const layer = interpolationLayer();
    select.replaceChildren();
    for (const selection of layer === undefined ? [] : interpolationSelections(layer)) {
      const option = document.createElement("option");
      option.value = JSON.stringify(selection);
      option.textContent = `${selection.quantity} · ${selection.unit} · ${selection.period} · ${selection.status} · ${selection.support}`;
      select.append(option);
    }
    if ([...select.options].some((option) => option.value === prior)) select.value = prior;
    if (select.options.length === 0) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No eligible wind-speed or irradiance measurement";
      select.append(option);
    }
  }
  function refreshInterpolationChoices(): void {
    const select = element<HTMLSelectElement>("rstep-interpolation-layer");
    const prior = select.value;
    select.replaceChildren();
    for (const layer of selectedLayers()) {
      if (layer.document.kind !== "resource" || enabled.get(layer.document.layer_id) === false) continue;
      const option = document.createElement("option");
      option.value = layer.document.layer_id;
      option.textContent = `${layer.document.name} · ${layer.document.revision}`;
      select.append(option);
    }
    if ([...select.options].some((option) => option.value === prior)) select.value = prior;
    if (select.options.length === 0) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "Open a local resource layer";
      select.append(option);
    }
    refreshInterpolationMeasurements();
  }
  function previewInterpolation(): void {
    invalidateInterpolation();
    const message = element("rstep-interpolation-status");
    try {
      const layer = interpolationLayer();
      if (layer === undefined) throw new Error("Select an enabled local resource layer first.");
      const selection = interpolationSelections(layer).find(
        (item) => JSON.stringify(item) === value("rstep-interpolation-measurement"),
      );
      if (selection === undefined)
        throw new Error("No eligible continuous wind-speed or irradiance measurement.");
      surface = interpolateResourceLayer(layer, aoi(), {
        selection,
        cellSizeMetres: element<HTMLInputElement>("rstep-interpolation-cell").valueAsNumber,
        radiusMetres: element<HTMLInputElement>("rstep-interpolation-radius").valueAsNumber,
      });
      message.dataset.state = surface.validCells === 0 ? "unavailable" : "ready";
      message.dataset.validCells = String(surface.validCells);
      message.dataset.maskedCells = String(surface.maskedCells);
      message.textContent = `${surface.validCells} display cells; ${surface.maskedCells} unavailable. Source values and screening remain unchanged.`;
      const output = element("rstep-interpolation-output");
      output.replaceChildren(
        text(
          "p",
          `${layer.document.source.publisher} · ${layer.document.source.edition} · ${selection.quantity} (${selection.unit}) · ${selection.period} · ${selection.status}`,
        ),
        text(
          "p",
          `IDW power 2; EPSG:5070 projected distances; cell ${surface.options.cellSizeMetres} m; radius ${surface.options.radiusMetres} m. ${surface.validCells} estimated cells; ${surface.maskedCells} unavailable cells remain transparent.`,
        ),
        text(
          "p",
          `Support: ${selection.support}. Declared native resolution: ${layer.document.measurement.native_resolution.description}. Interpolation adds no measured detail or validated accuracy.`,
        ),
      );
      if (surface.minimum !== null && surface.maximum !== null) {
        const constant = surface.minimum === surface.maximum;
        const legend = text(
          "p",
          constant
            ? `Constant display value ${surface.minimum.toFixed(3)} ${selection.unit}. Transparent = unavailable, never zero.`
            : `Blue ${surface.minimum.toFixed(3)} → yellow ${surface.maximum.toFixed(3)} ${selection.unit}. Transparent = unavailable, never zero.`,
        );
        const swatch = document.createElement("span");
        swatch.setAttribute("aria-hidden", "true");
        swatch.style.cssText = `display:block;height:12px;background:${constant ? "#969194" : "linear-gradient(to right,#2d3b86,#ffe6a1)"};margin-bottom:6px`;
        legend.prepend(swatch);
        output.append(legend);
      }
      for (const warning of surface.warnings) output.append(text("p", warning));
      output.append(
        details("Method and source identity", {
          algorithm: "exploratory-idw-p2/1",
          analysis_crs: "EPSG:5070",
          maximum_neighbors: 16,
          source_sha256: surface.sourceSha256,
          native_resolution: layer.document.measurement.native_resolution,
          options: surface.options,
        }),
      );
      const table = document.createElement("table");
      table.style.cssText =
        "width:100%;table-layout:fixed;border-collapse:collapse;overflow-wrap:anywhere;text-align:left";
      table.append(
        text(
          "caption",
          `Cell centers: EPSG:5070 easting, northing in metres; square cells ${surface.options.cellSizeMetres} m wide. Values estimate the center, not the cell average.`,
        ),
      );
      const header = document.createElement("tr");
      const columnWidths = [10, 30, 23, 25, 12];
      for (const [index, label] of [
        "Cell",
        "Center (m)",
        `Value (${selection.unit})`,
        "State",
        "Neighbors",
      ].entries()) {
        const heading = text("th", label);
        heading.style.cssText = `width:${columnWidths[index]}%;vertical-align:top;padding:3px 2px`;
        header.append(heading);
      }
      const head = document.createElement("thead");
      head.append(header);
      table.append(head);
      const body = document.createElement("tbody");
      surface.cells.forEach((cell, index) => {
        const xs: number[] = [],
          ys: number[] = [];
        visitGeometryPositions(cell.geometry, (position) => {
          xs.push(position[0] ?? NaN);
          ys.push(position[1] ?? NaN);
        });
        const centerX = (Math.min(...xs) + Math.max(...xs)) / 2;
        const centerY = (Math.min(...ys) + Math.max(...ys)) / 2;
        const row = document.createElement("tr");
        for (const cellText of [
          String(index + 1),
          `${centerX.toFixed(2)}, ${centerY.toFixed(2)}`,
          cell.value === null ? "Unavailable" : cell.value.toFixed(6),
          cell.absence ?? "estimated",
          String(cell.neighborCount),
        ]) {
          const entry = text("td", cellText);
          entry.style.cssText = "vertical-align:top;padding:3px 2px";
          row.append(entry);
        }
        body.append(row);
      });
      table.append(body);
      const inspection = document.createElement("details");
      inspection.append(text("summary", "Inspect every derived display cell"), table);
      output.append(inspection);
    } catch (error) {
      surface = null;
      message.dataset.state = "refused";
      message.textContent = error instanceof Error ? error.message : String(error);
    }
    renderMap();
  }
  function focusArea(mode: "oblique" | "overhead"): void {
    try {
      const display = transformGeometry(aoi(), "EPSG:5070", "EPSG:4326");
      const x: number[] = [],
        y: number[] = [];
      visitGeometryPositions(display, (position) => {
        x.push(position[0] ?? NaN);
        y.push(position[1] ?? NaN);
      });
      focusRstepArea(scene, [Math.min(...x), Math.min(...y), Math.max(...x), Math.max(...y)], mode);
    } catch (error) {
      element("rstep-interpolation-status").textContent =
        error instanceof Error ? error.message : String(error);
    }
  }
  async function action(run: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    const previousStatus = element("rstep-status").dataset.state ?? "empty";
    const previousMessage = element("rstep-status").textContent ?? "";
    status("working", "Validating the local operation…");
    for (const control of element("rstep-controls").querySelectorAll<HTMLInputElement>("button,input,select"))
      control.disabled = true;
    try {
      await run();
      if (element("rstep-status").dataset.state === "working") status(previousStatus, previousMessage);
    } catch (error) {
      status(
        "refused",
        `${error instanceof Error ? error.message : "Operation refused"} Previous source bytes retained.`,
      );
    } finally {
      busy = false;
      for (const control of element("rstep-controls").querySelectorAll<HTMLInputElement>(
        "button,input,select",
      ))
        control.disabled = false;
      element<HTMLButtonElement>("rstep-save").disabled = sidecar === null;
    }
  }
  function setBounds(bounds: readonly number[]): void {
    ["west", "south", "east", "north"].forEach((name, index) => {
      element<HTMLInputElement>(`rstep-${name}`).value = String(bounds[index]);
    });
  }
  function aoi(): Polygon | MultiPolygon {
    return (
      retainedAoi ??
      createRstepAoi(
        ["west", "south", "east", "north"].map((name) => element<HTMLInputElement>(`rstep-${name}`).value),
      )
    );
  }
  function renderMap(): void {
    const features: RstepMapFeature[] =
      surface === null ? [] : interpolationMapFeatures(surface, checked("rstep-interpolation-visible"));
    for (const layer of selectedLayers()) {
      for (const feature of layer.document.features)
        features.push({
          id: `${layer.document.layer_id}:${feature.id}`,
          geometry: feature.analysis_geometry,
          color:
            feature.data_center !== null
              ? "#c29bff"
              : layer.document.kind === "resource"
                ? "#67d8e8"
                : layer.document.kind === "context"
                  ? "#65e2ae"
                  : "#ffc15c",
          visible:
            checked("rstep-visibility") &&
            enabled.get(layer.document.layer_id) !== false &&
            (feature.data_center === null || checked("rstep-datacenters")),
        });
    }
    try {
      features.push({
        id: "aoi",
        geometry: sidecar !== null && currentScenario !== null ? currentScenario.aoi : aoi(),
        color: "#ffffff",
        visible: checked("rstep-visibility"),
        opacity:
          surface !== null && surface.validCells > 0 && checked("rstep-interpolation-visible") ? 0 : 0.48,
      });
    } catch {
      /* Invalid edits have no rendered AOI. */
    }
    map.render(features);
  }
  function renderSources(): void {
    invalidateInterpolation();
    refreshInterpolationChoices();
    const list = element("rstep-layers");
    list.replaceChildren();
    for (const layer of selectedLayers()) {
      const doc = layer.document;
      const card = text("div", "");
      card.className = "rstep-layer";
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = enabled.get(doc.layer_id) !== false;
      input.addEventListener("change", () => {
        enabled.set(doc.layer_id, input.checked);
        stale();
        renderMap();
      });
      label.append(input, document.createTextNode(` ${doc.name}`));
      const remove = text("button", "Remove") as HTMLButtonElement;
      remove.type = "button";
      remove.addEventListener("click", () => {
        layers = layers.filter((item) => item.document.layer_id !== doc.layer_id);
        permissions.delete(doc.layer_id);
        stale();
        renderSources();
        renderScenarios();
        renderMap();
      });
      card.append(
        label,
        text(
          "p",
          `${doc.source.publisher} • edition ${doc.source.edition} • ${doc.coverage.completeness} query • ${layer.featureCount} source representations`,
        ),
        text("p", doc.coverage.statement),
        details("Source, recipe, coverage and custody", {
          source: doc.source,
          preparation: doc.preparation,
          native_crs: doc.native_crs,
          analysis_crs: doc.analysis_crs,
          measurement: doc.measurement,
          custody: doc.custody,
          exact_sha256: layer.exactSha256,
        }),
        remove,
      );
      const records = document.createElement("select");
      records.setAttribute("aria-label", `Inspect record from ${doc.name}`);
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "Select a source record…";
      records.append(placeholder);
      for (const feature of doc.features) {
        const option = document.createElement("option");
        option.value = feature.id;
        option.textContent = feature.id;
        records.append(option);
      }
      records.addEventListener("change", () => {
        const feature = doc.features.find((item) => item.id === records.value);
        if (feature !== undefined) {
          const recordDetails = details(
            "Retained source record and normalized measurements",
            feature,
          ) as HTMLDetailsElement;
          recordDetails.open = true;
          element("rstep-source-inspector").replaceChildren(
            text("p", `${doc.source.title} • ${doc.source.edition}`),
            recordDetails,
          );
          const display = transformGeometry(feature.analysis_geometry, "EPSG:5070", "EPSG:4326");
          let west = Infinity,
            south = Infinity,
            east = -Infinity,
            north = -Infinity;
          visitGeometryPositions(display, (position) => {
            west = Math.min(west, position[0] ?? NaN);
            east = Math.max(east, position[0] ?? NaN);
            south = Math.min(south, position[1] ?? NaN);
            north = Math.max(north, position[1] ?? NaN);
          });
          if (west === east || south === north) scene.focusLongitudeLatitudePoint([west, south], 100);
          else scene.focusLongitudeLatitudeBounds([west, south, east, north], 1_000);
        }
      });
      card.append(records);
      list.append(card);
    }
    renderContext();
  }
  function renderContext(): void {
    const resources = element("rstep-resources");
    resources.replaceChildren();
    const centers = element("rstep-data-center-inspection");
    centers.replaceChildren();
    let resourceCount = 0,
      dcCount = 0;
    for (const layer of selectedLayers()) {
      const doc = layer.document;
      if (doc.kind === "resource") {
        resources.append(
          text(
            "p",
            `${doc.name} • ${doc.measurement.support} • ${doc.measurement.native_resolution.description}`,
          ),
        );
        for (const feature of doc.features)
          for (const measurement of feature.measurements) {
            const match =
              value("rstep-technology") === "wind" ? /wind|WS50M/i : /solar|irradiance|shortwave|ALLSKY/i;
            if (!match.test(measurement.quantity + measurement.id)) continue;
            resourceCount += 1;
            resources.append(
              text(
                "p",
                `${measurement.quantity}: ${measurement.value === null ? `unknown (${measurement.absence})` : measurement.value} ${measurement.unit}; ${measurement.period}; ${measurement.status}. Support: ${measurement.support}. Reference source record: ${measurement.source_record_id}.`,
              ),
            );
          }
      }
      if (doc.features.some((feature) => feature.data_center !== null)) {
        dcCount += 1;
        const summary = summarizeDataCenters(doc);
        try {
          const query = queryDataCenters(doc, aoi());
          const view = text(
            "p",
            `AOI inventory: ${query.evaluation}; ${query.representations} mapped representations / ${query.canonical_sites} mapped sites. Whole AOI coverage: ${query.coverage_complete ? "complete for this source inventory" : "unknown or incomplete"}. Matched source records: ${query.matched_source_ids.join(", ") || "none"}. No facility-absence conclusion; demand remains source-specific and unknown where unreported.`,
          );
          view.className = "rstep-dc-aoi";
          view.dataset.evaluation = query.evaluation;
          view.dataset.coverageComplete = String(query.coverage_complete);
          centers.append(view);
        } catch {
          centers.append(text("p", "AOI inventory query unavailable for the current bounds."));
        }
        centers.append(
          text(
            "p",
            `${doc.name}: ${summary.representations} mapped representations / ${summary.canonical_sites} mapped sites in this source/coverage. ${summary.unknown_demand_records} demand records unknown. Not an exhaustive state total; no demand sum or exclusion score.`,
          ),
          details("Data-center provenance and limitations", {
            source: doc.source,
            coverage: doc.coverage,
            measurement: doc.measurement,
            limitations: doc.preparation.limitations,
          }),
        );
      }
    }
    if (resourceCount === 0)
      resources.append(
        text("p", "Resource summary unavailable for this state and technology; missing is not zero."),
      );
    if (dcCount === 0)
      centers.append(
        text(
          "p",
          "Data-center records unavailable in the selected state packages. No facility-absence conclusion.",
        ),
      );
  }
  function renderResult(): void {
    const target = element("rstep-results");
    target.replaceChildren();
    if (result === null) {
      target.append(text("p", "No screening result."));
      return;
    }
    target.append(
      text("h3", result.conclusion),
      text(
        "p",
        "This is a selected-rule remainder, not development clearance. Coverage gaps and unresolved review remain unknown.",
      ),
    );
    const area = document.createElement("dl");
    for (const [name, amount] of Object.entries(result.area))
      area.append(
        text("dt", name.replaceAll("_square_metres", " (m²)").replaceAll("_", " ")),
        text("dd", amount.toLocaleString("en-US", { maximumFractionDigits: 2 })),
      );
    target.append(area);
    for (const finding of result.findings) {
      const card = text("div", "");
      card.className = "rstep-reason";
      card.append(
        text("strong", finding.rule_id),
        text(
          "p",
          `Basis: ${finding.basis}. Applicability: ${finding.applicability}. Evaluation: ${finding.evaluation}. Treatment: ${finding.treatment}.`,
        ),
        text("p", finding.message),
        details("Rule and all matched source identities", {
          finding,
          rule: currentScenario?.rules.find((rule) => rule.id === finding.rule_id),
        }),
      );
      target.append(card);
    }
    for (const warning of result.warnings) target.append(text("p", warning));
    target.append(
      details("Deterministic execution identity", {
        result_id: result.result_id,
        recipe_id: result.recipe_id,
        source_layer_digests: result.source_layer_digests,
      }),
    );
  }
  function renderScenarios(): void {
    const select = element<HTMLSelectElement>("rstep-scenario");
    select.replaceChildren();
    for (const scenario of scenarios) {
      const option = document.createElement("option");
      option.value = scenario.id;
      const available = [...scenario.layer_bindings, ...scenario.overlay_bindings].every((binding) =>
        layers.some(
          (layer) =>
            layer.document.layer_id === binding.layer_id && layer.document.revision === binding.revision,
        ),
      );
      option.textContent = `${scenario.name}${available ? "" : " — source edition unavailable"}`;
      option.disabled = !available;
      select.append(option);
    }
    select.value = currentScenario?.id ?? "";
  }
  async function recompute(): Promise<void> {
    const selected = selectedLayers();
    if (selected.length === 0) throw new Error("No source layer is installed for this state.");
    const id = `rstep.${++sequence}`;
    const technology = value("rstep-technology");
    const treatment = value("rstep-treatment");
    const scenario = createScenario({
      schema_version: "geobase.rstep-scenario/1",
      id,
      revision: "1",
      name: `${state()} ${technology} / ${treatment} / ${sequence}`,
      technology,
      jurisdiction: state(),
      aoi: aoi(),
      analysis_crs: "EPSG:5070",
      project_inputs: { method: "bounded inventory scenario; no legal clearance" },
      layer_bindings: selected
        .filter((layer) => layer.document.kind !== "partner_overlay")
        .map((layer) => ({
          layer_id: layer.document.layer_id,
          revision: layer.document.revision,
          enabled: enabled.get(layer.document.layer_id) !== false,
        })),
      overlay_bindings: selected
        .filter((layer) => layer.document.kind === "partner_overlay")
        .map((layer) => ({
          layer_id: layer.document.layer_id,
          revision: layer.document.revision,
          enabled: enabled.get(layer.document.layer_id) !== false,
        })),
      rules: selected
        .filter((layer) => layer.document.kind === "constraint" || layer.document.kind === "partner_overlay")
        .map((layer) => ({
          id: `overlap.${layer.document.layer_id}`,
          revision: "1",
          name: `Scenario overlap: ${layer.document.name}`,
          basis: "custodian_or_scenario_avoidance",
          technology: ["wind", "solar"],
          jurisdictions: layer.document.coverage.states,
          layer_id: layer.document.layer_id,
          layer_revision: layer.document.revision,
          geometry_operation: "overlap",
          buffer_metres: null,
          treatment,
          project_requirements: [],
          exceptions: [],
          citation: layer.document.source.uri,
          limitations: [
            "This inventory supports an explicit scenario assumption only; no legal applicability or development clearance has been established.",
            ...layer.document.preparation.limitations,
          ],
        })),
    });
    const nextResult = await evaluateScreening({ aoi: scenario.aoi, scenario, layers });
    // Historical snapshots remain separate; missing/replaced editions invalidate their exact replay.
    const nextScenarios = [...scenarios, scenario];
    const nextSidecar = await createSidecar({
      projectSha256: null,
      layers: layers.filter((layer) => layer.document.kind !== "partner_overlay"),
      overlays: layers
        .filter((layer) => layer.document.kind === "partner_overlay")
        .map((layer) => {
          const permission = permissions.get(layer.document.layer_id);
          if (permission === undefined) throw new Error("Overlay permission is unknown.");
          return { layer, permission };
        }),
      scenarios: nextScenarios,
      activeScenarioId: scenario.id,
      stableResult: nextResult,
    });
    currentScenario = scenario;
    retainedAoi = scenario.aoi;
    scenarios = nextScenarios;
    result = nextResult;
    sidecar = nextSidecar;
    renderResult();
    renderScenarios();
    renderMap();
    renderContext();
    const bounds = ["west", "south", "east", "north"].map((name) =>
      Number(element<HTMLInputElement>(`rstep-${name}`).value),
    ) as [number, number, number, number];
    focusRstepArea(scene, bounds, "oblique");
    status(
      "current",
      "Screening is current for the exact selected inputs. Areas use EPSG:5070 square metres.",
    );
  }
  async function importLayers(): Promise<void> {
    const selection = await window.geobase.openRstepLayers();
    if (selection.canceled) return;
    const staged = [...layers];
    const nextPermissions = new Map(permissions);
    for (const contents of selection.contents) {
      const layer = await parseSourceLayer(contents);
      const prior = staged.findIndex((item) => item.document.layer_id === layer.document.layer_id);
      if (
        prior >= 0 &&
        staged[prior]?.document.revision === layer.document.revision &&
        staged[prior]?.exactSha256 !== layer.exactSha256
      )
        throw new Error("Layer ID and revision have changed bytes; a new explicit revision is required.");
      if (prior >= 0 && staged[prior]?.exactSha256 !== layer.exactSha256 && !checked("rstep-replace-file"))
        throw new Error("Same layer ID has different bytes; select explicit replacement first.");
      if (layer.document.kind === "partner_overlay") {
        const permission = value("rstep-overlay-authorization");
        if (permission !== "synthetic_authorized" && permission !== "public_fixture_authorized") {
          const options = element("rstep-overlay-authorization").closest("details");
          if (options !== null) options.open = true;
          throw new Error("Partner overlay permission is unknown; import refused.");
        }
        nextPermissions.set(layer.document.layer_id, {
          status: permission,
          custodian: layer.document.custody.ownership,
          intended_scope: "Owner-authorized local prototype fixture only",
        });
      }
      if (prior >= 0) staged[prior] = layer;
      else staged.push(layer);
    }
    if (
      staged.length > 20 ||
      staged.reduce((sum, layer) => sum + layer.vertexCount, 0) > 1_000_000 ||
      staged.reduce((sum, layer) => sum + layer.exactBytes, 0) > 128 * 1024 * 1024
    )
      throw new Error("Active source budget exceeded; selection refused.");
    layers = staged;
    permissions = nextPermissions;
    sidecar = null;
    // Keep prior snapshots; missing editions are explicit unavailable entries.
    renderScenarios();
    renderSources();
    renderMap();
    status("ready", "Exact source layers validated. Recompute after selecting the AOI and scenario.");
  }
  async function openWorkspace(): Promise<void> {
    const selection = await window.geobase.openRstep();
    if (selection.canceled) return;
    const contents = selection.contents[0];
    if (contents === undefined) throw new Error("Workspace is empty.");
    const next = await parseSidecar(contents);
    const replay = await replaySidecar(next);
    const parsed = await Promise.all(
      [...next.layers, ...next.overlays].map((snapshot) => parseSourceLayer(snapshot.exact_json)),
    );
    const scenario = next.scenarios.find((item) => item.id === next.active_scenario_id);
    if (scenario === undefined) throw new Error("Active scenario is missing.");
    layers = parsed;
    permissions = new Map(next.overlays.map((overlay) => [overlay.layer_id, overlay.permission]));
    scenarios = next.scenarios;
    sequence = Math.max(
      sequence,
      scenarios.length,
      ...scenarios.map((item) => {
        const match = /^rstep\.(\d+)$/u.exec(item.id);
        const parsed = match === null ? 0 : Number(match[1]);
        return Number.isSafeInteger(parsed) ? parsed : 0;
      }),
    );
    currentScenario = scenario;
    sidecar = next;
    result = replay;
    applyScenarioControls(scenario);
    renderSources();
    renderScenarios();
    renderResult();
    renderMap();
    status("current", "Exact source, scenario and deterministic result replay verified offline.");
    focusArea("oblique");
  }
  function applyScenarioControls(scenario: RstepScenario): void {
    retainedAoi = scenario.aoi;
    element<HTMLSelectElement>("rstep-state").value = scenario.jurisdiction;
    element<HTMLSelectElement>("rstep-technology").value = scenario.technology;
    element<HTMLSelectElement>("rstep-treatment").value = scenario.rules[0]?.treatment ?? "context";
    enabled = new Map(
      [...scenario.layer_bindings, ...scenario.overlay_bindings].map((binding) => [
        binding.layer_id,
        binding.enabled,
      ]),
    );
    const display = transformGeometry(scenario.aoi, "EPSG:5070", "EPSG:4326");
    const x: number[] = [],
      y: number[] = [];
    visitGeometryPositions(display, (position) => {
      x.push(position[0] ?? NaN);
      y.push(position[1] ?? NaN);
    });
    setBounds([Math.min(...x), Math.min(...y), Math.max(...x), Math.max(...y)]);
  }
  element("rstep-mode").addEventListener("click", () => {
    active = !active;
    document.body.dataset.workspace = active ? "rstep" : "legacy";
    element("rstep-mode").setAttribute("aria-pressed", String(active));
    map.activate(active);
    if (active) {
      renderMap();
      element("rstep-open-layers").focus();
    }
  });
  element("rstep-open-layers").addEventListener("click", () => {
    void action(importLayers);
  });
  element("rstep-view-oblique").addEventListener("click", () => focusArea("oblique"));
  element("rstep-view-overhead").addEventListener("click", () => focusArea("overhead"));
  element("rstep-interpolate").addEventListener("click", previewInterpolation);
  element("rstep-interpolation-visible").addEventListener("change", renderMap);
  for (const id of [
    "rstep-interpolation-layer",
    "rstep-interpolation-measurement",
    "rstep-interpolation-cell",
    "rstep-interpolation-radius",
  ])
    element(id).addEventListener("change", () => {
      invalidateInterpolation();
      if (id === "rstep-interpolation-layer") refreshInterpolationMeasurements();
      renderMap();
    });
  element("rstep-open").addEventListener("click", () => {
    void action(openWorkspace);
  });
  element("rstep-recompute").addEventListener("click", () => {
    void action(recompute);
  });
  element("rstep-save").addEventListener("click", () => {
    void action(async () => {
      if (sidecar === null) throw new Error("Recompute before saving.");
      const saved = await window.geobase.saveRstep(serializeSidecar(sidecar));
      if (!saved.canceled)
        status(
          "saved",
          "Exact workspace saved locally. Source custody metadata retained; enforcement remains bypassed.",
        );
    });
  });
  element("rstep-state").addEventListener("change", () => {
    retainedAoi = null;
    setBounds(DEFAULT_BOUNDS[state()]);
    stale();
    renderSources();
    renderMap();
  });
  for (const id of [
    "rstep-technology",
    "rstep-treatment",
    "rstep-west",
    "rstep-south",
    "rstep-east",
    "rstep-north",
  ])
    element(id).addEventListener("change", () => {
      if (["rstep-west", "rstep-south", "rstep-east", "rstep-north"].includes(id)) retainedAoi = null;
      stale();
      renderContext();
      renderMap();
    });
  for (const id of ["rstep-visibility", "rstep-datacenters"])
    element(id).addEventListener("change", renderMap);
  element("rstep-scenario").addEventListener("change", () => {
    void action(async () => {
      const scenario = scenarios.find((item) => item.id === value("rstep-scenario"));
      if (scenario === undefined) return;
      const replayed = await evaluateScreening({ aoi: scenario.aoi, scenario, layers });
      currentScenario = scenario;
      applyScenarioControls(scenario);
      result = replayed;
      sidecar = null;
      renderSources();
      renderResult();
      renderMap();
      status("stale", "Stored scenario inspected. Recompute a new snapshot before saving.");
    });
  });
  setBounds(DEFAULT_BOUNDS.WA);
  refreshInterpolationChoices();
}
