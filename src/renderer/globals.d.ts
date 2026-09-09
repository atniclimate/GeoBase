declare const __APP_VERSION__: string;
declare const __APP_COMMIT__: string;
declare var CESIUM_BASE_URL: string;

type ReadDialogResult =
  | { canceled: true }
  | {
      canceled: false;
      path: string;
      contents: string;
      bytesRead: number;
      exactBytesSha256: string;
      baseline?: import("../core/baseline/manifest").BaselinePresentation;
      activationToken: string;
    };

type WriteDialogResult = { canceled: true } | { canceled: false; path: string; bytesWritten: number };

type WaTribalContextDialogResult =
  | { canceled: true }
  | {
      bytesRead: number;
      canceled: false;
      context: import("../core/tribal/presentation").TribalPresentationContext;
      exactBytesSha256: string;
    };

interface GeoBaseDesktopApi {
  openRstepLayers(): Promise<import("../electron/ipc-contract").RstepReadResult>;
  openRstep(): Promise<import("../electron/ipc-contract").RstepReadResult>;
  saveRstep(contents: string): Promise<WriteDialogResult>;
  openProject(): Promise<ReadDialogResult>;
  openWaTribalContext(activationToken?: string): Promise<WaTribalContextDialogResult>;
  completePackageActivation(activationToken: string, contents: string): Promise<void>;
  discardPackageActivation(activationToken: string): Promise<void>;
  releaseBaselinePackage(): Promise<void>;
  openBaselinePackage(): Promise<import("../electron/ipc-contract").BaselineDialogResult>;
  cancelBaselineLoad(): Promise<void>;
  probeBaseline(
    query: import("../core/baseline/manifest").BaselineQuery,
  ): Promise<import("../core/baseline/manifest").BaselineProbe>;
  saveProject(contents: string, suggestedName?: string): Promise<WriteDialogResult>;
  importGeoJson(): Promise<ReadDialogResult>;
  exportGeoJson(contents: string, suggestedName?: string): Promise<WriteDialogResult>;
  getSecurityReceipt(): Promise<import("../electron/ipc-contract").RuntimeSecurityReceipt>;
}

interface Window {
  geobase: GeoBaseDesktopApi;
}
