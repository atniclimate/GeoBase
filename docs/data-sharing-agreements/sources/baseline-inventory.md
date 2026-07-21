# Baseline inventory — scope and ID scheme

The DS-1 **baseline** lane converts `../pnw-data-sovereignty-research.md`
into a finite, ID-addressable inventory before any discovery work:

- **In scope (the inventory)**: every row of the report's three
  primary-document tables ("Tribal governance documents"; "Agreements,
  MOUs, compacts, and state implementation instruments"; "Federal statutes,
  regulations, executive authorities, and agency guidance") plus every row
  of "Academic, NGO, and model-policy resources" — assigned stable IDs
  `bl-001`, `bl-002`, … in table order.
- **Out of scope**: instruments mentioned only in prose, portals cited as
  context, and the report's own citation tokens (`citeturn…` placeholders
  are unresolved and are never provenance).

The lane's first deliverable is `baseline-inventory.jsonl`
(`{"baseline_id", "title", "entity", "report_section"}`), audited 1:1
against the report tables at the DS-1 gate ("no named document dropped
silently" is checked against this file, not prose memory).

Each item is then re-located at an official URL and becomes a register
record carrying its `baseline_id`. Items that cannot be re-located get
register status `unresolved-baseline` — distinct from `dead` (an observed
404/410): an unresolved placeholder is NOT evidence a public URL ever
existed, and archive (Wayback) fallback is prohibited for it without
explicit human authorization.

**Scope rule (binding):** the report is a discovery-lead inventory only.
Its recommendations to pursue custodian outreach, public-records requests,
or FOIA pulls describe the *post-ratification engagement path* (PLAN DS-5/
DS-6) — they do not authorize ingesting non-public or requested material
into this corpus, which remains public-documents-only per the charter.
