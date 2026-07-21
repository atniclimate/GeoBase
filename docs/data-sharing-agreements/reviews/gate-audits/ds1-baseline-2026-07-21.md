# DS-1 baseline slice audit — 2026-07-21

Lane: Claude verification subagent (partial DS-1 scope: baseline slice only; full
coverage-matrix gate deferred until Nation lanes land). No-network audit; nothing
was fetched. Worker outputs treated as inputs, not truths.

- Seed: **20260721**
- Population: `sources/baseline-inventory.jsonl` (53 records), `sources/register.baseline.jsonl`
  (53 rows), `provenance/access-log.baseline.jsonl` (106 events), audited against the four
  tables of `pnw-data-sovereignty-research.md`.

## 1. Deterministic checks — PASS

- `python tools/lifecycle_selftest.py` — **PASSED, 41 checks**, exit 0.
- `python tools/merge_validate.py validate` — **"validation clean"**, exit 0.

## 2. Baseline-inventory 1:1 audit — PASS

Extracted every data row of the four report tables in order
(lines 37–50, 56–68, 74–87, 93–104 of `pnw-data-sovereignty-research.md`:
14 + 13 + 14 + 12 = 53 rows) and compared programmatically against
`sources/baseline-inventory.jsonl`.

- Row count 53 = record count 53. **Zero title mismatches** (exact string equality,
  every row, in order).
- IDs are exactly `bl-001` … `bl-053`, sequential, in table order.
- `report_section` distribution matches the tables: tribal-governance 14 (bl-001…014),
  agreements-state 13 (bl-015…027), federal 14 (bl-028…041), academic-ngo 12 (bl-042…053).
- No silent drops, no invented items, no prose-only items smuggled in (inventory is
  exactly the table row set, nothing more).

Non-blocking observation (entity fidelity, not a table mismatch — the table's
jurisdiction column says only "State"): bl-020 (WAC 246-455-990) and bl-021
(WAC 182-125-0100) carry `entity: "Washington State Legislature"`. WACs are agency
administrative code (DOH / Health Care Authority respectively); the legislature
attribution is imprecise. Recommend correcting entity at DS-2 relocation.

## 3. Register cross-check — PASS

`sources/register.baseline.jsonl`:

- 53 rows; every `baseline_id` bl-001…bl-053 appears exactly once (no dups, no
  missing, no extras).
- Statuses: `candidate` 44, `unresolved-baseline` 9 — no other status, **no `dead`**.
- All 9 unresolved rows (bl-004, 007, 011, 024, 025, 026, 027, 043, 046) carry a
  notes report reference ("Report reference: pnw-data-sovereignty-research.md,
  baseline table item bl-XXX …") plus the archive-fallback prohibition.
- Archive-URL scan (web.archive.org, archive.org, archive.today, archive.ph,
  webcitation) across register slice, inventory, and access-log slice: **zero hits**.
  Unresolved rows use `report://pnw-data-sovereignty-research.md#bl-XXX` placeholders,
  not archive links.

## 4. Publication-intent spot-check (N=10, seeded, stratified) — PASS

- Seed 20260721 (`random.Random(20260721)`, strata iterated in sorted key order,
  rows sorted by baseline_id before sampling).
- Strata = report_section × status; 7 non-empty cells (federal has no unresolved).
  Allocation: 1 per non-empty stratum + 3 extra to the largest candidate strata
  (deterministic rule): federal-cand 2, tribal-gov-cand 2, academic-ngo-cand 2,
  agreements-state-cand 1, plus 1 unresolved from each of the 3 sections that have any.
- Sample: bl-001, bl-005, bl-011(u), bl-021, bl-027(u), bl-032, bl-035, bl-045,
  bl-046(u), bl-053.

Per-row judgment (URL/issuer plausibility only; nothing fetched):

| bl-ID | status | verdict |
|---|---|---|
| bl-001 | candidate | Plausible — ctuir.org (issuer domain) constitution PDF under /media/, matches CTUIR CMS URL shape. |
| bl-005 | candidate | Plausible — grandronde.org official constitution page. |
| bl-021 | candidate | Plausible — app.leg.wa.gov/wac/default.aspx?cite=182-125-0100 is the canonical WA WAC portal URL form. |
| bl-032 | candidate | Plausible — grants.nih.gov/grants/guide/notice-files/NOT-OD-22-214.html is the canonical NIH notice URL pattern. |
| bl-035 | candidate | Plausible — hhs.gov tribal-affairs consultation page; note it is the topic landing page, not the policy PDF itself (acceptable at search-only phase). |
| bl-045 | candidate | Plausible — nni.arizona.edu/publications/ slug matches the publication title. |
| bl-053 | candidate | Plausible issuer (Cambridge Core, Data & Policy) but **URL shape incomplete**: Cambridge Core article URLs end with a hex article ID after the slug; this one ends at the slug. Likely truncated. Flag for DS-2 relocation; non-blocking here since verification is explicitly deferred and no probe was claimed. |
| bl-011 | unresolved | Consistent — report:// placeholder, empty intent, report reference + archive prohibition in notes. |
| bl-027 | unresolved | Consistent — same pattern. |
| bl-046 | unresolved | Consistent — same pattern. |

Observation (non-blocking): `publication_intent` is identical boilerplate across all
candidates ("Native search result identified an issuer-controlled public page or
publication URL; direct verification deferred (no probe in this phase)."). It honestly
declines to overclaim, which fits a search-only slice, but it carries no per-item
evidence — the DS-2 gate must not treat it as verification.

## 5. Charter alignment (no-fetch discipline) — PASS

`provenance/access-log.baseline.jsonl`, 106 events:

- Actions: `search` 53, `discover` 53. **No probe, fetch, or any other action.**
- Every search event carries a query (schema v3 encodes it as the `url`
  search-query descriptor, `search:<query>`; all 53 non-empty and item-specific)
  and a valid `ts` date (all 106 events schema-conformant timestamps).
- Every discover event's `parent_event` resolves to a search event in the slice;
  exactly one discover per source_id (53 sources).
- All fetch-only fields (http_status, robots, sha256, local_path…) are null, as
  they must be for a no-fetch slice.

Note: the recorded query is a descriptor ("Official-source discovery: <title>")
rather than a literal engine query string. Schema-conformant and item-specific,
so accepted; literal query strings would be stronger evidence in Nation lanes.

## Verdict

**PASS — all five sections. Zero blocking findings, zero charter violations.**

Non-blocking findings to carry into DS-2:
1. bl-020 / bl-021 entity attribution ("Washington State Legislature" for agency WACs).
2. bl-053 register URL likely truncated (Cambridge Core slug without article ID).
3. publication_intent boilerplate carries no per-item evidence; DS-2 must verify.
4. Search events log descriptors, not literal query strings.
