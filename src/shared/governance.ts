import { isJsonObject } from "./json.js";

export const DEVELOPMENT_BUILD_WARNING = "DEVELOPMENT BUILD - SOVEREIGNTY CONTROLS NOT ENFORCED";

export const DEVELOPMENT_BYPASS_EXPLANATION =
  "Sovereignty controls are deferred during local development. Metadata custody remains required; this artifact is not approved for public distribution.";

export interface DevelopmentBypassStamp {
  application_commit: string;
  application_version: string;
  explanation: string;
  stamped_at: string;
}

/**
 * Mandatory governance state for every active development project and export.
 * The literal fields prevent callers from representing the bypass as enforcement.
 */
export interface DevelopmentBypassState {
  bypass_stamp: DevelopmentBypassStamp;
  governance_enforced: false;
  governance_mode: "development_bypass";
  public_distribution_allowed: false;
}

export interface DevelopmentBypassStampInput {
  applicationCommit: string;
  applicationVersion: string;
  stampedAt: string;
}

/** Builds the one governance state allowed by this development application. */
export function createDevelopmentBypassState(input: DevelopmentBypassStampInput): DevelopmentBypassState {
  assertNonEmpty(input.applicationCommit, "application commit");
  assertNonEmpty(input.applicationVersion, "application version");
  assertCanonicalTimestamp(input.stampedAt, "bypass stamp timestamp");

  return {
    bypass_stamp: {
      application_commit: input.applicationCommit,
      application_version: input.applicationVersion,
      explanation: DEVELOPMENT_BYPASS_EXPLANATION,
      stamped_at: input.stampedAt,
    },
    governance_enforced: false,
    governance_mode: "development_bypass",
    public_distribution_allowed: false,
  };
}

/** Validates and narrows persisted governance state without accepting lookalikes. */
export function assertDevelopmentBypassState(value: unknown): asserts value is DevelopmentBypassState {
  if (!isJsonObject(value)) {
    throw new Error("governance must be an object");
  }

  const exactKeys = ["bypass_stamp", "governance_enforced", "governance_mode", "public_distribution_allowed"];
  assertExactKeys(value, exactKeys, "governance");

  if (value.governance_mode !== "development_bypass") {
    throw new Error('governance_mode must equal "development_bypass"');
  }
  if (value.governance_enforced !== false) {
    throw new Error("governance_enforced must equal false");
  }
  if (value.public_distribution_allowed !== false) {
    throw new Error("public_distribution_allowed must equal false");
  }
  if (!isJsonObject(value.bypass_stamp)) {
    throw new Error("governance.bypass_stamp must be an object");
  }

  assertExactKeys(
    value.bypass_stamp,
    ["application_commit", "application_version", "explanation", "stamped_at"],
    "governance.bypass_stamp",
  );
  assertNonEmpty(value.bypass_stamp.application_commit, "application commit");
  assertNonEmpty(value.bypass_stamp.application_version, "application version");
  assertNonEmpty(value.bypass_stamp.explanation, "bypass explanation");
  assertCanonicalTimestamp(value.bypass_stamp.stamped_at, "bypass stamp timestamp");

  if (value.bypass_stamp.explanation !== DEVELOPMENT_BYPASS_EXPLANATION) {
    throw new Error("governance.bypass_stamp.explanation is not the required development warning");
  }
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (keys.length !== sortedExpected.length || keys.some((key, index) => key !== sortedExpected[index])) {
    throw new Error(`${label} has unexpected or missing fields`);
  }
}

function assertNonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function assertCanonicalTimestamp(value: unknown, label: string): asserts value is string {
  assertNonEmpty(value, label);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new Error(`${label} must be a canonical UTC ISO-8601 timestamp`);
  }
}
