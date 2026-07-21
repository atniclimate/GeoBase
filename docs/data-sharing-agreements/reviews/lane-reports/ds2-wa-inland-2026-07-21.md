# DS-2 WA Inland lane report — 2026-07-21

Probe-only work was performed with the required honest user agent. No document bytes were retained, no `fetch` events were created, and the NILL-gated Yakama source (`src-wai-001`) was not probed.

## Domain corroboration

Native search corroborated `yakama.com`, `colvilletribes.com`, `kalispeltribe.com`, and `spokanetribe.com` as the respective Nations' official sites. The Yakama work was confined to `yakama.com` and is separate from the NILL copy.

## Existing rows verified

| Source | Verdict | Result |
|---|---|---|
| `src-wai-002` | publication intent confirmed | Official Colville Archives & Records page returned 200 and deliberately links the research permit, ordinance process, Chapter 6-6 PDF, and resolutions. Robots permits the page. |
| `src-wai-004` | publication intent confirmed | State Commerce page returned 200; robots permits it with a 10-second crawl delay (observed). This remains a state-hosted account, not an official Nation copy. |
| `src-wai-005` | doubtful | Agreement endpoint returned 200, but `liheapch.acf.gov/robots.txt` returned 403. No further host access is recommended without human direction. |
| `src-wai-006` | publication intent confirmed | Official Spokane Archives and Collections page returned 200; its description of research clearance remains a process statement requiring human interpretation. |
| `src-wai-007` | publication intent confirmed | Official Spokane Preservation Program page returned 200; it is a program page, not clearly an operative data-governance instrument. |

`src-wai-003` was skipped as directed. No status transition was made for any pre-existing row.

## Official-site deepening

- Yakama: found and probed the official Water Code Administration Resources page and its official Water Code PDF. Added `src-d2wai-001` as a candidate only; a human should decide whether this resource-governance code is substantively in scope for this corpus.
- Colville: the official History & Archaeology page was also probed; it identifies cultural-resource-management services but no separate published data-governance instrument beyond the already-registered Archives & Records materials. Search also identified the Tribal Museum.
- Kalispel: government and master-planning pages returned 200, but robots returned 500. They did not identify a published policy/agreement suitable for registration. Stop automated work on this host pending human direction.
- Spokane: probed the official Preservation Program About page; it supplies program context only, not a separate policy/agreement.

## Ambiguity and human-review flags

- `src-wai-005`: robots 403 means permission for automated collection is unestablished; human review is required before any later acquisition.
- Kalispel official-site deepening: robots 500 means permission is unestablished; human review is required before further access.
- `src-wai-006`, `src-wai-007`, and `src-d2wai-001`: determine legal force and substantive fit before approval or collection.
- No wrong-domain or missing-allowlist hosts were found.
