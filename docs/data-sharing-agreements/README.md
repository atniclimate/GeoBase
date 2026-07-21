# Tribal Data-Sharing Agreements & Sovereignty Policy Corpus

A system to find, catalog, and analyze Tribes' published data-sharing
agreements, data sovereignty plans, Tribal IP legislation, IRB/research-review
policies, and related governance instruments — everything an external partner
or agency must adhere to when working with Tribal data of any kind.

Purpose:

1. **Respect** — document each Nation's inherent rights and stated requirements
   so ATNI projects meet them by design, not by afterthought.
2. **RSTEP** — produce the comprehensive *RSTEP Tribal Data Sovereignty
   Guidelines*, grounded in what Nations have actually enacted.
3. **GeoBase** — produce an adherence map showing how GeoBase/TSDF structurally
   embodies these requirements (and where gaps remain).

This corpus **champions the ATNI TSDF**
(<https://github.com/atniclimate/TieredSovereignDataFramework>) as the
convergence framework the collected policies are mapped onto.

## Governance posture (read first)

This is a **documentation research corpus**, out-of-band from the GeoBase
runtime and its TSDF tier gates. Nothing collected here enters the GeoBase
data spine, engines, or packages. Collection is governed by
[`COLLECTION-CHARTER.md`](COLLECTION-CHARTER.md) — a document-research
governance regime: publicly-published documents only, terms-before-bytes,
default-refuse on ambiguity, staging/clearance before analysis, append-only
schema-enforced provenance chain, versioned refetch, transitive
takedown-on-request (channel: reuben@atnitribes.org). All outputs are DRAFT
until the ratification path completes: RSTEP Tribal Advisory Board → direct
outreach to each Nation → Tribal IRB review where one exists → ratification.
Read the charter before fetching anything.

## Layout

| Path | Tracked in git | Contents |
|---|---|---|
| `PLAN.md` | yes | Phased execution plan (DS-0 … DS-6) |
| `COLLECTION-CHARTER.md` | yes | Ethics + provenance protocol (binding) |
| `AGENTS.md` | yes | Folder-scoped agent contract (Codex + subagents) |
| `LANES.md` + `lanes.json` | yes | Lane registry (human + machine) — session UUIDs, host ownership; validator-enforced |
| `pnw-data-sovereignty-research.md` | yes | Baseline web inventory (43 WA/OR/ID Nations) seeding DS-1 |
| `sources/` | yes | Seeds, `NATIONS.md` denominator, register schema + lane slices |
| `corpus/` | **no** (gitignored) | Staged + cleared documents, immutable byte versions |
| `corpus/MANIFEST*.jsonl` | yes | Versioned hash + URL manifest slices/merge |
| `catalog/` | yes | Claim-level catalog schema + lane slices/merge |
| `provenance/` | yes | Access-log schema + lane slices/merge (append-only) |
| `tools/` | yes | `merge_validate.py` — deterministic gate validator/merger |
| `summaries/` | yes | Per-document quick-reference pages |
| `wiki/` | yes | Cross-cutting theme pages + index (the quick-reference wiki) |
| `guidelines/` | yes | RSTEP Data Sovereignty Guidelines drafts + GeoBase adherence map |
| `prompts/` | yes | Worker prompts for Codex and Claude subagents |
| `reviews/` | yes | Adversarial review records for this sub-project |

## Status

- DS-0 infrastructure: scaffolded 2026-07-21 and hardened through three
  Codex adversarial rounds (`../../../_reviews/geobase/`, the workspace
  review archive outside this repo); gate tooling proven by
  `tools/lifecycle_selftest.py` (28 checks). Ready to launch DS-1
  (see `docs/handoffs/CURRENT.md` for the launch sequence).
