# corpus/ — downloaded documents (binaries NOT tracked in git)

Layout (immutable byte versions; **staging is a state, not a place**):

- `<entity-slug>/<doc-id>/<content_version>.<ext>` — written once at fetch
  time; effective clearance starts `staged` and transitions only via
  `clear`/`restrict`/`reject`/`takedown` events in the access log. The
  validator rejects any parse/summarize of a document that was not
  `cleared` at that moment, and requires bytes to be deleted once a
  document is `rejected`/`removed`.
- Refetches create new versions (`v2-…`, `supersedes` + a `supersede`
  event); paths are never reused.
- Raw response bytes/headers preserved alongside derived snapshots
  (`raw_path`/`raw_sha256`/`transformation` in the manifest).

Every file has a `manifest.schema.json`-conforming record in a
`MANIFEST.<lane>.jsonl` slice, merged into `MANIFEST.jsonl` by
`tools/merge_validate.py`, plus a matching fetch event. The tool verifies
disk bytes against recorded hashes and sizes in both directions at every
gate.

Binaries are gitignored by design. The manifest + access log are the
tracked audit record; the retained local bytes are the reproducible source
(URL+hash alone is a verification record, not reproducibility — charter §6).
