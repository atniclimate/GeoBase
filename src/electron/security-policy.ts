import path from "node:path";

export const APPLICATION_SCHEME = "geobase";
export const APPLICATION_HOST = "app";
export const APPLICATION_ORIGIN = `${APPLICATION_SCHEME}://${APPLICATION_HOST}`;

export type PathFlavor = "win32" | "posix";

export type ProtocolPathDecision =
  | {
      allowed: true;
      absolutePath: string;
      relativePath: string;
    }
  | {
      allowed: false;
      reason:
        | "invalid-root"
        | "invalid-url"
        | "wrong-scheme"
        | "wrong-authority"
        | "invalid-path-encoding"
        | "path-traversal"
        | "path-outside-root";
    };

interface RawApplicationUrl {
  authority: string;
  rawPath: string;
}

function parseRawApplicationUrl(rawUrl: string): RawApplicationUrl | undefined {
  const separatorIndex = rawUrl.indexOf("://");
  if (separatorIndex < 0) return undefined;

  const authorityStart = separatorIndex + 3;
  const pathStart = rawUrl.indexOf("/", authorityStart);
  const queryStart = rawUrl.indexOf("?", authorityStart);
  const hashStart = rawUrl.indexOf("#", authorityStart);
  const delimiters = [pathStart, queryStart, hashStart].filter((value) => value >= 0);
  const authorityEnd = delimiters.length === 0 ? rawUrl.length : Math.min(...delimiters);
  const authority = rawUrl.slice(authorityStart, authorityEnd);

  if (pathStart < 0 || pathStart !== authorityEnd) {
    return { authority, rawPath: "" };
  }

  const pathEndCandidates = [queryStart, hashStart].filter((value) => value > pathStart);
  const pathEnd = pathEndCandidates.length === 0 ? rawUrl.length : Math.min(...pathEndCandidates);
  return { authority, rawPath: rawUrl.slice(pathStart, pathEnd) };
}

function pathImplementation(flavor: PathFlavor): typeof path.win32 | typeof path.posix {
  return flavor === "win32" ? path.win32 : path.posix;
}

function isUnsafeWindowsFileSegment(segment: string): boolean {
  if (segment.endsWith(".") || segment.endsWith(" ") || /[<>:"|?*]/.test(segment)) return true;
  const deviceStem = segment.split(".")[0]?.toUpperCase();
  return (
    deviceStem === "CON" ||
    deviceStem === "PRN" ||
    deviceStem === "AUX" ||
    deviceStem === "NUL" ||
    /^COM[1-9]$/.test(deviceStem ?? "") ||
    /^LPT[1-9]$/.test(deviceStem ?? "")
  );
}

/** Returns true only when candidate resolves to root itself or one of its descendants. */
export function isPathWithinRoot(root: string, candidate: string, flavor: PathFlavor): boolean {
  const implementation = pathImplementation(flavor);
  const resolvedRoot = implementation.resolve(root);
  const resolvedCandidate = implementation.resolve(candidate);
  const relative = implementation.relative(resolvedRoot, resolvedCandidate);
  return relative === "" || (!relative.startsWith("..") && !implementation.isAbsolute(relative));
}

/**
 * Resolves a geobase://app URL without trusting WHATWG URL dot-segment normalization.
 * The caller must additionally realpath both the root and result before reading, so a
 * symlink in the renderer bundle cannot escape the bundle root.
 */
export function resolveApplicationProtocolPath(
  rawUrl: string,
  rendererRoot: string,
  flavor: PathFlavor = process.platform === "win32" ? "win32" : "posix",
): ProtocolPathDecision {
  const implementation = pathImplementation(flavor);
  if (!implementation.isAbsolute(rendererRoot)) {
    return { allowed: false, reason: "invalid-root" };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: "invalid-url" };
  }

  if (parsed.protocol !== `${APPLICATION_SCHEME}:`) {
    return { allowed: false, reason: "wrong-scheme" };
  }
  if (
    parsed.hostname !== APPLICATION_HOST ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== ""
  ) {
    return { allowed: false, reason: "wrong-authority" };
  }

  const raw = parseRawApplicationUrl(rawUrl);
  if (raw === undefined || raw.authority.toLowerCase() !== APPLICATION_HOST) {
    return { allowed: false, reason: "wrong-authority" };
  }

  const rawSegments = raw.rawPath === "" || raw.rawPath === "/" ? [] : raw.rawPath.slice(1).split("/");
  const decodedSegments: string[] = [];
  for (const rawSegment of rawSegments) {
    let segment: string;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      return { allowed: false, reason: "invalid-path-encoding" };
    }

    if (
      segment === "" ||
      segment === "." ||
      segment === ".." ||
      segment.includes("/") ||
      segment.includes("\\") ||
      segment.includes("\0") ||
      (flavor === "win32" && isUnsafeWindowsFileSegment(segment))
    ) {
      return { allowed: false, reason: "path-traversal" };
    }
    decodedSegments.push(segment);
  }

  if (decodedSegments.length === 0) decodedSegments.push("index.html");
  const absolutePath = implementation.resolve(rendererRoot, ...decodedSegments);
  if (!isPathWithinRoot(rendererRoot, absolutePath, flavor)) {
    return { allowed: false, reason: "path-outside-root" };
  }

  return {
    allowed: true,
    absolutePath,
    relativePath: decodedSegments.join("/"),
  };
}

export type RequestPolicyReason =
  | "bundled-application"
  | "test-local-asset"
  | "test-local-asset-rejected"
  | "inline-data"
  | "runtime-blob"
  | "developer-tools"
  | "development-loopback"
  | "malformed-url"
  | "network-disabled"
  | "remote-host-disabled"
  | "scheme-disabled";

export interface RequestPolicyDecision {
  allowed: boolean;
  reason: RequestPolicyReason;
}

/**
 * One-way session policy for the only network exception: development loopback.
 * Attaching any context whose trusted tier denies network access closes the
 * exception for the remainder of the desktop process.
 */
export class SessionNetworkPolicy {
  #developmentLoopbackAllowed: boolean;

  #restrictedContextNetworkLatched = false;

  public constructor(explicitDevelopmentMode: boolean) {
    this.#developmentLoopbackAllowed = explicitDevelopmentMode;
  }

  public get developmentLoopbackAllowed(): boolean {
    return this.#developmentLoopbackAllowed;
  }

  public get restrictedContextNetworkLatched(): boolean {
    return this.#restrictedContextNetworkLatched;
  }

  public latchNetworkAllowed(networkAllowed: boolean): void {
    if (networkAllowed) return;
    this.#developmentLoopbackAllowed = false;
    this.#restrictedContextNetworkLatched = true;
  }
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  return /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

/** Decides whether a runtime URL is local enough to leave the renderer process. */
export function decideRuntimeRequest(
  rawUrl: string,
  explicitDevelopmentMode: boolean,
): RequestPolicyDecision {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: "malformed-url" };
  }

  switch (parsed.protocol) {
    case `${APPLICATION_SCHEME}:`:
      return parsed.hostname === APPLICATION_HOST
        ? { allowed: true, reason: "bundled-application" }
        : { allowed: false, reason: "scheme-disabled" };
    case "data:":
      return { allowed: true, reason: "inline-data" };
    case "blob:":
      return { allowed: true, reason: "runtime-blob" };
    case "devtools:":
      return { allowed: true, reason: "developer-tools" };
    case "http:":
    case "https:":
      if (!explicitDevelopmentMode) return { allowed: false, reason: "network-disabled" };
      return isLoopbackHostname(parsed.hostname)
        ? { allowed: true, reason: "development-loopback" }
        : { allowed: false, reason: "remote-host-disabled" };
    default:
      return { allowed: false, reason: "scheme-disabled" };
  }
}

function sanitizedMediaType(rawUrl: string): string {
  const commaIndex = rawUrl.indexOf(",");
  const metadata = rawUrl.slice("data:".length, commaIndex < 0 ? undefined : commaIndex);
  const mediaType = metadata.split(";")[0]?.toLowerCase() ?? "";
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType) ? mediaType : "application/octet-stream";
}

/** Removes credentials, query strings, fragments, payloads, and remote path details. */
export function sanitizeObservedRequest(rawUrl: string): string {
  if (rawUrl.toLowerCase().startsWith("data:")) {
    return `data:${sanitizedMediaType(rawUrl)};[redacted]`;
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return "[invalid-url]";
  }

  if (parsed.protocol === "blob:") {
    try {
      const inner = new URL(rawUrl.slice("blob:".length));
      return `blob:${inner.protocol}//${inner.host}/[redacted]`;
    } catch {
      return "blob:[redacted]";
    }
  }

  if (parsed.protocol === `${APPLICATION_SCHEME}:` && parsed.hostname === APPLICATION_HOST) {
    return `${APPLICATION_ORIGIN}${parsed.pathname}`;
  }

  if (parsed.host !== "") return `${parsed.protocol}//${parsed.host}/[redacted]`;
  return `${parsed.protocol}[redacted]`;
}

export type WindowsDriveType =
  | "fixed"
  | "removable"
  | "network"
  | "optical"
  | "ram-disk"
  | "no-root"
  | "unknown";

export type WindowsDriveTypeLookup = (driveRoot: string) => WindowsDriveType | Promise<WindowsDriveType>;
export type NetworkPathLookup = (absolutePath: string) => boolean | Promise<boolean>;

export interface LocalPathPolicyOptions {
  platform: "win32" | "linux" | "darwin" | string;
  windowsDriveTypeLookup?: WindowsDriveTypeLookup;
  allowedWindowsDriveTypes?: readonly WindowsDriveType[];
  networkPathLookup?: NetworkPathLookup;
}

export type LocalPathDecision =
  | {
      allowed: true;
      normalizedPath: string;
      storageKind: WindowsDriveType | "local-posix";
    }
  | {
      allowed: false;
      reason:
        | "empty-path"
        | "url-path"
        | "relative-path"
        | "network-path"
        | "drive-lookup-unavailable"
        | "drive-lookup-failed"
        | "drive-type-disabled";
    };

function isUrlForm(value: string, platform: string): boolean {
  if (platform === "win32" && /^[a-z]:[\\/]/i.test(value)) return false;
  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}

function isObviousPosixNetworkPath(value: string): boolean {
  return /^(?:\/\/|\\\\)/.test(value) || /^\/(?:afs|net|Network)(?:\/|$)/.test(value);
}

/**
 * Validates a path returned by a native file dialog. Windows accepts only fixed
 * and removable drive roots by default. Drive lookup failures are denials.
 */
export async function decideLocalUserSelectedPath(
  candidate: string,
  options: LocalPathPolicyOptions,
): Promise<LocalPathDecision> {
  if (candidate === "" || candidate.includes("\0")) return { allowed: false, reason: "empty-path" };
  if (isUrlForm(candidate, options.platform)) return { allowed: false, reason: "url-path" };

  if (options.platform === "win32") {
    if (/^(?:\\\\|\/\/)/.test(candidate)) return { allowed: false, reason: "network-path" };
    if (!/^[a-z]:[\\/]/i.test(candidate) || !path.win32.isAbsolute(candidate)) {
      return { allowed: false, reason: "relative-path" };
    }
    if (candidate.slice(2).includes(":")) return { allowed: false, reason: "url-path" };
    if (options.windowsDriveTypeLookup === undefined) {
      return { allowed: false, reason: "drive-lookup-unavailable" };
    }

    const normalizedPath = path.win32.normalize(candidate);
    const driveRoot = path.win32.parse(normalizedPath).root.slice(0, 2).toUpperCase();
    let driveType: WindowsDriveType;
    try {
      driveType = await options.windowsDriveTypeLookup(driveRoot);
    } catch {
      return { allowed: false, reason: "drive-lookup-failed" };
    }

    const allowedTypes = options.allowedWindowsDriveTypes ?? ["fixed", "removable"];
    if (!allowedTypes.includes(driveType)) return { allowed: false, reason: "drive-type-disabled" };
    return { allowed: true, normalizedPath, storageKind: driveType };
  }

  if (isObviousPosixNetworkPath(candidate)) return { allowed: false, reason: "network-path" };
  if (!path.posix.isAbsolute(candidate)) return { allowed: false, reason: "relative-path" };
  const normalizedPath = path.posix.normalize(candidate);

  if (options.networkPathLookup !== undefined) {
    try {
      if (await options.networkPathLookup(normalizedPath)) return { allowed: false, reason: "network-path" };
    } catch {
      return { allowed: false, reason: "drive-lookup-failed" };
    }
  }
  return { allowed: true, normalizedPath, storageKind: "local-posix" };
}

export function isTrustedApplicationUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return (
      parsed.protocol === `${APPLICATION_SCHEME}:` &&
      parsed.hostname === APPLICATION_HOST &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.port === ""
    );
  } catch {
    return false;
  }
}
