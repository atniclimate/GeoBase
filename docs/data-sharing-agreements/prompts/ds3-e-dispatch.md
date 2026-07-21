# ds3-e — DS-3 cataloging, final 16 round-3 documents (Nation-authored + flag-cleared)

Working root: C:\dev\GeoBase\docs\data-sharing-agreements. Your lane:
`ds3-e` (lanes.json). Contract: prompts/codex-ds3-catalog.md in full
(charter §8, catalog schema v3, parse events parented to the clear event,
faithful modals, honest none_reason / tsdf_mapping / review_state). Read
reviews/gate-audits/ds3-gate-2026-07-21.md first — do not repeat the c002
modal-upgrade defect class; preserve qualifiers; never broaden covered
parties.

## BINDING HANDLING RULES (owner rulings ev-director-0180..0188, DECISIONS.md 2026-07-21)

For the eight flag-cleared docs (bl-038, d2bl-001, inst-003, inst-004,
inst-011, inst-013, wac-008, wai-005): flagged content — signature imagery,
individual staff names, personal/work emails of individuals, direct phone
lines — is NEVER excerpted, reproduced, or described in any catalog field
(claim text, conditions, cite, notes). Institution-not-person: refer to
roles and organizations only ("the Archives and Records Manager", "the BIA
Director approved", never the person's name/email). Violating this is a
blocking charter violation.

Constitutions and constitution/code landing pages typically carry
governance frameworks, not partner-facing data obligations — an honest
`none_reason` is the expected outcome there; do not force claims.

## Assigned docs (16; verify each clear event in provenance/access-log.jsonl)

- `bl-001` (clear ev-director-0142) — CTUIR Constitution and Bylaws PDF
- `bl-003` (clear ev-director-0143) — Warm Springs Constitution PDF
- `d2id-002` (clear ev-director-0152) — Shoshone-Paiute constitution page (thin TOC/landing page)
- `d2id-003` (clear ev-director-0153) — Shoshone-Bannock constitution page
- `id-005` (clear ev-director-0154) — Shoshone-Bannock privacy policy
- `or-006` (clear ev-director-0167) — Warm Springs tribal code portal page
- `r3-001` (clear ev-director-0168) — CTUIR codes/statutes/laws page
- `wac-006` (clear ev-director-0171) — Snoqualmie tribal codes page (note: register discovery cites Public Records Act 5.3 — catalog what the retrieved bytes actually contain)
- `bl-038` (clear ev-director-0181) — BIA Tribal Data Priorities consultation page
- `d2bl-001` (clear ev-director-0182) — NWTEC Data Governance Handbook v1.1 (nation_authored=false per correction ev-director-0141: intertribal). Its confidential/internal-use language is dataset-handling rules — catalog them as claims where partner-facing.
- `inst-003` (clear ev-director-0183) — NIH THRO overview presentation
- `inst-004` (clear ev-director-0184) — BJA Tribal Data Sovereignty presentation
- `inst-011` (clear ev-director-0185) — NNI policy brief page
- `inst-013` (clear ev-director-0186) — BIA 78 IAM 2 Data Governance directive
- `wac-008` (clear ev-director-0187) — Swinomish Tribal Archive research request page
- `wai-005` (clear ev-director-0188) — Kalispel/WA Commerce LIHEAP agreement (executed intergovernmental agreement — legal_status accordingly; no signatory names/contacts anywhere)

Slices: catalog/catalog.ds3-e.jsonl + provenance/access-log.ds3-e.jsonl
(ev-ds3-e-NNNN, real UTC ts). Finish: `python tools/merge_validate.py
validate` clean; lane report reviews/lane-reports/ds3-e-2026-07-21.md
(records, none_reason count, theme patterns for DS-4, flags). Touch
nothing else.
