import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstat, open, readFile, readdir, realpath, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  decideLocalUserSelectedPath,
  type LocalPathPolicyOptions,
  type WindowsDriveType,
} from "./security-policy.js";

const execFileAsync = promisify(execFile);
const MAXIMUM_FILE_BYTES = 128 * 1024 * 1024;
const ATOMIC_WRITE_RESIDUE_MINIMUM_AGE_MS = 24 * 60 * 60 * 1_000;
const WINDOWS_DRIVE_TYPE_SCRIPT =
  "[System.IO.DriveInfo]::new($env:ATNI_GEOBASE_DRIVE_ROOT).DriveType.ToString().ToLowerInvariant()";
const LOCAL_LINUX_FILE_SYSTEM_TYPES = new Set([
  "apfs",
  "bcachefs",
  "btrfs",
  "erofs",
  "exfat",
  "ext2",
  "ext3",
  "ext4",
  "f2fs",
  "hfsplus",
  "iso9660",
  "ntfs",
  "ntfs3",
  "overlay",
  "ramfs",
  "squashfs",
  "tmpfs",
  "udf",
  "vfat",
  "xfs",
  "zfs",
]);
const NETWORK_LINUX_FILE_SYSTEM_TYPES = new Set([
  "9p",
  "afs",
  "ceph",
  "cifs",
  "davfs",
  "fuse.davfs",
  "fuse.glusterfs",
  "fuse.rclone",
  "fuse.s3fs",
  "fuse.sshfs",
  "gfs",
  "gfs2",
  "glusterfs",
  "lustre",
  "ncp",
  "nfs",
  "nfs4",
  "ocfs2",
  "smb",
  "smb2",
  "smb3",
  "sshfs",
]);

export class LocalFilePolicyError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LocalFilePolicyError";
  }
}

export interface AtomicWriteRecoveryReceipt {
  deferred: number;
  inspected: number;
  removed: number;
}

/** Queries Windows for the physical/logical drive category without interpolating a path into script text. */
export async function lookupWindowsDriveType(driveRoot: string): Promise<WindowsDriveType> {
  if (!/^[A-Z]:$/.test(driveRoot)) throw new Error("Invalid drive root.");
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_DRIVE_TYPE_SCRIPT],
    {
      timeout: 5_000,
      windowsHide: true,
      maxBuffer: 4_096,
      env: { ...process.env, ATNI_GEOBASE_DRIVE_ROOT: driveRoot },
    },
  );

  switch (stdout.trim().toLowerCase()) {
    case "fixed":
      return "fixed";
    case "removable":
      return "removable";
    case "network":
      return "network";
    case "cdr om":
    case "cdrom":
      return "optical";
    case "ram":
    case "ramdisk":
      return "ram-disk";
    case "norootdirectory":
      return "no-root";
    default:
      return "unknown";
  }
}

/** Classifies a Linux mount type and rejects unknown or ambiguous storage fail-closed. */
export function classifyLinuxFileSystemType(fileSystemType: string): boolean {
  const normalized = fileSystemType.trim().toLowerCase();
  if (NETWORK_LINUX_FILE_SYSTEM_TYPES.has(normalized)) return true;
  if (LOCAL_LINUX_FILE_SYSTEM_TYPES.has(normalized)) return false;
  throw new Error(`Unsupported or ambiguous POSIX file system type: ${normalized || "empty"}`);
}

/** Resolves a POSIX path to a mount and reports whether its storage is network-backed. */
export async function lookupPosixNetworkPath(absolutePath: string): Promise<boolean> {
  const existingPath = await nearestExistingPath(absolutePath);
  if (process.platform === "linux") {
    const { stdout } = await execFileAsync(
      "findmnt",
      ["--noheadings", "--output", "FSTYPE", "--target", existingPath],
      { maxBuffer: 4_096, timeout: 5_000, windowsHide: true },
    );
    const fileSystemType = stdout.trim().split(/\s+/u)[0];
    return classifyLinuxFileSystemType(fileSystemType ?? "");
  }
  if (process.platform === "darwin") {
    const { stdout } = await execFileAsync("/bin/df", ["-P", existingPath], {
      maxBuffer: 16_384,
      timeout: 5_000,
      windowsHide: true,
    });
    const lastLine = stdout
      .trim()
      .split(/\r?\n/u)
      .filter((line) => line.trim().length > 0)
      .at(-1);
    const device = lastLine?.trim().split(/\s+/u)[0] ?? "";
    if (device.startsWith("/dev/")) return false;
    if (/^(?:\/\/|[^/\s]+:)/u.test(device)) return true;
    throw new Error(`Unsupported or ambiguous macOS mount device: ${device || "empty"}`);
  }
  throw new Error(`POSIX mount-locality lookup is unsupported on ${process.platform}`);
}

async function nearestExistingPath(candidate: string): Promise<string> {
  let current = path.resolve(candidate);
  while (true) {
    try {
      await stat(current);
      return current;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function policyOptions(): LocalPathPolicyOptions {
  return process.platform === "win32"
    ? { platform: "win32", windowsDriveTypeLookup: lookupWindowsDriveType }
    : { networkPathLookup: lookupPosixNetworkPath, platform: process.platform };
}

async function requireLocalPath(candidate: string): Promise<string> {
  const decision = await decideLocalUserSelectedPath(candidate, policyOptions());
  if (!decision.allowed) {
    throw new LocalFilePolicyError(decision.reason, "The selected path is not an approved local path.");
  }
  return decision.normalizedPath;
}

/** Resolves and bounds one user-selected local file without reading its contents. */
export async function resolveUserSelectedLocalFile(selectedPath: string): Promise<string> {
  const normalized = await requireLocalPath(selectedPath);
  let resolved: string;
  try {
    resolved = await realpath(normalized);
  } catch {
    throw new LocalFilePolicyError("file-unavailable", "The selected file is unavailable.");
  }
  const checkedResolved = await requireLocalPath(resolved);
  const metadata = await stat(checkedResolved);
  if (!metadata.isFile()) throw new LocalFilePolicyError("not-a-file", "The selection is not a file.");
  if (metadata.size > MAXIMUM_FILE_BYTES) {
    throw new LocalFilePolicyError("file-too-large", "The selected file exceeds the desktop limit.");
  }
  return checkedResolved;
}

/** Resolves an existing directory and applies the same fixed/local-drive policy used for selected files. */
export async function resolveApprovedLocalDirectory(candidate: string): Promise<string> {
  const normalized = await requireLocalPath(candidate);
  let resolved: string;
  try {
    resolved = await realpath(normalized);
  } catch {
    throw new LocalFilePolicyError("directory-unavailable", "The local working directory is unavailable.");
  }
  const checkedResolved = await requireLocalPath(resolved);
  const metadata = await stat(checkedResolved);
  if (!metadata.isDirectory()) {
    throw new LocalFilePolicyError("not-a-directory", "The local working path is not a directory.");
  }
  return checkedResolved;
}

export async function readUserSelectedUtf8File(selectedPath: string): Promise<{
  contents: string;
  bytesRead: number;
  exactBytesSha256: string;
  resolvedPath: string;
}> {
  const resolvedPath = await resolveUserSelectedLocalFile(selectedPath);
  const bytes = await readFile(resolvedPath);
  const decoded = decodeUserSelectedUtf8Bytes(bytes);
  return {
    contents: decoded.contents,
    bytesRead: bytes.byteLength,
    exactBytesSha256: decoded.exactBytesSha256,
    resolvedPath,
  };
}

/** Rejects normalization-prone encodings and decodes exactly the selected UTF-8 byte view. */
export function decodeUserSelectedUtf8Bytes(bytes: Uint8Array): {
  contents: string;
  exactBytesSha256: string;
} {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new LocalFilePolicyError(
      "utf8-bom-unsupported",
      "UTF-8 BOM is unsupported; save the selected file as UTF-8 without a BOM.",
    );
  }

  let contents: string;
  try {
    contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new LocalFilePolicyError("invalid-utf8", "The selected file is not valid UTF-8 text.");
  }
  return {
    contents,
    exactBytesSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function validateTextSize(contents: string): number {
  const bytes = Buffer.byteLength(contents, "utf8");
  if (bytes > MAXIMUM_FILE_BYTES) {
    throw new LocalFilePolicyError("file-too-large", "The requested file exceeds the desktop limit.");
  }
  return bytes;
}

async function resolvedLocalWritePath(selectedPath: string): Promise<string> {
  const normalized = await requireLocalPath(selectedPath);
  const selectedDirectory = path.dirname(normalized);
  let resolvedDirectory: string;
  try {
    resolvedDirectory = await realpath(selectedDirectory);
  } catch {
    throw new LocalFilePolicyError("directory-unavailable", "The selected directory is unavailable.");
  }
  const checkedDirectory = await requireLocalPath(resolvedDirectory);
  const destination = path.join(checkedDirectory, path.basename(normalized));
  return requireLocalPath(destination);
}

function escapedRegularExpression(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function processMayBeAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return !isNodeError(error) || error.code !== "ESRCH";
  }
}

/**
 * Removes only stale, regular files matching GeoBase's exact temporary-name contract for one
 * destination. Recent, symlinked, non-file, or failed removals remain deferred and visible.
 */
export async function recoverInterruptedAtomicWrites(
  resolvedDestination: string,
  nowMilliseconds = Date.now(),
): Promise<AtomicWriteRecoveryReceipt> {
  const directory = path.dirname(resolvedDestination);
  const destinationName = path.basename(resolvedDestination);
  const pattern = new RegExp(
    `^\\.${escapedRegularExpression(destinationName)}\\.([1-9][0-9]*)\\.[0-9a-f]{24}\\.tmp$`,
    "u",
  );
  const receipt: AtomicWriteRecoveryReceipt = { deferred: 0, inspected: 0, removed: 0 };

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const match = pattern.exec(entry.name);
    if (match === null) continue;
    receipt.inspected += 1;
    const residuePath = path.join(directory, entry.name);
    try {
      const metadata = await lstat(residuePath);
      const ageMilliseconds = nowMilliseconds - metadata.mtimeMs;
      const processId = Number(match[1]);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        ageMilliseconds < ATOMIC_WRITE_RESIDUE_MINIMUM_AGE_MS ||
        processMayBeAlive(processId)
      ) {
        receipt.deferred += 1;
        continue;
      }
      await unlink(residuePath);
      receipt.removed += 1;
    } catch {
      receipt.deferred += 1;
    }
  }
  return receipt;
}

/** Writes beside the destination, flushes, and atomically renames into place. */
export async function atomicWriteUserSelectedUtf8File(
  selectedPath: string,
  contents: string,
): Promise<{ bytesWritten: number; recovery: AtomicWriteRecoveryReceipt; resolvedPath: string }> {
  const bytesWritten = validateTextSize(contents);
  const resolvedPath = await resolvedLocalWritePath(selectedPath);
  const recovery = await recoverInterruptedAtomicWrites(resolvedPath);
  const directory = path.dirname(resolvedPath);
  const temporaryName = `.${path.basename(resolvedPath)}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`;
  const temporaryPath = path.join(directory, temporaryName);
  const handle = await open(temporaryPath, "wx", 0o600);

  let renamed = false;
  try {
    await handle.writeFile(contents, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    await rename(temporaryPath, resolvedPath);
    renamed = true;
  } finally {
    try {
      await handle.close();
    } catch {
      // The successful path already closed the handle.
    }
    if (!renamed) {
      try {
        await unlink(temporaryPath);
      } catch {
        // Preserve the primary write error; the randomly named temp is never used as output.
      }
    }
  }

  return { bytesWritten, recovery, resolvedPath };
}
