# ds2-round3 RESUME — fix contradictory robots records, complete fetches

Director follow-up on your round-3 run. Same lane (`ds2-round3`), same
contract (prompts/ds2-round3-fetch.md + wave-B). Slices are yours to APPEND
to (never rewrite existing lines — they are provisional but treat them as
event-sourced: corrections, not edits). Work from
C:\dev\GeoBase\docs\data-sharing-agreements.

## Problem found by director review

21 assigned rows were probed 200/206 but never fetched, and their `probe`
events record `robots_ok: false` while their own `robots_evidence` text
says "no applicable disallow or Crawl-delay above 5 seconds observed" —
internally contradictory. Affected source_ids:
src-bl-030 src-bl-032 src-bl-038 src-bl-052 src-id-005 src-wac-006
src-wac-008 src-inst-001 src-inst-002 src-inst-003 src-inst-004
src-inst-005 src-inst-006 src-inst-009 src-inst-010 src-inst-011
src-inst-013 src-inst-016 src-inst-017 src-inst-018 src-d2id-003

## Do now, per row

1. Re-fetch and re-evaluate the host robots.txt PROPERLY (RFC 9309: the
   group matching our UA token else `*`; longest-match allow/disallow; note
   Crawl-delay). Append a `correction` event (`parent_event` = the
   contradictory probe's event_id) stating the true robots ruling and that
   the earlier `robots_ok:false` flag was a recording defect.
2. If robots + terms genuinely allow: FETCH per the wave-B contract (UA,
   5s/host or Crawl-delay, terms-before-bytes, immutable corpus path,
   manifest record, full fetch event). If genuinely disallowed: append a
   `register-status` → `excluded-terms` (terms) or leave candidate with a
   clear note (robots), and say which rule.
3. src-bl-036 / src-bl-037 redirect to `isp.healthit.gov` — now IN your
   allowlist (director addition, lanes.json). Probe + fetch them there if
   robots/terms allow. Their earlier `dead` rulings: if you did not
   actually observe a 404 at the final URL, append a `register-status`
   event returning them to `candidate` (correction-style note), then
   proceed; if a genuine 404 was observed, leave dead and note it.
4. Event ids continue `ev-ds2-round3-NNNN` monotonically from your last.
   Real UTC timestamps only.
5. Update reviews/lane-reports/ds2-round3-2026-07-21.md (append a
   "Resume pass" section: corrections made, fetches completed, final
   robots rulings).
6. `python tools/merge_validate.py validate` must end clean. Touch nothing
   outside your slices + corpus/ + your report.
