import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadTsdfSource, type TsdfSource, type TsdfSourceRecord } from "../core/governance/tsdf-source.js";
import { parseWaTribalSourceProfile, type WaTribalSourceProfile } from "../core/tribal/source-profile.js";

const TRUSTED_SOURCE_PATH = fileURLToPath(new URL("../../config/wa-rstep-tsdf-source.json", import.meta.url));
const TRUSTED_WA_TRIBAL_SOURCE_PROFILE_PATH = fileURLToPath(
  new URL("../../config/wa-tribal-source-profile.json", import.meta.url),
);
const AUTHORITY_DOCUMENT_PATH = fileURLToPath(
  new URL("../../docs/handoffs/ATNI-GEOBASE-WA-RSTEP-LAUNCH-PROMPT.md", import.meta.url),
);

/** Loads the tracked WA/RSTEP tier profile and binds it to its exact authority-document bytes. */
export async function loadTrustedWaRstepTsdfSource(): Promise<TsdfSource> {
  const [recordBytes, authorityBytes] = await Promise.all([
    readFile(TRUSTED_SOURCE_PATH),
    readFile(AUTHORITY_DOCUMENT_PATH),
  ]);
  const record = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(recordBytes),
  ) as TsdfSourceRecord;
  return validateTrustedWaRstepTsdfSource(record, authorityBytes);
}

/** Loads the tracked, non-coordinate source inventory and registry digest. */
export async function loadTrustedWaTribalSourceProfile(): Promise<WaTribalSourceProfile> {
  const bytes = await readFile(TRUSTED_WA_TRIBAL_SOURCE_PROFILE_PATH);
  const record = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  return parseWaTribalSourceProfile(record);
}

/** Validates the trusted profile without deriving behavior from an artifact-controlled table. */
export function validateTrustedWaRstepTsdfSource(
  record: TsdfSourceRecord,
  authorityBytes: Uint8Array,
): TsdfSource {
  const source = loadTsdfSource(record);
  const authoritySha256 = createHash("sha256").update(authorityBytes).digest("hex");
  if (source.record.source_sha256 !== authoritySha256) {
    throw new Error("trusted WA/RSTEP TsdfSource does not match its exact authority document bytes");
  }
  const defaultTier = source.resolve(null);
  if (
    defaultTier.id !== "T3" ||
    defaultTier.behavior.export_allowed ||
    defaultTier.behavior.network_allowed ||
    defaultTier.behavior.public_distribution_allowed
  ) {
    throw new Error("trusted WA/RSTEP unclassified profile must default to fail-closed T3 behavior");
  }
  return source;
}
