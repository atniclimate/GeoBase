# TSDF Integration

GeoBase enforces the **Tiered Sovereign Data Framework (TSDF)** system-wide. This
document explains how the framework — an external, versioned document — becomes a
runtime policy that every dataset, engine, and SoLO app obeys.

Canonical framework: <https://github.com/atniclimate/TieredSovereignDataFramework>
(pinned here at **v0.9.4**). Framework content is CC-BY-NC-SA 4.0; see
[`../spec/tsdf/ATTRIBUTION.md`](../spec/tsdf/ATTRIBUTION.md).

## The tiers

| Tier | Name | Definition | GeoBase behavior |
|------|------|-----------|------------------|
| **T0** | Open/Public | Formally released for public benefit by sovereign decision | Federated baseline; auto-distributed to nodes |
| **T1** | Network | Shared among Indigenous network members via reciprocal protocols | Shared within the network; network scope only |
| **T2** | Negotiated | Shared with external partners through formal agreements | The "paint & export" path — product only, never source |
| **T3** | Sovereign | Complete Indigenous control; never leaves community systems | Local-only, ceremony-gated, architectural egress guarantee |

**Default classification is T3.** *"When in doubt, classify as T3. Over-classification
is correctable; under-classification may cause irreversible harm."* GeoBase encodes
this as `TsdfSpec::default_classification()` — any unclassified dataset is T3.

TSDF also carries an **AI/ML restriction matrix** (T3 training and inference are
**prohibited**; T2 per agreement; T1 network-scoped; T0 permitted). These load
alongside the tiers in `tiers.toml` and must be honored by any ML feature.

## Why the resolver is pluggable

Tier descriptions and processes change with the framework version. Hardcoding
them would mean a code change (and redeploy) every time the framework evolves —
and would make it impossible to move governance to a private server later. So
GeoBase reads tiers at runtime through a `TsdfSource`:

```
                       ┌──────────────────────────┐
   config: "vendored"  │      VendoredSource       │  spec/tsdf/tiers.toml (v0.9.4)
   config: "github"    │      GitHubSource         │  public framework repo (diffed)
   config: "local-…"   │      LocalServerSource     │  future private/local server
                       └──────────────┬───────────┘
                                      ▼
                              TsdfSpec { version, tiers, default_tier, … }
```

- **`VendoredSource`** — the offline default. Embeds `spec/tsdf/tiers.toml` at
  compile time, so a node always has a known policy even with no network. This is
  also the anchor that upstream changes are diffed against.
- **`GitHubSource`** — fetches the upstream framework and **diffs** it against the
  vendored anchor, surfacing changes for **sovereign review**. Adoption is never
  automatic — a governing body decides.
- **`LocalServerSource`** — a stub interface today, present so a Tribe can migrate
  TSDF governance to a private or local server (Phase 2.2) by config alone.

Select via `source_from_config(SourceKind)` (or `place.toml`'s `[tsdf] source`).

## Version stamping

Every dataset records the TSDF `version` in force when it was classified, and
every audit record does too. So the exact tier model that applied to any decision
is always recoverable, even after the framework advances.

## Updating the vendored spec

1. `GitHubSource` reports an upstream change vs. the pinned `spec/tsdf/VERSION`.
2. A sovereign body reviews the diff.
3. On adoption: bump `spec/tsdf/VERSION` and `tiers.toml`'s `version`, update tier
   definitions, and note the change. Existing data keeps its original stamp.

## Enforcement (roadmap)

The resolver supplies *policy*. Turning policy into *mechanism* — tier-based
access control, the FPIC permissions ceremony, audit trails, and the T3 egress
guarantee — is Phase 1.2. See [`ROADMAP.md`](ROADMAP.md).
