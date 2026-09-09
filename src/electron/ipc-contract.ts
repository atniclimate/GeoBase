import type { BaselinePresentation } from "../core/baseline/manifest.js";
import type { TribalPresentationContext } from "../core/tribal/presentation.js";
import type { RequestPolicyReason } from "./security-policy.js";

export const IPC_CHANNELS = Object.freeze({
  openRstepLayers: "geobase:rstep:layers:open",
  openRstep: "geobase:rstep:open",
  saveRstep: "geobase:rstep:save",
  openProject: "geobase:project:open",
  openWaTribalContext: "geobase:wa-tribal-context:open",
  openBaselinePackage: "geobase:baseline:open",
  cancelBaselineLoad: "geobase:baseline:cancel",
  probeBaseline: "geobase:baseline:probe",
  completePackageActivation: "geobase:package:complete",
  discardPackageActivation: "geobase:package:discard",
  releaseBaselinePackage: "geobase:baseline:release",
  saveProject: "geobase:project:save",
  importGeoJson: "geobase:geojson:import",
  exportGeoJson: "geobase:geojson:export",
  securityReceipt: "geobase:security:receipt",
});

export type RstepReadResult = { canceled: true } | { canceled: false; contents: string[] };

export type DialogReadResult =
  | { canceled: true }
  | {
      canceled: false;
      path: string;
      contents: string;
      bytesRead: number;
      exactBytesSha256: string;
      baseline?: BaselinePresentation;
      activationToken: string;
    };

export type BaselineDialogResult =
  | { canceled: true }
  | {
      canceled: false;
      baseline: BaselinePresentation;
      verifiedBytes: number;
      openingMilliseconds: number;
      activationToken: string;
    };

export type DialogWriteResult = { canceled: true } | { canceled: false; path: string; bytesWritten: number };

export type WaTribalContextDialogResult =
  | { canceled: true }
  | {
      bytesRead: number;
      canceled: false;
      context: TribalPresentationContext;
      exactBytesSha256: string;
    };

export interface WriteTextRequest {
  contents: string;
  suggestedName?: string;
}

export interface RequestObservation {
  observedAt: string;
  resourceType: string;
  sanitizedUrl: string;
  allowed: boolean;
  reason: RequestPolicyReason;
}

export interface RuntimeSecurityReceipt {
  receiptVersion: 1;
  capturedAt: string;
  applicationOrigin: "geobase://app";
  rendererEntry: "standard" | "rstep-demo-spike";
  explicitDevelopmentMode: boolean;
  renderer: {
    contextIsolation: true;
    sandbox: true;
    nodeIntegration: false;
    webSecurity: true;
  };
  controls: {
    permissionsDenied: true;
    navigationDenied: true;
    newWindowsDenied: true;
    remoteRequestsCanceled: true;
    telemetryEnabled: false;
    userSelectedFilesOnly: boolean;
    networkDriveDestinationsDenied: true;
    developmentLoopbackAllowed: boolean;
    restrictedContextNetworkLatched: boolean;
    exportAllowed: boolean;
    testLocalAssetAllowlistEnforced: boolean;
    testLocalAssetMaximumBytes: number | null;
    testLocalAssetMountActive: boolean;
  };
  cumulative: {
    deniedRequests: number;
    httpHttpsRequests: number;
    observationsRecorded: number;
    testLocalAssetRequests: number;
  };
  observations: readonly RequestObservation[];
  limitations: readonly string[];
}
