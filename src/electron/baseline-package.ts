import { createHash } from "node:crypto";
import { lstat, open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  assertSafeBaselineRelativePath,
  BASELINE_LIMITS,
  type BaselineAsset,
  type BaselineData,
  BaselineError,
  type BaselinePresentation,
  createBaselineBinding,
  parseBaselineManifest,
  validateBaselineData,
} from "../core/baseline/manifest.js";
import {
  lookupPosixNetworkPath,
  lookupWindowsDriveType,
  resolveUserSelectedLocalFile,
} from "./local-files.js";
import { decideLocalUserSelectedPath } from "./security-policy.js";

export interface LoadedBaselinePackage extends BaselineData, BaselinePresentation {
  /** Main-process-only path, never persisted in the portable project or sent to the renderer. */
  manifestPath: string;
  openingMilliseconds: number;
  verifiedBytes: number;
}

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new BaselineError("GB-PKG-006", "Package activation cancelled", "missing");
}
function samePath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
/** Reject redirects even when the final target happens to remain under the selected root. */
async function rejectLinkedAncestors(candidate: string): Promise<void> {
  const absolute = path.resolve(candidate);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep)) {
    if (!segment) continue;
    current = path.join(current, segment);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink())
      throw new BaselineError("GB-PKG-002", "Package paths must not contain links or reparse redirects");
    const canonical = await realpath(current);
    if (!samePath(canonical, current)) {
      // Windows may spell a regular ancestor with its 8.3 alias (including the OS temp path).
      // Accept only that spelling class and identical file identity, never a link redirect.
      const target = await stat(canonical);
      if (
        process.platform !== "win32" ||
        !/~[0-9]/u.test(current) ||
        metadata.dev !== target.dev ||
        metadata.ino !== target.ino
      )
        throw new BaselineError("GB-PKG-002", "Package path resolves through a redirect");
    }
  }
}
async function readAndHash(
  candidate: string,
  maximumBytes: number,
  expected: BaselineAsset | null,
  retain: boolean,
  signal?: AbortSignal,
): Promise<{ bytes: Uint8Array; sha256: string; length: number }> {
  cancelled(signal);
  try {
    await rejectLinkedAncestors(candidate);
  } catch (error) {
    if (error instanceof BaselineError) throw error;
    throw new BaselineError("GB-PKG-005", "Required package asset is unavailable", "missing");
  }
  const handle = await open(candidate, "r").catch(() => {
    throw new BaselineError("GB-PKG-005", "Required package asset cannot be opened", "missing");
  });
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new BaselineError("GB-PKG-002", "Package assets must be regular files");
    if (before.size > maximumBytes)
      throw new BaselineError("GB-PKG-004", "Package asset exceeds its byte budget");
    if (expected !== null && before.size !== expected.bytes)
      throw new BaselineError("GB-PKG-003", "Asset byte length differs from the manifest");
    const retained = retain ? new Uint8Array(before.size) : new Uint8Array(0);
    const chunk = Buffer.alloc(Math.min(256 * 1024, Math.max(before.size, 1)));
    const hash = createHash("sha256");
    let offset = 0;
    while (offset < before.size) {
      cancelled(signal);
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, before.size - offset), offset);
      if (bytesRead === 0) throw new BaselineError("GB-PKG-003", "Package asset changed during reading");
      const bytes = chunk.subarray(0, bytesRead);
      hash.update(bytes);
      if (retain) retained.set(bytes, offset);
      offset += bytesRead;
    }
    const probe = await handle.read(chunk, 0, 1, offset);
    const after = await handle.stat();
    if (
      probe.bytesRead !== 0 ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new BaselineError("GB-PKG-003", "Package asset changed during activation");
    await rejectLinkedAncestors(candidate);
    const sha256 = hash.digest("hex");
    if (expected !== null && sha256 !== expected.sha256)
      throw new BaselineError("GB-PKG-003", "Package asset SHA-256 mismatch");
    return { bytes: retained, sha256, length: offset };
  } finally {
    await handle.close();
  }
}
function json(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new BaselineError("GB-PKG-001", "Package JSON must be valid UTF-8 JSON");
  }
}

/** Transactional loader: nothing is attached, cached, rendered or written until all checks pass. */
export async function loadBaselinePackage(
  selectedManifestPath: string,
  options: { signal?: AbortSignal } = {},
): Promise<LoadedBaselinePackage> {
  const started = performance.now();
  cancelled(options.signal);
  let manifestPath: string;
  try {
    // Existing locality policy refuses UNC, mapped network drives, ADS and ambiguous mounts before read.
    const locality = await decideLocalUserSelectedPath(
      selectedManifestPath,
      process.platform === "win32"
        ? { platform: "win32", windowsDriveTypeLookup: lookupWindowsDriveType }
        : { platform: process.platform, networkPathLookup: lookupPosixNetworkPath },
    );
    if (!locality.allowed)
      throw new BaselineError("GB-PKG-002", "Package path is not on approved local storage");
    await rejectLinkedAncestors(locality.normalizedPath);
    manifestPath = await resolveUserSelectedLocalFile(selectedManifestPath);
  } catch (error) {
    if (error instanceof BaselineError) throw error;
    throw new BaselineError("GB-PKG-002", "Select an existing regular manifest on an approved local drive");
  }
  if (path.basename(manifestPath) !== "manifest.json")
    throw new BaselineError("GB-PKG-001", "Select the package manifest.json");
  const manifestBytes = await readAndHash(
    manifestPath,
    BASELINE_LIMITS.manifestBytes,
    null,
    true,
    options.signal,
  );
  const manifest = parseBaselineManifest(json(manifestBytes.bytes));
  const root = path.dirname(manifestPath);
  const payloads: Partial<Record<keyof typeof manifest.assets, Uint8Array>> = {};
  let verifiedBytes = manifestBytes.length;
  // Sequential streaming keeps peak memory bounded, including a potentially larger original source.
  for (const key of ["original", "values", "mask", "display"] as const) {
    const asset = manifest.assets[key];
    assertSafeBaselineRelativePath(asset.path);
    const candidate = path.join(root, ...asset.path.split("/"));
    const relative = path.relative(root, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw new BaselineError("GB-PKG-002", "Package asset escaped its root");
    const result = await readAndHash(
      candidate,
      key === "display" ? BASELINE_LIMITS.displayBytes : BASELINE_LIMITS.assetBytes,
      asset,
      key !== "original",
      options.signal,
    );
    if (key !== "original") payloads[key] = result.bytes;
    verifiedBytes += result.length;
  }
  cancelled(options.signal);
  const data = validateBaselineData(
    manifest,
    payloads.values as Uint8Array,
    payloads.mask as Uint8Array,
    json(payloads.display as Uint8Array),
  );
  cancelled(options.signal);
  // Rebind the manifest after potentially long source hashing; reject edits during activation.
  const finalManifest = await readAndHash(
    manifestPath,
    BASELINE_LIMITS.manifestBytes,
    null,
    false,
    options.signal,
  );
  if (finalManifest.sha256 !== manifestBytes.sha256)
    throw new BaselineError("GB-PKG-003", "Manifest changed during activation");
  return {
    ...data,
    binding: createBaselineBinding(manifest, manifestBytes.sha256),
    manifestPath,
    verifiedBytes,
    openingMilliseconds: performance.now() - started,
  };
}

export function baselinePresentation(loaded: LoadedBaselinePackage): BaselinePresentation {
  return {
    manifest: structuredClone(loaded.manifest),
    binding: structuredClone(loaded.binding),
    display: structuredClone(loaded.display),
  };
}
