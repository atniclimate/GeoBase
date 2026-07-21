# DS-2 baseline — Wave B fetch report

Fetched five approved public HTML pages. All records are staged; no parsing, summary, or clearance action was performed.

| Source | Document | SHA-256 | Bytes |
|---|---|---|---:|
| `src-bl-018` | `rcw-43-376` | `67dd26e75b7a04c268235babf6ba1c791ab8b35356f41f12e6faaf1950376ba7` | 115162 |
| `src-bl-019` | `rcw-70-02` | `348116972fa4bef470075108ceb7f8f782318289c83f160dba54df0e20b4d232` | 139066 |
| `src-bl-020` | `wac-246-455-990` | `31ffa5aa9dae21f4e718e38f0f11312bb77b0200e4b8fc3cdb4c66496d3fad2f` | 109242 |
| `src-bl-021` | `wac-182-125-0100` | `fa183b051e4aff16362270e0263222eb1ce96bab90c096a58caa48a5e5af693b` | 111937 |
| `src-bl-047` | `local-contexts-home` | `58815dbd36bd91188dbd6ce1b77b686d4b2ddb068ee719c323b7b7e7758d0586` | 157721 |

`app.leg.wa.gov/robots.txt` returned 404 (default allow); the Legislature privacy page returned 200 with no observed automated-retrieval restriction. Local Contexts robots permitted the homepage and its terms page returned 200 with no observed restriction. Requests were spaced at least five seconds apart per host. No retries or failures occurred.

The Local Contexts homepage exposed links to tool pages and image assets, but no standalone CARE/Local Contexts instrument document. No new candidate registration was created.
