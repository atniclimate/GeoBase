# ds4-a — DS-4 summaries + theme wiki drafts

Working root: C:\dev\GeoBase\docs\data-sharing-agreements. Your lane:
`ds4-a` (lanes.json). Contract: prompts/codex-ds4-summarize.md in full
(charter §§7–8; catalog = single source of truth; summaries/wiki RESTATE
claims by claim_id, never invent requirement statements; summarize +
summary-attach events parented to each doc's parse event; slices only:
summaries/<doc-id>.md, wiki/<theme>.ds4-a.md, provenance/access-log.ds4-a.jsonl,
event ids ev-ds4-a-NNNN, real UTC ts).

MANDATORY PRE-READS:
- reviews/gate-audits/ds3-gate-2026-07-21.md — yakama-water-code:c002 modal
  is corrected to MAY (ev-director-0140); 3 standing minor findings
  (ctclusi c004 omitted item (a); klamath c005 paragraph labeling; quileute
  c001 clerk's-oath omission) — restate those claims with care.
- Handling rules (owner rulings, DECISIONS.md 2026-07-21): for docs bl-038,
  d2bl-001, inst-003, inst-004, inst-011, inst-013, wac-008, wai-005 —
  NO individual names, personal emails, direct lines, or signature imagery
  in any output; institution-not-person. Klamath special-use-permit rules
  are permanent: Exhibit A site locations, signatures, contacts never
  excerpted, reproduced, or described.
- Every summary and wiki page carries the DRAFT banner + "non-discovery ≠
  absence" footer; no Nation-attributed claim presented as confirmed.

## Assigned summaries (one page each; doc list = prompts/_ds4-a-docs.txt)

Every assigned doc gets summaries/<doc-id>.md, including none_reason
records (state honestly: governance framework only / landing page — no
partner-facing data obligations cataloged; keep those to a third of a page).

## Assigned wiki theme drafts (wiki/<theme>.ds4-a.md)

- consent-fpic — free, prior and informed consent duties
- ownership-control — data/records ownership and Tribal control
- review-board — research review boards, permits, oversight processes
- redisclosure-confidentiality — redisclosure limits + confidentiality duties

Theme pages draw claims from the ENTIRE merged catalog (catalog/catalog.jsonl,
all 64 records / 359 claims), not just your summary docs. Show ranges
across Nations without averaging away stricter requirements; every
statement cites claim_ids; list searched-not-found Nations
(sources/coverage-matrix.jsonl) as such, never as having no requirements.


Finish: `python tools/merge_validate.py validate` clean; lane report
reviews/lane-reports/ds4-a-2026-07-21.md (docs covered, claims you were
unsure restating, corpus gaps). Touch nothing outside your slices.
