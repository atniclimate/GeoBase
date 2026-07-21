# Codex worker — DS-3 cataloging (cleared documents only)

Lane: assigned manifest rows whose EFFECTIVE clearance is `cleared` (state
is computed from clear events — check the log, not a manifest field; the
validator rejects parse events on uncleared docs). Slice files:
`catalog/catalog.<lane>.jsonl`, `provenance/access-log.<lane>.jsonl`. DS-2
must have passed its gate for your assigned slice before this lane starts.

Contract: `../AGENTS.md` + `../COLLECTION-CHARTER.md` §8 bind you. Schema:
`catalog/catalog.schema.json` (v3) — strict on purpose.

Per document (log a `parse` event with `parent_event` = the clear event,
then):
1. One catalog record citing the exact `content_version` and your
   `parse_event`. `covered_parties`/`covered_data` are required — literal
   `"unknown"` is allowed but forces `review_state:
   "needs-human-review"` (tool-enforced). Get
   `legal_status` right — enacted law vs. executed agreement vs. template
   vs. pending bill vs. guidance vs. scholarship. When you cannot tell, use
   `unknown-needs-review`, never a guess.
2. `requirements.claims`: one claim per obligation with stable `claim_id`
   (`<doc_id>:cN`), `category`, faithful `claim` text, `modal` as written,
   `conditions` (qualifiers/exceptions/definitions — null only if genuinely
   unconditional), `cite` (section/page in that content_version). Covered
   parties and scope stay inside the claim text — never broaden them.
   Instruments with no partner-facing requirements get an honest
   `none_reason` (e.g. constitutions: governance framework only).
3. `tsdf_mapping.outcome` honestly: many sovereign obligations
   (benefit-sharing, publication review, jurisdiction) are
   `not-represented` or `partially-mapped` — that is a finding, not a
   failure. Do not force-fit tiers.
4. `review_state`: `machine-extracted` unless the unknown-applicability or
   sensitivity rules force `needs-human-review`. You never set
   `human-reviewed` — that state exists only via a `human/*` review event.
   Add sensitivity flags with `disposition: "pending-review"` where
   applicable.

Before finishing: `python tools/merge_validate.py validate`; fix findings;
lane report (records, `unknown-needs-review` count, unmapped-obligation
patterns worth a wiki theme, flags).
