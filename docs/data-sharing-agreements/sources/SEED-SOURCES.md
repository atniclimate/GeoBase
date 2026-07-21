# Seed sources (DS-1 starting points)

Fetch per `../COLLECTION-CHARTER.md` only. Each item becomes a
`register.schema.json`-conforming record in the lane's
`register.<lane>.jsonl` slice with a `discover` event in the lane's
access-log slice.

## Baseline inventory (primary seed)

`../pnw-data-sovereignty-research.md` — 43-Nation WA/OR/ID web-baseline
naming ~50 specific instruments and authorities. The **baseline** DS-1 lane
normalizes every named item into register records, re-locating official
URLs (the report's citations are unresolved placeholders). The report also
supplies the coverage denominator (`NATIONS.md`), the custodian model for
later outreach, and the controlled vocabulary that seeds the DS-4 wiki
themes.

## Owner-provided seeds

| Source | URL | Why |
|---|---|---|
| UC Berkeley LibGuide — Indigenous Data Sovereignty | <https://guides.lib.berkeley.edu/c.php?g=527365&p=8210973> | Curated link hub → many downstream sources |
| Tribal Resilience Action Database — Data Sovereignty | <https://tribalresilienceactions.org/data-sovereignty/> | Tribal-specific actions + policies |
| NIH THRO — Tribal IDS Listening Session (2024, 508 PDF) | <https://dpcpsi.nih.gov/sites/g/files/mnhszr346/files/THRO%20presentation%20TAC%20IDS%20Listening%20Session%20June%2026%202024_508.pdf> | Federal research-governance perspective |
| BJA — Tribal Data Sovereignty presentation (PDF) | <https://bja.ojp.gov/doc/tribal-data-sovereignty-presentation.pdf> | Justice-sector data-sharing perspective |
| ATNI TSDF — literature | <https://github.com/atniclimate/TieredSovereignDataFramework/tree/main/literature> | IDSov reviews + convergence architecture (already-synthesized groundwork) |
| ATNI TSDF — standard (v0.95) | <https://github.com/atniclimate/TieredSovereignDataFramework/tree/main/standard> | **The convergence framework this corpus champions** |

## Institutional layers to sweep (DS-1)

- Intertribal: ATNI (member resolutions on data), NCAI (data sovereignty
  resolutions/policy), AIHEC, regional consortia (USET, ITCA, GPTCA, CRITFC,
  NWIFC …)
- Research governance: Native Nations Institute / US Indigenous Data
  Sovereignty Network, Global Indigenous Data Alliance (CARE Principles),
  NARF, NCAI Policy Research Center; FNIGC/OCAP® as comparative
- Federal: NIH THRO, IHS IRB, BIA/DOI data policies, DOE tribal energy data
  guidance, EPA/NOAA/USGS tribal data-sharing policies
- Academic: university–Tribe DSA/MOU templates, Tribal college IRBs
  (AIHEC-affiliated), published research codes
- **Individual Nations** (the core layer): published research codes,
  IRB/review-board policies, data sovereignty plans, IP/TK ordinances —
  ATNI member Nations first, then nationwide

## Register

Discovered sources accumulate in per-lane `register.<lane>.jsonl` slices
conforming to `register.schema.json`, merged into `register.jsonl` by
`../tools/merge_validate.py` (director-run).
