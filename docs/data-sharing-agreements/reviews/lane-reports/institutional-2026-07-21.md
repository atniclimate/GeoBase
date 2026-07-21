# DS-1 institutional lane report — 2026-07-21

## Result

Recorded 20 search-only candidate sources in `sources/register.institutional.jsonl` and 36 append-only events in `provenance/access-log.institutional.jsonl` (16 searches and 20 discoveries). No probes, fetches, downloads, corpus files, parsing, or summaries were performed because the institutional lane has no assigned hosts in `lanes.json`.

`python tools/merge_validate.py validate` completed with `validation clean` after the slice writes.

## Records by layer

| Layer | Candidate records | Source IDs |
|---|---:|---|
| Intertribal | 5 | src-inst-005–009 |
| Research governance | 3 | src-inst-010–012 |
| Federal | 8 | src-inst-003–004, src-inst-013–018 |
| Academic | 3 | src-inst-001, src-inst-019–020 |
| NGO | 1 | src-inst-002 |

The six owner-provided seed rows were registered as `src-inst-001` through `src-inst-006`.

## Searches run

Search events `ev-institutional-s001` through `ev-institutional-s016` record these queries:

- ATNI tribal data sovereignty resolutions data governance
- NCAI resolution Indigenous data sovereignty data governance
- AIHEC tribal college IRB research data policy
- USET Tribal data sovereignty policy resolution
- NIH THRO Tribal Indigenous Data Sovereignty Listening Session 2024
- IHS IRB tribal data sharing policy
- BIA DOI tribal data governance policy
- DOE tribal energy data sovereignty guidance
- EPA Tribal data sharing policy data sovereignty
- NOAA tribal data sharing agreement Indigenous knowledge policy
- USGS tribal data policy data sharing
- FNIGC OCAP principles official
- Native Nations Institute US Indigenous Data Sovereignty Network data governance
- National Congress American Indians Policy Research Center tribal data governance research
- Native American Rights Fund research data sovereignty tribal research code
- university Tribe data sharing agreement template Indigenous research MOU

## Layers with no qualifying candidate located in this review

- ATNI member data resolutions: no specific institutional instrument located by the search-only result set; the owner-provided public TSDF repository rows were recorded separately.
- AIHEC: no AIHEC-issued IRB/data-governance instrument located; the search did locate the Northwest Indian College policy (src-inst-020).
- Regional consortia ITCA, GPTCA, CRITFC, and NWIFC: no qualifying layer-level instrument located.
- IHS IRB: no qualifying IHS IRB instrument located.
- DOE tribal-energy data guidance: search returned energy-sovereignty/planning material, not a qualifying data-sharing instrument, so no record was made.
- NARF: no qualifying NARF-issued governance instrument located from the result set.
- FNIGC/OCAP: no official FNIGC candidate URL was located from the result set; this comparative layer remains incomplete.

Non-discovery is not evidence of absence.

## Exclusions

No candidate was classified `excluded-*`: the search-only evidence presented no login, paywall, terms restriction, or deliberately unpublished document. Several candidate notes flag legacy/archive hosts, template scope, or policy legal force for review before any collection.

## Suspected duplicates

- `src-inst-003`, `src-inst-013`, `src-inst-017` may overlap baseline federal material, especially `src-bl-033` and `src-bl-034`; these are candidates pending director deduplication.
- `src-inst-020` is a suspected duplicate of `src-wac-010` (Northwest Indian College IRB Policy 806).

## Host-allowlist requests

Before any permitted probe/fetch, request director assignment and terms/robots review for: `guides.lib.berkeley.edu`, `tribalresilienceactions.org`, `dpcpsi.nih.gov`, `bja.ojp.gov`, `github.com`, `archive.ncai.org`, `wwwe.ncai.org`, `usetinc.org`, `usindigenousdatanetwork.org`, `nni.arizona.edu`, `bia.gov`, `noaa.gov`, `epa.gov`, `usgs.gov`, `cih.jhu.edu`, and `nwic.edu`.

## Flags for human review

- Confirm ATNI authorship and intentional-publication scope of the two GitHub repository seeds before any collection.
- Confirm the current publication status and terms of legacy NCAI archive hosts (`src-inst-007`, `src-inst-008`, `src-inst-012`).
- Determine whether consultation pages and FAQs (`src-inst-014`, `src-inst-016`) are in scope as instruments versus contextual guidance.
- Confirm legal status/version and document-level scope for NOAA, EPA, BIA, and USGS candidates before use.
- Determine whether the Johns Hopkins agreement and NWIC Policy 806 are reusable published templates/policies and whether their terms permit automated collection.
