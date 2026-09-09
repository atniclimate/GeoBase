export const RSTEP_DEMO_SPIKE_ENTRY = "rstep-demo-spike" as const;
export const RSTEP_DEMO_ASSET_PREFIX = "__rstep-demo-assets__" as const;
export const RSTEP_DEMO_MAX_LOCAL_ASSET_BYTES = 16 * 1024 * 1024;

const allowedRstepDemoAssetPatterns = [
  /^tiles\/terrain\/layer\.json$/u,
  /^tiles\/terrain\/\d+\/\d+\/\d+\.terrain$/u,
  /^tiles\/s2cloudless-wa\/metadata\.json$/u,
  /^tiles\/s2cloudless-wa\/\d+\/\d+\/\d+\.jpg$/u,
  /^tiles\/wind-wa\/metadata\.json$/u,
  /^tiles\/wind-wa\/\d+\/\d+\/\d+\.png$/u,
  /^tiles\/landcover\/legend\.json$/u,
  /^tiles\/landcover\/\d+\/\d+\/\d+\.png$/u,
] as const;

export interface RstepDemoAssetRoute {
  allowed: boolean;
  assetRelativePath: string | null;
  targetsMount: boolean;
}

/** Applies the exact donor-asset allowlist after the generic app URL path has been decoded. */
export function routeRstepDemoAsset(relativePath: string): RstepDemoAssetRoute {
  const mountedPrefix = `${RSTEP_DEMO_ASSET_PREFIX}/`;
  if (!relativePath.startsWith(mountedPrefix)) {
    return { allowed: false, assetRelativePath: null, targetsMount: false };
  }
  const assetRelativePath = relativePath.slice(mountedPrefix.length);
  return {
    allowed: allowedRstepDemoAssetPatterns.some((pattern) => pattern.test(assetRelativePath)),
    assetRelativePath,
    targetsMount: true,
  };
}

export type RendererEntryId = "standard" | typeof RSTEP_DEMO_SPIKE_ENTRY;

export type RendererEntryDecision =
  | {
      id: "standard";
      exportRestricted: false;
      localAssetRootCandidate: null;
      networkRestricted: false;
      urlSuffix: "";
    }
  | {
      id: typeof RSTEP_DEMO_SPIKE_ENTRY;
      exportRestricted: true;
      localAssetRootCandidate: string;
      networkRestricted: true;
      urlSuffix: "?testScene=rstep-demo-spike";
    };

export interface RendererEntryOptions {
  explicitDevelopmentMode: boolean;
  isPackaged: boolean;
  requestedAssetRoot: string | undefined;
  requestedScene: string | undefined;
}

/** Selects the only test renderer without accepting an arbitrary route or local root. */
export function decideRendererEntry(options: RendererEntryOptions): RendererEntryDecision {
  if (options.requestedScene === undefined) {
    return {
      id: "standard",
      exportRestricted: false,
      localAssetRootCandidate: null,
      networkRestricted: false,
      urlSuffix: "",
    };
  }

  if (options.requestedScene !== RSTEP_DEMO_SPIKE_ENTRY) {
    throw new Error(`Unsupported ATNI_GEOBASE_TEST_SCENE value: ${options.requestedScene || "[empty]"}.`);
  }
  if (options.isPackaged || !options.explicitDevelopmentMode) {
    throw new Error(
      "The RSTEP compatibility spike requires an unpackaged launch with ATNI_GEOBASE_DEVELOPMENT_MODE=1.",
    );
  }

  const requestedAssetRoot = options.requestedAssetRoot?.trim();
  if (requestedAssetRoot === undefined || requestedAssetRoot === "") {
    throw new Error(
      "The RSTEP compatibility spike requires ATNI_GEOBASE_RSTEP_DONOR_PUBLIC to name the donor public directory.",
    );
  }

  return {
    id: RSTEP_DEMO_SPIKE_ENTRY,
    exportRestricted: true,
    localAssetRootCandidate: requestedAssetRoot,
    networkRestricted: true,
    urlSuffix: "?testScene=rstep-demo-spike",
  };
}
