# DS-2 Wave B — acquisition of APPROVED register rows

MANDATORY FIRST READS: AGENTS.md, COLLECTION-CHARTER.md (§3–§5 govern you),
corpus/manifest.schema.json, provenance/access-log.schema.json, lanes.json
(your allowlist), sources/register.jsonl (find your assigned rows).

## Task

Fetch ONLY the register rows listed in your dispatch (all have effective
status `approved` via director register-status events — verify by checking
provenance/access-log.jsonl for the approval before each fetch; fetching an
unapproved row is a blocking violation).

Per row, in order:
1. robots.txt for the host (record evidence). Honor `Crawl-delay` if
   present: your inter-request gap for that host = max(5s, Crawl-delay).
2. Terms before bytes: record `terms_ok` + `terms_check` basis in the fetch
   record. If terms restrict automated retrieval: `register-status` →
   `excluded-terms`, no fetch, move on.
3. Fetch with UA exactly
   `ATNI-GeoBase-PolicyCorpus/1.0 (reuben@atnitribes.org; data-sovereignty research)`
   via scripted curl. Preserve raw response bytes exactly as received.
4. Write bytes ONCE to `corpus/<entity-slug>/<doc-id>/<content_version>.<ext>`
   (immutable; never overwrite; corpus/ is gitignored — never commit
   binaries). Choose `<entity-slug>` from the issuing entity, `<doc-id>` a
   stable kebab-case document id, `<content_version>` per the manifest
   schema conventions (e.g. v1-<date> or the schema's pattern — read it).
5. Append the `fetch` event to YOUR lane's access-log slice (all
   schema-required fields: http_status, robots_ok, robots_evidence,
   user_agent, terms_ok, terms_check, sha256, content_type, size_bytes,
   local_path, source_id, doc_id, content_version) and the manifest record
   to `corpus/MANIFEST.<lane>.jsonl` (all required fields; set
   `nation_authored` honestly — a document issued by a Tribal Nation or its
   government is nation_authored:true regardless of host).
6. NO parsing, NO summarization, NO analysis — documents land in effective
   clearance `staged`. The clearance stage (screen + clear events) is the
   director/owner's, after your lane completes.

If a fetch fails: 429/503 honor Retry-After (else 60s, max 2 retries);
404/410 → `register-status` `dead`; other 4xx → log and move on. If a page
row (HTML) links the actual instrument PDFs (e.g. an archives landing
page), fetch the approved row URL itself, and REGISTER the linked
instrument documents as new `candidate` rows (+ discover events) for
director approval — do not fetch them this wave.

Before finishing: `python tools/merge_validate.py validate` clean for your
slices; lane report `reviews/lane-reports/<lane>-waveb-2026-07-21.md`
(fetched: doc_id/sha256/size per row; failures with retry class;
terms/robots decisions; new candidate registrations; flags).
