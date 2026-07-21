# Lane registry — authoritative orchestration state

The director updates this file at every lane start, checkpoint, and stop.
Resume ALWAYS uses the exact recorded session UUID (never `resume --last`).
A host may appear in exactly one ACTIVE lane's host allowlist at a time —
this is the global per-host throttle mechanism.

| lane | phase | worker (model@effort) | scope (Nations/hosts/slice) | file allowlist | session UUID | status | checkpoint / notes |
|---|---|---|---|---|---|---|---|
| baseline | DS-1 | codex gpt-5.6-terra@medium | baseline-inventory normalization + official-URL re-location; hosts per `lanes.json` (seed list — extend on flagged request) | `sources/baseline-inventory.jsonl`, `sources/register.baseline.jsonl`, `provenance/access-log.baseline.jsonl`, `reviews/lane-reports/baseline-*.md` | `019f85af-e4ad-70f3-866e-d0d4927e6b99` | done | 2026-07-21: 53 inventory records (bl-001–bl-053), 44 candidates + 9 unresolved-baseline, 106 log events, search-only (no probes). Merged by director; validate clean. Report: `reviews/lane-reports/baseline-2026-07-21.md`. |
| wa-coastal | DS-1 | codex gpt-5.6-terra@medium | 25 WA coastal/Puget Sound Nations (chehalis…upper-skagit per NATIONS.md); search-only, hosts=[] | `sources/register.wa-coastal.jsonl`, `provenance/access-log.wa-coastal.jsonl`, `reviews/lane-reports/wa-coastal-*.md` | `019f85b6-b6b2-7fc1-b8b2-00a22e4c1781` | done | 2026-07-21: 25 Nation search events, 12 register rows (8 candidate, 4 excluded-ambiguous), search-only. Merged; validate clean. Report: `reviews/lane-reports/wa-coastal-2026-07-21.md`. |
| wa-inland | DS-1 | codex gpt-5.6-terra@medium | yakama, colville, kalispel, spokane; search-only, hosts=[] | `sources/register.wa-inland.jsonl`, `provenance/access-log.wa-inland.jsonl`, `reviews/lane-reports/wa-inland-*.md` | `019f85b6-db81-79a0-86a5-47fe031283e5` | done | 2026-07-21: 12 searches, 7 rows (6 candidate incl. 1 later marked duplicate, 1 excluded-gated). Merged; validate clean. |
| or | DS-1 | codex gpt-5.6-terra@medium | 9 Oregon Nations per NATIONS.md; search-only, hosts=[] | `sources/register.or.jsonl`, `provenance/access-log.or.jsonl`, `reviews/lane-reports/or-*.md` | `019f85b7-0031-7d92-826f-d2d3d3dc05a3` | done | 2026-07-21: 9 searches, 8 candidates (1 later marked duplicate). Merged; validate clean. |
| id | DS-1 | codex gpt-5.6-terra@medium | 5 Idaho Nations per NATIONS.md; search-only, hosts=[] | `sources/register.id.jsonl`, `provenance/access-log.id.jsonl`, `reviews/lane-reports/id-*.md` | `019f85b7-2738-7e51-b557-c7f6b6d21541` | done | 2026-07-21: 5 searches, 7 rows (6 candidate incl. 1 later marked duplicate, 1 excluded-ambiguous). Merged; validate clean. |
| institutional | DS-1 | codex gpt-5.6-terra@medium | intertribal / research-governance / federal / state / academic-NGO layers per SEED-SOURCES.md + owner seeds; search-only, hosts=[] | `sources/register.institutional.jsonl`, `provenance/access-log.institutional.jsonl`, `reviews/lane-reports/institutional-*.md` | `019f85bd-8275-7fc1-a92d-179fb66ef3c8` | done | 2026-07-21: 16 searches, 20 candidates across 5 layers (1 later marked duplicate). Merged; validate clean. Report: `reviews/lane-reports/institutional-2026-07-21.md`. |
| director | standing | claude/director | dedup + merges; no hosts | `provenance/access-log.director.jsonl` | n/a | active | 2026-07-21: register-status→duplicate ev-0001…0005 (src-or-005→src-bl-002, src-wai-003→src-wai-002, src-id-004→src-bl-012, src-inst-020→src-wac-010, src-inst-014→src-bl-038 [gate-audit remediation]); src-id-003 retained (newer 2024 Nez Perce research-regulation PDF — DS-2 approval selects canonical URL). DS-1 gate audit: PASS after remediation (`reviews/gate-audits/ds1-gate-2026-07-21.md`). |

| ds2-wa-coastal | DS-2A | codex gpt-5.6-terra@medium | verify src-wac rows + deepen 15 WA-coastal Nations on official sites; probe-only | `sources/register.ds2-wa-coastal.jsonl`, `provenance/access-log.ds2-wa-coastal.jsonl`, report | `019f85d3-cd3d…` A / `019f85e3-9e19…` B | done | Wave A per `prompts/ds2-wave-a-probe.md`; hosts in lanes.json. |
| ds2-wa-inland | DS-2A | codex gpt-5.6-terra@medium | verify src-wai rows + deepen 4 inland Nations; probe-only | ds2-wa-inland slices + report | `019f85d3-e73f…` A / `019f85e3-7214…` B | done | Wave A. NILL stays untouched (gated). |
| ds2-or | DS-2A | codex gpt-5.6-terra@medium | verify src-or rows + src-bl-002; deepen cow-creek + code portals; probe-only | ds2-or slices + report | `019f85d4-0037…` A / `019f85e3-5c57…` B | done | Wave A. |
| ds2-id | DS-2A | codex gpt-5.6-terra@medium | verify src-id + src-bl-012/013; deepen kootenai, shoshone-paiute official sites; probe-only | ds2-id slices + report | `019f85d4-1b4b…` A / `019f85e3-8833…` B | done | Wave A. |
| ds2-institutional | DS-2A | codex gpt-5.6-terra@medium | verify src-inst rows + third-party legal-publisher terms (municode/thorpe/NARF); probe-only | ds2-institutional slices + report | `019f85d4-3bcb…` | done | Wave A. Terms rulings decisive for Wave B fetchability. |
| ds2-baseline | DS-2A | codex gpt-5.6-terra@medium | verify src-bl candidates on state/federal/intertribal hosts; re-locate 9 unresolved-baseline; probe-only | ds2-baseline slices + report | `019f85d4-659a…` A / `019f85e3-b196…` B | done | Wave A. Supplies real per-item publication_intent evidence. |

Statuses: `pending` → `active` → `merging` → `done` | `stalled` | `aborted`.
Stalled lanes (no progress across a session) are recovered by resuming the
recorded session or re-issuing the lane with the same slice files — the
keyed merge makes re-runs safe.

Lane reports land in `reviews/lane-reports/<lane>-<date>.md` and must state:
records produced, failures with retry class, flags raised for human review,
and coverage achieved vs. assigned scope.
