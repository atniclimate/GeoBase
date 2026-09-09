import type { BaselinePresentation, BaselineProbe } from "../core/baseline/manifest";

function element<T extends HTMLElement>(id: string): T {
  const result = document.getElementById(id);
  if (result === null) throw new Error(`Missing DEM control ${id}`);
  return result as T;
}

export function renderDemPanel(baseline: BaselinePresentation | null): void {
  for (const id of ["dem-section", "dem-inspector", "dem-coverage-view"])
    element(id).hidden = baseline === null;
  const details = element("dem-metadata");
  details.replaceChildren();
  element("dem-probe-result").textContent = "Select a cell to inspect.";
  if (baseline === null) {
    delete document.body.dataset.demPackage;
    element("terrain-toggle-label").textContent = "Procedural terrain";
    element("reset-camera").textContent = "Reset fixture view";
    element("terrain-attribution-title").textContent = "Local procedural reference grid";
    element("terrain-attribution-context").textContent =
      "WA-region frame is authored context, not an authoritative boundary.";
    element("terrain-attribution-detail").textContent =
      "Terrain heights are deterministic visual test values, not measured elevation.";
    return;
  }
  const { manifest, binding, display } = baseline;
  const { grid } = manifest;
  const bounds = [
    grid.affine[0],
    grid.affine[3] + grid.height * grid.affine[5],
    grid.affine[0] + grid.width * grid.affine[1],
    grid.affine[3],
  ];
  const entries = [
    ["Package", `${manifest.title} • ${manifest.package_id}`],
    ["Edition", manifest.edition],
    [
      "Producer / source",
      `${manifest.source.producer} • ${manifest.source.product} • ${manifest.source.edition}`,
    ],
    ["Native horizontal CRS", grid.horizontal_crs],
    ["Native vertical reference / units", `${grid.vertical_reference} • ${grid.unit}`],
    [
      "Native support",
      `${grid.width} columns × ${grid.height} rows; ${grid.native_resolution.map((value) => value.toPrecision(9)).join(" × ")} degrees per source cell. Display detail does not increase scientific resolution.`,
    ],
    [
      "Coverage bounds",
      `Native west, south, east, north: ${bounds.map((value) => value.toFixed(9)).join(", ")}. Outside coverage is unavailable.`,
    ],
    [
      "NoData",
      `${grid.nodata === null ? "No numeric sentinel" : `Source sentinel ${grid.nodata}`}; explicit 0/1 mask retained. Missing cells are holes, never zero. Triangles touching a masked cell are omitted; display support stops at sampled cell centers.`,
    ],
    [
      "Display",
      `Relative relief; source reference ${display.height_reference_m} m subtracted. Exaggeration ×1. ${display.interpolation}. No vertical-datum conversion. Dark background means no displayed elevation.`,
    ],
    ["Attribution", manifest.source.attribution],
    ["Local use", manifest.source.rights],
    [
      "Custody",
      "Effective T3; local project only. Export and network remain blocked for this session. Metadata retained; sovereignty enforcement remains bypassed.",
    ],
    ["Exact manifest SHA-256", binding.manifest_sha256],
    ["Original source SHA-256", binding.source_sha256],
    ["Recipe SHA-256", binding.recipe_id],
  ];
  for (const [term, value] of entries) {
    const dt = document.createElement("dt");
    dt.textContent = term ?? "";
    const dd = document.createElement("dd");
    dd.textContent = value ?? "";
    details.append(dt, dd);
  }
  element("dem-kind").textContent =
    manifest.kind === "measured"
      ? "MEASURED public-source elevation"
      : "SYNTHETIC elevation fixture — not measured";
  element("dem-provenance").textContent = JSON.stringify(
    { source: manifest.source, grid, recipe: manifest.recipe },
    null,
    2,
  );
  element("terrain-toggle-label").textContent = "Local DEM relief";
  element("reset-camera").textContent = "Oblique DEM view";
  element("terrain-attribution-title").textContent =
    `${manifest.kind === "measured" ? "Measured" : "Synthetic"} local DEM • ${manifest.edition}`;
  element("terrain-attribution-context").textContent =
    "Native values in inspector. DEM is context only; bundled siting rules do not analyze its elevations.";
  element("terrain-attribution-detail").textContent =
    `Relative relief ×1 • reference ${display.height_reference_m} m subtracted • no vertical conversion • dark holes/outside are unavailable.`;
  document.body.dataset.demPackage = "verified";
  document.body.dataset.demEdition = manifest.edition;
}

export function renderDemProbe(probe: BaselineProbe): void {
  const result = element("dem-probe-result");
  result.dataset.status = probe.status;
  result.dataset.value = probe.value === null ? "" : String(probe.value);
  const location =
    probe.row === null
      ? "Outside native raster coverage"
      : `Native row ${probe.row}, column ${probe.column}; center ${probe.x}, ${probe.y}`;
  const value =
    probe.value === null
      ? probe.status === "source_null"
        ? "NoData — source null; no numeric elevation"
        : "Unavailable — no source coverage"
      : `${probe.value} ${probe.unit}${probe.status === "observed_zero" ? " — valid observed zero" : " — observed elevation"}`;
  result.textContent = `${location}. ${value}. Vertical reference: ${probe.vertical_reference}. Value product: ${probe.value_product}.`;
  result.dataset.pending = "false";
}
