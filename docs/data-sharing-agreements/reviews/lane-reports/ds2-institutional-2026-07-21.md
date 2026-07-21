# DS-2 institutional lane report — 2026-07-21

Probe-only work completed. No corpus files were downloaded, stored, parsed, or summarized.

## Register verification

- Publication intent confirmed (HTTP 200): src-inst-001, 002, 005, 006, 009, 011, 014, 016–019. The two GitHub rows remain non-primary-host candidates requiring issuer review.
- Public PDF endpoint confirmed by HEAD 200: src-inst-003, 004, 010, 013. No bytes were retained.
- Inaccessible, not dead: src-inst-007, 008, 012 (NCAI hosts timed out with no HTTP response); src-inst-015 (NOAA robots and HEAD returned 403). No 404/410 was observed.
- src-inst-020 was skipped as directed.

## Terms / third-party publisher findings

- `library.municode.com`: robots returns `Content-Signal: search=yes, ai-train=no, use=reference` and allows the declared UA. Its `/terms-of-use` route returned an application shell rather than readable terms. This does not establish a fetch right; `src-id-006` remains candidate pending human terms/issuer-authorization review, not excluded-terms.
- `narf.org` / `www.narf.org` / `nill.narf.org`: NARF robots allows general crawling; NILL robots is 404. The tested NARF terms route was 404, so a published terms basis was not located. No automated collection is recommended pending human terms review.
- `thorpe.law.ou.edu`: robots and tested terms route both returned 404. No relevant assigned holding was probed; flag for human terms review before any future Thorpe collection.

## Nation-lane holdings and ambiguity reassessment

- `src-wac-002` (Muckleshoot): NILL's public index expressly says the Tribe has not permitted full text online. I appended an `excluded-gated` register-status event; no further content was probed.
- `src-wac-003` (Port Gamble): NILL says the Tribe makes its code available online and links to the Tribe's own website. The aggregator is not the official copy; candidate remains.
- `src-wac-004` (Puyallup): NILL says the Tribe makes its code available online and links to Code Publishing. Candidate remains; official-source and third-party publication authority need human review.
- `src-id-006` (Shoshone-Bannock): Municode returns an application shell at the listed route. The page does not prove issuer authorization; candidate remains pending human review.
- `src-id-007` (Shoshone-Paiute): public NILL index confirms the Tribe has not given permission to put full text online. This supports the existing precautionary exclusion; no status change made.
- `src-wai-001` (Yakama): public NILL index confirms the Nation has not given permission to put full text online. This supports the existing exclusion; no status change made.

## Deepening

- USET's public Health resolutions index and native `data sovereignty` search were probed. No additional unambiguous instrument was registered.
- NNI's policy-brief page and native data-sovereignty search were probed. No additional unambiguous instrument was registered.
- USIDSN brief endpoint is live (HEAD 200); no additional unambiguous instrument was identified in the limited pass.
- NCAI archive hosts did not respond, so archive deepening could not proceed.

## Human-review flags

- Terms/automated-use basis for Municode, NARF/NILL, and Thorpe must be resolved before any Wave B collection.
- Retry NCAI and NOAA manually or from a permitted network context; do not classify as dead from this evidence.
- The initial scripted page probe preceded usable robots capture because of a PowerShell `$Host` variable collision. Correct robots requests were subsequently made, and every log record discloses this anomaly. No fetch occurred.
