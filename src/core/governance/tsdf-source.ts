export interface TsdfTierDefinition {
  behavior: {
    export_allowed: boolean;
    network_allowed: boolean;
    public_distribution_allowed: boolean;
  };
  description: string;
  id: string;
  label: string;
  restrictiveness_order: number;
}

export interface TsdfSourceRecord {
  default_tier_id: string;
  framework_version: string;
  source_sha256: string;
  source_title: string;
  tiers: readonly TsdfTierDefinition[];
}

export interface TsdfSource {
  readonly record: TsdfSourceRecord;
  effectiveTier(tierIds: readonly (string | null)[]): TsdfTierDefinition;
  resolve(tierId: string | null): TsdfTierDefinition;
}

export class TsdfSourceError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "TsdfSourceError";
  }
}

/** Loads tier semantics from artifact data; no tier rank or behavior is defined in application code. */
export function loadTsdfSource(record: TsdfSourceRecord): TsdfSource {
  requireNonEmpty(record.framework_version, "framework_version");
  requireSha256(record.source_sha256, "source_sha256");
  requireNonEmpty(record.source_title, "source_title");
  if (record.tiers.length === 0) throw new TsdfSourceError("tiers must not be empty");

  const byId = new Map<string, TsdfTierDefinition>();
  const orders = new Set<number>();
  for (const [index, tier] of record.tiers.entries()) {
    const path = `tiers[${index}]`;
    requireNonEmpty(tier.id, `${path}.id`);
    requireNonEmpty(tier.label, `${path}.label`);
    requireNonEmpty(tier.description, `${path}.description`);
    if (!Number.isSafeInteger(tier.restrictiveness_order) || tier.restrictiveness_order < 0) {
      throw new TsdfSourceError(`${path}.restrictiveness_order must be a non-negative integer`);
    }
    if (byId.has(tier.id)) throw new TsdfSourceError(`${path}.id duplicates ${tier.id}`);
    if (orders.has(tier.restrictiveness_order)) {
      throw new TsdfSourceError(`${path}.restrictiveness_order must be unique`);
    }
    for (const [behavior, value] of Object.entries(tier.behavior)) {
      if (typeof value !== "boolean") {
        throw new TsdfSourceError(`${path}.behavior.${behavior} must be boolean`);
      }
    }
    byId.set(tier.id, tier);
    orders.add(tier.restrictiveness_order);
  }
  if (!byId.has(record.default_tier_id)) {
    throw new TsdfSourceError(`default_tier_id ${record.default_tier_id} is not defined`);
  }

  const resolve = (tierId: string | null): TsdfTierDefinition => {
    const resolvedId = tierId ?? record.default_tier_id;
    const tier = byId.get(resolvedId);
    if (tier === undefined) throw new TsdfSourceError(`tier ${resolvedId} is not defined by this TsdfSource`);
    return tier;
  };

  return {
    effectiveTier(tierIds) {
      if (tierIds.length === 0) return resolve(null);
      return tierIds
        .map(resolve)
        .reduce((mostRestrictive, tier) =>
          tier.restrictiveness_order > mostRestrictive.restrictiveness_order ? tier : mostRestrictive,
        );
    },
    record,
    resolve,
  };
}

function requireNonEmpty(value: string, path: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TsdfSourceError(`${path} must be a non-empty string`);
  }
}

function requireSha256(value: string, path: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new TsdfSourceError(`${path} must be a lowercase SHA-256 digest`);
  }
}
