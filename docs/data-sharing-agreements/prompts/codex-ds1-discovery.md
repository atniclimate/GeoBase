# Codex worker — DS-1 source discovery

Lane: assigned in `../LANES.md` (one layer or Nation shard; your slice files
are `sources/register.<lane>.jsonl` and `provenance/access-log.<lane>.jsonl`
— write nothing else outside your lane report).

Contract: read `../AGENTS.md` and `../COLLECTION-CHARTER.md` first; they
bind you. Schemas are authoritative: `sources/register.schema.json`,
`provenance/access-log.schema.json` (note the per-action conditional
required fields).

Task:
1. **baseline lane only**: first produce `sources/baseline-inventory.jsonl`
   (stable `bl-NNN` IDs; scope defined in `sources/baseline-inventory.md` —
   the report's four tables, in order). Then re-locate each item's official
   URL (issuing entity's own site preferred) and record it as a register
   row carrying its `baseline_id`. Items that cannot be re-located get
   `status: "unresolved-baseline"` (NOT `dead`) with the report reference
   in notes — no archive fallback (charter §3).
2. **nation lanes**: sweep your assigned `nation_id`s from
   `sources/NATIONS.md` — official Tribal sites first (codes, constitutions,
   research/IRB pages, legal-notice portals), then state/federal/academic
   holdings of that Nation's instruments. Log every search as a `search`
   event (query, date) so coverage is auditable; a Nation with nothing
   found still needs its searches logged.
3. Other layer lanes: per `sources/SEED-SOURCES.md`.
4. Every candidate: register record (with `discover_event` FK,
   `official_source`, `publication_intent` evidence, `nation_id` where
   applicable) + `discover` log event. Suspected duplicates of another
   lane's scope: record with `status: "candidate"` and note — the director
   dedupes at merge.
5. Login-gated / paywalled / terms-restricted / ambiguous sources: record
   with the matching `excluded-*` status and reason. Never fetch them.
6. No document downloads in this phase. Identification fetches of index
   pages are `probe` events (HTTP status, robots evidence, UA — no stored
   bytes), must respect your lane's host allowlist and the charter's
   5s/host limit (your URL hosts must be in your lane's `lanes.json`
   allowlist — tool-enforced). Web searches are `search` events (query +
   date) with `nation_id` set when the sweep concerns a Nation — the
   coverage matrix may only cite events whose `nation_id` matches its row
   (tool-enforced), so log every Nation sweep separately, even when it
   finds nothing.

Before finishing: run `python tools/merge_validate.py validate` from the
folder root and fix your slice's findings. Then write your lane report to
`reviews/lane-reports/<lane>-<date>.md` (records produced, searches run,
Nations/layers with nothing found, exclusions, flags for human review).
