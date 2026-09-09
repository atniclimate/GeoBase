import type { JsonObject } from "../../shared/json.js";
import { assertPositionInCrs, transformPosition } from "../crs.js";
import { assertWktMatchesEpsg } from "../crs-wkt.js";

export const BASELINE_PROFILE = "geobase.local-dem/1" as const;
export const BASELINE_LIMITS = {
  manifestBytes: 256 * 1024,
  assetBytes: 512 * 1024 * 1024,
  totalBytes: 1024 * 1024 * 1024,
  cells: 1_048_576,
  displayBytes: 16 * 1024 * 1024,
  vertices: 65_536,
  indices: 393_216,
} as const;

export class BaselineError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly state = code === "GB-CRS-003"
      ? "conflicting"
      : code === "GB-TIER-003"
        ? "approval_required"
        : code === "GB-PROF-001"
          ? "missing"
          : "incompatible",
  ) {
    super(`${code}: ${message}`);
    this.name = "BaselineError";
  }
}

export interface BaselineAsset {
  path: string;
  bytes: number;
  sha256: string;
}
export interface BaselineGrid {
  horizontal_crs: "EPSG:4269" | "EPSG:4326";
  wkt: string;
  vertical_reference: string;
  unit: "metre";
  width: number;
  height: number;
  affine: [number, number, number, number, number, number];
  native_resolution: [number, number];
  nodata: number | null;
  mask_encoding: "u8-0-invalid-1-valid";
}
export interface BaselineManifest {
  schema_version: "1.0.0";
  profile: typeof BASELINE_PROFILE;
  package_id: string;
  edition: string;
  kind: "synthetic" | "measured";
  title: string;
  effective_tier: "T3";
  source: JsonObject & {
    producer: string;
    product: string;
    edition: string;
    rights: string;
    attribution: string;
    metadata_urls: string[];
  };
  grid: BaselineGrid;
  assets: { original: BaselineAsset; values: BaselineAsset; mask: BaselineAsset; display: BaselineAsset };
  recipe: JsonObject & {
    id: string;
    version: "1.0.0";
    horizontal_operation: string;
    vertical_operation: "none";
    resampling: "none";
  };
}
export interface BaselineDisplay {
  schema_version: "1.0.0";
  mode: "relative-relief";
  height_reference_m: number;
  positions: [number, number, number][];
  source_indices: number[];
  indices: number[];
  interpolation: "linear triangles; no cells spanning NoData";
  vertical_conversion: "none";
}
export interface BaselineBinding {
  profile: typeof BASELINE_PROFILE;
  package_id: string;
  edition: string;
  manifest_sha256: string;
  artifact_reference: "manifest.json";
  effective_tier: "T3";
  source_sha256: string;
  recipe_id: string;
}
export interface BaselinePresentation {
  manifest: BaselineManifest;
  binding: BaselineBinding;
  display: BaselineDisplay;
}
export interface BaselineData {
  manifest: BaselineManifest;
  values: Float32Array;
  mask: Uint8Array;
  display: BaselineDisplay;
}
export type BaselineQuery = { row: number; column: number } | { x: number; y: number };
export interface BaselineProbe {
  status: "observed" | "observed_zero" | "source_null" | "outside_spatial_coverage";
  value: number | null;
  row: number | null;
  column: number | null;
  x: number | null;
  y: number | null;
  unit: "metre";
  vertical_reference: string;
  value_product: "lossless native grid";
}

function fail(code: string, message: string): never {
  throw new BaselineError(code, message);
}
function object(value: unknown, label: string, keys?: string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail("GB-PKG-001", `${label} must be an object`);
  const result = value as Record<string, unknown>;
  if (
    keys !== undefined &&
    (Object.keys(result).length !== keys.length || keys.some((key) => !Object.hasOwn(result, key)))
  )
    fail("GB-PKG-001", `${label} has missing or unexpected fields`);
  return result;
}
function text(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 32_768 ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 && code !== 9 && code !== 10 && code !== 13;
    })
  )
    fail("GB-PKG-001", `${label} must be bounded text`);
  return value;
}
function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail("GB-MEAS-001", `${label} must be finite`);
  return value;
}
function integer(value: unknown, label: string, max: number, min = 0): number {
  const n = finite(value, label);
  if (!Number.isSafeInteger(n) || n < min || n > max)
    fail("GB-PKG-004", `${label} exceeds its supported range`);
  return n;
}
function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value))
    fail("GB-PKG-003", `${label} must be a SHA-256 digest`);
  return value;
}
function literal(value: unknown, expected: string, label: string, code = "GB-PKG-001"): void {
  if (value !== expected) fail(code, `${label} must equal ${expected}`);
}

/** Platform-independent restrictive directory profile; no URL decoding or backslash normalization. */
export function assertSafeBaselineRelativePath(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length > 240 || !/^[A-Za-z0-9_./-]+$/u.test(value))
    fail("GB-PKG-002", "Asset path is not a safe relative path");
  const segments = value.split("/");
  if (
    segments.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part.endsWith(".") ||
        /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(part),
    )
  )
    fail("GB-PKG-002", "Asset path contains unsafe segments");
}
function asset(value: unknown, label: string): BaselineAsset {
  const a = object(value, label, ["path", "bytes", "sha256"]);
  assertSafeBaselineRelativePath(a.path);
  return {
    path: a.path,
    bytes: integer(a.bytes, `${label}.bytes`, BASELINE_LIMITS.assetBytes, 1),
    sha256: digest(a.sha256, `${label}.sha256`),
  };
}

/** Pure, exact-version preflight. No filesystem, network, cache or rendering side effects. */
export function parseBaselineManifest(value: unknown): BaselineManifest {
  const m = object(value, "manifest", [
    "schema_version",
    "profile",
    "package_id",
    "edition",
    "kind",
    "title",
    "effective_tier",
    "source",
    "grid",
    "assets",
    "recipe",
  ]);
  literal(m.schema_version, "1.0.0", "schema_version");
  literal(m.profile, BASELINE_PROFILE, "profile");
  literal(m.effective_tier, "T3", "effective_tier", "GB-TIER-003");
  if (m.kind !== "synthetic" && m.kind !== "measured")
    fail("GB-PKG-001", "kind must distinguish synthetic from measured");
  const packageId = text(m.package_id, "package_id");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(packageId) || packageId.length > 100)
    fail("GB-PKG-001", "package_id must be a portable identifier");
  const source = object(m.source, "source");
  for (const key of ["producer", "product", "edition", "rights", "attribution"])
    text(source[key], `source.${key}`);
  if (
    !Array.isArray(source.metadata_urls) ||
    source.metadata_urls.length > 32 ||
    source.metadata_urls.some(
      (url) => typeof url !== "string" || url.length > 2048 || !/^https:\/\//u.test(url),
    )
  )
    fail("GB-PKG-001", "metadata_urls must contain bounded HTTPS evidence references");
  const g = object(m.grid, "grid", [
    "horizontal_crs",
    "wkt",
    "vertical_reference",
    "unit",
    "width",
    "height",
    "affine",
    "native_resolution",
    "nodata",
    "mask_encoding",
  ]);
  if (g.horizontal_crs === null || g.horizontal_crs === undefined || g.wkt === null || g.wkt === undefined)
    fail("GB-CRS-001", "Authoritative horizontal CRS metadata is absent");
  if (g.horizontal_crs !== "EPSG:4269" && g.horizontal_crs !== "EPSG:4326")
    fail("GB-CRS-002", "Only native EPSG:4269/4326 geographic grids are supported");
  const wkt = text(g.wkt, "grid.wkt");
  try {
    assertWktMatchesEpsg(wkt, Number(g.horizontal_crs.slice(5)), {
      allowGeographicAuthorityAxisOrder: true,
      allowRasterEllipsoidSerialization: true,
    });
  } catch (error) {
    fail(
      /^(?:GEOGCS|GEOGCRS|GEODCRS)\s*\[/u.test(wkt) ? "GB-CRS-003" : "GB-CRS-002",
      `Unsupported or contradictory authoritative WKT: ${error instanceof Error ? error.message : "invalid WKT"}`,
    );
  }
  literal(g.unit, "metre", "grid.unit", "GB-MEAS-001");
  literal(g.mask_encoding, "u8-0-invalid-1-valid", "grid.mask_encoding", "GB-MEAS-001");
  text(g.vertical_reference, "grid.vertical_reference");
  const width = integer(g.width, "grid.width", BASELINE_LIMITS.cells, 2),
    height = integer(g.height, "grid.height", BASELINE_LIMITS.cells, 2);
  if (width * height > BASELINE_LIMITS.cells) fail("GB-PKG-004", "Native grid cell budget exceeded");
  if (!Array.isArray(g.affine) || g.affine.length !== 6)
    fail("GB-MEAS-001", "Grid affine must have six values");
  const affine = g.affine.map((n) => finite(n, "grid.affine")) as BaselineGrid["affine"];
  if (affine[1] <= 0 || affine[5] >= 0 || affine[2] !== 0 || affine[4] !== 0)
    fail("GB-MEAS-001", "Only unrotated north-up native grids are supported");
  if (
    !Array.isArray(g.native_resolution) ||
    g.native_resolution.length !== 2 ||
    g.native_resolution[0] !== affine[1] ||
    g.native_resolution[1] !== -affine[5]
  )
    fail("GB-MEAS-001", "Native resolution contradicts affine support");
  if (g.nodata !== null) finite(g.nodata, "grid.nodata");
  assertPositionInCrs([affine[0], affine[3]], g.horizontal_crs);
  assertPositionInCrs([affine[0] + width * affine[1], affine[3] + height * affine[5]], g.horizontal_crs);
  const a = object(m.assets, "assets", ["original", "values", "mask", "display"]);
  const assets = {
    original: asset(a.original, "original"),
    values: asset(a.values, "values"),
    mask: asset(a.mask, "mask"),
    display: asset(a.display, "display"),
  };
  const paths = Object.values(assets).map((member) => member.path.toLowerCase());
  if (new Set(paths).size !== paths.length || paths.includes("manifest.json"))
    fail("GB-PKG-002", "Duplicate or manifest-colliding asset path");
  if (
    Object.values(assets).reduce((sum, member) => sum + member.bytes, 0) > BASELINE_LIMITS.totalBytes ||
    assets.display.bytes > BASELINE_LIMITS.displayBytes
  )
    fail("GB-PKG-004", "Package byte budget exceeded");
  if (assets.values.bytes !== width * height * 4 || assets.mask.bytes !== width * height)
    fail("GB-PKG-003", "Native float32/mask byte lengths contradict grid dimensions");
  const recipe = object(m.recipe, "recipe");
  digest(recipe.id, "recipe.id");
  literal(recipe.version, "1.0.0", "recipe.version");
  text(recipe.horizontal_operation, "recipe.horizontal_operation");
  literal(recipe.vertical_operation, "none", "recipe.vertical_operation", "GB-MEAS-001");
  literal(recipe.resampling, "none", "recipe.resampling", "GB-MEAS-001");
  return {
    schema_version: "1.0.0",
    profile: BASELINE_PROFILE,
    package_id: packageId,
    edition: text(m.edition, "edition"),
    kind: m.kind,
    title: text(m.title, "title"),
    effective_tier: "T3",
    source: structuredClone(source) as BaselineManifest["source"],
    grid: {
      horizontal_crs: g.horizontal_crs,
      wkt,
      vertical_reference: text(g.vertical_reference, "vertical_reference"),
      unit: "metre",
      width,
      height,
      affine,
      native_resolution: [affine[1], -affine[5]],
      nodata: g.nodata as number | null,
      mask_encoding: "u8-0-invalid-1-valid",
    },
    assets,
    recipe: structuredClone(recipe) as BaselineManifest["recipe"],
  };
}

export function parseBaselineBinding(value: unknown): BaselineBinding {
  const b = object(value, "baseline_context", [
    "profile",
    "package_id",
    "edition",
    "manifest_sha256",
    "artifact_reference",
    "effective_tier",
    "source_sha256",
    "recipe_id",
  ]);
  literal(b.profile, BASELINE_PROFILE, "baseline_context.profile");
  literal(b.artifact_reference, "manifest.json", "baseline_context.artifact_reference");
  literal(b.effective_tier, "T3", "baseline_context.effective_tier", "GB-TIER-003");
  return {
    profile: BASELINE_PROFILE,
    package_id: text(b.package_id, "package_id"),
    edition: text(b.edition, "edition"),
    manifest_sha256: digest(b.manifest_sha256, "manifest_sha256"),
    artifact_reference: "manifest.json",
    effective_tier: "T3",
    source_sha256: digest(b.source_sha256, "source_sha256"),
    recipe_id: digest(b.recipe_id, "recipe_id"),
  };
}
export function createBaselineBinding(manifest: BaselineManifest, manifestSha256: string): BaselineBinding {
  return parseBaselineBinding({
    profile: BASELINE_PROFILE,
    package_id: manifest.package_id,
    edition: manifest.edition,
    manifest_sha256: manifestSha256,
    artifact_reference: "manifest.json",
    effective_tier: "T3",
    source_sha256: manifest.assets.original.sha256,
    recipe_id: manifest.recipe.id,
  });
}
export function verifyBaselineBinding(expected: BaselineBinding, actual: BaselineBinding): boolean {
  const a = parseBaselineBinding(expected),
    b = parseBaselineBinding(actual);
  return (Object.keys(a) as (keyof BaselineBinding)[]).every((key) => a[key] === b[key]);
}

export function nativeCellCenter(grid: BaselineGrid, row: number, column: number): [number, number] {
  return [grid.affine[0] + (column + 0.5) * grid.affine[1], grid.affine[3] + (row + 0.5) * grid.affine[5]];
}

/** Validates native arrays and independently checks every mesh vertex and its mask support. */
export function validateBaselineData(
  manifest: BaselineManifest,
  valueBytes: Uint8Array,
  maskBytes: Uint8Array,
  displayValue: unknown,
): BaselineData {
  const count = manifest.grid.width * manifest.grid.height;
  if (valueBytes.byteLength !== count * 4 || maskBytes.byteLength !== count)
    fail("GB-PKG-003", "Native payload byte-length mismatch");
  const values = new Float32Array(count),
    mask = maskBytes.slice();
  const view = new DataView(valueBytes.buffer, valueBytes.byteOffset, valueBytes.byteLength);
  let minimum = Number.POSITIVE_INFINITY;
  for (let i = 0; i < count; i++) {
    if (mask[i] !== 0 && mask[i] !== 1) fail("GB-MEAS-001", "Mask contains a value other than zero or one");
    const value = view.getFloat32(i * 4, true);
    values[i] = value;
    if (
      mask[i] === 1 &&
      (!Number.isFinite(value) || Math.abs(value) > 20_000 || value === manifest.grid.nodata)
    )
      fail("GB-MEAS-001", "Valid native elevation is non-finite, unsupported, or contradicts NoData");
    if (mask[i] === 1) minimum = Math.min(minimum, value);
  }
  const d = object(displayValue, "display", [
    "schema_version",
    "mode",
    "height_reference_m",
    "positions",
    "source_indices",
    "indices",
    "interpolation",
    "vertical_conversion",
  ]);
  literal(d.schema_version, "1.0.0", "display.schema_version");
  literal(d.mode, "relative-relief", "display.mode");
  literal(d.vertical_conversion, "none", "display.vertical_conversion", "GB-MEAS-001");
  literal(
    d.interpolation,
    "linear triangles; no cells spanning NoData",
    "display.interpolation",
    "GB-MEAS-001",
  );
  const reference = finite(d.height_reference_m, "height_reference_m");
  if (reference !== minimum) fail("GB-MEAS-001", "Display reference must equal the valid native minimum");
  if (
    !Array.isArray(d.positions) ||
    !Array.isArray(d.source_indices) ||
    d.positions.length !== d.source_indices.length ||
    d.positions.length < 3 ||
    d.positions.length > BASELINE_LIMITS.vertices
  )
    fail("GB-PKG-004", "Display vertex budget or mapping is invalid");
  if (
    !Array.isArray(d.indices) ||
    d.indices.length < 3 ||
    d.indices.length % 3 !== 0 ||
    d.indices.length > BASELINE_LIMITS.indices
  )
    fail("GB-PKG-004", "Display triangle budget is invalid");
  const seen = new Set<number>();
  const sourceIndices = d.source_indices.map((value) => integer(value, "source index", count - 1));
  const positions = d.positions.map((position, i) => {
    if (!Array.isArray(position) || position.length !== 3)
      fail("GB-MEAS-001", "Display position must have three ordinates");
    const p = position.map((n) => finite(n, "display position")) as [number, number, number];
    const sourceIndex = sourceIndices[i] as number;
    if (seen.has(sourceIndex) || mask[sourceIndex] !== 1)
      fail("GB-MEAS-001", "Display vertex repeats or uses a masked native cell");
    seen.add(sourceIndex);
    const native = nativeCellCenter(
      manifest.grid,
      Math.floor(sourceIndex / manifest.grid.width),
      sourceIndex % manifest.grid.width,
    );
    const lonlat = transformPosition(native, manifest.grid.horizontal_crs, "EPSG:4326");
    if (
      Math.abs(p[0] - (lonlat[0] as number)) > 1e-7 ||
      Math.abs(p[1] - (lonlat[1] as number)) > 1e-7 ||
      Math.abs(p[2] - ((values[sourceIndex] as number) - reference)) > 0.0001
    )
      fail("GB-MEAS-001", "Display vertex contradicts native coordinate or elevation");
    return p;
  });
  const indices = d.indices.map((value) => integer(value, "triangle index", positions.length - 1));
  let checks = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const cellIndices = indices.slice(i, i + 3).map((index) => sourceIndices[index] as number);
    const rows = cellIndices.map((index) => Math.floor(index / manifest.grid.width)),
      columns = cellIndices.map((index) => index % manifest.grid.width);
    if (
      new Set(cellIndices).size !== 3 ||
      ((rows[1] as number) - (rows[0] as number)) * ((columns[2] as number) - (columns[0] as number)) ===
        ((rows[2] as number) - (rows[0] as number)) * ((columns[1] as number) - (columns[0] as number))
    )
      fail("GB-MEAS-001", "Degenerate display triangle");
    const minRow = Math.min(...rows),
      maxRow = Math.max(...rows),
      minCol = Math.min(...columns),
      maxCol = Math.max(...columns);
    checks += (maxRow - minRow + 1) * (maxCol - minCol + 1);
    if (checks > 16 * BASELINE_LIMITS.cells) fail("GB-PKG-004", "Display support validation budget exceeded");
    for (let row = minRow; row <= maxRow; row++)
      for (let col = minCol; col <= maxCol; col++)
        if (mask[row * manifest.grid.width + col] !== 1)
          fail("GB-MEAS-001", "Display triangle spans native NoData");
  }
  return {
    manifest,
    values,
    mask,
    display: {
      schema_version: "1.0.0",
      mode: "relative-relief",
      height_reference_m: reference,
      positions,
      source_indices: sourceIndices,
      indices,
      interpolation: "linear triangles; no cells spanning NoData",
      vertical_conversion: "none",
    },
  };
}

/** A sample is its native pixel center/value, with an explicit half-open pixel-edge footprint. */
export function probeBaseline(data: BaselineData, query: BaselineQuery): BaselineProbe {
  const grid = data.manifest.grid;
  const outside: BaselineProbe = {
    status: "outside_spatial_coverage",
    value: null,
    row: null,
    column: null,
    x: null,
    y: null,
    unit: "metre",
    vertical_reference: grid.vertical_reference,
    value_product: "lossless native grid",
  };
  let row: number, column: number;
  if ("row" in query) {
    row = query.row;
    column = query.column;
  } else {
    const { x, y } = query;
    if (!Number.isFinite(x) || !Number.isFinite(y))
      throw new BaselineError("GB-MEAS-001", "Query ordinates must be finite");
    if (
      x < grid.affine[0] ||
      x >= grid.affine[0] + grid.width * grid.affine[1] ||
      y > grid.affine[3] ||
      y <= grid.affine[3] + grid.height * grid.affine[5]
    )
      return outside;
    column = Math.floor((x - grid.affine[0]) / grid.affine[1]);
    row = Math.floor((y - grid.affine[3]) / grid.affine[5]);
  }
  if (!Number.isSafeInteger(row) || !Number.isSafeInteger(column))
    throw new BaselineError("GB-MEAS-001", "Native row and column must be integers");
  if (row < 0 || column < 0 || row >= grid.height || column >= grid.width) return outside;
  const index = row * grid.width + column,
    [x, y] = nativeCellCenter(grid, row, column);
  const value = data.mask[index] === 1 ? (data.values[index] as number) : null;
  return {
    ...outside,
    row,
    column,
    x,
    y,
    value,
    status: value === null ? "source_null" : value === 0 ? "observed_zero" : "observed",
  };
}
