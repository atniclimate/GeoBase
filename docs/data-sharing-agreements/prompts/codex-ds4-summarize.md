# Codex worker — DS-4 summaries + wiki drafts (from catalog claims)

Lane: assigned merged-catalog records per `../LANES.md`. Slice files:
`summaries/<doc-id>.md` for your assigned doc_ids,
`wiki/<theme>.<lane>.md` drafts, `provenance/access-log.<lane>.jsonl`.
Summary attachment is an event, not a record edit: emit a
`summary-attach` event (`doc_id`, `content_version`, `artifact_path` =
the summary file, `parent_event` = the parse event). Never write catalog
slice records for docs you did not catalog.

Contract: charter §§7–8. The catalog is the single source of truth —
summaries and wiki pages RESTATE claims by `claim_id`; they never introduce
requirement statements that lack a claim_id.

Per document (log a `summarize` event, `parent_event` = the parse event):
`summaries/<doc-id>.md` — one page: issuing entity + official URL +
content_version + legal_status banner (templates/guidance/pending clearly
labeled as non-binding); what it is; obligations table (claim_id, category,
modal, claim, conditions, cite); TSDF relationship incl. honest
`not-represented` items; DRAFT + "non-discovery ≠ absence" footer. Quote
sparingly; nothing a document marks restricted.

Wiki drafts: themes assigned by the director post-DS-3 (seeded by the
research report's vocabulary: ownership, control, access, publication
review, redisclosure, confidentiality, benefit sharing, IP). Show ranges
across Nations without averaging away stricter requirements; every
statement cites claim_ids; Nations whose instruments were
searched-not-found are listed as such, never as having no requirements.

Before finishing: `merge_validate.py validate`; lane report (docs covered,
claims you were unsure restating, corpus gaps suggested by the material).
