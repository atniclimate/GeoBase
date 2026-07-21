# Codex worker — DS-2 acquisition (staged state)

Lane: assigned rows of the merged register (effective status `approved`) +
host allowlist per `../LANES.md`/`lanes.json`. Slice files:
`corpus/MANIFEST.<lane>.jsonl`, `provenance/access-log.<lane>.jsonl`.
Cataloging is NOT this phase — no analysis of document contents beyond the
automated screen. **Staging is a state, not a place**: files go straight to
their final immutable path but must not be parsed until a `clear` event
exists (the validator enforces this).

Contract: `../AGENTS.md` + `../COLLECTION-CHARTER.md` §§2–4 bind you.
Schemas: `corpus/manifest.schema.json`, `provenance/access-log.schema.json`
(fetch events have 13 conditionally-required fields — all of them).

Per approved source:
1. **Terms check first** (charter §3): record `terms_ok` + `terms_check`.
   Terms restrict automated retrieval → emit a `register-status` event
   (`new_state: "excluded-terms"`), no fetch. The validator rejects fetch
   records with `terms_ok` or `robots_ok` false.
2. Fetch with the charter UA, robots evidence recorded, ≥5s spacing within
   your host allowlist. Preserve raw bytes + headers (`raw_path` +
   `raw_sha256` when the primary file is a derived snapshot; record the
   `transformation`). Scanned PDFs → `ocr: true`; low-confidence OCR is a
   human-review flag, not a judgment call.
3. Store at `corpus/<entity-slug>/<doc-id>/v1-<sha8>.<ext>` (immutable;
   refetches are v2-… with `supersedes` + a `supersede` event). Append the
   manifest record (set `nation_authored` honestly — it controls who may
   clear) + the fetch event. FK discipline: the fetch event's source_id,
   doc_id, content_version, sha256, and local_path must match the manifest
   exactly (tool-verified).
4. **Automated screen** (minimal scan, no summarization): personal data,
   signatures/contacts, site locations, restricted-TK references,
   publication ambiguity. Clean agency/academic/NGO/intertribal docs: emit
   a `clear` event citing the screen result. **Nation-authored docs and
   anything flagged: no clear event** — list them in your lane report for
   the human clearance queue (`clear` on nation-authored docs requires a
   `human/*` actor; the validator rejects yours).
5. Failures: honor `Retry-After` on 429/503 (else 60s backoff, max 2
   retries); observed 404/410 → `register-status` event `dead`; log
   everything, work around nothing. Archive fallback only per charter §3
   (human authorization; never Nation-authored or unresolved-baseline).

Before finishing: `python tools/merge_validate.py validate`; fix your
slice's findings; lane report to `reviews/lane-reports/` (fetched, failed
by class, clearance queue, screen flags).
