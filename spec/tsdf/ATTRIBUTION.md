# TSDF — Attribution & Licensing

The **Tiered Sovereign Data Framework (TSDF)** is authored and maintained by the
Affiliated Tribes of Northwest Indians — Tribal Climate Resilience program.

- **Canonical source:** https://github.com/atniclimate/TieredSovereignDataFramework
- **Pinned version in this repo:** `0.9.4` (see `VERSION`)
- **Framework license:** CC-BY-NC-SA 4.0 (Creative Commons Attribution–NonCommercial–ShareAlike 4.0 International)

## Important licensing note

The GeoBase **code** is licensed Apache-2.0. The **TSDF framework content** vendored
here under `spec/tsdf/` remains under **CC-BY-NC-SA 4.0** and is NOT relicensed by
inclusion. `tiers.toml` is a machine-readable rendering of the framework's tier
model for software enforcement; it carries the same attribution and non-commercial
share-alike obligations as the source framework.

## Companion protocol

TSDF names a companion technical specification, the **Federated Indigenous Data
Protocol (FIDP)**, which provides implementation details for federated data
infrastructure. GeoBase's federation layer (roadmap Phase 2.0) targets FIDP.
See `spec/fidp/`.

## Keeping in sync

When the upstream framework publishes a new version:

1. `geobase-tsdf`'s `GitHubSource` fetches upstream and diffs it against this
   pinned copy.
2. Changes are surfaced for **sovereign review** — adoption is a deliberate
   decision, never automatic.
3. On adoption, bump `VERSION` and `tiers.toml`'s `version`, update tier defs,
   and record the change. Every dataset and audit record is version-stamped, so
   the tier model in force at classification time is always recoverable.
