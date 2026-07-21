# AGENTS.md — docs/data-sharing-agreements (folder-scoped contract)

Scope: this directory tree only. The repo-root `AGENTS.md` continues to apply
except as explicitly extended here.

## Grant (owner: Patrick Freeland, 2026-07-21)

- Codex and Claude subagents have **full read/write** inside
  `docs/data-sharing-agreements/`.
- Read-only access to the rest of the GeoBase repo for alignment (TSDF spec,
  ROADMAP, ARCHITECTURE, RSTEP-related docs).
- **Network access is granted for this lane** — fetching publicly published
  policy documents per `COLLECTION-CHARTER.md`. This is an explicit exception
  to the repo-root "offline" posture, scoped to charter-compliant fetches
  only. The charter is binding; its violations are blocking findings.

## Hard rules

1. Read `COLLECTION-CHARTER.md` before any external fetch. Public documents
   only; terms-before-bytes; default-refuse on ambiguity; robots.txt +
   global per-host rate limits (host ownership per `LANES.md`); honest UA.
2. Every external access and derivation appends to YOUR LANE's
   `provenance/access-log.<lane>.jsonl` (schema-conditional fields are
   mandatory); every stored file gets a `corpus/MANIFEST.<lane>.jsonl`
   record. Workers never write shared (unsuffixed) JSONL files — the
   director merges via `tools/merge_validate.py`.
3. Corpus binaries stay in `corpus/` (effective clearance starts `staged`
   — no analysis before a `clear` event, per charter §4) and are gitignored
   — never commit downloaded documents, never copy them elsewhere in the
   repo. Byte versions are immutable; never overwrite. All state
   transitions (clearance, review, register status, takedown) are
   access-log events — merged JSONL records are never edited.
4. Records validate against their schemas (`sources/register.schema.json`,
   `corpus/manifest.schema.json`, `provenance/access-log.schema.json`,
   `catalog/catalog.schema.json`; requires the `jsonschema` package); run
   `python tools/merge_validate.py validate` before finishing any lane.
5. No machine-absolute paths in tracked files. Never push to remotes.
6. Summaries cite entity + official URL; quote sparingly; never excerpt
   content a document marks as restricted.
7. When a source or mapping is ambiguous, flag for human review — do not
   decide sovereignty questions autonomously.
