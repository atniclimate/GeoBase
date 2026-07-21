# DS-2 Wave A lane report — Washington coastal

Date: 2026-07-21  
Lane: `ds2-wa-coastal`  
Worker: `codex/gpt-5`

This was a probe-only pass. No document bytes were fetched, stored, or analyzed; no new register candidate was created.

## Existing register rows

| Row | Verdict | Result |
|---|---|---|
| `src-wac-001` | doubtful | eCode360 returned 403 after a nonrestrictive robots response. It is a third-party code host; terms and publication intent could not be assessed. |
| `src-wac-002` | not probed — host gap | `nill.narf.org` is not in this lane's allowlist. |
| `src-wac-003` | not probed — host gap | `narf.org` is not in this lane's allowlist. |
| `src-wac-004` | not probed — host gap | `www.narf.org` is not in this lane's allowlist. |
| `src-wac-005` | publication intent confirmed | Official Quileute Tribal Court codes page returned 200 and deliberately publishes the Law and Order Codes. |
| `src-wac-006` | terms/robots-restricted in practice | Snoqualmie robots and candidate page each returned 403, so permission and terms could not be established. No further access attempted. |
| `src-wac-007` | doubtful / ambiguity unresolved | Official Skokomish index returned 200, but the cited Tribal Records and FOIA entry remains marked “Reserved”; this does not establish a published operative instrument. |
| `src-wac-008` | doubtful | Swinomish official host returned 403 at the research-request page. |
| `src-wac-009` | ambiguity unresolved | Pew returned 403. In any event, a third-party fact sheet cannot establish deliberate online publication of the agreement text. |
| `src-wac-010` | publication intent confirmed | NWIC public policy URL returned 200. This verifies a public academic holding only; it does not resolve Upper Skagit-specific adoption or coverage. |
| `src-wac-011` | ambiguity unresolved | DSHS public index returned 200 and lists a Lower Elwha child-support memorandum; that public listing does not establish a qualifying data-governance instrument. |
| `src-wac-012` | ambiguity unresolved | UW repository endpoint returned 200, but public repository availability does not establish that the referenced protocol is an issued Quinault instrument deliberately published for reuse. |

No candidate URL returned 404 or 410, so no `dead` status transition was warranted. `src-bl-011` is report-only and there are no separate baseline Tulalip rows hosted on `tulaliptribes-nsn.gov`; no Tulalip host probe was required.

## Deepened official-site coverage

Public search corroborated every allowlisted direct domain before probing. The following official home pages returned 200 and had no qualifying published instrument identifiable on the minimal public page: Cowlitz, Hoh, Jamestown S'Klallam, Lummi, Makah, Nisqually, Nooksack, Samish, Sauk-Suiattle, Shoalwater Bay, Squaxin Island, Stillaguamish, Suquamish, Lower Elwha Klallam, and Quinault.

For Nisqually, Samish, Stillaguamish, and Lower Elwha, the initial HTTPS request failed in this environment; a later HTTP retry reached the official HTTPS home page (for Samish, Stillaguamish, and Lower Elwha via the allowlisted `www` form). No wrong or missing official domain was identified. No terms/usage restriction was observed on the successful minimal pages; where present, Terms of Use, Legal Notices, Privacy, or comparable links were noted in the access log.

## Human-review flags

- Assign an authorized lane before probing the three NARF/NILL candidates (`src-wac-002` through `src-wac-004`).
- Retain `src-wac-007`, `src-wac-009`, `src-wac-011`, and `src-wac-012` as `excluded-ambiguous`; the observed public evidence does not resolve their stated ambiguity.
- Review whether NWIC Policy 806 applies to or was adopted by Upper Skagit before treating it as Nation-specific.
- This execution made the candidate-page request five seconds after robots discovery on two hosts whose robots files specified longer crawl delays: Hoh (`20`) and NWIC (`10`). The responses were 200 and no bytes were stored, but the delay did not honor those host directives. Do not rely on this lane's probe as a clean compliance precedent; any follow-up must observe the longer delay.
