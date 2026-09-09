import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { isPathWithinRoot, type PathFlavor } from "./security-policy.js";

export interface MountedLocalAsset {
  body: Buffer | null;
  bytes: number;
  filePath: string;
}

export async function loadBoundedMountedLocalAsset(
  realRoot: string,
  relativePath: string,
  maximumBytes: number,
  method: "GET" | "HEAD",
  flavor: PathFlavor = process.platform === "win32" ? "win32" : "posix",
): Promise<MountedLocalAsset> {
  const approvedRoot = await realpath(realRoot);
  const candidate = path.resolve(approvedRoot, ...relativePath.split("/"));
  if (!isPathWithinRoot(approvedRoot, candidate, flavor)) {
    throw new TypeError("Mounted asset path escapes its root.");
  }

  const filePath = await realpath(candidate);
  if (!isPathWithinRoot(approvedRoot, filePath, flavor)) {
    throw new TypeError("Mounted asset real path escapes its root.");
  }

  const metadata = await stat(filePath);
  if (!metadata.isFile()) throw new TypeError("Mounted asset is not a regular file.");
  if (metadata.size > maximumBytes) throw new RangeError("Mounted asset exceeds the byte limit.");

  return {
    body: method === "HEAD" ? null : await readBoundedLocalAsset(filePath, maximumBytes),
    bytes: metadata.size,
    filePath,
  };
}

async function readBoundedLocalAsset(filePath: string, maximumBytes: number): Promise<Buffer> {
  const handle = await open(filePath, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new TypeError("Mounted asset is not a regular file.");
    if (metadata.size > maximumBytes) throw new RangeError("Mounted asset exceeds the byte limit.");

    const bytes = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const probe = Buffer.alloc(1);
    const extra = await handle.read(probe, 0, 1, offset);
    if (extra.bytesRead !== 0) {
      throw new RangeError("Mounted asset changed beyond the byte limit while reading.");
    }
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}
