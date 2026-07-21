# DS-2 Wave A — verification probes + deepened direct-site discovery

Authorization: owner decision 2026-07-21 (DECISIONS.md) — direct search/probe
of Tribal websites and publicly accessible databases is authorized (RSTEP
Guidelines effort T2 under R-STEP program DE-FOA-0003189). The
COLLECTION-CHARTER.md remains binding and unchanged.

MANDATORY FIRST READS: AGENTS.md, COLLECTION-CHARTER.md,
sources/register.schema.json, provenance/access-log.schema.json, lanes.json
(your lane's host allowlist), sources/NATIONS.md. Also read the merged
`sources/register.jsonl` rows relevant to your scope.

## Task (in priority order)

1. **Verify existing candidates in your scope.** For each register row
   assigned to you: probe the host (robots.txt first, then the candidate/
   index page). A `probe` event records: HTTP status, robots evidence,
   exact UA, and in notes the terms/usage-policy basis you observed and a
   publication-intent judgment (deliberately published by the issuer? is
   this the official copy?). NO document downloads — a probe is page
   identification only, never stored bytes. If a probed URL 404/410s,
   append a `register-status` event → `dead` with the evidence. If terms
   restrict automated access, `register-status` → `excluded-terms` and stop
   probing that host.
2. **Deepen searched-not-found Nations in your scope.** Probe the Nation's
   official site directly (home/government/code/court/research/records
   pages) to locate published instruments the web search missed. FIRST
   corroborate via native search that the allowlisted domain really is the
   Nation's official site — if it is not, or the real domain is missing
   from your allowlist, flag it in your lane report and do NOT probe it.
   New finds → register row (`candidate`, your lane's source_id prefix,
   `discover` event, `nation_id`) + probe evidence.
3. **Re-assess excluded-ambiguous rows in your scope** from public index
   pages only. Never attempt gated/blocked content; never probe a host that
   marked its content as not authorized for online publication. If public
   evidence resolves the ambiguity, say so in the lane report — the
   status change stays with the director.

## Hard rules

- Hosts: ONLY those in YOUR lane's allowlist (exact hostname match) —
  tool-enforced. ≥5 seconds between any two requests to the same host.
  robots.txt before first content request per host; honor it and record it.
- UA exactly: `ATNI-GeoBase-PolicyCorpus/1.0 (reuben@atnitribes.org; data-sovereignty research)`
- No fetches (`fetch` events), no stored bytes, no corpus/ writes — Wave B
  handles acquisition after director approval.
- Write ONLY your lane slices (`sources/register.<lane>.jsonl`,
  `provenance/access-log.<lane>.jsonl`) + your lane report
  (`reviews/lane-reports/<lane>-2026-07-21.md`). Never edit merged files.
- Retry classes per PLAN: 429/503 honor Retry-After (else 60s, max 2);
  404/410 → dead; other 4xx → log and move on.
- Before finishing: `python tools/merge_validate.py validate` from the
  folder root; fix every finding attributable to your slices.

Lane report must include: rows verified (with verdicts: publication intent
confirmed / doubtful / dead / terms-restricted), new discoveries per Nation,
ambiguity re-assessments, hosts flagged (wrong-domain or missing-from-
allowlist), and flags for human review. Recommendations only — approval
(`candidate` → `approved`) is the director's act.
