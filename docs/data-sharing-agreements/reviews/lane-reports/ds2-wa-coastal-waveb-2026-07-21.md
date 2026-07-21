# DS-2 WA Coastal — Wave B acquisition report

Date: 2026-07-21  
Lane: `ds2-wa-coastal`

## Fetched

- `src-wac-005` — `quileute-law-and-order-codes`, `v1-5e10b6ab`; SHA-256 `5e10b6ab622dd2a929ea909c21dfc9cdc6d33ffffe75e6b26811140b35cf105b`; 153,560 bytes; HTML. Stored staged at `corpus/quileute-tribe/quileute-law-and-order-codes/v1-5e10b6ab.html`. `nation_authored: true`.
- `src-wac-010` — `nwic-irb-policy-806`, `v1-8f9e1c9f`; SHA-256 `8f9e1c9f1f5f36920b798be0835a59679268d7e99b8476de6e6874a44e96f4dc`; 236,082 bytes; PDF. Stored staged at `corpus/northwest-indian-college/nwic-irb-policy-806/v1-8f9e1c9f.pdf`. `nation_authored: false` (issuer: Northwest Indian College).

## Robots and terms

- Quileute: `robots.txt` returned 200 and permits the source path (only `/wp-admin/` is disallowed). Wave A’s official-page probe found no published terms or automated-retrieval restriction. Fetch returned 200.
- NWIC: `robots.txt` returned 200, permits all paths, and specifies `Crawl-delay: 10`. The PDF fetch at 18:17:01Z followed the robots request at 18:15:53Z, exceeding the delay. Wave A’s official-policy URL probe found no published terms or automated-retrieval restriction. Fetch returned 200.

## Candidate registration

- Added `src-d2wac-001`: *Quileute Law and Order Code, Articles I–XII*, linked from the approved official code page and identified there as containing the Clerk and Records article. It remains a candidate and was not fetched.

## Validation

`python tools/merge_validate.py validate` was run. It reported 28 repository-wide findings for corpus files from other lanes without manifest records. No finding names either `quileute-law-and-order-codes` or `nwic-irb-policy-806`; this lane’s records did not add a validation finding. Full clean validation requires the other lanes’ manifest slices to be present/merged.
