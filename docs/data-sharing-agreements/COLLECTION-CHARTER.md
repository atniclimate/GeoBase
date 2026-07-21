# Collection Charter — binding protocol for this corpus

This charter governs every discover/fetch/store/parse/summarize action in
`docs/data-sharing-agreements/`. It is a **document-research governance
regime in its own right** — designed in the spirit of the TSDF's
precautionary defaults, but it does not claim to reproduce the TSDF runtime
guarantees, and nothing collected here enters the GeoBase data spine. Every
agent — Codex, Claude subagents, humans — is bound by it. Violations are
blocking findings.

A standing epistemic rule binds all downstream outputs: **public
availability of a document establishes availability, not consent** to every
use. Collection, retention, summarization, and cross-Nation comparison are
justified here only by (a) restricting to deliberately published
instruments, (b) faithful representation with citations, (c) the takedown
protocol, and (d) the human ratification path in `PLAN.md` (Tribal Advisory
Board review, then direct outreach to each Nation, then Tribal IRB review
where one exists) before anything is presented as a statement of a Nation's
requirements.

## 1. What may be collected

- **Only publicly published documents**: constitutions, codes, resolutions,
  policies, agreements/templates, plans, statutes, rules, guidance,
  presentations, and scholarship that the issuing Nation, organization, or
  agency has deliberately made public on the open web.
- Documents *about* Tribal data governance from intertribal, federal, state,
  academic, and NGO sources.

## 2. What may never be collected

- Anything behind a login, paywall, membership gate, or access-request
  process — a gate is a sovereign decision; do not circumvent it.
- Anything that appears internal, draft-leaked, or unintentionally exposed.
  **Default-refuse**: if it is ambiguous whether a document was deliberately
  published, do not fetch it — register it with `status:
  "excluded-ambiguous"` and the reason, for human review.
- Real-world *datasets* (the corpus is policy documents, not data).
- Personal data as a collection target. Where an otherwise-public
  instrument incidentally contains personal data, signatures, contacts,
  site locations, or TK-adjacent content, §4 staging governs it.

## 3. How collection must behave

- **Terms before bytes**: check the host's published terms/usage policy and
  record the decision (`terms_ok` boolean + `terms_check` basis) in the
  fetch record. A site can permit browsing while restricting automated
  extraction — if terms restrict the fetch, emit a `register-status` event
  setting the source to `excluded-terms` and do not fetch. The validator
  rejects any fetch record with `terms_ok` or `robots_ok` false.
- **Archives are not a loophole**: Wayback/archive fetches are allowed only
  for sources with an *observed* 404/410 (`dead`), only for
  non-Nation-authored documents whose deliberate publication is
  unambiguous, and only after a prior `archive-auth` access-log event from
  a `human/*` actor for that source (the validator rejects archive-host
  fetches without one). Never for
  `unresolved-baseline` items (an unresolved citation is not evidence a
  public URL ever existed), and never to resurrect something a Nation
  unpublished — unpublication is a takedown trigger (§7), not an archive
  opportunity.
- Honor `robots.txt`; record the evidence (`robots_evidence`).
- Identify honestly: user-agent
  `ATNI-GeoBase-PolicyCorpus/1.0 (reuben@atnitribes.org; data-sovereignty research)`;
  record the exact string in every fetch record.
- Rate-limit **per host, globally across all lanes**: ≥ 5 seconds between
  requests to the same host. Hosts are assigned to exactly one lane at a
  time by the director (the lane registry is the throttle mechanism). No
  recursive mirroring — fetch identified documents and the minimal pages
  needed to identify them.
- Prefer official copies (the Nation's own site over aggregators); record
  `official_source` in the register.
- **Lossless**: preserve raw response bytes + headers; derived snapshots
  (HTML→single-file, OCR text) are separate files with the transformation
  tool recorded in the manifest. Low-confidence OCR requires human review
  before cataloging.

## 4. Staging and clearance (before any analysis)

**Staging is a state, not a place.** Fetched files are written once to
their final immutable path
(`corpus/<entity-slug>/<doc-id>/<content_version>.<ext>`) and begin in
effective clearance `staged`. Clearance transitions are **events in the
access log** (`clear` / `restrict` / `reject`), computed by the validator —
manifest records are never edited. **No parsing, summarization, or model
analysis of a staged document beyond the minimal automated screen** (the
validator rejects `parse`/`summarize` events whose document was not
`cleared` at that time). The screen checks for: personal data,
signatures/contacts, site locations, restricted-TK references, publication
ambiguity. Then:

- Agency/academic/NGO/intertribal documents with a clean screen may be
  auto-cleared (a `clear` event citing the screen result).
- **Nation-authored documents always require a `clear` event from a
  `human/*` actor** (tool-enforced via the manifest's `nation_authored`
  flag).
- Flagged content → `restrict` event (human then decides: clear with
  handling rules, or `reject`). Rejected files are **deleted**; their
  manifest record and log events remain as the audit trail (the validator
  requires the bytes to be absent once effective clearance is
  rejected/removed).

## 5. Provenance chain (mandatory, append-only)

Every external access, derivation, and state transition appends one record
to the lane's `provenance/access-log.<lane>.jsonl` conforming to
`provenance/access-log.schema.json` — the schema's per-action conditional
requirements are the authoritative field list. Chain: `search`/`probe`/
`discover` → register record → `fetch` → manifest record (staged) →
`clear` → `parse` → catalog record (with `parse_event`) → `summarize`/
`summary-attach` → summary/wiki/guidelines. Index-page identification
fetches are `probe` events (HTTP/robots/UA evidence, no stored bytes).
State transitions (`clear`/`restrict`/`reject`/`review`/`register-status`/
`supersede`/`takedown`) are events too — the validator computes effective
states and cross-checks every foreign key, byte hash, and parent-event
type, so any claim traces to exact bytes.

Logs are **append-only**: corrections are `correction` events referencing
the `event_id` of the corrected record. Lanes never write shared files;
`tools/merge_validate.py merge` (director-run) validates the whole
population against the JSON Schemas plus cross-record rules, then merges
all slices in a two-phase write. The one sanctioned edit of a merged file
is `merge_validate.py takedown <doc_id>`, which replaces catalog records
with a tombstone evidenced by the takedown event (§7). Slices already
merged may be moved to an `_archive/` subfolder as housekeeping; the
validator tolerates already-merged and tombstone-superseded slice records
either way.

## 6. Versioning and refetch

Byte versions are immutable. A refetch that yields different bytes creates
a new `content_version` (new path, `supersedes` set); the old version's
file, manifest record, and citations are retained. Claims cite a specific
`content_version` — on supersession, dependent catalog records, summaries,
and guideline text are marked stale and must be refreshed before further
use. URL+hash is a *verification* record; the retained bytes are the
reproducible source.

## 7. Ownership, attribution, takedown

- Collected documents remain the property and expression of the issuing
  Nations and organizations. This corpus is a reference library, not a
  republication; corpus binaries are never committed to git and never
  redistributed outside the ATNI workspace.
- Every summary and guideline citation names the issuing entity, the
  `claim_id`, and the official source URL. Quote sparingly; never excerpt
  content a document marks as restricted.
- **Takedown channel**: requests go to **Reuben (ATNI Energy Program
  Manager, reuben@atnitribes.org)**, who directs execution; target
  turnaround five business days, immediate stop-use on receipt.
- **Takedown is transitive**: on request or unpublication — (1) append a
  `takedown` log event (human actor) enumerating what is being removed;
  (2) delete all byte versions from `corpus/` (the event flips effective
  clearance to `removed`; the validator then requires the bytes to be
  absent); (3) run `python tools/merge_validate.py takedown <doc_id>` to
  replace the catalog record with a tombstone (entity, title, reason,
  takedown event — requirements/claims removed); (4) delete the summary;
  (5) grep summaries/wiki/guidelines for the doc's `claim_id`s and remove
  or reattribute every passage before any further publication; (6) redact
  sensitive URL/path notes from retained log records via `correction`
  events if the Nation requests; (7) re-run `validate` to prove closure.
  This exact lifecycle is exercised by `tools/lifecycle_selftest.py`,
  which must pass before every phase launch.

## 8. Interpretation

- These documents express positions of sovereign Nations and their
  institutions. Analysis must represent them faithfully: preserve
  obligation strength (`modal`), covered parties, scope, conditions, and
  exceptions — a "must" that loses its qualifier is as wrong as a "must"
  that becomes "should".
- Distinguish legal force. Enacted law, executed agreements, templates,
  pending bills, guidance, and scholarship are different things
  (`legal_status` in the catalog); never present non-binding or superseded
  material as a Nation's current requirement.
- Where Nations differ, record the range; never average away a stricter
  requirement.
- **Non-discovery is not evidence of absence.** Every downstream product
  states prominently that "not found online" means not located in this
  review — many instruments are held by custodians and unpublished by
  sovereign choice.
- When unsure, flag for human review (`needs-human-review`) rather than
  deciding — the TSDF's precautionary default applies to analysis, too.
