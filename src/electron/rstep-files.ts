import { open } from "node:fs/promises";
import { decodeUserSelectedUtf8Bytes, resolveUserSelectedLocalFile } from "./local-files.js";

/** Existing local-path policy, then a bounded open handle; files cannot grow past the read budget. */
export async function readRstepLocalText(selectedPath: string, maximumBytes: number) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 128 * 1024 * 1024)
    throw new RangeError("Invalid RSTEP file limit.");
  const resolvedPath = await resolveUserSelectedLocalFile(selectedPath);
  const handle = await open(resolvedPath, "r");
  try {
    const initial = await handle.stat();
    if (!initial.isFile() || initial.size > maximumBytes) throw new RangeError("RSTEP file exceeds limit.");
    const bytes = Buffer.alloc(initial.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) throw new Error("RSTEP file changed during read.");
      offset += read.bytesRead;
    }
    const final = await handle.stat();
    if (initial.size !== final.size || initial.mtimeMs !== final.mtimeMs || initial.ctimeMs !== final.ctimeMs)
      throw new Error("RSTEP file changed during read.");
    return { ...decodeUserSelectedUtf8Bytes(bytes), bytesRead: bytes.length, resolvedPath };
  } finally {
    await handle.close();
  }
}
