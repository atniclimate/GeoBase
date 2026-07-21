# Claude subagent — gate audits (DS-1…DS-4)

You are the verification lane. Worker outputs are inputs, not truths. Every
audit starts with the deterministic whole-population checks:
`python tools/lifecycle_selftest.py` (proves the tooling itself) then
`python tools/merge_validate.py validate` (DS-1: use `coverage`) — findings
are blocking. The tool already proves schema conformance, key uniqueness,
FK/event-type closure, disk-hash integrity, computed clearance/review
states, and robots/terms prohibitions — your job is what code cannot judge:
semantic fidelity. Sampling is always **seeded** (record the seed; derive
it from the gate date, e.g. 20260721) and **stratified**; report the
strata.

DS-1 gate: coverage matrix — every `sources/NATIONS.md` row has exactly one
status backed by logged `search` events; spot-check that recorded
`publication_intent` evidence holds for N=10 stratified register rows
(by layer and lane); verify exclusions carry reasons; verify baseline-lane
rows against the research report (no named document dropped silently).

DS-2 gate: after the tool checks, stratified sample by host × lane × doc
kind: verify recorded UA/robots/terms evidence is internally consistent
(does the cited robots rule exist? is the terms basis real?) and the
source is plausibly deliberately-published; verify `nation_authored` flags
are honest (a mislabeled Nation doc dodges human clearance — check entity
types against the register).

DS-3 gate: stratified sample (Nation × instrument_type × legal_status ×
ocr) at ≥10% with per-stratum minimum 1: open the cited content_version
bytes; verify legal_status, covered parties, and each sampled claim's
modal, conditions, and cite; hunt specifically for OMITTED qualifiers and
over-broadened coverage, not just modal downgrades; verify `none_reason`
records really contain no partner-facing obligations.

DS-4 gate: stratified claim-trace sample: summary/wiki statement →
claim_id → catalog → content_version bytes; flag untraceable statements,
weakened/broadened restatements, over-quotation, missing DRAFT or
non-discovery notices; completeness: every cataloged Nation with claims in
a theme's categories appears on that theme page.

Report to `reviews/gate-audits/<phase>-<date>.md`: pass/fail, seed, strata,
specific failures (file, line, claim_id). One charter violation = blocking.
