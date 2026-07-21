# PLAN v2 — Tribal Data-Sharing Agreement Corpus & RSTEP Sovereignty Guidelines

Status: REVISED after adversarial review
(`../../../_reviews/geobase/2026-07-21_dsa-corpus-plan*.md`, the workspace
review archive outside this repo — NO-GO rounds 1–2; all named blockers
remediated and drilled). Owner: Patrick Freeland.
Director: Claude. Workers: Codex (search/fetch/organize/extract/summarize)
+ Claude subagents (audits, alignment). Baseline inventory:
`pnw-data-sovereignty-research.md` (43-Nation WA/OR/ID web-baseline).

## Objective

Build a governed corpus of publicly published Tribal data-governance
instruments (data-sharing agreements, sovereignty plans, IP legislation,
IRB/research-review policies, research codes, constitutions/codes, state and
federal instruments, model frameworks), catalog and analyze them, and
synthesize:

1. **RSTEP Tribal Data Sovereignty Guidelines** — comprehensive draft +
   adherence plan for RSTEP.
2. **GeoBase adherence map** — obligation-by-obligation mapping onto
   GeoBase/TSDF mechanisms with claim-level outcomes (`implemented` /
   `partially` / `not-represented` / `in-tension` / `not-applicable`) and
   observed-behavior receipts — not spec citations alone.
3. **Quick-reference wiki** — per-document summaries + theme pages,
   generated from the catalog's structured claims (single source of truth).

The corpus champions the ATNI **TSDF** as the convergence framework — and
records honestly where an obligation has no TSDF mechanism.

## Governance

Collection is governed by `COLLECTION-CHARTER.md`: a document-research
regime in the spirit of TSDF's precautionary defaults (public-only,
terms-before-bytes, default-refuse, staging/clearance before analysis,
append-only provenance chain with schema-enforced completeness, versioned
refetch, transitive takedown via reuben@atnitribes.org). It does not claim
TSDF runtime equivalence; nothing here enters the GeoBase data spine.

**Ratification path (owner-decided 2026-07-21):** the DS-5 Guidelines are a
*draft* until (1) RSTEP Tribal Advisory Board review/approval, (2) direct
outreach to each Nation, (3) Tribal IRB review where one exists, then
(4) full ratification. Until then every output is labeled DRAFT and no
Nation-attributed requirement is presented as confirmed by that Nation.

## Phases

### DS-0 — Infrastructure (Claude director) — DONE pending re-review
Scaffold, charter v3, schemas v3 (register/manifest/access-log/catalog with
IDs, per-action conditional requirements, and foreign keys), committed gate
tool (`tools/merge_validate.py`: real JSON Schema validation via
`jsonschema`; disk byte/hash/size verification incl. raw artifacts; path
containment; event-computed states with a legal clearance-transition table
(`removed` terminal); per-lane monotonic sequence-vs-timestamp check;
human-actor enforcement for Nation-doc clears, review upgrades, reject,
takedown, archive-auth; fetch gating on effective register approval +
publication-intent evidence; per-lane host allowlists + global 5s/host
spacing; Nation-bound coverage evidence; baseline-inventory closure;
two-phase merge; fail-closed transitive takedown transaction), synthetic
lifecycle drill (`tools/lifecycle_selftest.py`, 28 checks incl. negative
cases — must pass before every phase launch),
canonical denominator (`sources/nations.json` + `NATIONS.md`), machine lane
registry (`lanes.json` + `LANES.md`), baseline-inventory scope
(`sources/baseline-inventory.md`), worker prompts.
State model: staging/clearance/review/register-status/takedown are
append-only access-log events; the validator computes effective state —
merged records are never edited (sole exception: the evidenced takedown
tombstone transaction).
**Gate:** `lifecycle_selftest.py` green; Codex adversarial re-review
confirms blockers closed; owner go-ahead.

### DS-1 — Source discovery (Codex; Claude subagents cross-check)
Lanes (host ownership assigned in `LANES.md`; every lane writes only its
own `register.<lane>.jsonl` + `access-log.<lane>.jsonl` slices):

- **baseline** — normalize `pnw-data-sovereignty-research.md`: every named
  document/authority becomes a register record; re-locate official URLs
  (the report's citations are unresolved placeholders). This seeds ~50
  high-value records including the Nez Perce research-permit regulations,
  WA-DOH/Tulalip DSA materials, SB 841, HHS TEC Data Access Policy, tribal
  constitutions/codes, CARE/Local Contexts, NWTEC handbook.
- **nation lanes** — per-Nation sweep against `sources/NATIONS.md`
  (sharded WA-coastal / WA-inland / OR / ID), official sites first.
- **intertribal / research-governance / federal / state / academic-ngo**
  lanes per `sources/SEED-SOURCES.md` layers.

The baseline lane's first deliverable is `sources/baseline-inventory.jsonl`
(stable `bl-NNN` IDs per `sources/baseline-inventory.md`); un-relocatable
items get status `unresolved-baseline` (distinct from `dead`; no archive
fallback without human authorization — charter §3).
**Gate (deterministic):** `python tools/merge_validate.py coverage` clean —
this enforces: schema + FK validation of the whole population, one
coverage-matrix row per denominator Nation with linked `search`/`probe`
event evidence, and the ATNI roster expansion completed or explicitly
owner-deferred (`sources/atni-roster-status.json`). Plus: baseline
inventory audited 1:1 against the report tables; duplicates resolved;
lane reports filed in `reviews/lane-reports/`.

### DS-2 — Acquisition + clearance (Codex fetch; owner/director clearance)
Fetch approved register rows per charter §3 to final immutable paths in
effective state `staged` (raw bytes + headers preserved; derived snapshots
recorded as transformations; scan-detection → OCR path with confidence
flag). Automated sensitivity screen → auto-clear event (agency/academic,
clean screen) or the human clearance queue (all Nation-authored docs —
`clear` requires a `human/*` actor, tool-enforced; anything flagged).
**Gate (deterministic):** `merge_validate.py validate` clean — this
enforces: every corpus file ↔ manifest ↔ fetch event with disk-hash
verification both directions; zero parse/summarize of uncleared documents;
no robots/terms-forbidden fetch records. Plus: `lifecycle_selftest.py`
green (includes the transitive takedown drill); Claude-subagent audit of a
seeded, stratified sample (host × lane × doc kind) for charter compliance
using the recorded evidence fields.

### DS-3 — Cataloging (Codex; only effectively-cleared docs)
One catalog record per document per `catalog/catalog.schema.json`: legal
status, covered parties/data (literal `unknown` forces needs-human-review,
tool-enforced), dates, claim-level requirements (stable `claim_id`s, modal
strength, conditions, cites), TSDF mapping with honest enum outcomes, and
the `parse_event` FK. Records start `machine-extracted`; upgrades to
`human-reviewed` happen only via `review` events from `human/*` actors
(tool-enforced). **Nation-attributed claims must reach `human-reviewed`
before guideline use** — DS-5 checks the effective state, not the record.
**Gate (deterministic + semantic):** schema/FK validation on the whole
population; every record has non-empty claims or `none_reason`; seeded
stratified sample (per Nation, instrument type, legal status, OCR flag)
audited by Claude subagent against source bytes for accuracy, omitted
qualifiers, and applicability — not just modal fidelity.

### DS-4 — Analysis & quick-reference (Codex drafts; Claude verifies)
`summaries/<doc-id>.md` (cites `claim_id`s + content_version) and `wiki/`
theme pages **generated from catalog claims** — the wiki taxonomy is chosen
after DS-3 from the categories that actually occur, seeded by the research
report's controlled vocabulary (ownership, control, access, publication
review, redisclosure, confidentiality, benefit sharing, IP). Every page
carries the "non-discovery ≠ absence" notice and DRAFT status.
**Gate:** seeded claim-trace audit (summary/wiki claim → claim_id →
content_version bytes); completeness check against the catalog (no
cataloged Nation omitted from theme pages that cover its claims).

### DS-5 — Synthesis (Claude director)
- `guidelines/RSTEP-DATA-SOVEREIGNTY-GUIDELINES.md` (DRAFT): principles;
  what external partners/agencies must adhere to, by obligation class with
  Nation-specific citations; RSTEP-specific plan (what RSTEP collects,
  tier assignments, consent flows, siting-data sensitivities such as
  site locations); engagement protocol built on the research report's
  custodian model (council secretaries, legal counsel, health/research
  offices) for the outreach stage.
- `guidelines/GEOBASE-ADHERENCE-MAP.md`: claim-level outcomes,
  basis-stamped (GeoBase commit, TSDF version, content_versions cited)
  with observed-behavior receipts (test/artifact evidence) for anything
  marked `implemented`.
**Gate:** every Nation-attributed claim cited in the draft has effective
review state `human-reviewed` (checked against the event log, not record
fields); Codex adversarial review (sol@max); owner ratification of the
DRAFT; then the external path — Tribal Advisory Board → direct outreach to
**every Nation attributed in the draft** (not merely the regional
denominator) → Tribal IRB review where present → ratification. A
ratification ledger (`guidelines/RATIFICATION-LEDGER.md`) links Advisory
Board decisions, per-Nation outreach, IRB reviews, corrections, and final
disposition to exact claim_ids and content_versions. Acceptance stays
owner-reserved; external ratification stays with the Nations.

Pre-DS-5 tooling task (carry-over from review round 3): a `ds5` gate mode
that parses the draft's citations and verifies every Nation-attributed
claim_id has effective `human-reviewed` state and a current (non-superseded)
content_version, plus a ratification-ledger completeness check. Built and
drilled before DS-5 synthesis begins.

### DS-6 — Maintenance
Quarterly URL/hash re-check with versioned refetch (stale-claim
propagation per charter §6); takedown-channel monitoring
(reuben@atnitribes.org); denominator extension (ATNI roster, then
nationwide); new-source intake through DS-1's register path; annual
coverage-matrix refresh.

## Orchestration control

- `lanes.json` (machine) + `LANES.md` (human) are the lane registry: lane
  id → worker, model, effort, assigned hosts/Nations, file allowlist, Codex
  session UUID, status, checkpoint. The validator enforces: slice filenames
  name registered lanes, log records match their slice's lane, and no host
  is owned by two active lanes. The director updates both at every lane
  start/stop; resume always uses the recorded exact session id (never
  `resume --last`).
- Lanes write only `<name>.<lane>.jsonl` slices + their own lane report.
  The director runs `python tools/merge_validate.py merge` after each lane
  completes; a failed validation blocks the merge and the lane's gate.
- Host politeness is enforced structurally: a host appears in exactly one
  active lane's allowlist at a time.
- Crash/retry: fetches are idempotent per (source_id, sha256) — re-running
  a lane may re-fetch but never duplicates records (merge is keyed);
  partial lane output is safe because slices only merge after validation.
- Retry classes: 429/503 honor `Retry-After` (else 60s backoff, max 2
  retries); 404/410 → register `dead`; other 4xx → log and move on. Archive
  fallback (Wayback) only for `dead` sources, recorded as such.

## Codex model/effort assignments (capability interview, 2026-07-21)

| Phase | Model | Effort |
|---|---|---|
| DS-1 discovery | `gpt-5.6-terra` | `medium` (escalate to `sol` for policy/legal judgment) |
| DS-2 fetch/hash/log | `gpt-5.6-terra` | `low`–`medium` (shell does the exact work) |
| DS-3/DS-4 analysis | `gpt-5.6-sol` | `high`–`xhigh` |
| Adversarial reviews | `gpt-5.6-sol` | `xhigh`; `max` for the DS-5 review; `-p adversary` |

`codex exec -m <model> -c 'model_reasoning_effort="<level>"'`. Native search
for discovery; deterministic downloads via scripted `curl.exe`; PDFs via PDF
plugin/Poppler/pypdf; batch processing with results persisted (272k context
is not corpus capacity); parallel sessions with disjoint file ownership.

## Risks & mitigations

- **Disrespectful collection** → charter §§2–4 (public-only,
  terms-before-bytes, default-refuse, per-host global throttle, honest UA,
  staging, takedown drill before real fetches).
- **Misrepresenting a Nation's requirements** → legal_status + claim-level
  modal/conditions modeling; human review required for Nation-attributed
  claims; DRAFT labeling until the Advisory-Board → outreach → IRB →
  ratification path completes.
- **Provenance gaps** → schema-conditional required fields + FK chain +
  `merge_validate.py` whole-population checks at every gate.
- **Concurrency corruption** → slice-only writes, keyed atomic merge,
  lane registry, single-host ownership.
- **Coverage illusion** → NATIONS.md denominator + per-Nation coverage
  matrix with search evidence; "non-discovery ≠ absence" notice mandatory
  in all outputs.
- **Derivative drift / takedown leakage** → claims live once in the
  catalog; summaries/wiki cite claim_ids; supersession and takedown mark
  dependents stale via claim_id search.
- **Hallucinated sources** → nothing enters the catalog without fetch
  event + manifest + hash; baseline-report items must be re-located at
  official URLs before fetch.
