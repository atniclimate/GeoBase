# DS-2 baseline lane report — 2026-07-21

Probe-only lane. Requests used the required honest user-agent, robots were requested before content on each host, and requests to each host were spaced at least five seconds apart. No corpus files were created.

## Verified baseline rows

| Rows | Verdict | Evidence |
|---|---|---|
| src-bl-015, src-bl-016, src-bl-017 | dead | Their DOH URLs each returned 404 after a permissive robots check. |
| src-bl-018, src-bl-019, src-bl-020, src-bl-021 | publication intent confirmed | Current public Washington Legislature RCW/WAC pages returned 200 and identify the cited official chapter/rule. |
| src-bl-031 | excluded-gated | eCFR robots permits the path, but the target returned a Request Access page. No access-gate workflow was attempted. |
| src-bl-033 | dead | ASPE target returned 404 after a permissive robots check. |
| src-bl-034, src-bl-035 | doubtful / inaccessible | HHS denied both robots.txt and candidate requests with 403 Access Denied; no status change is recommended absent a human-approved access path. |
| src-bl-042 | dead | GIDA `/care` returned 404; robots did not disallow the stated user-agent. |
| src-bl-047 | publication intent confirmed | Local Contexts' public home page returned 200 and clearly identifies the organization. |
| src-bl-048 | dead | The cited Indigenous Data Sovereignty Agreement URL returned Local Contexts' 404 page. |

## Relocation and discovery

- `bl-046`: re-located as new candidate `src-d2bl-001`, the NPAIHB-hosted NWTEC Data Governance Handbook Version 1.1 URL. Search-result title and the NPAIHB/NWTEC organizational relationship provide preliminary publication evidence; human review remains required.
- `bl-007`: search found `https://www.colvilletribes.com/enrollment/`, whose result describes Constitution and Code-and-Law links. It is off this lane's allowlist, so it was not probed.
- `bl-024`: search found Oregon OHA's `https://www.oregon.gov/oha/ERD/SiteAssets/Pages/Government-Relations/OHA%20TA%20LC%20413_Collecting%20Tribal%20Affiliation%20Data_DRAFT%20Summary.pdf`; it discusses future data-sharing agreements but is not clearly the requested template. It is off-allowlist and was not probed.
- `bl-043`: search found `https://usindigenousdatanetwork.org/`; it is off-allowlist and was not probed. It appears to be the Network's current public site, but no particular baseline instrument is identified.
- `bl-004`, `bl-011`, `bl-025`, `bl-026`, `bl-027`: no allowlisted canonical URL was located. The likely Nation/state hosts are outside this lane's allowlist; no probes were made.

## `src-bl-053` correction flag

The Cambridge URL is not merely truncated: search identifies a differently titled 2024 *Ethics & Human Research* case analysis, DOI `10.1002/eahr.500202`, with likely canonical publisher URL `https://onlinelibrary.wiley.com/doi/10.1002/eahr.500202`. This conflicts with the register's claimed *Data & Policy*/Cambridge identity. Both candidate hosts are off-allowlist; do not replace the register row without human review.

## Human-review flags

- `src-bl-020` and `src-bl-021` are correctly published state rules, but the listed entity wording should be checked against the actual rule agency.
- The `src-d2bl-001` PDF probe implementation inadvertently read the response into transient memory before discarding it. No bytes were written, retained, parsed, or summarized. Treat this as a probe-only protocol deviation and do not acquire the file without the usual approval and clearance path.
