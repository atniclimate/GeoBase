import { contextBridge, ipcRenderer } from "electron";

const MAXIMUM_TEXT_CHARACTERS = 128 * 1024 * 1024;

function checkedContents(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("File contents must be text.");
  if (value.length > MAXIMUM_TEXT_CHARACTERS) throw new RangeError("File contents exceed the desktop limit.");
  return value;
}

function checkedSuggestedName(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new TypeError("The suggested file name must be text.");
  return value;
}

const api = Object.freeze({
  openRstepLayers: () => ipcRenderer.invoke("geobase:rstep:layers:open"),
  openRstep: () => ipcRenderer.invoke("geobase:rstep:open"),
  saveRstep: (contents: unknown) => ipcRenderer.invoke("geobase:rstep:save", checkedContents(contents)),
  openProject: () => ipcRenderer.invoke("geobase:project:open"),
  openWaTribalContext: (activationToken?: unknown) =>
    ipcRenderer.invoke("geobase:wa-tribal-context:open", activationToken),
  openBaselinePackage: () => ipcRenderer.invoke("geobase:baseline:open"),
  cancelBaselineLoad: () => ipcRenderer.invoke("geobase:baseline:cancel"),
  probeBaseline: (query: unknown) => ipcRenderer.invoke("geobase:baseline:probe", query),
  completePackageActivation: (activationToken: unknown, contents: unknown) =>
    ipcRenderer.invoke("geobase:package:complete", activationToken, checkedContents(contents)),
  discardPackageActivation: (activationToken: unknown) =>
    ipcRenderer.invoke("geobase:package:discard", activationToken),
  releaseBaselinePackage: () => ipcRenderer.invoke("geobase:baseline:release"),
  saveProject: (contents: unknown, suggestedName?: unknown) =>
    ipcRenderer.invoke("geobase:project:save", {
      contents: checkedContents(contents),
      suggestedName: checkedSuggestedName(suggestedName),
    }),
  importGeoJson: () => ipcRenderer.invoke("geobase:geojson:import"),
  exportGeoJson: (contents: unknown, suggestedName?: unknown) =>
    ipcRenderer.invoke("geobase:geojson:export", {
      contents: checkedContents(contents),
      suggestedName: checkedSuggestedName(suggestedName),
    }),
  getSecurityReceipt: () => ipcRenderer.invoke("geobase:security:receipt"),
});

contextBridge.exposeInMainWorld("geobase", api);
