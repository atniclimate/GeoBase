export class CrsWktError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CrsWktError";
  }
}

interface WktNode {
  readonly keyword: string;
  readonly values: readonly WktValue[];
}

type WktValue = WktNode | number | string;

interface ProjectionParameterSpec {
  readonly authorityCode: number;
  readonly expected: number;
  readonly kind: "angle" | "length";
  readonly label: string;
  readonly names: readonly string[];
}

export interface CrsWktValidationOptions {
  /**
   * Permits the EPSG registry's latitude/longitude axis declaration while
   * validating a mandatory, unreferenced GeoPackage SRS row. Feature-table
   * registrations must retain the default application x/y requirement.
   */
  allowGeographicAuthorityAxisOrder?: boolean;
  /** Fixed decimal serialization allowance for geographic raster metadata only.
   * All datum, authority, name, unit and axis checks still apply. */
  allowRasterEllipsoidSerialization?: boolean;
}

const DEGREE_TO_RADIAN = Math.PI / 180;
const MAX_WKT_LENGTH = 1_000_000;
const MAX_WKT_DEPTH = 64;

const NAD83_DATUM_NAMES = new Set([
  "DNORTHAMERICAN1983",
  "DNORTHAMERICANDATUM1983",
  "NAD83",
  "NORTHAMERICAN1983",
  "NORTHAMERICANDATUM1983",
]);
const WGS84_DATUM_NAMES = new Set([
  "DWGS1984",
  "WGS84",
  "WGS1984",
  "WORLDGEODETICSYSTEM1984",
  "WORLDGEODETICSYSTEM1984ENSEMBLE",
]);
const GRS80_ELLIPSOID_NAMES = new Set(["GRS80", "GRS1980"]);
const WGS84_ELLIPSOID_NAMES = new Set(["WGS84", "WGS1984"]);
const ALBERS_METHOD_NAMES = new Set(["ALBERSCONICEQUALAREA", "ALBERSEQUALAREA"]);

const EPSG_5070_PARAMETERS: readonly ProjectionParameterSpec[] = [
  {
    authorityCode: 8823,
    expected: 29.5,
    kind: "angle",
    label: "standard parallel 1",
    names: ["STANDARDPARALLEL1", "LATITUDEOF1STSTANDARDPARALLEL", "LATITUDEOFFIRSTSTANDARDPARALLEL"],
  },
  {
    authorityCode: 8824,
    expected: 45.5,
    kind: "angle",
    label: "standard parallel 2",
    names: ["STANDARDPARALLEL2", "LATITUDEOF2NDSTANDARDPARALLEL", "LATITUDEOFSECONDSTANDARDPARALLEL"],
  },
  {
    authorityCode: 8821,
    expected: 23,
    kind: "angle",
    label: "latitude of false origin",
    names: [
      "LATITUDEOFCENTER",
      "LATITUDEOFCENTRE",
      "LATITUDEOFFALSEORIGIN",
      "LATITUDEOFORIGIN",
      "LATITUDEOFPROJECTIONCENTER",
      "LATITUDEOFPROJECTIONCENTRE",
    ],
  },
  {
    authorityCode: 8822,
    expected: -96,
    kind: "angle",
    label: "longitude of false origin",
    names: [
      "CENTRALMERIDIAN",
      "LONGITUDEOFCENTER",
      "LONGITUDEOFCENTRE",
      "LONGITUDEOFFALSEORIGIN",
      "LONGITUDEOFORIGIN",
      "LONGITUDEOFPROJECTIONCENTER",
      "LONGITUDEOFPROJECTIONCENTRE",
    ],
  },
  {
    authorityCode: 8826,
    expected: 0,
    kind: "length",
    label: "false easting",
    names: ["EASTINGATFALSEORIGIN", "FALSEEASTING"],
  },
  {
    authorityCode: 8827,
    expected: 0,
    kind: "length",
    label: "false northing",
    names: ["FALSENORTHING", "NORTHINGATFALSEORIGIN"],
  },
];

/**
 * Validates supported WKT1/WKT2 definitions against an expected EPSG identity.
 * Identity is established from parsed datum, ellipsoid, units, projection method,
 * and named operation parameters; labels and unrelated numeric tokens do not count.
 */
export function assertWktMatchesEpsg(
  wkt: string,
  expectedEpsg: number,
  options: CrsWktValidationOptions = {},
): void {
  const normalized = wkt.trim();
  if (normalized.length === 0 || containsForbiddenControlCharacter(normalized)) {
    throw new CrsWktError("CRS WKT is empty or contains control characters");
  }
  if (normalized.length > MAX_WKT_LENGTH) {
    throw new CrsWktError(`CRS WKT exceeds the ${MAX_WKT_LENGTH}-character validation limit`);
  }

  const root = new WktParser(normalized).parse();
  assertNoTowgs84(root);
  assertAuthorityIfPresent(root, expectedEpsg, "CRS WKT root authority");

  switch (expectedEpsg) {
    case 4269:
      assertGeographicRoot(
        root,
        4269,
        options.allowGeographicAuthorityAxisOrder === true,
        options.allowRasterEllipsoidSerialization === true,
      );
      return;
    case 4326:
      assertGeographicRoot(
        root,
        4326,
        options.allowGeographicAuthorityAxisOrder === true,
        options.allowRasterEllipsoidSerialization === true,
      );
      return;
    case 5070:
      assertProjected5070(root);
      return;
    default:
      throw new CrsWktError(`no semantic WKT verifier is registered for EPSG:${expectedEpsg}`);
  }
}

function assertGeographicRoot(
  root: WktNode,
  epsg: 4269 | 4326,
  allowAuthorityAxisOrder: boolean,
  allowRasterEllipsoidSerialization: boolean,
): void {
  if (root.keyword !== "GEOGCS" && root.keyword !== "GEOGCRS") {
    throw new CrsWktError(`EPSG:${epsg} must be a geographic CRS definition`);
  }
  assertGeographicDefinition(root, epsg, true, allowAuthorityAxisOrder, allowRasterEllipsoidSerialization);
}

function assertGeographicDefinition(
  root: WktNode,
  epsg: 4269 | 4326,
  requireAngularUnit: boolean,
  allowAuthorityAxisOrder = false,
  allowRasterEllipsoidSerialization = false,
): void {
  assertAxisConvention(root, "geographic", allowAuthorityAxisOrder);
  const datum = requireSingleChild(
    root,
    ["DATUM", "GEODETICDATUM", "ENSEMBLE"],
    epsg === 4269 ? "NAD83 datum" : "WGS 84 datum or ensemble",
  );
  const expectedDatumNames = epsg === 4269 ? NAD83_DATUM_NAMES : WGS84_DATUM_NAMES;
  assertRecognizedName(datum, expectedDatumNames, epsg === 4269 ? "NAD83 datum" : "WGS 84 datum");
  assertAuthorityIfPresent(datum, epsg === 4269 ? 6269 : 6326, "geodetic datum authority");

  const ellipsoid = requireSingleChild(datum, ["ELLIPSOID", "SPHEROID"], "geodetic ellipsoid");
  const expectedEllipsoidNames = epsg === 4269 ? GRS80_ELLIPSOID_NAMES : WGS84_ELLIPSOID_NAMES;
  assertRecognizedName(
    ellipsoid,
    expectedEllipsoidNames,
    epsg === 4269 ? "GRS 80 ellipsoid" : "WGS 84 ellipsoid",
  );
  assertAuthorityIfPresent(ellipsoid, epsg === 4269 ? 7019 : 7030, "ellipsoid authority");
  const ellipsoidLengthUnit = optionalSingleChild(ellipsoid, ["LENGTHUNIT"]);
  if (ellipsoidLengthUnit !== null) {
    assertAuthorityIfPresent(ellipsoidLengthUnit, 9001, "ellipsoid length unit authority");
  }
  const ellipsoidUnitFactor = ellipsoidLengthUnit === null ? 1 : unitFactor(ellipsoidLengthUnit);
  assertApproximately(
    requireNumber(ellipsoid, 1, "ellipsoid semi-major axis") * ellipsoidUnitFactor,
    6_378_137,
    1e-6,
    "ellipsoid semi-major axis",
  );
  assertApproximately(
    requireNumber(ellipsoid, 2, "ellipsoid inverse flattening"),
    epsg === 4269 ? 298.257222101 : 298.257223563,
    allowRasterEllipsoidSerialization ? 1e-10 : 1e-12,
    "ellipsoid inverse flattening",
  );

  const primeMeridian = requireSingleChild(root, ["PRIMEM"], "Greenwich prime meridian");
  assertAuthorityIfPresent(primeMeridian, 8901, "prime meridian authority");
  if (normalizeName(requireString(primeMeridian, 0, "prime meridian name")) !== "GREENWICH") {
    throw new CrsWktError(`EPSG:${epsg} requires the Greenwich prime meridian`);
  }
  const meridianUnit = optionalSingleChild(primeMeridian, ["ANGLEUNIT"]);
  const meridianDegrees =
    requireNumber(primeMeridian, 1, "prime meridian longitude") *
    (meridianUnit === null ? 1 : unitFactor(meridianUnit) / DEGREE_TO_RADIAN);
  assertApproximately(meridianDegrees, 0, 1e-12, "Greenwich prime meridian longitude");

  if (requireAngularUnit) {
    const angularUnit = requireSingleChild(root, ["ANGLEUNIT", "UNIT"], "degree angular unit");
    assertAuthorityIfPresent(angularUnit, 9122, "angular unit authority");
    assertNamedUnit(angularUnit, new Set(["DEGREE", "DEGREES"]), DEGREE_TO_RADIAN, "degree angular unit");
  }
}

function assertProjected5070(root: WktNode): void {
  if (root.keyword !== "PROJCS" && root.keyword !== "PROJCRS") {
    throw new CrsWktError("EPSG:5070 must be a projected CRS definition");
  }
  assertAxisConvention(root, "projected");

  const base = requireSingleChild(
    root,
    ["BASEGEODCRS", "BASEGEOGCRS", "GEOGCRS", "GEOGCS"],
    "NAD83 base geographic CRS",
  );
  assertAuthorityIfPresent(base, 4269, "EPSG:5070 base geographic CRS authority");
  assertGeographicDefinition(base, 4269, base.keyword === "GEOGCS" || base.keyword === "GEOGCRS");

  let method: WktNode;
  let parameterParent: WktNode;
  if (root.keyword === "PROJCS") {
    method = requireSingleChild(root, ["PROJECTION"], "Albers Equal Area projection method");
    parameterParent = root;
  } else {
    const conversion = requireSingleChild(root, ["CONVERSION"], "EPSG:5070 conversion");
    method = requireSingleChild(conversion, ["METHOD"], "Albers Equal Area projection method");
    parameterParent = conversion;
  }
  assertRecognizedName(method, ALBERS_METHOD_NAMES, "Albers Equal Area projection method");
  assertAuthorityIfPresent(method, 9822, "Albers Equal Area method authority");

  const projectedUnit = requireSingleChild(root, ["LENGTHUNIT", "UNIT"], "metre linear unit");
  assertAuthorityIfPresent(projectedUnit, 9001, "projected unit authority");
  assertNamedUnit(projectedUnit, new Set(["METER", "METERS", "METRE", "METRES"]), 1, "metre linear unit");
  assert5070Parameters(parameterParent);
}

function assertNoTowgs84(root: WktNode): void {
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) continue;
    if (node.keyword === "TOWGS84") {
      throw new CrsWktError(
        "supported EPSG definitions must be unbound and must not contain a TOWGS84 transformation",
      );
    }
    for (const value of node.values) {
      if (typeof value === "object") pending.push(value);
    }
  }
}

function assertAxisConvention(
  root: WktNode,
  kind: "geographic" | "projected",
  allowGeographicAuthorityAxisOrder = false,
): void {
  const axes = directChildren(root, ["AXIS"]);
  if (axes.length === 0) return;
  if (axes.length !== 2) {
    throw new CrsWktError(
      `${kind} CRS must omit AXIS nodes or declare exactly two axes in application x/y order`,
    );
  }

  const directions = axes.map((axis) => normalizeName(requireString(axis, 1, `${kind} axis direction`)));
  const applicationOrder = directions[0] === "EAST" && directions[1] === "NORTH";
  const authorityOrder =
    kind === "geographic" &&
    allowGeographicAuthorityAxisOrder &&
    directions[0] === "NORTH" &&
    directions[1] === "EAST";
  if (!applicationOrder && !authorityOrder) {
    const expectedDirections = ["EAST", "NORTH"] as const;
    const mismatchIndex: 0 | 1 = directions[0] === expectedDirections[0] ? 1 : 0;
    throw new CrsWktError(
      `${kind} CRS AXIS ${mismatchIndex + 1} must be ${expectedDirections[mismatchIndex]} for application x/y order; found ${directions[mismatchIndex]}`,
    );
  }
  const hasExplicitOrder = axes.map((axis) => optionalSingleChild(axis, ["ORDER"]) !== null);
  if (hasExplicitOrder[0] !== hasExplicitOrder[1]) {
    throw new CrsWktError(`${kind} CRS AXIS nodes must either both declare ORDER or both omit it`);
  }

  for (const [index, axis] of axes.entries()) {
    const order = optionalSingleChild(axis, ["ORDER"]);
    if (order !== null) {
      const value = requireNumber(order, 0, `${kind} axis order`);
      if (!Number.isSafeInteger(value) || value !== index + 1) {
        throw new CrsWktError(`${kind} CRS AXIS ${index + 1} ORDER must equal ${index + 1}; found ${value}`);
      }
    }
  }
}

function assert5070Parameters(parent: WktNode): void {
  const byName = new Map<string, ProjectionParameterSpec>();
  for (const spec of EPSG_5070_PARAMETERS) {
    for (const name of spec.names) byName.set(name, spec);
  }

  const observed = new Set<ProjectionParameterSpec>();
  for (const parameter of directChildren(parent, ["PARAMETER"])) {
    const suppliedName = requireString(parameter, 0, "projection parameter name");
    const spec = byName.get(normalizeName(suppliedName));
    if (spec === undefined) {
      throw new CrsWktError(
        `EPSG:5070 contains unsupported projection parameter ${JSON.stringify(suppliedName)}`,
      );
    }
    if (observed.has(spec)) {
      throw new CrsWktError(`EPSG:5070 repeats defining parameter ${spec.label}`);
    }
    observed.add(spec);
    assertAuthorityIfPresent(parameter, spec.authorityCode, `${spec.label} parameter authority`);

    const rawValue = requireNumber(parameter, 1, `${spec.label} value`);
    const unit = optionalSingleChild(parameter, spec.kind === "angle" ? ["ANGLEUNIT"] : ["LENGTHUNIT"]);
    const canonicalValue =
      unit === null
        ? rawValue
        : spec.kind === "angle"
          ? (rawValue * unitFactor(unit)) / DEGREE_TO_RADIAN
          : rawValue * unitFactor(unit);
    assertApproximately(
      canonicalValue,
      spec.expected,
      spec.kind === "angle" ? 1e-10 : 1e-6,
      `EPSG:5070 ${spec.label}`,
    );
  }

  for (const spec of EPSG_5070_PARAMETERS) {
    if (!observed.has(spec)) throw new CrsWktError(`EPSG:5070 lacks defining parameter ${spec.label}`);
  }
}

function assertAuthorityIfPresent(node: WktNode, expectedCode: number, label: string): void {
  const authorities = directChildren(node, ["AUTHORITY", "ID"]);
  if (authorities.length > 1) throw new CrsWktError(`${label} is repeated`);
  for (const authority of authorities) {
    const organization = requireString(authority, 0, `${label} organization`);
    if (organization.toUpperCase() !== "EPSG") {
      throw new CrsWktError(
        `${label} ${JSON.stringify(organization)} contradicts expected EPSG:${expectedCode}`,
      );
    }
    const codeValue = authority.values[1];
    const code =
      typeof codeValue === "number"
        ? codeValue
        : typeof codeValue === "string" && /^\d+$/.test(codeValue)
          ? Number(codeValue)
          : Number.NaN;
    if (!Number.isSafeInteger(code) || code !== expectedCode) {
      throw new CrsWktError(`${label} EPSG:${String(codeValue)} contradicts expected EPSG:${expectedCode}`);
    }
  }
}

function assertRecognizedName(node: WktNode, expectedNames: ReadonlySet<string>, label: string): void {
  const supplied = requireString(node, 0, `${label} name`);
  if (!expectedNames.has(normalizeName(supplied))) {
    throw new CrsWktError(`CRS WKT ${label} name ${JSON.stringify(supplied)} is not recognized`);
  }
}

function assertNamedUnit(
  node: WktNode,
  expectedNames: ReadonlySet<string>,
  expectedFactor: number,
  label: string,
): void {
  const supplied = requireString(node, 0, `${label} name`);
  if (!expectedNames.has(normalizeName(supplied))) {
    throw new CrsWktError(`CRS WKT requires a ${label}; found ${JSON.stringify(supplied)}`);
  }
  assertApproximately(unitFactor(node), expectedFactor, 1e-15, label);
}

function unitFactor(node: WktNode): number {
  const factor = requireNumber(node, 1, `${node.keyword} conversion factor`);
  if (!(factor > 0)) throw new CrsWktError(`CRS WKT ${node.keyword} conversion factor must be positive`);
  return factor;
}

function requireSingleChild(node: WktNode, keywords: readonly string[], label: string): WktNode {
  const matches = directChildren(node, keywords);
  if (matches.length !== 1) {
    throw new CrsWktError(`CRS WKT requires exactly one ${label}; found ${matches.length}`);
  }
  return matches[0] as WktNode;
}

function optionalSingleChild(node: WktNode, keywords: readonly string[]): WktNode | null {
  const matches = directChildren(node, keywords);
  if (matches.length > 1) {
    throw new CrsWktError(`CRS WKT repeats ${keywords.join("/")} nodes`);
  }
  return matches[0] ?? null;
}

function directChildren(node: WktNode, keywords: readonly string[]): WktNode[] {
  const accepted = new Set(keywords);
  return node.values.filter(
    (value): value is WktNode => typeof value === "object" && accepted.has(value.keyword),
  );
}

function requireString(node: WktNode, index: number, label: string): string {
  const value = node.values[index];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CrsWktError(`CRS WKT ${label} must be non-empty text`);
  }
  return value;
}

function requireNumber(node: WktNode, index: number, label: string): number {
  const value = node.values[index];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CrsWktError(`CRS WKT ${label} must be a finite number`);
  }
  return value;
}

function assertApproximately(actual: number, expected: number, tolerance: number, label: string): void {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
    throw new CrsWktError(`CRS WKT ${label} must equal ${expected}; found ${actual}`);
  }
}

function normalizeName(value: string): string {
  return value.toUpperCase().replaceAll(/[^A-Z0-9]/g, "");
}

function containsForbiddenControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x08 ||
        codePoint === 0x0b ||
        codePoint === 0x0c ||
        (codePoint >= 0x0e && codePoint <= 0x1f))
    ) {
      return true;
    }
  }
  return false;
}

class WktParser {
  readonly #source: string;
  #offset = 0;

  public constructor(source: string) {
    this.#source = source;
  }

  public parse(): WktNode {
    this.skipWhitespace();
    const root = this.parseNode(0);
    this.skipWhitespace();
    if (this.#offset !== this.#source.length) this.fail("has trailing content");
    return root;
  }

  private parseNode(depth: number, knownKeyword?: string): WktNode {
    if (depth > MAX_WKT_DEPTH) this.fail(`exceeds the ${MAX_WKT_DEPTH}-level nesting limit`);
    const keyword = (knownKeyword ?? this.parseBareToken("node keyword")).toUpperCase();
    this.skipWhitespace();
    const opening = this.#source[this.#offset];
    if (opening !== "[" && opening !== "(") this.fail(`node ${keyword} lacks an opening delimiter`);
    this.#offset += 1;
    const closing = opening === "[" ? "]" : ")";
    const values: WktValue[] = [];
    this.skipWhitespace();
    if (this.#source[this.#offset] === closing) {
      this.#offset += 1;
      return { keyword, values };
    }

    while (this.#offset < this.#source.length) {
      values.push(this.parseValue(depth + 1));
      this.skipWhitespace();
      const separator = this.#source[this.#offset];
      if (separator === closing) {
        this.#offset += 1;
        return { keyword, values };
      }
      if (separator !== ",") this.fail(`node ${keyword} requires a comma or ${closing}`);
      this.#offset += 1;
      this.skipWhitespace();
    }
    this.fail(`node ${keyword} has an unclosed ${opening}`);
  }

  private parseValue(depth: number): WktValue {
    this.skipWhitespace();
    const character = this.#source[this.#offset];
    if (character === '"') return this.parseQuotedString();
    const number = this.parseNumber();
    if (number !== null) return number;
    if (character === "'" || character === "]" || character === ")" || character === undefined) {
      this.fail("contains an invalid value");
    }
    const token = this.parseBareToken("value");
    this.skipWhitespace();
    const next = this.#source[this.#offset];
    return next === "[" || next === "(" ? this.parseNode(depth, token) : token;
  }

  private parseQuotedString(): string {
    this.#offset += 1;
    let value = "";
    while (this.#offset < this.#source.length) {
      const character = this.#source[this.#offset];
      if (character === '"') {
        if (this.#source[this.#offset + 1] === '"') {
          value += '"';
          this.#offset += 2;
          continue;
        }
        this.#offset += 1;
        return value;
      }
      value += character;
      this.#offset += 1;
    }
    this.fail("has an unclosed quoted string");
  }

  private parseNumber(): number | null {
    const match = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?/.exec(this.#source.slice(this.#offset));
    if (match?.[0] === undefined) return null;
    this.#offset += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) this.fail("contains a non-finite number");
    return value;
  }

  private parseBareToken(label: string): string {
    const start = this.#offset;
    while (this.#offset < this.#source.length) {
      const character = this.#source[this.#offset] as string;
      if (/\s/.test(character) || character === "," || "[]()\"'".includes(character)) break;
      this.#offset += 1;
    }
    if (this.#offset === start) this.fail(`lacks a ${label}`);
    return this.#source.slice(start, this.#offset);
  }

  private skipWhitespace(): void {
    while (/\s/.test(this.#source[this.#offset] ?? "")) this.#offset += 1;
  }

  private fail(message: string): never {
    throw new CrsWktError(`CRS WKT ${message} at offset ${this.#offset}`);
  }
}
