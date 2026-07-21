# DS-1 Nation discovery lane report — wa-coastal

Date: 2026-07-21  
Worker: `codex/gpt-5`  
Mode: search-only; no probes, fetches, downloads, corpus files, or host-network events.

## Output and validation

- Search events: 25 (`ev-wa-coastal-001` through `ev-wa-coastal-025`), one for every assigned Nation.
- Discover events: 12 (`ev-wa-coastal-026` through `ev-wa-coastal-037`).
- Register records: 12: 8 `candidate`; 4 `excluded-ambiguous`.
- Validation: `python tools/merge_validate.py validate` completed successfully: `validation clean`.

## Coverage by Nation

| Nation ID | Search event | Result |
|---|---:|---|
| chehalis | 001 | Candidate: third-party-indexed Chehalis Central Registry code (`src-wac-001`). |
| cowlitz | 002 | Nothing qualifying located. |
| hoh | 003 | Nothing qualifying located. |
| jamestown-sklallam | 004 | Nothing qualifying located. |
| lower-elwha-klallam | 005 | Excluded ambiguous: state agreement index did not establish a qualifying data-governance instrument (`src-wac-011`). |
| lummi | 006 | Nothing qualifying located. |
| makah | 007 | Nothing qualifying located. |
| muckleshoot | 008 | Candidate: third-party-indexed Tribal Code with harvest-data reporting reference (`src-wac-002`). |
| nisqually | 009 | Nothing qualifying located. |
| nooksack | 010 | Nothing qualifying located. |
| port-gamble-sklallam | 011 | Candidate: third-party-indexed Tribal Code with records-retention reference (`src-wac-003`). |
| puyallup | 012 | Candidate: Tribal Codes Administrative Access Manual for enrollment records (`src-wac-004`). |
| quileute | 013 | Candidate: official Law and Order Codes page, including Clerk and Records article (`src-wac-005`). |
| quinault | 014 | Excluded ambiguous: academic repository item references a data-confidentiality protocol but does not establish an issued Nation instrument (`src-wac-012`). |
| samish | 015 | Nothing qualifying located. |
| sauk-suiattle | 016 | Nothing qualifying located. |
| shoalwater-bay | 017 | Nothing qualifying located. |
| skokomish | 018 | Excluded ambiguous: official index marks the Tribal Records and FOIA item as reserved (`src-wac-007`). |
| snoqualmie | 019 | Candidate: official Public Records Act 5.3 (`src-wac-006`). |
| squaxin-island | 020 | Nothing qualifying located. |
| stillaguamish | 021 | Nothing qualifying located. |
| suquamish | 022 | Nothing qualifying located. |
| swinomish | 023 | Candidate: official Tribal Archive research-request form (`src-wac-008`). |
| tulalip | 024 | Excluded ambiguous: secondary report of a Tulalip–DOH DSA; published agreement text not established (`src-wac-009`). |
| upper-skagit | 025 | Candidate: Northwest Indian College IRB Policy 806, publicly indexed as serving Upper Skagit (`src-wac-010`). |

“Nothing qualifying located” means only that this search review did not locate an online qualifying instrument; it is not evidence that a Nation lacks one.

## Candidate URLs

- Confederated Tribes of the Chehalis Reservation — [Central Registry code](https://ecode360.com/47356601).
- Muckleshoot Indian Tribe — [Tribal Code index](https://nill.narf.org/codes/muckleshoot/index.html).
- Port Gamble S'Klallam Tribe — [Tribal Code index](https://narf.org/nill/codes/port_gamble/index.html).
- Puyallup Tribe of Indians — [Tribal Codes index](https://www.narf.org/nill/codes/puyallup/index.html).
- Quileute Tribe — [Law and Order Codes](https://quileutetribe.com/government/tribal-court/law-and-order-codes/).
- Snoqualmie Indian Tribe — [Tribal Codes](https://www.snoqualmietribe.us/tribal-codes/).
- Swinomish Indian Tribal Community — [Research Request Form](https://www.swinomish-nsn.gov/tribal-archive/page/research-request-form).
- Northwest Indian College — [IRB Policy 806](https://www.nwic.edu/wp-content/uploads/2021/09/Policy-806-Institutional-Review-Board-1-1.pdf), indexed as serving Upper Skagit Indian Tribe.

## Exclusions and human-review flags

- Lower Elwha: determine whether the Washington DSHS index points to an actual qualifying data-sharing agreement rather than only a child-support memorandum.
- Quinault: determine whether the University of Washington repository reference is an officially issued and deliberately published Quinault protocol.
- Skokomish: verify whether an operative records/FOIA instrument exists despite the official index's “reserved” label.
- Tulalip: identify an official deliberately published copy of the reported Tulalip–Washington Department of Health DSA; likely baseline/other-lane duplicate if one exists.
- All third-party legal-publisher/library candidates require currentness, official-copy, terms, robots, and publication-intent checks before a probe or retrieval.
- The Upper Skagit NWIC policy requires confirmation of the policy's operative scope for Upper Skagit.

## Host-allowlist requests

No host was contacted in this lane. If a later, charter-compliant probe phase is approved, request director assignment of these hosts before access:

- Official hosts: `quileutetribe.com`, `www.snoqualmietribe.us`, `skokomish.org`, `www.swinomish-nsn.gov`, `www.nwic.edu`, `www.dshs.wa.gov`.
- Candidate secondary/academic hosts: `ecode360.com`, `nill.narf.org`, `narf.org`, `www.narf.org`, `www.pew.org`, `digital.lib.washington.edu`.

Any future access must check terms and robots first, use the charter UA, and observe the globally coordinated per-host rate limit.
