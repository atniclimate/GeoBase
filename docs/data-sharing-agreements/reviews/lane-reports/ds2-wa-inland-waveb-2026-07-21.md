# DS-2 Wave B — ds2-wa-inland

Fetched four approved HTML sources, all HTTP 200. No retries or fetch failures.

| Source | Doc ID | SHA-256 | Size |
| --- | --- | --- | ---: |
| src-wai-002 | archives-records-colville | c26bd7d37a3cc5241356bdb3eef22f59a352aa0b1b10759dd5c592a0fc7160dd | 130570 |
| src-wai-004 | kalispel-commerce-mou-announcement | 9673376ca5bb82eccdeabc622ba5493105301aedc628ee7f5a9c122ab7a116f9 | 84107 |
| src-wai-006 | archives-and-collections | d47885f130b82eec81152ba5940847f7d8d4f7e33156863a0c6ab7f044ae4d69 | 103854 |
| src-wai-007 | preservation-program | 8910f25c093868548cd0bf189cd75c603b4ff3bc32f710ce6f39fc31fa34a41c | 103934 |

Robots permission was confirmed for all target paths. Commerce's `Crawl-delay: 10` was honored. The permitted Wave A page-level terms/usage checks found no published automated-retrieval restriction; `terms_ok:true` and that basis are recorded on every fetch event. `src-wai-004` is correctly recorded as `nation_authored:false`; the other three are `true` and remain staged pending human clearance.

New, unfetched Colville candidate registrations: `src-d2wai-002` Research Permit Application; `src-d2wai-003` Research Regulation Ordinance Process; `src-d2wai-004` Chapter 6-6 Research Regulation; `src-d2wai-005` Resolution 1981-721; `src-d2wai-006` Resolution 1990-317.

`python tools/merge_validate.py validate` found no attributable lane error, but did report 19 pre-existing/concurrent corpus files in other lanes without manifest records. No shared files were changed.
