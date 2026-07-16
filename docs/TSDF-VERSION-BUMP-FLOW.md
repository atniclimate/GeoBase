# TSDF version-bump adoption flow (C5)

How a new upstream version of the Tiered Sovereign Data Framework is **reviewed
and adopted** — deliberately, by sovereign decision, never automatically. This
is the flow `docs/ROADMAP.md` Phase 2.2 and `PLAN_1.0.md` C5 name; it is
documented here now, with the seam that already exists, and the one networked
step marked as its remaining Phase 2.2 work.

## The principle it protects

A TSDF version bump changes how **every dataset in every federated node** is
classified and enforced (`spec/tsdf/tiers.toml` header). So adoption is never a
silent self-update. The source model enforces this by construction:
`geobase-tsdf`'s `GitHubSource::load()` deliberately returns `NotImplemented`
rather than fetching-and-applying — "adoption of a new version is always a
deliberate sovereign decision, never automatic" (`crates/geobase-tsdf/src/lib.rs`).

## The flow

1. **Anchor.** The vendored, pinned `spec/tsdf/tiers.toml` is the offline
   source of truth (`VendoredSource::embedded()`), version `0.9.4` today. Every
   already-ingested artifact carries its TSDF version stamp *in the artifact*
   (`gpkg_metadata`, `AGENTS.md` §4) — a bump does not retroactively restamp
   existing data. That is the "existing data keeps its stamp" guarantee: old
   packs remain classified under the version they were ingested with; the new
   version governs *new* classification decisions.

2. **Diff (Phase 2.2 — the one networked step).** `GitHubSource` fetches the
   upstream framework at a ref and diffs it against the vendored anchor. Today
   this is a stub (`NotImplemented`); wiring the fetch + textual/semantic diff
   is its Phase 2.2 work. The diff is the material a sovereign body reviews —
   what tiers changed, what behaviors changed, what the version delta implies
   for already-classified data.

3. **Sovereign review.** The diff goes to the governing authority (the TSDF
   governance process, not a code default — `governance-config.yaml`). Adoption
   is their decision. Nothing in GeoBase applies a bump without it.

4. **Vendored bump.** On adoption, the reviewed upstream `tiers.toml` replaces
   the vendored anchor in one commit; the version string moves (`0.9.4` →
   `0.9.5`), and `docs/DECISIONS.md` records the adoption with the diff summary
   and the authorizing body. `cargo test` re-validates the four-tier invariant
   (`geobase-tsdf` `validate()`), and the render/layer/rstep gates re-run on the
   new spec.

5. **Existing data unchanged.** Because the tier stamp travels with each
   artifact, packs ingested under `0.9.4` keep reading as `0.9.4`-classified;
   only re-ingestion or an explicit sovereign reclassification act (through the
   ceremony/audit path) moves an existing artifact to the new version.

## What is demonstrated today vs. deferred

- **Demonstrated (C4, in `geobase-tsdf` tests):** the resolver source is
  swappable **by config alone** — a node moves from the vendored model to an
  operator-held tier model (`VendoredSource::from_str`, origin
  `local-file:governance/tiers.toml`) through the same `TsdfSource` trait, with
  the swap-invariant (T3 never egresses; four tiers present) preserved. This is
  the "governance moves by config" half of portability, offline.
- **Deferred to Phase 2.2:** the networked `GitHubSource` fetch + diff and the
  `LocalServerSource` private-server fetch. Both remain honest stubs that defer
  rather than self-update — the sovereignty-preserving default.

## Owner note

The adoption decision (step 3) and any reclassification of existing data
(step 5) are sovereign acts reserved to the governing authority, not
engineering. This doc describes the *mechanism*; it does not authorize a bump.
