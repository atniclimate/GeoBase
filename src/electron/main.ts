import { randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  type IpcMainInvokeEvent,
  ipcMain,
  Menu,
  protocol,
  type Session,
  session,
} from "electron";
import {
  type BaselineBinding,
  type BaselineQuery,
  probeBaseline,
  verifyBaselineBinding,
} from "../core/baseline/manifest.js";
import type { TsdfSource, TsdfTierDefinition } from "../core/governance/tsdf-source.js";
import {
  type ProjectWaTribalContextBinding,
  parseProject,
  serializeProject,
  verifyProjectWaTribalContextBinding,
} from "../core/project.js";
import type { TribalPresentationContext } from "../core/tribal/presentation.js";
import { parseSourceLayer } from "../core/source-layer/index.js";
import { readRstepLocalText } from "./rstep-files.js";
import { parseSidecar, replaySidecar, sidecarContentDigests } from "../core/rstep/index.js";
import type { WaTribalSourceProfile } from "../core/tribal/source-profile.js";
import { baselinePresentation, type LoadedBaselinePackage, loadBaselinePackage } from "./baseline-package.js";
import {
  IPC_CHANNELS,
  type RequestObservation,
  type RuntimeSecurityReceipt,
  type WriteTextRequest,
} from "./ipc-contract.js";
import {
  atomicWriteUserSelectedUtf8File,
  readUserSelectedUtf8File,
  resolveApprovedLocalDirectory,
  resolveUserSelectedLocalFile,
} from "./local-files.js";
import {
  configurePackagedWindowsRuntimePaths,
  createWindowsLocalRuntimePaths,
  queryWindowsLocalAppData,
} from "./local-runtime-paths.js";
import { loadBoundedMountedLocalAsset } from "./mounted-local-asset.js";
import {
  decideRendererEntry,
  type RendererEntryId,
  RSTEP_DEMO_ASSET_PREFIX,
  RSTEP_DEMO_MAX_LOCAL_ASSET_BYTES,
  routeRstepDemoAsset,
} from "./renderer-entry.js";
import {
  APPLICATION_ORIGIN,
  APPLICATION_SCHEME,
  decideRuntimeRequest,
  isPathWithinRoot,
  isTrustedApplicationUrl,
  resolveApplicationProtocolPath,
  SessionNetworkPolicy,
  sanitizeObservedRequest,
} from "./security-policy.js";
import { loadTrustedWaRstepTsdfSource, loadTrustedWaTribalSourceProfile } from "./trusted-wa-governance.js";
import { assertTrustedWaTribalTsdfProfile, loadWaTribalContextFromGeoPackage } from "./wa-tribal-context.js";

const RENDERER_ROOT = fileURLToPath(new URL("../renderer/", import.meta.url));
const PRELOAD_PATH = fileURLToPath(new URL("./preload.cjs", import.meta.url));
const MAXIMUM_OBSERVATIONS = 256;
const MAXIMUM_TEXT_CHARACTERS = 128 * 1024 * 1024;
const GEOJSON_TYPES = new Set([
  "FeatureCollection",
  "Feature",
  "GeometryCollection",
  "Point",
  "MultiPoint",
  "LineString",
  "MultiLineString",
  "Polygon",
  "MultiPolygon",
]);

protocol.registerSchemesAsPrivileged([
  {
    scheme: APPLICATION_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      codeCache: true,
    },
  },
]);
app.enableSandbox();
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("disable-component-update");
app.commandLine.appendSwitch("disable-domain-reliability");
app.commandLine.appendSwitch("disable-sync");
app.commandLine.appendSwitch("no-proxy-server");

class RequestObservationLog {
  #deniedRequests = 0;

  #httpHttpsRequests = 0;

  #testLocalAssetRequests = 0;

  readonly #observations: RequestObservation[] = [];

  #observationsRecorded = 0;

  public record(
    url: string,
    allowed: boolean,
    reason: RequestObservation["reason"],
    resourceType: string,
  ): void {
    this.#observationsRecorded += 1;
    if (!allowed) this.#deniedRequests += 1;
    let protocol = "";
    try {
      protocol = new URL(url).protocol.toLowerCase();
    } catch {
      // Invalid request URLs are still retained as denied observations.
    }
    if (protocol === "http:" || protocol === "https:") this.#httpHttpsRequests += 1;
    if (reason === "test-local-asset") this.#testLocalAssetRequests += 1;
    this.#observations.push({
      observedAt: new Date().toISOString(),
      resourceType,
      sanitizedUrl: sanitizeObservedRequest(url),
      allowed,
      reason,
    });
    if (this.#observations.length > MAXIMUM_OBSERVATIONS) this.#observations.shift();
  }

  public snapshot(): readonly RequestObservation[] {
    return this.#observations.map((observation) => ({ ...observation }));
  }

  public cumulative(): RuntimeSecurityReceipt["cumulative"] {
    return {
      deniedRequests: this.#deniedRequests,
      httpHttpsRequests: this.#httpHttpsRequests,
      observationsRecorded: this.#observationsRecorded,
      testLocalAssetRequests: this.#testLocalAssetRequests,
    };
  }
}

function mimeType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
    case ".geojson":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".ico":
      return "image/x-icon";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    case ".wasm":
      return "application/wasm";
    case ".xml":
      return "application/xml; charset=utf-8";
    case ".glb":
      return "model/gltf-binary";
    case ".gltf":
      return "model/gltf+json";
    case ".ktx2":
      return "image/ktx2";
    case ".terrain":
      return "application/vnd.quantized-mesh";
    default:
      return "application/octet-stream";
  }
}

function securityHeaders(filePath: string, byteLength: number): Record<string, string> {
  return {
    "Content-Type": mimeType(filePath),
    "Content-Length": String(byteLength),
    "Content-Security-Policy": [
      "default-src 'self'",
      "base-uri 'none'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'none'",
      "script-src 'self' 'wasm-unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "worker-src 'self' blob:",
      "manifest-src 'self'",
    ].join("; "),
    "Cross-Origin-Opener-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

function response(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function installApplicationProtocol(
  secureSession: Session,
  observations: RequestObservationLog,
  localAssetMount?: { realRoot: string; virtualPrefix: string },
): Promise<void> {
  if (localAssetMount !== undefined && localAssetMount.virtualPrefix !== RSTEP_DEMO_ASSET_PREFIX) {
    throw new Error("Unsupported local asset mount prefix.");
  }
  const realRendererRoot = await realpath(RENDERER_ROOT);
  const realLocalAssetRoot =
    localAssetMount === undefined ? undefined : await realpath(localAssetMount.realRoot);
  await secureSession.protocol.handle(APPLICATION_SCHEME, async (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      observations.record(request.url, false, "scheme-disabled", "protocol");
      return response(405, "Method not allowed");
    }

    const resolution = resolveApplicationProtocolPath(request.url, realRendererRoot);
    if (!resolution.allowed) {
      observations.record(request.url, false, "scheme-disabled", "protocol");
      return response(404, "Not found");
    }

    let isLocalAssetRequest = false;
    try {
      const mountedRoute = routeRstepDemoAsset(resolution.relativePath);
      if (mountedRoute.targetsMount && (!mountedRoute.allowed || realLocalAssetRoot === undefined)) {
        observations.record(request.url, false, "test-local-asset-rejected", "protocol");
        return response(404, "Not found");
      }
      isLocalAssetRequest = mountedRoute.targetsMount && mountedRoute.allowed;
      let requestedFile = resolution.absolutePath;
      const allowedRoot = realRendererRoot;
      let bytes: Buffer | null;
      let responseBytes: number;
      if (isLocalAssetRequest) {
        if (realLocalAssetRoot === undefined || mountedRoute.assetRelativePath === null) {
          throw new Error("The approved RSTEP asset route is incomplete.");
        }
        const mountedAsset = await loadBoundedMountedLocalAsset(
          realLocalAssetRoot,
          mountedRoute.assetRelativePath,
          RSTEP_DEMO_MAX_LOCAL_ASSET_BYTES,
          request.method,
        );
        requestedFile = mountedAsset.filePath;
        bytes = mountedAsset.body;
        responseBytes = mountedAsset.bytes;
      } else {
        const resolvedFile = await realpath(requestedFile);
        const flavor = process.platform === "win32" ? "win32" : "posix";
        if (!isPathWithinRoot(allowedRoot, resolvedFile, flavor)) {
          observations.record(request.url, false, "scheme-disabled", "protocol");
          return response(404, "Not found");
        }
        const fileMetadata = await stat(resolvedFile);
        if (!fileMetadata.isFile()) {
          observations.record(request.url, false, "scheme-disabled", "protocol");
          return response(404, "Not found");
        }
        requestedFile = resolvedFile;
        bytes = request.method === "HEAD" ? null : await readFile(resolvedFile);
        responseBytes = fileMetadata.size;
      }
      observations.record(
        request.url,
        true,
        isLocalAssetRequest ? "test-local-asset" : "bundled-application",
        "protocol",
      );
      return new Response(bytes === null ? null : Uint8Array.from(bytes), {
        status: 200,
        headers: securityHeaders(requestedFile, bytes?.byteLength ?? responseBytes),
      });
    } catch {
      observations.record(
        request.url,
        false,
        isLocalAssetRequest ? "test-local-asset-rejected" : "scheme-disabled",
        "protocol",
      );
      return response(404, "Not found");
    }
  });
}

function installRuntimeGuards(
  secureSession: Session,
  observations: RequestObservationLog,
  networkPolicy: SessionNetworkPolicy,
): void {
  secureSession.setPermissionCheckHandler(() => false);
  secureSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  secureSession.setDevicePermissionHandler(() => false);

  secureSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    const decision = decideRuntimeRequest(details.url, networkPolicy.developmentLoopbackAllowed);
    if (!details.url.startsWith(`${APPLICATION_SCHEME}:`)) {
      observations.record(details.url, decision.allowed, decision.reason, details.resourceType);
    }
    callback({ cancel: !decision.allowed });
  });
}

function lockWindow(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-redirect", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
}

function trustedSender(event: IpcMainInvokeEvent, window: BrowserWindow): boolean {
  if (window.isDestroyed() || event.sender.isDestroyed()) return false;
  if (event.sender.id !== window.webContents.id) return false;
  if (event.senderFrame !== window.webContents.mainFrame) return false;
  return isTrustedApplicationUrl(event.senderFrame.url);
}

function requireTrustedSender(event: IpcMainInvokeEvent, window: BrowserWindow): void {
  if (!trustedSender(event, window)) throw new Error("IPC request rejected.");
}

function checkedWriteRequest(value: unknown): WriteTextRequest {
  if (typeof value !== "object" || value === null) throw new TypeError("Invalid write request.");
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.contents !== "string") throw new TypeError("File contents must be text.");
  if (candidate.contents.length > MAXIMUM_TEXT_CHARACTERS) {
    throw new RangeError("File contents exceed the desktop limit.");
  }
  if (candidate.suggestedName !== undefined && typeof candidate.suggestedName !== "string") {
    throw new TypeError("The suggested file name must be text.");
  }
  return candidate.suggestedName === undefined
    ? { contents: candidate.contents }
    : { contents: candidate.contents, suggestedName: candidate.suggestedName };
}

function checkedSuggestedName(value: string | undefined, fallback: string): string {
  if (value === undefined || value === "") return fallback;
  const hasUnsafeCharacter = [...value].some(
    (character) => character.charCodeAt(0) <= 31 || '\\/:*?"<>|'.includes(character),
  );
  if (value.length > 120 || value === "." || value === ".." || hasUnsafeCharacter) {
    throw new TypeError("The suggested file name is invalid.");
  }
  return value;
}

function parseJsonObject(contents: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new TypeError(`${label} must contain valid JSON.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError(`${label} must contain a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function requireGeoJson(contents: string): void {
  const parsed = parseJsonObject(contents, "GeoJSON");
  if (typeof parsed.type !== "string" || !GEOJSON_TYPES.has(parsed.type)) {
    throw new TypeError("GeoJSON has an unsupported top-level type.");
  }
}

function registerIpcHandlers(
  getWindow: () => BrowserWindow | null,
  observations: RequestObservationLog,
  explicitDevelopmentMode: boolean,
  rendererEntry: RendererEntryId,
  exportRestrictedAtStartup: boolean,
  testLocalAssetMountActive: boolean,
  trustedWaRstepTsdfSource: TsdfSource,
  trustedWaTribalSourceProfile: WaTribalSourceProfile,
  networkPolicy: SessionNetworkPolicy,
): void {
  let activeWaContext: TribalPresentationContext | null = null;
  let activeBaseline: LoadedBaselinePackage | null = null;
  let baselineAbort: AbortController | null = null;
  let exportAllowedForSession = !exportRestrictedAtStartup;
  let waRestrictedForSession = exportRestrictedAtStartup;
  let pendingActivation: {
    token: string;
    baseline: LoadedBaselinePackage | null;
    projectContents: string | null;
    waContext: TribalPresentationContext | null;
  } | null = null;
  const admittedRstepHashes = new Set<string>();
  let legacyContentForSession = false;
  let rstepContentForSession = false;

  const latchBaselinePolicy = (): void => {
    exportAllowedForSession = false;
    networkPolicy.latchNetworkAllowed(false);
  };
  const latchRstepPolicy = (): void => {
    rstepContentForSession = true;
    latchBaselinePolicy();
  };

  const latchBindingPolicy = (binding: ProjectWaTribalContextBinding | TribalPresentationContext): void => {
    const behavior = trustedWaContextBehavior(binding, trustedWaRstepTsdfSource);
    if (behavior?.export_allowed !== true) {
      exportAllowedForSession = false;
      waRestrictedForSession = true;
    }
    networkPolicy.latchNetworkAllowed(behavior?.network_allowed === true);
  };

  const latchContextPolicy = (context: TribalPresentationContext): void => {
    activeWaContext = context;
    latchBindingPolicy(context);
  };

  const withWindow = (event: IpcMainInvokeEvent): BrowserWindow => {
    const window = getWindow();
    if (window === null) throw new Error("Desktop window is unavailable.");
    requireTrustedSender(event, window);
    return window;
  };

  const selectBaseline = async (
    window: BrowserWindow,
    expected?: BaselineBinding,
  ): Promise<LoadedBaselinePackage | null> => {
    if (baselineAbort !== null)
      throw new Error("A DEM package is already loading. Cancel it before selecting another.");
    const controller = new AbortController();
    baselineAbort = controller;
    try {
      const selection = await dialog.showOpenDialog(window, {
        title: expected === undefined ? "Open local DEM package" : "Locate exact DEM edition for project",
        properties: ["openFile"],
        filters: [{ name: "DEM package manifest", extensions: ["json"] }],
      });
      const selectedPath = selection.filePaths[0];
      if (selection.canceled || selectedPath === undefined || controller.signal.aborted) return null;
      const loaded = await loadBaselinePackage(selectedPath, { signal: controller.signal });
      if (expected !== undefined && !verifyBaselineBinding(expected, loaded.binding)) {
        throw new Error(
          "GB-PKG-003: Selected DEM package does not match the project's exact edition and hashes. Previous workspace retained.",
        );
      }
      return loaded;
    } finally {
      if (baselineAbort === controller) baselineAbort = null;
    }
  };

  ipcMain.handle(IPC_CHANNELS.openRstepLayers, async (event) => {
    const selection = await dialog.showOpenDialog(withWindow(event), {
      title: "Open local source layers or declarative partner overlays",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "GeoBase source layers", extensions: ["json"] }],
    });
    if (selection.canceled || selection.filePaths.length === 0) return { canceled: true } as const;
    if (selection.filePaths.length > 20)
      throw new RangeError("At most 20 source layers may be opened together.");
    const parsed = [];
    let bytes = 0;
    let vertices = 0;
    for (const selectedPath of selection.filePaths) {
      const file = await readRstepLocalText(selectedPath, 32 * 1024 * 1024);
      bytes += file.bytesRead;
      if (bytes > 128 * 1024 * 1024)
        throw new RangeError("Source selection exceeds the scenario byte limit.");
      const layer = await parseSourceLayer(file.contents);
      vertices += layer.vertexCount;
      if (vertices > 1_000_000) throw new RangeError("Source selection exceeds the active vertex limit.");
      parsed.push(layer);
    }
    // Restriction is irreversible and occurs before any selected content crosses IPC.
    latchRstepPolicy();
    for (const layer of parsed) admittedRstepHashes.add(layer.exactSha256);
    return { canceled: false, contents: parsed.map((layer) => layer.exactJson) } as const;
  });

  ipcMain.handle(IPC_CHANNELS.openRstep, async (event) => {
    const selection = await dialog.showOpenDialog(withWindow(event), {
      title: "Open independent RSTEP scenario workspace",
      properties: ["openFile"],
      filters: [{ name: "RSTEP workspace", extensions: ["json"] }],
    });
    const selectedPath = selection.filePaths[0];
    if (selection.canceled || selectedPath === undefined) return { canceled: true } as const;
    const file = await readRstepLocalText(selectedPath, 128 * 1024 * 1024);
    const sidecar = await parseSidecar(file.contents);
    if (sidecar.project_sha256 !== null)
      throw new Error(
        "This RSTEP view supports independent workspaces only; the bound legacy project must use a qualified adapter.",
      );
    await replaySidecar(sidecar);
    latchRstepPolicy();
    for (const digest of sidecarContentDigests(sidecar)) admittedRstepHashes.add(digest.sha256);
    return { canceled: false, contents: [file.contents] } as const;
  });

  ipcMain.handle(IPC_CHANNELS.saveRstep, async (event, contents: unknown) => {
    const window = withWindow(event);
    if (
      legacyContentForSession ||
      waRestrictedForSession ||
      activeWaContext !== null ||
      activeBaseline !== null
    )
      throw new Error(
        "Legacy content was opened in this session. Restart the app and open only the independent RSTEP workspace before saving; cross-format custody is unsupported.",
      );
    const request = checkedWriteRequest({ contents });
    const sidecar = await parseSidecar(request.contents);
    if (sidecar.project_sha256 !== null)
      throw new Error("Only independent RSTEP workspaces are supported in this view.");
    for (const digest of sidecarContentDigests(sidecar)) {
      if (!admittedRstepHashes.has(digest.sha256))
        throw new Error("RSTEP source bytes were not admitted by a local file selection in this session.");
    }
    await replaySidecar(sidecar);
    latchRstepPolicy();
    const selection = await dialog.showSaveDialog(window, {
      title: "Save local RSTEP scenario workspace",
      defaultPath: path.join(app.getPath("documents"), "workspace.rstep.json"),
      filters: [{ name: "RSTEP workspace", extensions: ["json"] }],
    });
    if (selection.canceled || !selection.filePath) return { canceled: true } as const;
    const written = await atomicWriteUserSelectedUtf8File(selection.filePath, request.contents);
    return { canceled: false, path: written.resolvedPath, bytesWritten: written.bytesWritten } as const;
  });

  ipcMain.handle(IPC_CHANNELS.openBaselinePackage, async (event) => {
    const loaded = await selectBaseline(withWindow(event));
    if (loaded === null) return { canceled: true } as const;
    latchBaselinePolicy();
    legacyContentForSession = true;
    const token = randomUUID();
    pendingActivation = { token, baseline: loaded, projectContents: null, waContext: activeWaContext };
    return {
      canceled: false,
      baseline: baselinePresentation(loaded),
      verifiedBytes: loaded.verifiedBytes,
      openingMilliseconds: loaded.openingMilliseconds,
      activationToken: token,
    } as const;
  });
  ipcMain.handle(IPC_CHANNELS.cancelBaselineLoad, (event) => {
    withWindow(event);
    baselineAbort?.abort();
  });
  ipcMain.handle(IPC_CHANNELS.probeBaseline, (event, query: BaselineQuery) => {
    withWindow(event);
    if (activeBaseline === null)
      throw new Error("Load a validated DEM package before inspecting native values.");
    return probeBaseline(activeBaseline, query);
  });

  ipcMain.handle(IPC_CHANNELS.completePackageActivation, (event, token: unknown, contents: unknown) => {
    withWindow(event);
    const pending = pendingActivation;
    if (pending === null || typeof token !== "string" || pending.token !== token)
      throw new Error("Package activation token is unavailable or stale.");
    const request = checkedWriteRequest({ contents });
    const parsed = parseProject(request.contents);
    if (
      serializeProject(parsed) !== request.contents ||
      (pending.projectContents !== null && request.contents !== pending.projectContents)
    )
      throw new Error("Activation project bytes must match the verified canonical project.");
    if (
      pending.baseline === null
        ? parsed.baseline_context !== undefined
        : parsed.baseline_context === undefined ||
          !verifyBaselineBinding(parsed.baseline_context, pending.baseline.binding)
    )
      throw new Error("DEM activation must retain the exact package binding.");
    if (
      parsed.wa_tribal_context !== null &&
      (pending.waContext === null ||
        !verifyProjectWaTribalContextBinding(parsed.wa_tribal_context, pending.waContext).verified)
    )
      throw new Error("WA/Tribal activation must retain its freshly validated binding.");
    activeBaseline = pending.baseline;
    if (parsed.wa_tribal_context !== null) activeWaContext = pending.waContext;
    pendingActivation = null;
  });
  ipcMain.handle(IPC_CHANNELS.discardPackageActivation, (event, token: unknown) => {
    withWindow(event);
    if (typeof token === "string" && pendingActivation?.token === token) pendingActivation = null;
  });
  ipcMain.handle(IPC_CHANNELS.releaseBaselinePackage, (event) => {
    withWindow(event);
    if (baselineAbort !== null) throw new Error("Cancel package loading before clearing the workspace.");
    activeBaseline = null;
    pendingActivation = null;
    // Only native buffers are released. Session export/network restrictions are irreversible.
  });

  ipcMain.handle(IPC_CHANNELS.openProject, async (event) => {
    const window = withWindow(event);
    const selection = await dialog.showOpenDialog(window, {
      title: "Open ATNI-GeoBase project",
      properties: ["openFile"],
      filters: [{ name: "ATNI-GeoBase project", extensions: ["json"] }],
    });
    const selectedPath = selection.filePaths[0];
    if (selection.canceled || selectedPath === undefined) return { canceled: true } as const;
    const file = await readUserSelectedUtf8File(selectedPath);
    const parsed = parseProject(file.contents);
    if (parsed.wa_tribal_context !== null) {
      latchBindingPolicy(parsed.wa_tribal_context);
      if (activeWaContext === null) {
        throw new Error("Load and validate the bound WA/Tribal GeoPackage before opening this project.");
      }
      const verification = verifyProjectWaTribalContextBinding(parsed.wa_tribal_context, activeWaContext);
      if (!verification.verified) {
        throw new Error("Project WA/Tribal binding does not match the freshly validated local package.");
      }
    }
    let reopenedBaseline: LoadedBaselinePackage | null = null;
    if (parsed.baseline_context !== undefined) {
      latchBaselinePolicy();
      reopenedBaseline = await selectBaseline(window, parsed.baseline_context);
      if (reopenedBaseline === null) return { canceled: true } as const;
    }
    const token = randomUUID();
    pendingActivation = {
      token,
      baseline: reopenedBaseline,
      projectContents: file.contents,
      waContext: activeWaContext,
    };
    legacyContentForSession = true;
    return {
      canceled: false,
      path: file.resolvedPath,
      contents: file.contents,
      bytesRead: file.bytesRead,
      exactBytesSha256: file.exactBytesSha256,
      ...(reopenedBaseline === null ? {} : { baseline: baselinePresentation(reopenedBaseline) }),
      activationToken: token,
    } as const;
  });

  ipcMain.handle(IPC_CHANNELS.openWaTribalContext, async (event, token?: unknown) => {
    const window = withWindow(event);
    if (token !== undefined && (typeof token !== "string" || pendingActivation?.token !== token))
      throw new Error("Project activation token is unavailable or stale.");
    const selection = await dialog.showOpenDialog(window, {
      title: "Open WA/Tribal context package",
      properties: ["openFile"],
      filters: [{ name: "GeoPackage", extensions: ["gpkg"] }],
    });
    const selectedPath = selection.filePaths[0];
    if (selection.canceled || selectedPath === undefined) return { canceled: true } as const;
    const resolvedPath = await resolveUserSelectedLocalFile(selectedPath);
    const loaded = await loadWaTribalContextFromGeoPackage(
      resolvedPath,
      trustedWaRstepTsdfSource,
      trustedWaTribalSourceProfile,
    );
    if (token !== undefined) {
      if (pendingActivation?.token !== token) throw new Error("Project activation was superseded.");
      pendingActivation.waContext = loaded.context;
      latchBindingPolicy(loaded.context);
    } else latchContextPolicy(loaded.context);
    legacyContentForSession = true;
    return {
      bytesRead: loaded.bytesRead,
      canceled: false,
      context: loaded.context,
      exactBytesSha256: loaded.exactBytesSha256,
    } as const;
  });

  ipcMain.handle(IPC_CHANNELS.saveProject, async (event, rawRequest: unknown) => {
    const window = withWindow(event);
    if (rstepContentForSession)
      throw new Error(
        "RSTEP content was opened in this session. Restart the app and open only the legacy project before saving; cross-format custody is unsupported.",
      );
    const request = checkedWriteRequest(rawRequest);
    const parsed = parseProject(request.contents);
    if (serializeProject(parsed) !== request.contents) {
      throw new TypeError("Project contents must be the exact canonical serialization.");
    }
    if (parsed.wa_tribal_context !== null) latchBindingPolicy(parsed.wa_tribal_context);
    if (parsed.baseline_context !== undefined) latchBaselinePolicy();
    if (activeBaseline !== null || parsed.baseline_context !== undefined) {
      if (
        activeBaseline === null ||
        parsed.baseline_context === undefined ||
        !verifyBaselineBinding(parsed.baseline_context, activeBaseline.binding)
      ) {
        throw new Error(
          "A restricted DEM session may save only its freshly validated exact-edition bound project.",
        );
      }
    }
    if (waRestrictedForSession || activeWaContext !== null) {
      if (activeWaContext === null || parsed.wa_tribal_context === null) {
        throw new Error("A restricted WA/Tribal session may save only its bound local project.");
      }
      const verification = verifyProjectWaTribalContextBinding(parsed.wa_tribal_context, activeWaContext);
      if (!verification.verified) {
        throw new Error("Project WA/Tribal binding does not match the freshly validated local package.");
      }
    }
    const suggestedName = checkedSuggestedName(request.suggestedName, "project.atnigeobase.json");
    const selection = await dialog.showSaveDialog(window, {
      title: "Save ATNI-GeoBase project",
      defaultPath: path.join(app.getPath("documents"), suggestedName),
      filters: [{ name: "ATNI-GeoBase project", extensions: ["json"] }],
    });
    if (selection.canceled || selection.filePath === "") return { canceled: true } as const;
    const written = await atomicWriteUserSelectedUtf8File(selection.filePath, request.contents);
    return {
      canceled: false,
      path: written.resolvedPath,
      bytesWritten: written.bytesWritten,
    } as const;
  });

  ipcMain.handle(IPC_CHANNELS.importGeoJson, async (event) => {
    const window = withWindow(event);
    const selection = await dialog.showOpenDialog(window, {
      title: "Import GeoJSON",
      properties: ["openFile"],
      filters: [{ name: "GeoJSON", extensions: ["geojson", "json"] }],
    });
    const selectedPath = selection.filePaths[0];
    if (selection.canceled || selectedPath === undefined) return { canceled: true } as const;
    const file = await readUserSelectedUtf8File(selectedPath);
    requireGeoJson(file.contents);
    legacyContentForSession = true;
    return {
      canceled: false,
      path: file.resolvedPath,
      contents: file.contents,
      bytesRead: file.bytesRead,
      exactBytesSha256: file.exactBytesSha256,
    } as const;
  });

  ipcMain.handle(IPC_CHANNELS.exportGeoJson, async (event, rawRequest: unknown) => {
    const window = withWindow(event);
    if (!exportAllowedForSession) {
      throw new Error("The active WA/Tribal context tier forbids export before serialization.");
    }
    const request = checkedWriteRequest(rawRequest);
    requireGeoJson(request.contents);
    const suggestedName = checkedSuggestedName(request.suggestedName, "selection.geobase-export.geojson");
    const selection = await dialog.showSaveDialog(window, {
      title: "Export GeoJSON",
      defaultPath: path.join(app.getPath("documents"), suggestedName),
      filters: [{ name: "GeoJSON", extensions: ["geojson", "json"] }],
    });
    if (selection.canceled || selection.filePath === "") return { canceled: true } as const;
    const written = await atomicWriteUserSelectedUtf8File(selection.filePath, request.contents);
    return {
      canceled: false,
      path: written.resolvedPath,
      bytesWritten: written.bytesWritten,
    } as const;
  });

  ipcMain.handle(IPC_CHANNELS.securityReceipt, (event): RuntimeSecurityReceipt => {
    withWindow(event);
    return {
      receiptVersion: 1,
      capturedAt: new Date().toISOString(),
      applicationOrigin: APPLICATION_ORIGIN,
      rendererEntry,
      explicitDevelopmentMode,
      renderer: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
      },
      controls: {
        permissionsDenied: true,
        navigationDenied: true,
        newWindowsDenied: true,
        remoteRequestsCanceled: true,
        telemetryEnabled: false,
        userSelectedFilesOnly: !testLocalAssetMountActive,
        networkDriveDestinationsDenied: true,
        developmentLoopbackAllowed: networkPolicy.developmentLoopbackAllowed,
        restrictedContextNetworkLatched: networkPolicy.restrictedContextNetworkLatched,
        exportAllowed: exportAllowedForSession,
        testLocalAssetAllowlistEnforced: testLocalAssetMountActive,
        testLocalAssetMaximumBytes: testLocalAssetMountActive ? RSTEP_DEMO_MAX_LOCAL_ASSET_BYTES : null,
        testLocalAssetMountActive,
      },
      cumulative: observations.cumulative(),
      observations: observations.snapshot(),
      limitations: [
        "Detailed request observations are bounded to the latest 256 requests; cumulative denial, HTTP(S), and test-local-asset counters cover every session-policy decision since startup.",
        "CSP permits bundled Cesium WebAssembly compilation; JavaScript unsafe-eval remains disabled.",
        ...(testLocalAssetMountActive
          ? [
              "The spike uses an environment-configured read-only asset mount, so userSelectedFilesOnly is false; exact path patterns, realpath containment, a 16 MiB per-file cap, network latch, and export latch bound that exception.",
            ]
          : []),
        "Local-drive checks do not identify folders synchronized by third-party cloud software.",
        "POSIX paths fail closed unless runtime mount inspection recognizes local storage; Windows permits only fixed or removable drive roots.",
      ],
    };
  });
}

function trustedWaContextBehavior(
  binding: ProjectWaTribalContextBinding | TribalPresentationContext,
  trustedSource: TsdfSource,
): TsdfTierDefinition["behavior"] | undefined {
  const classification = binding.custody.classification;
  try {
    assertTrustedWaTribalTsdfProfile({
      classification,
      sourceReceiptCount: binding.custody.source_receipts.length,
      trustedTsdfSource: trustedSource,
    });
    const effectiveTier = trustedSource.effectiveTier(classification.source_tier_ids);
    return effectiveTier.id === classification.effective_tier_id ? effectiveTier.behavior : undefined;
  } catch {
    return undefined;
  }
}

async function bootstrap(): Promise<void> {
  if (app.isPackaged && process.platform === "win32") {
    configurePackagedWindowsRuntimePaths(app, createWindowsLocalRuntimePaths(queryWindowsLocalAppData()));
  }
  await app.whenReady();
  Menu.setApplicationMenu(null);

  const explicitDevelopmentMode = !app.isPackaged && process.env.ATNI_GEOBASE_DEVELOPMENT_MODE === "1";
  const rendererEntry = decideRendererEntry({
    explicitDevelopmentMode,
    isPackaged: app.isPackaged,
    requestedAssetRoot: process.env.ATNI_GEOBASE_RSTEP_DONOR_PUBLIC,
    requestedScene: process.env.ATNI_GEOBASE_TEST_SCENE,
  });
  const observations = new RequestObservationLog();
  const networkPolicy = new SessionNetworkPolicy(explicitDevelopmentMode);
  if (rendererEntry.networkRestricted) networkPolicy.latchNetworkAllowed(false);
  const localAssetRoot =
    rendererEntry.localAssetRootCandidate === null
      ? undefined
      : await resolveApprovedLocalDirectory(rendererEntry.localAssetRootCandidate);
  const secureSession = session.fromPartition("geobase-secure", { cache: false });
  await secureSession.setProxy({ mode: "direct" });
  installRuntimeGuards(secureSession, observations, networkPolicy);
  await installApplicationProtocol(
    secureSession,
    observations,
    localAssetRoot === undefined
      ? undefined
      : { realRoot: localAssetRoot, virtualPrefix: RSTEP_DEMO_ASSET_PREFIX },
  );
  const [trustedWaRstepTsdfSource, trustedWaTribalSourceProfile] = await Promise.all([
    loadTrustedWaRstepTsdfSource(),
    loadTrustedWaTribalSourceProfile(),
  ]);

  let mainWindow: BrowserWindow | null = null;
  registerIpcHandlers(
    () => mainWindow,
    observations,
    explicitDevelopmentMode,
    rendererEntry.id,
    rendererEntry.exportRestricted,
    localAssetRoot !== undefined,
    trustedWaRstepTsdfSource,
    trustedWaTribalSourceProfile,
    networkPolicy,
  );
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: "#09131c",
    webPreferences: {
      preload: PRELOAD_PATH,
      session: secureSession,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: explicitDevelopmentMode,
      spellcheck: false,
      webviewTag: false,
      navigateOnDragDrop: false,
    },
  });
  lockWindow(mainWindow);
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  await mainWindow.loadURL(`${APPLICATION_ORIGIN}/index.html${rendererEntry.urlSuffix}`);
}

app.on("window-all-closed", () => app.quit());

void bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown desktop startup error.";
  console.error(`ATNI-GeoBase failed to start: ${message}`);
  app.exit(1);
});
