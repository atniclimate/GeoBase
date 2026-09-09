import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

export interface LocalRuntimePaths {
  userData: string;
  sessionData: string;
  logs: string;
  temp: string;
  crashDumps: string;
}

interface ElectronPathApplication {
  isReady(): boolean;
  setPath(name: string, directory: string): void;
}

const KNOWN_LOCAL_DATA_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
`;

// FileAttributes checks include Windows reparse tags that Node's symlink check
// does not identify. Paths are JSON in a private child environment, never code.
const PREPARE_LOCAL_DIRECTORIES_SCRIPT = `
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$request = $env:ATNI_GEOBASE_RUNTIME_DIRECTORIES | ConvertFrom-Json
$localData = [string]$request.localData
$appRoot = [string]$request.appRoot
$directories = @($request.directories)
$driveRoot = [IO.Path]::GetPathRoot($localData)
$drive = [IO.DriveInfo]::new($driveRoot)
if ($drive.DriveType -ne [IO.DriveType]::Fixed -or -not $drive.IsReady) {
  throw 'The local runtime drive is not an available fixed local drive.'
}

function Assert-DirectoryChain([string]$candidate, [bool]$mustExist) {
  $current = $candidate
  while ($null -ne $current) {
    $attributes = $null
    try {
      $attributes = [IO.File]::GetAttributes($current)
    } catch {
      $cause = $_.Exception
      while ($null -ne $cause.InnerException) { $cause = $cause.InnerException }
      if ($cause -isnot [IO.FileNotFoundException] -and
          $cause -isnot [IO.DirectoryNotFoundException]) { throw }
      if ($mustExist) { throw 'A required local runtime directory is unavailable.' }
    }
    if ($null -ne $attributes) {
      if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'A local runtime directory or ancestor is a reparse point.'
      }
      if (($attributes -band [IO.FileAttributes]::Directory) -eq 0) {
        throw 'A local runtime directory or ancestor is not a directory.'
      }
    }
    $parent = [IO.Directory]::GetParent($current)
    $current = if ($null -eq $parent) { $null } else { $parent.FullName }
  }
}

Assert-DirectoryChain $localData $true
if ([IO.Path]::GetDirectoryName($appRoot) -ne $localData) {
  throw 'The application data directory is outside the local-data folder.'
}
# Inspect every existing branch before creating anything, including later
# children whose unsafe state must not leave earlier branches modified.
Assert-DirectoryChain $appRoot $false
foreach ($directory in $directories) {
  if ([IO.Path]::GetDirectoryName($directory) -ne $appRoot) {
    throw 'A runtime directory is outside the application data directory.'
  }
  Assert-DirectoryChain $directory $false
}

foreach ($directory in @($appRoot) + $directories) {
  Assert-DirectoryChain ([IO.Path]::GetDirectoryName($directory)) $true
  Assert-DirectoryChain $directory $false
  [void][IO.Directory]::CreateDirectory($directory)
  Assert-DirectoryChain $directory $true
}

foreach ($directory in $directories) {
  Assert-DirectoryChain $directory $true
  $probe = [IO.Path]::Combine($directory, '.local-write-probe-' + [Guid]::NewGuid().ToString('N'))
  $stream = $null
  $created = $false
  try {
    $stream = [IO.FileStream]::new($probe, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write,
      [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough)
    $created = $true
    $stream.WriteByte(0)
    $stream.Flush($true)
  } finally {
    if ($null -ne $stream) { $stream.Dispose() }
    if ($created) {
      Assert-DirectoryChain $directory $true
      [IO.File]::Delete($probe)
    }
  }
}
`;

function runWindowsPathScript(script: string, environment: NodeJS.ProcessEnv = process.env): string {
  if (process.platform !== "win32") throw new Error("Windows local runtime paths require Windows.");
  try {
    return execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      env: environment,
      maxBuffer: 16_384,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
      windowsHide: true,
    }).trim();
  } catch (cause) {
    throw new Error("Local runtime directory validation failed; no alternate profile will be used.", {
      cause,
    });
  }
}

function normalizedWindowsDirectory(candidate: string): string {
  if (!/^[a-z]:[\\/]/iu.test(candidate)) {
    throw new Error("Local runtime directories require an absolute Windows drive path.");
  }
  const segments = candidate.slice(3).split(/[\\/]/u);
  if (
    segments.some(
      (segment) =>
        segment === "." ||
        segment === ".." ||
        /[<>:"|?*]/u.test(segment) ||
        /[. ]$/u.test(segment) ||
        [...segment].some((character) => character.charCodeAt(0) < 32),
    )
  ) {
    throw new Error("The local runtime directory contains an ambiguous path component.");
  }
  return path.win32.resolve(candidate);
}

function requireUnredirectedDirectory(candidate: string, mustExist: boolean): void {
  try {
    const metadata = lstatSync(candidate);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("The local runtime directory must be an ordinary directory.");
    }
    if (realpathSync(candidate).toLowerCase() !== candidate.toLowerCase()) {
      throw new Error("The local runtime directory resolves to a different location.");
    }
  } catch (error) {
    if (!mustExist && error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

/** Uses the Windows known-folder API through built-in .NET, not LOCALAPPDATA. */
export function queryWindowsLocalAppData(): string {
  return normalizedWindowsDirectory(runWindowsPathScript(KNOWN_LOCAL_DATA_SCRIPT));
}

/** Prepares only the fixed runtime children of an already identified local folder. */
export function createWindowsLocalRuntimePaths(localAppData: string): LocalRuntimePaths {
  const localData = normalizedWindowsDirectory(localAppData);
  const appRoot = path.win32.join(localData, "ATNI-GeoBase");
  const paths: LocalRuntimePaths = {
    userData: path.win32.join(appRoot, "UserData"),
    sessionData: path.win32.join(appRoot, "SessionData"),
    logs: path.win32.join(appRoot, "Logs"),
    temp: path.win32.join(appRoot, "Temp"),
    crashDumps: path.win32.join(appRoot, "CrashDumps"),
  };
  requireUnredirectedDirectory(localData, true);
  for (const directory of [appRoot, ...Object.values(paths)]) {
    requireUnredirectedDirectory(directory, false);
  }
  runWindowsPathScript(PREPARE_LOCAL_DIRECTORIES_SCRIPT, {
    ...process.env,
    ATNI_GEOBASE_RUNTIME_DIRECTORIES: JSON.stringify({
      localData,
      appRoot,
      directories: Object.values(paths),
    }),
  });
  for (const directory of Object.values(paths)) requireUnredirectedDirectory(directory, true);
  return paths;
}

/** Must finish synchronously before Electron's first ready/session event. */
export function configureElectronRuntimePaths(
  application: ElectronPathApplication,
  paths: LocalRuntimePaths,
): void {
  if (application.isReady()) throw new Error("Local runtime paths must be configured before readiness.");
  for (const [name, directory] of Object.entries(paths)) application.setPath(name, directory);
}

/** Aligns Node and subsequently launched children with the validated Electron temp path. */
export function configurePackagedWindowsRuntimePaths(
  application: ElectronPathApplication,
  paths: LocalRuntimePaths,
): void {
  configureElectronRuntimePaths(application, paths);
  process.env.TEMP = paths.temp;
  process.env.TMP = paths.temp;
}
