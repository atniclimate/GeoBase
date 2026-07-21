# ds2-round3 corrective micro-pass — 2 rows

Same lane (`ds2-round3`), same contract as before (prompts/ds2-round3-fetch.md
wave-B rules; probe-before-fetch; append to your existing slices, event ids
continue monotonically after your last ev-ds2-round3-NNNN).

Fetch exactly these two newly approved rows (approvals ev-director-0176/0177
in provenance/access-log.jsonl; verify before fetch):

- `src-r3-004` — https://uscode.house.gov/view.xhtml?path=/prelim@title25/chapter46&edition=prelim
  (correct ISDEAA codification, 25 USC ch. 46; replaces wrong-content bl-028 ch. 33 forestry)
- `src-r3-005` — https://www.govinfo.gov/content/pkg/FR-2000-11-09/pdf/00-29003.pdf
  (EO 13175 Federal Register PDF; govinfo.gov is now in your allowlist)

No new candidate registrations this pass. Append a "Corrective pass" section
to reviews/lane-reports/ds2-round3-2026-07-21.md (fetched hashes/sizes or
failure classes). Finish with `python tools/merge_validate.py validate`
clean. Touch nothing else.
