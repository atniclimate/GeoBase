# DECISIONS.md — escalation-ladder log

Every climb past "obvious local fix" on the deep-think ladder produces an
entry here: trigger, causal chain or research summary, options considered,
choice, and the strongest surviving objection. Newest entries last.

---

## 2026-07-06 — Two-agent workflow established (director + offload engine)

**Trigger:** Workflow setup (not a code decision). Claude Code (Fable)
directs: architecture, sequencing, novel code, final judgment. Codex CLI
offloads: well-specified implementation, standing code review of every
non-trivial diff (stop-time review gate enabled), adversarial second
opinions (capped at two rounds), and log/test triage. Contract file:
`AGENTS.md` (invariants + data gate). Sovereignty boundary: Codex context
is limited to tracked repo content — gitignored material and any
real-world data are never piped to it; inference happens on OpenAI
servers, so the data gate is enforced at the director level as well as in
`AGENTS.md`.

## 2026-07-06 — Phase 0.3 geo IO stack: pure Rust, narrow writer, GDAL as CI oracle only

**Trigger:** ladder rung 4 (decision expensive to reverse — data format,
dependency weight, packaging). **Options:** (1) `gdal` crate bindings —
immediate capability parity, but system GDAL on every dev machine, CI, and
eventually bundled into the Tauri desktop app (~100 MB of DLLs, wide
supply-chain surface, Windows toolchain pain); (2) permanent Python
ingestion — contradicts the roadmap and the fragile-Windows-geo-env
history; (3) **pure Rust** (`rusqlite` bundled, `tiff`, `shapefile`,
`geozero`), GeoPackage tables written by us per spec.

**Choice:** (3), amended by one adversarial Codex round (2026-07-06,
read-only): Phase 0.3 ships a *deliberately narrow, conformance-tested
writer*, not a general raster tiler. Accepted input: single-band
Float32/Int16 GeoTIFF (stripped or tiled; uncompressed/LZW/Deflate),
bounded dimensions; six common geometry types for shapefiles; everything
else rejects loudly per CRS-discipline. Conformance details bound into the
implementation: `2d-gridded-coverage` ancillary tables + three
`gpkg_extensions` rows, per-tile ancillary rows, scale/offset exactly 1/0,
exact tile-matrix bounds arithmetic, TIFF tile blobs single-image Float32
with `data_null` (never NaN), upper-left origin. `.prj`→EPSG via AUTHORITY
node or curated table; otherwise reject unless the operator *explicitly
declares* a CRS, recorded in the audit trail (actor, timestamp, reason) —
declaration is never a code-chosen fallback. Geometry blobs via `geozero`,
not hand-rolled WKB. The existing Python/GDAL stack stays as the
**cross-implementation oracle in CI** (rasterio/pyogrio value-for-value
round-trip + multi-tile/nodata/edge-tile fixtures), so GDAL conformance is
proven continuously without GDAL entering the product.

**Strongest surviving objection:** a narrow writer passing a small fixture
matrix can still be non-conformant for shapes outside it; mitigated by the
oracle fixture set (multi-tile, partial edge tiles, interior nodata,
non-square, UTM CRS) and revisited when Phase 2.1 widens raster inputs.

## 2026-07-06 — Node server browser boundary: loopback CORS allowlist + rebinding guard

**Trigger:** rung 2 (root cause of the node-mode render-gate failure was
CORS, and the obvious patch — `Access-Control-Allow-Origin: *` — would
have let any web page the user visits read node data through their
browser: drive-by localhost exfiltration, egress off-node in all but
name). **Choice:** the 127.0.0.1 bind keeps remote sockets out; a guard
middleware keeps remote web pages out — non-loopback `Host` headers are
refused (DNS-rebinding defense; a rebound attacker domain is same-origin
to the victim's browser and bypasses CORS entirely), and `Origin` is
echoed into CORS headers only for loopback origins (`localhost`,
`*.localhost` per RFC 6761, `127.0.0.1`, `[::1]`, `tauri://localhost`);
anything else is a flat 403. **Strongest surviving objection:** any local
web page can still read T0/T1 — acceptable for 1.0 (they are the user's
own local apps); per-app tokens arrive with the Phase 1.2 ceremony work.

## 2026-07-06 — Desktop shell: Tauri 2, feature-gated; workspace MSRV 1.75 → 1.85

**Trigger:** rung 1–2 (Phase 1.0 build decision). Tauri 2 requires a
newer MSRV than the workspace's 1.75 (cargo silently resolved Tauri 1.8
under the old pin — caught, corrected, pinned to `tauri = "2"`).
**Choice:** bump workspace `rust-version` to 1.85; gate the shell behind
`--features shell` with a `required-features` binary so `cargo build
--workspace` stays webkit/GTK-free on CI and on lean machines — the
desktop shell is built deliberately, not incidentally. The shell binary
injects the node URL via initialization script rather than app-URL query
strings (webview-platform-dependent behavior).

## 2026-07-06 — RStep paint tool: hand-rolled behind an adapter seam, not a draw library

**Trigger:** rung 4 (dependency choice for the 1.3c paint interaction;
one adversarial Codex round per the 1.1+1.3 workplan). **Options:**
(1) maplibre-gl-draw — aging lineage, style/id-collision nuisances, big
surface for a small need; (2) terra-draw — modern, active, MapLibre
adapter, but a real dependency with its own layer/event model inside an
app that already has one; (3) hand-rolled minimal polygon tool on the
same GeoJSON source+layer machinery the layer panel uses.

**Choice:** (3), amended by the adversarial round (Codex dissented
*conditionally*; the conditions are adopted, which the director judges
better than either unconditional path): the tool lives behind a frozen
`PaintTool` adapter interface in the SoLO SDK from day one (terra-draw
becomes a drop-in adapter the day editing/vertex-drag reaches the
roadmap — the migration surface is the interface, not the app); Phase
1.3 UX is *deliberately narrow and recorded as such* (desktop-pointer-
first, no touch commitment, no vertex editing, no undo beyond
remove-last-vertex); draw-time hygiene is in scope (≥3 distinct
vertices, degenerate-ring refusal at close, remove-last-vertex on
Backspace, dblclick-zoom suppression while drawing); ring winding is
normalized at export. Zero new dependencies in the sovereignty-audited
stack.

**Strongest surviving objection (Codex):** a production-feeling tool
costs 400–800 lines with affordances and event hygiene, not the ~200
first estimated, and hand-rolled interaction state machines are where
subtle bugs live; accepted — the paint tool is gate-driven (SDK
injection), bounded, and behind the adapter seam, so the cost of being
wrong is a contained swap, not a rewrite.

## 2026-07-06 — Export product format: shapefile with out-of-band classification (recorded tension with §4)

**Trigger:** rung 3 (1.3b review flagged that a shapefile product cannot
carry TSDF classification in-band, and invariant §4 forbids relying on
detachable sidecars). **Options:** (1) export GPKG-only — classification
travels in-artifact, but the phase deliverable is explicitly a shapefile
others can open in any GIS; (2) shapefile + compensating mechanism;
(3) both artifacts per export. **Choice:** (2) for Phase 1.3, recorded
here so the tension is a decision, not an accident: the shapefile format
HAS no in-band metadata channel, so the T2 stamp travels as (a) the
node-local T3 export ledger (`exports_dir/node-audit.gpkg` —
`export.ceremony` + `export.t2` rows, the authoritative record), (b) the
API response, and (c) a `.tsdf.json` sidecar (best-effort provenance for
humans; a shapefile is already a detachable sidecar bundle by nature).
The export verifier + RStep gate keep the product contents themselves
safe regardless of what detaches. **Revisit:** when a phase needs
product interchange with stronger provenance, add option (3) — a
T2-tagged GPKG twin written in the same export transaction.

**Strongest surviving objection:** a recipient of only the `.shp/.dbf`
pair sees no classification at all; accepted for 1.3 because the product
contains ONLY painted-derived data (verifier-enforced) and the sharing
workflow is Phase 1.2+ governance territory.

## 2026-07-11 — Phase 0 congruence: track planning docs, supersede digital-twin scope, defer MANIFEST reorg

**Trigger:** `PLAN_1.0.md` Phase 0 (P0.1-P0.7) — the plan's own drift audit
found `MANIFEST.md`, `PLAN_1.0.md`, `docs/GEOBASE-BUILD-DIRECTIVE.md`, and
`docs/GEOBASE-DIGITAL-TWIN-FEATURES.md` untracked and therefore without
authority; `git status` at execution time additionally showed `DEPENDENCIES.md`
untracked, correcting the plan's own "exactly four" count to five — noted here
so the discrepancy is a recorded correction, not a silent miss.

**P0.2 — commit or supersede.** `MANIFEST.md`, `PLAN_1.0.md`, and
`DEPENDENCIES.md` are committed as tracked, governing/reference docs (the
first two already state their own proposal-only / DG-1-pending status
in-body; `DEPENDENCIES.md` is a read-only dependency audit with no
ratification claims). `docs/GEOBASE-BUILD-DIRECTIVE.md` and
`docs/GEOBASE-DIGITAL-TWIN-FEATURES.md` are committed with a `SUPERSEDED /
OUT OF SCOPE FOR PRODUCT-1.0` header each, pointing at tracked
`docs/ARCHITECTURE.md` (heavy-render is "a deferred Phase 2.1 option, not a
v1 requirement") — retained as raw research material for **post-1.0 backlog
only** (`PLAN_1.0.md` Backlog Queue B-1..B-4), not deleted, not ratified.
Also corrects a stray "v1.0 — final" header inside `PLAN_1.0.md` itself
(leftover template text contradicting the document's own DG-1-pending body)
to the accurate "v0.2 — draft."

**P0.6 — DG-1-consistent wording.** Under the default (DG-1 not yet
ratified, but this is the stated default the whole plan operates against),
tracked `docs/ROADMAP.md` 2.1 keeps its existing "optional native
Rust/`wgpu`" wording; a note is added there recording that the deck.gl /
digital-twin direction surveyed in the now-superseded directive remains
backlog authority only, not adopted. No contradiction is introduced between
`ROADMAP.md`, `ARCHITECTURE.md`, and the superseded docs' headers.

**P0.7 — DG-5 disposition.** The `MANIFEST.md` repo reorganization (apps/,
packages/, tools/ split) is **deferred to post-1.0** — the plan default.
No files move in this pass or before the `v1.0.0` tag; `MANIFEST.md` remains
a tracked proposal only. Final disposition (accept/defer/reject) is
reconfirmed at Phase C, C8 pre-tag.

**Choice:** commit all five untracked docs (correcting the count), supersede
(not delete) the two digital-twin docs, defer the reorg. **Strongest
surviving objection:** committing superseded material at all invites future
readers to mistake retained research for live direction; mitigated by the
loud in-file banner on both documents and this entry being the canonical
cross-reference.

## 2026-07-11 — DG-1 draft recorded; ratification pending (`docs/RELEASE-DEFINITION.md`)

**Trigger:** `PLAN_1.0.md` P0.1 — DG-1 ("where is the 1.0 line?") requires a
tracked-commit resolution mechanism, never an untracked note.

**Choice:** `docs/RELEASE-DEFINITION.md` is committed encoding the
sovereignty-core default (Phases 1.2+1.3 as one combined acceptance gate +
release hardening; F1-F4/federation/LiDAR are serial non-gating 1.x
backlog), the source-of-truth hierarchy, and the acceptance-integrity rule
(a gate is accepted exactly once, against the final sovereign mechanism,
never `ProvisionalDevGate`). The file is committed in **DRAFT** status —
this is Claude Code drafting the plan's stated default for Patrick's review,
**not** an owner ratification. DG-1 remains open in `PLAN_1.0.md` until
Patrick either ratifies the draft as-is (flips the file's own status line to
RATIFIED in a Patrick-authored or Patrick-approved commit) or overrides the
default.

**Strongest surviving objection:** a committed "DRAFT" file could be
mistaken for a resolved gate by a future session skimming file existence
rather than content; mitigated by the file's own top-of-document status
banner and by this entry stating explicitly that DG-1 is not yet resolved.

## 2026-07-11 — Phase 0 adversarial-review fixes: ratification semantics, T3 invariant notices, plan reconciliation

**Trigger:** Codex adversarial review of the Phase 0 commits
(`C:\dev\_reviews\geobase\2026-07-11_phase0-close-review.md` — reviewer
gpt-5.6-sol, range `8c418e5~4..8c418e5`). Verdict: work sound, Phase 0 must
not be called closed, four defect classes. All four accepted and applied:

1. **Reframe (blocking):** Phase 0 is **"complete except P0.1 (awaiting
   Patrick)"** — P0.1 per `PLAN_1.0.md` means *ratify*, and the Phase 0 exit
   criterion + M0 require DG-1 resolved. P0.2-P0.7 checkboxes are checked
   with dated execution notes; P0.1 stays unchecked. Every "resolved by
   committing `docs/RELEASE-DEFINITION.md`" formulation (DG-1 row,
   source-of-truth table, P0.1 verify, exit criteria, M0 evidence) now reads
   "resolved only when the owner records **RATIFIED**" — file existence is
   never resolution evidence. This entry's predecessor heading was renamed
   from "draft ratification recorded" to "draft recorded; ratification
   pending" to kill the contradictory phrase.
2. **T3 invariant (blocking):** the retained research docs contained
   invariant-violating text — `GEOBASE-DIGITAL-TWIN-FEATURES.md` C4 framed
   the T3 guarantee as a location boundary permitting loopback *serving* of
   T3, and its F5 defaulted survey data to T2; `GEOBASE-BUILD-DIRECTIVE.md`
   WP4 concretized a loopback COPC range endpoint over default-T3 ingest
   with a T3 render gate. `AGENTS.md` invariant 3 forbids serving/networking
   T3 absolutely — loopback included. Both files now carry an **INVARIANT
   CONFLICT NOTICE** in the top banner plus inline `VOID` markers above the
   exact passages: T3 is never served or networked, loopback included; any
   T3 rendering must be a non-serving in-process path; COPC/range endpoints
   refuse T3 before opening the artifact; survey data defaults T3, T2 only
   by explicit sovereign classification act. Research text retained
   unmodified beneath the markers. A superseded banner alone is not a waiver.
3. **Release-definition fidelity (major):** `docs/RELEASE-DEFINITION.md`
   item 1 restored the three omitted acceptance properties from the PLAN
   default verbatim in force: the shipping cipher is **fail-closed**; **T2
   export requires a recorded agreement**; the **audit trail is complete**.
   Still DRAFT.
4. **Stale-state reconciliation (major):** `PLAN_1.0.md`'s Current
   Position/kickoff text asserted now-false facts its own commits created
   (verify-rstep.mjs "does not exist", HEAD `b7ad69c`, "exactly four"
   untracked docs, README stale) — all reconciled with dated corrections
   preserving the pre-Phase-0 baseline as history. `MANIFEST.md` gained its
   P0.2-required top-level status header (dated point-in-time inventory;
   reorg proposal-only; subordinate to `ROADMAP.md`) and its stale README
   claim was annotated corrected.

**Standing consequence:** M0 has not landed and Phase A may not start until
Patrick records RATIFIED (or an override) in `docs/RELEASE-DEFINITION.md` +
a dated entry here.

## 2026-07-16 — Owner overnight-build directive: execute engineering under the DG-1 default; Codex granted full repo access

**Trigger:** owner session directive (Patrick Freeland, 2026-07-16, direct
instruction to Claude Code): attempt a one-shot overnight build on the
established design; Codex (gpt-5.6-sol via CLI) as a full partner with full
read/write privileges in this repository; adversarial Codex review after each
major milestone; all data sources and codebase in use for this build are
declared **Tier 0** with attribution + provenance required in documentation;
build first, licensing addressed afterwards; run autonomously overnight with
owner review in the morning.

**Interpretation (recorded so scope is a decision, not an inference):**

1. **Sequencing interruption, not ratification.** This directive is a
   deliberate, recorded owner interruption of `PLAN_1.0.md`'s sequencing rule
   that Phase A awaits M0 — engineering execution proceeds tonight under the
   DG-1 *default* (sovereignty-core). It is **not** a DG-1 ratification:
   `docs/RELEASE-DEFINITION.md` remains DRAFT, its ratification record remains
   empty, and P0.1 remains open for Patrick. The plan's own Backlog Queue rule
   contemplates exactly this mechanism ("deliberate, recorded interruption").
2. **Nothing owner-reserved is exercised tonight.** No acceptance flips
   (`ROADMAP.md` 1.2/1.3 stay not-accepted; the acceptance-integrity rule is
   fully honored; the RStep harness runs against `ProvisionalDevGate` and is
   labeled as such); no ceremony-mechanism decision (B2 is prepared as a DRAFT
   proposal only); no classification acts; no pushes to the public remote —
   all commits stay local for morning review.
3. **Scope.** *(Drafted at session start as planned scope; it originally
   over-listed B4/B5/B6/B7 as executed. Corrected here to what ACTUALLY landed,
   per the overnight final review
   `_reviews/geobase/2026-07-16_overnight-final-review.md`.)*
   - **Landed + merged:** Phase A (A1–A7); the **B1 DG-2 cipher spike only**
     (recommendation recorded below — no cipher code); the **DG-3 S1 Whitebox
     spike only** (recorded below — nothing vendored, `geobase-sim` not
     scaffolded); release hardening **C3 partial** (cargo license gate live;
     pnpm informational), **C4 = a trait/seam test only** (not a node-config
     path — `SourceKind` has no local-file variant), **C5 = a procedure doc
     only** (no fetch/diff, no before/after stamp artifact); owner-directed
     **Backlog B-1 partial** (`tools/acquire` staging lane, not the full
     acquire→GeoPack round-trip); and the **B2 ceremony DRAFT proposal**.
   - **NOT done — unimplemented, owner-open:** B3 (sovereign `CeremonyGate`),
     B4 (real at-rest cipher / DG-2 impl), B5 (requester authentication), B6
     (adversarial-egress suite), B7 (runtime network-denial harness).
     `ProvisionalDevGate` remains the only composed gate; no sovereign
     cryptography, authentication, or egress proof exists yet.
4. **Codex data-gate change:** see `AGENTS.md` § Data gate (dated grant).
   Basis: the owner's declaration that all material in use for this build is
   Tier 0. The adversary-profile deny-by-default review rules are unchanged.

**Strongest surviving objection:** executing Phase A before DG-1 ratification
risks wasted work if Patrick overrides DG-1 toward a different 1.0 line;
accepted because the owner directed the build explicitly, everything that
landed (the RStep gate harness, the interim guard, the spikes, the
out-of-product tooling) is on every candidate 1.0 line's critical path, and no
acceptance or ratification act is simulated.

## 2026-07-16 — Phase A A6: RStep is pack-driven (F7.4 honesty check, recorded)

**Trigger:** `PLAN_1.0.md` A6 requires confirming RStep's renewable/NoGo
logic is pack-driven config, not hardcoded, with the inspection recorded.

**Finding (code inspection, `solo/rstep/src/main.ts` + `paint.ts`):** RStep
has **no** hardcoded renewable/NoGo semantics and **no** fixture pack ids in
app source. Layer stacking flows entirely from the node catalog
(`client.packs()` → `stackRenderableLayers()` → `activePackIds`); the export
sends `activePackIds` as source packs. "Renewable capacity" and "NoGo" are
purely which packs the vault serves — the app is agnostic to them. Tier
enforcement is the node's job (features/layers endpoints refuse T2/T3 before
open), not an app-side branch; there is no `tier === "T…"` role logic in the
app. This is the correct F7.4 posture.

**Pin:** `solo/rstep/scripts/check-pack-driven.mjs` (wired into the
`rstep-gate` CI job) fails if a future edit hardcodes a fixture pack id or a
tier-keyed role branch into RStep source, or if `client.packs()` /
`activePackIds` disappear. A full TS unit-test runner was deliberately not
added for one pin (the TS workspaces run none today; adding one to the
sovereignty-audited stack is unwarranted scope) — the empirical proof is in
`verify-rstep.mjs`, which stacks two arbitrary fixture packs by
name-agnostic discovery.

## 2026-07-16 — DG-2 cipher spike (B1) — recommendation recorded; DG-2 stays owner-open

**Trigger:** `PLAN_1.0.md` B1 / DG-2, the scheduled condition-precedent spike
for the T3 at-rest cipher. **This entry records the spike's finding and a
recommended default; it does NOT resolve DG-2.** DG-2's owner is Patrick
(`PLAN_1.0.md` Decision Gates); the choice, the dependency-graph commitment it
implies, and the live implementation (B4) are reserved to him. Executed
overnight per the 2026-07-16 directive, which explicitly does not exercise
owner-reserved gates.

**Scope studied:** the T3 export ledger (`exports_dir/node-audit.gpkg`) is the
only T3 artifact a shipped node writes today. The seam
(`crates/geobase-gpkg/src/cipher.rs`) is authorization-only by design — it
gates *whether* a T3 write may proceed (fail-closed default), and deliberately
carries **no `Encrypted` protection variant** until a real cipher applies
encryption (the doc's own "no false assurance" rule). So B4 is genuinely two
pieces: (i) a crypto primitive, and (ii) extending the seam with an
open/seal capability + rewiring the ledger write path through it. This spike
addresses (i)'s choice and sizes (ii).

**Candidate matrix.**

| Candidate | Dependency posture | Fit | Verdict |
|---|---|---|---|
| **Pure-Rust XChaCha20-Poly1305 file envelope** (RustCrypto `chacha20poly1305` + `argon2` KDF + `zeroize`) over the whole serialized ledger DB | Pure Rust, no C, wheels-free; ~4 well-audited RustCrypto crates | Ledger is small (a few KB of audit rows); decrypt→in-memory SQLite→append→serialize→encrypt→atomic-replace is cheap and correct for this size. AEAD gives authenticated, non-malleable, tamper-evident bytes. | **Recommended default** |
| **`age` X25519 recipient envelope** | Pure Rust but crate pre-1.0/beta; specified streaming format | Good, and a specified format we don't own — but a heavier dependency and a recipient model richer than a single-node ledger needs. | Viable alternative; hold unless a multi-recipient story appears |
| **SQLCipher** (page-level, C) | System/bundled C dependency | Contradicts the tracked pure-Rust product decision (2026-07-06); pulls C into the Tauri bundle we deliberately avoided for GDAL. | Rejected unless an escalation-ladder entry overrides the pure-Rust posture |
| **Encrypted SQLite VFS** (`sqlite-vfs`) | Pure Rust but the crate self-describes as prototype (no WAL, unreviewed `unsafe`, Unix-only tests) | Right *eventual* random-access layer for large T3 GeoPackages, wrong maturity now. | Deferred; revisit for vault-wide T3 (below) |

**Recommended default (pending owner confirmation of DG-2):** pure-Rust
XChaCha20-Poly1305 file envelope for the T3 ledger. Per-artifact random 32-byte
DEK; DEK wrapped by a per-node key/identity; node key derived from a
passphrase via **Argon2id** or supplied as a 32-byte keyfile held outside the
vault; key material in `zeroize`-on-drop buffers; 24-byte random nonce per
seal; versioned envelope header authenticated as AEAD associated data.

**Lost-key policy:** already ratified — **deliberately unrecoverable** (2026-07-07,
Patrick; `cipher.rs` module docs). No escrow, no master key, no recovery
recipient. The spike changes nothing here; it only picks a primitive that
*honors* it (losing the passphrase/keyfile = cryptographically destroyed T3,
by construction).

**Sizing (ii), the honest cost center:** the ledger rewire needs GeoPackage to
open from and serialize back to an in-memory SQLite image (rusqlite 0.40 has
`serialize`/`deserialize`), plus a commit-on-close discipline so every
`append_audit` re-seals. `examples/verify-export-audit.rs` (the trusted read
path built in A4) already isolates ledger reads behind the product crate, so
that rewire does **not** change the RStep gate's command line — the reason A4
built it that way.

**Recorded gap for Patrick's Phase 1.2 (not fixed tonight — Codex-flagged,
verified in code):** the ledger is not the only place T3 can reach disk.
`ingest()` (`crates/geobase-ingestor/src/lib.rs:226,261`) and `package()`
(`crates/geobase-ingestor/src/package.rs:243,247`) write **plaintext staging
GPKGs** for default-T3 / explicit-T3 inputs, bypassing the `AtRestCipher` seam
entirely. Vault-wide T3-at-rest (the large-GeoPackage case the VFS candidate
targets) is the durable Phase 1.2 scope; the fail-closed *ledger* is the
bounded first step. Both belong to the owner's sovereign-core work (Phase B
B4), sequenced after DG-2 is confirmed.

**Strongest surviving objection:** recommending a primitive without committing
the dependency and the code could read as deciding DG-2 by the back door.
Mitigated by leaving the deps unadded and DG-2 explicitly owner-open: this is
decision *support*, the artifact B4 consumes once Patrick confirms — no
`chacha20poly1305`/`argon2` entered `Cargo.toml` tonight.

## 2026-07-16 — DG-3 S1 spike: Whitebox Next Gen license inventory (recommendation; DG-3 owner-open)

**Trigger:** `PLAN_1.0.md` MB2.1 / DG-3, the scheduled "stop-and-choose"
condition-precedent spike before any `geobase-sim` scaffolding. Executed
overnight per the 2026-07-16 directive. **This records the inventory + a
recommendation; it does NOT resolve DG-3 (owner: Patrick) and does NOT vendor
anything or scaffold the crate** — adopting Next Gen commits the product
dependency graph, an owner act.

**Method:** shallow-cloned `github.com/jblindsay/whitebox_next_gen` (into a
scratchpad, NOT the repo — external code stays out of the tree per the data
gate) at HEAD **`a377e25ac6fbe3ef43f598048fa5a32119fb11b5`** (the pin
candidate) and inventoried the `wbtools_oss` open split.

**Findings (verified):**

1. **All ten F1 tools present in the open split** (`crates/wbtools_oss/src`):
   BreachDepressionsLeastCost, FillDepressions, D8Pointer, DInf, FD8,
   Watershed, ExtractStreams, WetnessIndex, ElevationAboveStream,
   DownslopeDistanceToStream. **All four F2 recipe tools present** too
   (LidarGroundPointFilter, TINGridding, IDWInterpolation, LidarTile).
2. **In-memory signatures: yes.** Tools use in-memory `wbraster::Raster`
   objects through a registry/tool model (`registry.register(Box::new(...))`),
   satisfying the vetting §3 rule-3 "accepts in-memory raster" condition — the
   work-file question mostly dissolves for T0/T1.
3. **Open compute path is free of license gating.** `wbtools_oss` depends only
   on other open `wb*` crates (`wbcore`, `wbraster`, `wbgeotiff`, `wbvector`,
   `wbprojection`, `wbtopology`), each `license = "MIT OR Apache-2.0"`. It does
   **not** depend on `wblicense_core` or `wbtools_pro_shim`. The pro shim IS a
   license-tier gate (`ctx.capabilities.has_tool_access(meta.id,
   meta.license_tier)`); `wblicense_core` (no network round-trip, but a
   license-tier concept) is pulled in only by `wbtools_pro_shim`, `wbw_python`,
   and `wbw_r` — never by the open compute path. Vendoring `wbtools_oss` + its
   open deps therefore excludes the pro/license machinery by construction (the
   directive's CI check "no `wbtools_pro_shim` in the vendored tree" is
   naturally satisfiable).
4. **License grant is crate-level only — the one real caveat.** `wbtools_oss`
   is `license = "MIT OR Apache-2.0"`, `publish = false` (vendoring by pinned
   rev required, as the directive anticipated). But there is **no top-level
   LICENSE file** and **0 of 79 `.rs` files in `wbtools_oss` carry an SPDX
   header**. The grant exists at the crate level (each `Cargo.toml`'s `license`
   field — a standard, legally-operative SPDX declaration) but **not** at the
   per-file level. The directive's condition precedent (i) as literally written
   ("every vendored file carries the MIT/Apache grant") is **met at the crate
   level, not the file level**.

**Recommendation (owner-open):** the technical preconditions for adopting
Next Gen are **met** — the ten tools are in the open split, in-memory, gate-free.
The remaining decision is a licensing-posture judgment reserved to Patrick:
whether the crate-level MIT/Apache grant suffices, or the stricter per-file
grant is required. The directive already **pre-approved the legacy-MIT
WhiteboxTools vendor fallback with "no new vetting round if it trips,"** so
either path is unblocked:
- **Adopt Next Gen** → vendor `wbtools_oss` + open deps at rev `a377e25`,
  exclude `wbtools_pro_shim`/`wblicense_core`, record the crate-level grant +
  a per-crate license note in `THIRD_PARTY_NOTICES.md`.
- **Legacy-MIT fallback** → `jblindsay/whitebox-tools` (top-level MIT
  `LICENSE.txt`), if a per-file/explicit grant is wanted.

DG-3 stays **owner-open**; `geobase-sim` is NOT scaffolded (the plan's
stop-and-choose bar — do not scaffold before the choice — is honored).

**Strongest surviving objection:** the crate-level-only grant could later be
challenged by a downstream redistributor wanting per-file provenance;
mitigated because the legacy-MIT fallback with an explicit top-level license
is pre-approved and one decision away, and nothing is vendored until Patrick
chooses.

## 2026-07-16 — DG-1 RATIFIED: the 1.0 line is the sovereignty core (owner act)

**Trigger:** owner ratification act (Patrick Freeland, 2026-07-16 sitting),
resolving `PLAN_1.0.md` P0.1 / Decision Gate DG-1.

**Decision:** `docs/RELEASE-DEFINITION.md` is **accepted as written** — no
override, no amendment. Product-1.0 is the sovereignty core: Phases 1.2 and
1.3 as one combined acceptance gate plus release hardening; F1–F4,
federation, and LiDAR are serial 1.x backlog. The file's status line is
flipped to RATIFIED and its ratification record filled in the same commit;
the DG-1 row in `PLAN_1.0.md` is marked resolved.

**Effect:** `docs/RELEASE-DEFINITION.md` is now the single authoritative
home for the 1.0 line (its own source-of-truth hierarchy governs).
Ratification changes no acceptance status: `ProvisionalDevGate` remains the
only composed gate, and ROADMAP 1.2/1.3 remain not-accepted until B8.

**Strongest surviving objection:** the release-hardening bar (item 3:
signed installer CI matrix) is the heaviest, least-sovereignty-relevant
item for a solo maintainer; the owner considered amending before ratifying
and chose to ratify as written — trimming that bar later would itself be a
recorded DG-1 amendment, not a quiet drift.

## 2026-07-16 — B2 RESOLVED: the sovereign ceremony mechanism is decided; §4 consent evidence RE-RATIFIED richer; design of record tracked (owner acts)

**Trigger:** the owner B2 sitting (Patrick Freeland, 2026-07-16): a
question-by-question walk of the reconciled decision table (the DRAFT
proposal's 15 rows + items surfaced by reconciliation against the
2026-07-08 ratified schema), with an adversarial options review by
Codex/gpt-5.6-sol (`_reviews/geobase/2026-07-16_b2-decision-options-review.md`,
verdict: blocked as a design of record until provenance, withdrawal
precedence, and publication recovery were specified — all three are now
specified below). **The normative carrier of every decision here is
`docs/CEREMONY-DESIGN.md` (RATIFIED, same date); this entry records the
acts and the reasoning residue.**

**Decisions (owner):**

1. **Identity split.** `authorized_by` stays the ratified authenticated
   `ExportIdentity`; the authority-of-record (tribal signatory / witnessed
   consenter) becomes a separate `CeremonyRecord` field populated from the
   agreement store, never request-supplied.
2. **Seam replacement at B3 (breaking, deliberate).** The free-text
   `ExportAuthorization.requester` and `CeremonyRecord.conditions:
   Vec<String>` are REPLACED by typed fields — no deprecated free-text
   shadow paths. `docs/CEREMONY-GATE.md` clause 2's non-breaking wording is
   corrected in the same commit as this entry.
3. **Conditions.** Typed `Conditions` struct; **expiry enforced
   fail-closed in 1.0**; geography/purpose recorded-but-advisory; expiry
   stored as a full UTC instant resolved by the human at recording time;
   invalid/unavailable clock = infrastructure failure.
4. **Consent store.** A separate local T3 GPKG artifact with the export
   ledger's full treatment (reserved name, append-only triggers,
   in-artifact tags, DG-2 envelope).
5. **Source scope.** ID-scoped subset match with export-time tier
   re-resolution; hashes are signing-time evidence, not match criteria;
   accepted residual: same-tier content change does not re-trigger
   ceremony in 1.0.
6. **Evidence bar — §4 RE-RATIFIED richer** (owner diverged from the
   director's store-side recommendation, deliberately): `ConsentBasis`
   itself carries structured evidence (document ref + SHA-256 hash +
   acknowledgment instant; witnesses + verification attestation), making
   evidence-thin authorizations unconstructible; the `export.ceremony` row
   is self-contained.
7. **Record authority.** LocalOperator records; evidence-complete = active
   immediately; revoke/supersede/correct by append (correction is
   supersession); store-sequence ordering, never evidence timestamps.
8. **Matching — explicit lineage head** (adopted after the adversarial
   review REFUTED the drafted newest-wins/no-veto rule with a
   withdrawal-becomes-reauthorization scenario): one active lineage head
   must fully cover the source set; precedence only via recorded
   supersession; revoking a head never falls back to ancestors;
   independent duplicate coverage refuses; no unions in 1.0. Store
   unavailable/corrupt = **503 infrastructure failure**, distinct from the
   ceremony's `Declined`.
9. **Source-set provenance — node-witnessed export sessions** (closes a
   review-confirmed bypass: the request body supplies `source_packs`
   today, so a caller could omit a contributing pack): the node
   accumulates every pack it serves into an unforgeable session; the
   export's source set is the node's record; no session → refuse.
10. **Credentials.** 1.0 is LocalOperator-only: an OS-keychain-protected
    signing credential bound to the OS account at enrollment, **plus an
    OS-peer-identity boundary (Tauri IPC / named pipe)** — plain loopback
    HTTP alone can no longer authorize an export. `TribalDelegate` stays
    schema-present but UNISSUABLE until the owner ratifies a
    Tribal-authority issuer ceremony (operator-issued delegation rejected
    as a sovereignty inversion). The A1 interim token retires at B5.
11. **Constants.** `process = "geobase-recorded-consent-check-v1"`;
    `basis = "active recorded consent evidence matched for T2
    derived-product export"`. B8 asserts BOTH fields independently.
12. **Lifecycle (both T3 artifacts).** Permanent minimal proof-core;
    identifying evidence detail is a separable schema class with owner-set
    retention; compaction is a future explicit sovereign act (nothing
    auto-deletes in 1.0); sealed-artifact-only backup with anti-rollback
    sequence/head checks on restore.
13. **Publication.** The recoverable intent → prepared (one SQLite txn,
    both rows) → atomic namespace publish → finalize protocol; success
    reported only after finalization; documented as recoverable atomic
    publication, never cross-resource ACID. `docs/CEREMONY-GATE.md`'s
    prior "same transaction discipline" claim was inaccurate against
    shipped code (two separate appends after product write) and is
    corrected to honest present tense in this commit.
14. **Record graduation.** `docs/CEREMONY-DESIGN.md` (normative design of
    record) and `docs/THREAT-MODEL-1.2.md` (edited graduation of the
    threat model) are tracked; deliberative handoffs stay gitignored; the
    DRAFT proposal is superseded-marked and retained as history.

**Effect on the plan:** B2 is resolved. B3 gains session provenance,
lineage matching, the consent store, and the publication protocol; B4b
(staging closure) is inserted as condition precedent to B6/B8 (see the
DG-2 entry below); B5 gains the OS-peer-identity boundary and
LocalOperator enrollment; B8 asserts both constants. Acceptance status is
unchanged — nothing here accepts 1.2 or 1.3.

**Strongest surviving objection:** the richer self-contained evidence row
(decision 6) duplicates identifying evidence into the permanent export
ledger, raising the minimization stakes; accepted deliberately, with
decision 12 (retention classes + future compaction covering BOTH
artifacts) as the mitigation the owner chose.

## 2026-07-16 — At-rest cipher constraints RATIFIED (enumerated); DG-2 CONFIRMED: bounded pure-Rust envelope (B4) + staging closure (B4b) (owner acts)

**Trigger:** owner acts at the 2026-07-16 sitting, resolving (a) the
ratification-scope ambiguity in the gitignored threat-model working doc
(its §7 header claimed "ratified §3–§5" while its §8 recorded only §4–§5 —
the enumerated ratification below replaces the section-label shorthand;
the tracked correction lives in `docs/THREAT-MODEL-1.2.md` §4), and (b)
Decision Gate DG-2.

**Ratified constraints (enumerated, mechanism-agnostic):** authenticated
encryption; fail-closed on missing key or corruption; no unwrapped key
material at rest (salt + KDF params only); no escrow, no master key, no
support recovery path — key loss destroys access by design; rotation is an
explicit audited event; a production cipher refuses `UNENCRYPTED-DEV`
artifacts; **multi-operator key wrapping remains explicitly OPEN.**
Tracked home: `docs/THREAT-MODEL-1.2.md` §3.

**DG-2 CONFIRMED (resolves the gate):** the B1 spike's recommendation is
adopted at its honest scope — a pure-Rust XChaCha20-Poly1305 + Argon2id
whole-file envelope for the **two bounded T3 metadata artifacts only**
(export ledger + consent store): passphrase-primary (keyfile as a
documented advanced mode, never stored beside artifacts); per-artifact
locks, serialized writers, synchronous reseal; versioned
AEAD-authenticated header carrying monotonic sequence + previous-envelope
hash (anti-rollback); export linearization per
`docs/CEREMONY-DESIGN.md` §10. The RustCrypto dependencies
(`chacha20poly1305`, `argon2`, `zeroize`) enter `Cargo.toml` at B4 — not
before.

**B4b (named now, designed at activation):** closure of the recorded
plaintext T3 staging paths (`ingest()`/`package()`) is an explicit Phase
1.2 item and a **condition precedent to B6/B8** — deferring it past the
combined acceptance would falsify the ratified "no plaintext T3 at rest"
property. The large-artifact backend is decided at B4b (the
page-level/VFS question may re-open there, bounded to that case).

**Strongest surviving objection:** two storage paths (envelope for small
stores, a different backend for large staging) is more surface than one
uniform design; accepted because a whole-file envelope at vault-GPKG scale
has unacceptable memory/crash profiles, and one uniform page-level backend
would re-import the C-dependency question the pure-Rust posture rejected.

## 2026-07-16 — DG-3 DEFERRED to MB2.1 activation (owner act)

**Trigger:** owner act at the 2026-07-16 sitting on Decision Gate DG-3
(Whitebox Next Gen licensing posture).

**Decision:** DEFER until the `geobase-sim` backlog item (MB2.1)
activates. DG-3 blocks only that scaffolding — nothing on the 1.0 critical
path — so deciding now buys no schedule benefit and risks a stale pin. The
2026-07-16 S1 spike stands as **evidence, not a decision**. At activation:
choose a fresh pinned revision, re-run the license/file inventory against
it, then either adopt Next Gen (crate-level MIT/Apache grant) or take the
pre-approved legacy-MIT fallback, which remains one decision away with no
new vetting round.

## 2026-07-16 — B3 merged; raw-SQL residual re-scoped; B4 fence + storage-key custody ratified (owner acts)

**Trigger:** owner acts at the 2026-07-16 (night) sitting, closing the B3
adversarial cycle (three Codex reviews + two addenda; final verdict PASS)
and settling the B4 questions its findings and the sovereignty-stack
integration assessment (`C:\dev\_reviews\geobase\
2026-07-16_sovereignty-stack-integration-assessment.md`) raised.

**Residual re-scoped and RATIFIED:** the accepted-until-B4 raw-SQL
forgery residual covers **both consent kinds**, not signed-kind only —
the §9 witnessed-verbal commitment is an unkeyed integrity digest
(binds detail to hash; supports compaction verification), **not writer
authentication**; a raw-SQL writer who computes the public digest over
fabricated detail authorizes. Documented in `consent_store.rs` module
docs and pinned by the test
`honest_residual_a_correctly_hashed_witnessed_forgery_authorizes_until_b4`,
which B4 must flip when the sealed store lands.

**B4 fence:** B4 seals **both** bounded T3 metadata stores (consent
store + export ledger) under the one DG-2 envelope design. Source-file
locking (strict total ordering of source-pack mutations vs ledger seal,
noted in review round 3) is **B5 scope**, where authenticated serves
give operator↔work-unit binding meaning.

**Storage-key custody:** multi-slot **named custody** — the envelope DEK
is wrapped independently under each enrolled custodian's Argon2id
passphrase (LUKS-style key slots; two slots at node establishment:
LocalOperator + a council-designated steward). Any one custodian unlocks
alone (routine operation stays a one-person act); **enrollment and
revocation of slots are audited ceremonies requiring an existing
custodian**. This is not escrow: every slot is a named, ceremony-enrolled
person; no third party, master key, or vendor path exists; losing all
slots remains deliberately unrecoverable, with a documented, rehearsed
re-establishment drill (new store, re-record from originals, sealed
artifacts retained) as a B4 deliverable. Threshold/quorum unlock is
REJECTED for B4-era single-node operation (defends a key-holding-human
threat B4's proof boundary explicitly does not claim, at daily
operational cost); it remains open for the governance-server era.

**Role separation (law):** storage keys (B4), authentication credentials
(B5 — OS-keychain baseline, optional FIDO2), and evidence-signing keys
(post-B5) are distinct roles; authentication credentials never decrypt
stores, and credential recovery never becomes T3-key recovery.

**Migration:** production openers refuse `UNENCRYPTED-DEV` artifacts
permanently; no silent conversion. Dev data is re-recorded.

**Assessment verdicts adopted as posture:** Keycloak, gate-level OPA,
node keyless Sigstore/transparency services, and TEEs are REJECTED;
detached-signature and signed-manifest concepts, X25519 recipients (for
any future ratified T2 exchange), and optional FIDO2 at B5 are ADAPT
candidates. Remaining owner items from the assessment (#8–14:
attestation posture, TribalDelegate issuance, signing profiles, release
signing, federation trust, T2 exchange) queue for the B4/B5 design
sitting.

## 2026-07-16 — B3 post-merge review: F4/F5 owner receipts (owner acts)

**Trigger:** a multi-agent /code-review of the merged B3 diff
(`c0f2f3d..9f38281`) surfaced two Tier-2 decisions — consequences of the
ratified §5.1 export order — and a Codex-sol remediation swarm
(propose → deliberate → converge;
`C:\dev\_reviews\geobase\2026-07-16_b3-postmerge-remediation-pathway.md`)
framed each with options + a recommended default.

**F4 — pre-authentication 403 disclosure — RECEIPT: Option B.** The export
route's three distinguishable pre-auth 403 reasons (invalid-session /
T3-floor / bad-token) let a tokenless loopback caller holding a session id
learn session liveness and whether the witnessed source set is T3 vs
exportable. Resolution: **one uniform public refusal** (and uniform
audit-failure 503 text) across all three pre-auth branches; the detailed,
content-free node-derived cause still lands in the protected local ledger.
The authenticated consume-race branch stays diagnostic. Unanimous swarm
consensus; smallest boundary fix preserving the ratified order. SDK
lifecycle logic must never parse refusal reason strings. (The remaining
serve-route session-liveness oracle is B5 scope, not closed here.)

**F5 — malformed tokenless body schema echo — RECEIPT: Option B.** A
malformed export body returned a 400 echoing the full request schema
(serde "unknown field, expected one of …") and wrote no audit row.
Resolution: **fixed schema-free `"invalid export request"` 400, no row**;
`deny_unknown_fields` retained. A serde parse failure is structural and
precedes §5.1 session resolution/floor/auth, so it stays outside the
governance-refusal audit taxonomy. Recorded dissent (sovereignty lens +
original proposal preferred a generic `export.refused` row on the
release-level "complete audit trail" basis); rejected for now because it
would create synchronous T3 writes for arbitrary malformed loopback bytes,
overload a governance action with a transport parse failure, flip 400→503
under audit outage, and needs its own ratified action/retention semantics.
If durable malformed-transport auditing is wanted, design it after the B5
OS-peer boundary rather than overloading `export.refused` now.

## 2026-07-16 — B4.1 owner receipts + contract freeze (owner acts)

**Trigger:** the B4.1 sitting held immediately after PR #5 (B3 post-merge
remediation) merged to main at `d30c46b` (all five workflows green). Agenda
and options came from the adversarially agreed B4 roadmap
(`C:\dev\_reviews\geobase\2026-07-16_b4-roadmap-agreed.md`, verdict
GO-WITH-CHANGES from a three-lane Codex-sol swarm). Per that synthesis, B4
implementation does not start until these receipts exist and the normative
documents are reconciled. All six areas were put to the owner with framed
options + recommendation; nothing below was decided by engineering.

**Q1 — Revocation semantics — RECEIPT: rotate-on-revoke.** `slot.revoked`
generates a fresh DEK for **each** artifact, re-encrypts both store bodies,
omits the revoked slot, and re-wraps each fresh DEK for **every retained
custodian — all must be present** (no master KEK exists; GeoBase may not
reconstruct another person's passphrase). If rotation cannot complete, the
node records a differently named access warning and stays fail-closed; it
never claims cryptographic revocation. Stated unavoidable residual: a
former custodian can still read old envelope **copies** retained from
before revocation; historical possession cannot be cryptographically
recalled.

**Q2 — Boot/unlock supply — RECEIPT: attended pre-bind ceremony.** One
custodian supplies a storage-only secret once — trusted desktop prompt for
desktop operation, controlling-TTY prompt with echo disabled for attended
headless. Both stores unlock, publication recovery completes, and only then
may an export-enabled node bind. Environment-variable and argv secrets are
unacceptable production defaults; automatic OS-keychain unlock is rejected
(it would silently make the OS/device a storage custodian and blur the
ratified lost-key model). **Production unattended export startup is
unsupported at B4** — cancel, bad secret, corrupt/unknown envelope, roster
mismatch, missing required store, lost anchor, or recovery failure leaves
the node unbound (viewer-only behavior stays explicitly bounded). CI uses
an injected test-only ephemeral provider. The ratified advanced keyfile
mode remains explicit, removable, never colocated or auto-discovered, and
requires an owner-approved custody procedure.

**Q4 — Anti-rollback — RECEIPT: independent TipAnchor ADOPTED.** The
in-envelope `sequence + previous-envelope hash` is chain **continuity
only**; it cannot detect wholesale replacement with an older valid envelope
(consent-resurrection replay). B4 therefore carries an independent
`TipAnchor` keyed by stable random `artifact_id`, holding at least
`(artifact_id, sequence, envelope_hash)`, with a pending/committed crash
protocol under the artifact lock. Contradictory, missing, forked, or older
anchor state fails closed for ceremony. The anchor is an **integrity role
only** — never a DEK/KEK, B5 credential, or recovery key. **Backing
(Q4b): OS-protected integrity state is the default backend** (a protection
boundary distinct from the vault files; defends the Class-B vault-file
writer; OS admin remains Class C), behind a pluggable `TipAnchor` seam
**configurable for TPM NV and separately-custodied WORM checkpoint
backends for highly secure T3 deployments**. Scope note recorded at the
sitting: the seam + config surface are B4 deliverables, but only the
OS-protected backend is a B4.6 exit requirement; the TPM NV and WORM
backends are ratified configuration extensions implemented as their own
later work items.

**Q5 — Roster topology — RECEIPT: one logical roster.** One named-custodian
membership set and one roster epoch across BOTH stores; one attended
passphrase entry unlocks both. Cryptographic material stays fully
independent per artifact (own DEK, salt/KEK, wrap nonce, wrapped-DEK bytes,
body nonce, artifact id, sequence). Enrollment, revocation, rotation, and
roster repair are recoverable **two-artifact ceremonies** with one
operation id, strict lock order, prepared/committed states, idempotent
startup reconciliation, and no plaintext coordinator or hidden third
authority.

**Q6 — Argon2id policy — RECEIPT: lane proposal ratified.** Engineering-
mandatory bounds (not owner choices): Argon2id v1.3, 32-byte KEK, ≥16-byte
random salt, per-slot stored parameters accepted only inside a versioned
pre-authentication policy envelope so attacker-controlled headers cannot
drive unbounded memory/work. Owner-ratified profile: **floor 64 MiB /
t=3 / p=1; enrollment calibrates upward toward ~0.5–1 s on the slowest
supported office machine; hard caps 256 MiB / t≤10 / p≤4; maximum 8
slots.** Slot-selection UX: **operator-selected opaque slot id** (the
prompt lists enrolled opaque ids; the id is not a secret and may be written
on the custody card; exactly one KDF run per attempt; no human identities
in the clear header; unbounded try-all rejected). Passphrase profile:
**tool-generated 6-word diceware** (EFF large wordlist, ~77 bits;
regenerate-until-memorable, never hand-picked; canonical encoding =
lowercase words, single spaces, Unicode NFC, UTF-8 bytes). KDF/passphrase
upgrade ceremony: at an attended unlock, a slot below the ratified floor
(or on custodian request) is re-derived and re-wrapped **for that slot
only** (body DEK untouched, no other custodian required), audited as
`slot.upgraded`.

**Honest-residual wording (normative, not a new choice):** the B4 exit
receipt and threat model use the synthesis §5 residual statement verbatim
(TipAnchor branch, per Q4). The software claim is "no application-created
plaintext database, WAL, journal, temp, or backup artifact for these two
stores" — never "plaintext cannot reach OS-managed swap or crash dumps";
best-effort zeroization narrows Class-C exposure but does not convert it
into a B4 claim.

**Doc reconciliation (same sitting, director-drafted, owner-ratified):**
`docs/THREAT-MODEL-1.2.md` §3.7's "multi-operator key wrapping remains
OPEN" resolved to the ratified multi-slot named custody + these receipts;
`docs/CEREMONY-DESIGN.md` §9/§10 anti-rollback wording corrected (internal
chain = continuity; anti-rollback = TipAnchor); `PLAN_1.0.md` B4 item
rewritten to the agreed B4.1–B4.6 sequence with the whole-file seam
explicitly NOT promised for large artifacts. The
`honest_residual_a_correctly_hashed_witnessed_forgery_authorizes_until_b4`
test flips **only at B4.6**. No acceptance status changed; B8 remains the
sole acceptance act.

**Strongest surviving objection:** rotate-on-revoke's full-roster presence
requirement means an emergency revocation can leave the node fail-closed
until every retained custodian attends — accepted deliberately: the
alternative makes `revoked` a false claim in exactly the
distrusted-custodian case, and the fail-closed warning state is the honest
representation of an incomplete ceremony.

**Remediation:** branch `fix/b3-postmerge-remediation` lands F1, F2,
F4(B), F5(B), F6, F7, F8, T-A, and a T-B regression pin. **F3 downgraded**
to a diagnostic-only startup message — mandatory pre-bind publication
recovery (CEREMONY-DESIGN §6) is an invariant; catch-and-continue would
serve with unresolved publication truth, so the real fix (encrypted
open/unlock/recovery + `UNENCRYPTED-DEV` re-record) defers to B4. **T-B
refuted** — the current global multiplicity-before-product-class order
implements the ratified §5.2 independent-duplicate-coverage rule; it gets a
regression pin, not a change.

## 2026-07-21 — Data-sharing-agreements corpus subproject (DS lane; owner decisions + DS-0 infrastructure)

**Subproject created (owner-directed):** `docs/data-sharing-agreements/` — a
governed corpus of Tribes' publicly published data-governance instruments
(DSAs, sovereignty plans, IP legislation, IRB/research policies) producing
the RSTEP Tribal Data Sovereignty Guidelines, a GeoBase/TSDF adherence map,
and a quick-reference wiki. Plan of record: its `PLAN.md` (phases DS-0…DS-6).

**Governance basis (owner-ratified):** collection runs out-of-band from the
GeoBase runtime TSDF gates under `COLLECTION-CHARTER.md` — a document-research
regime (public-documents-only, terms-before-bytes, default-refuse,
staging-as-a-state with human clearance for Nation-authored documents,
append-only event-sourced provenance, versioned refetch, transitive
takedown). It deliberately does NOT claim TSDF runtime equivalence; nothing
enters the data spine.

**Owner decisions (Patrick Freeland, 2026-07-21):**
- **Ratification path:** DS-5 guidelines stay DRAFT until RSTEP Tribal
  Advisory Board review → direct outreach to every Nation attributed in the
  draft → Tribal IRB review where one exists → full ratification
  (`guidelines/RATIFICATION-LEDGER.md`).
- **Takedown channel:** reuben@atnitribes.org (ATNI Energy Program Manager,
  RSTEP lead); takedown/reject/archive-auth events require human actors
  (tool-enforced).
- **Coverage denominator:** the 43-Nation NWTEC WA/OR/ID list
  (`sources/nations.json`, `2026-07-21-nwtec-43`); ATNI-roster expansion
  deferred to DS-6 (receipt in `sources/atni-roster-status.json`).

**Adversarial review record:** three Codex-sol rounds in
`../_reviews/geobase/` (2026-07-21 `dsa-corpus-plan.md`, `-rereview.md`,
`-rereview2.md`; NO-GO → NO-GO → remediated) plus stop-gate escalations; all
named blockers closed in `tools/merge_validate.py` (schema+integrity gate,
fail-closed transitive takedown transaction) and proven by
`tools/lifecycle_selftest.py` (23 checks incl. negative cases). Pre-DS-5
carry-over: a `ds5` citation/ledger gate mode (recorded in PLAN.md).

No acceptance status changed; B8 remains the sole acceptance act; main-line
resume stays TASK-B4.2-SPEC.

## 2026-07-21 — DSA corpus: DS-1 gate closed; direct-site access authorized (owner decision)

**DS-1 executed and certified same day** (commit `6cab07d`): six search-only
lanes, 107 register rows, 43/43-Nation coverage matrix, duplicates resolved
via director register-status events, full gate audit PASS
(`docs/data-sharing-agreements/reviews/gate-audits/ds1-gate-2026-07-21.md`).

**Owner decision (Patrick Freeland, 2026-07-21):** DS-1 gate closed; DS-2
authorized, including **direct search/probe of Tribal websites and publicly
accessible databases** for published policies and legislation, under
program authority recorded privately (owner authorization record,
2026-07-21; kept outside the public tree by owner decision). Owner intent:
Tribal staff capacity is limited, so ATNI will still request
additional/updated documents from Tribes directly, but must first "do our
homework" and locate everything already searchable on the open web. The
recorded authority is ATNI-internal program authority to conduct
public-document research — it is not, and does not claim to be, authority
granted by any Tribal Nation over its data or instruments.

**Scope note (director):** this authorization changes nothing in
COLLECTION-CHARTER.md, which already provides for direct probes/fetches —
it closes the DS-1 gate and directs the work. Charter limits remain
binding: public-only, terms-before-bytes, robots, honest UA, 5s/host,
default-refuse on publication ambiguity, human clearance for Nation-authored
documents, takedown channel unchanged. DS-2 proceeds in two waves:
(A) verification probes + deepened direct-site discovery for the
searched-not-found Nations; (B) document fetches of director-approved rows.

**Owner decisions (Patrick Freeland, 2026-07-21, same session — addendum):**

1. **Registered data actor:** `human/patrick-freeland` = Patrick Freeland,
   ATNI Climate (contact in the private owner authorization record) —
   usable in the provenance chain for owner acts (clearances, review
   upgrades, takedown/archive authorization, corrections). Recorded in
   COLLECTION-CHARTER.md §5.
2. **Preliminary analysis authorized:** fetched documents may receive
   preliminary machine analysis (parse for cataloging, summarization) under
   a standing owner clearance, instead of per-document ad-hoc review:
   - the automated sensitivity screen (charter §4) remains mandatory and
     runs first — CLEAN screens proceed; anything flagged (personal data,
     signatures/contacts, site locations, restricted-TK references,
     publication ambiguity) still stops for individual human review;
   - clear events for Nation-authored documents are recorded with actor
     `human/patrick-freeland` citing this standing decision (the validator's
     human-actor requirement is unchanged and satisfied honestly — the
     standing decision IS the owner's clearance act, granted prospectively
     for clean-screen documents);
   - the DS-3/DS-5 bar is UNCHANGED: Nation-attributed claims must still
     reach effective `human-reviewed` state before guideline use, and all
     outputs stay DRAFT until the external ratification path completes.
     Preliminary analysis widens the funnel, not the mouth of the bottle.

## 2026-07-21 — DSA grilling sitting (owner decisions Q1–Q8, all enacted)

Owner grilled the day's decisions one-by-one (AskUserQuestion receipts):

- **Q1 Standing-clearance attribution:** batch ratification REQUIRED each
  round before DS-3 consumes a clearance batch; future standing clears use
  the distinct actor `human/patrick-freeland/standing-delegation`; the
  2026-07-21 batch of ten Nation-authored clears was re-attributed by
  correction events and RATIFIED by the owner in the sitting.
- **Q2 Klamath Special Use Permit:** cleared WITH handling rules — Exhibit
  A site locations, signatures, and contact details are never excerpted,
  reproduced, or described in catalog/summary/wiki/guideline content;
  treated as restricted content per charter §7.
- **Q3 Grand Ronde FOI ordinance + Colville/Spokane archive pages:** cleared
  with the institution-not-person rule (no individual names/emails/signature
  imagery downstream).
- **Q4 Third-party legal publishers:** fetch ONLY where the Nation's own
  channel designates the publisher as its publication venue AND the owner
  approves that host after terms resolve; aggregator presence is never
  authorization (charter §3 amended).
- **Q5 Round-2 fetches:** all nine approved (five Colville instruments,
  Quileute Articles I–XII, Nez Perce Titles 3 and 6, Yakama Water Code).
- **Q6 Authorization details:** kept out of the public tree for now
  (private owner record; provenance notes redacted via the sanctioned
  transaction; git-history purge left as an explicit open maintainer act).
- **Q7 Searched-not-found depth:** a structured deep sweep (official-site
  section walk, fixed term list, state/federal agreement databases,
  university IRB listings — all event-logged) is a MANDATORY pre-outreach
  gate per Nation (PLAN pre-DS-5 tasks).
- **Q8 Sequencing:** enact → round-2 acquisition/screen/clear → DS-3
  preliminary cataloging.

**Owner directive (same day, trueup):** priority is per-Tribe information
display ASAP plus full download/gathering/analysis of remaining sources —
and LESS process ("this was supposed to be a one-shot"): bias to direct
delivery using the existing tools; no new machinery unless a gate demands
it. First per-Tribe pages shipped (`docs/data-sharing-agreements/wiki/
nations/`, generated by `tools/nation_pages.py`).

## 2026-07-21 — Round-3 ratification + flagged-item rulings (owner decisions)

**Owner decisions (Patrick Freeland, 2026-07-21, in-session):**

1. **Round-3 standing-delegation batch RATIFIED** (grilling Q1 convention):
   the eight Nation-authored clears ev-director-0142/0143/0152/0153/0154/
   0167/0168/0171 (CTUIR constitution + codes page, Warm Springs
   constitution + code page, Shoshone-Paiute constitution page,
   Shoshone-Bannock constitution page + privacy policy, Snoqualmie codes
   page). Recorded as ev-director-0180; catalog lanes may consume them.
2. **All eight round-3 restricted documents CLEARED "flags only"**
   (ev-director-0181..0188), i.e. flag-scoped handling rules per the Q2/Q3
   precedent: flagged content (signature imagery, individual names,
   personal emails, direct lines) is never excerpted, reproduced, or
   described in any output; institution-not-person applies; policy content
   is otherwise clear for analysis. Applies to: bl-038 (BIA Tribal Data
   Priorities), d2bl-001 (NWTEC handbook), inst-003 (NIH THRO), inst-004
   (BJA), inst-011 (NNI brief page), inst-013 (BIA 78 IAM 2), wac-008
   (Swinomish archive page), wai-005 (Kalispel LIHEAP agreement).
3. **Optional acquisitions DECLINED**: no git-clone of the atniclimate
   TSDF repositories; no approval of further `src-r3c-*` candidates (JHU
   template, Sho-Pai constitution PDF). Directive: finish the job with
   what is held — catalog the remaining cleared documents, then DS-4
   summaries and theme wiki.

## 2026-07-21 — DS-5 proceeds on machine-extracted claims (owner decision)

**Owner decision (Patrick Freeland, 2026-07-21, in-session):** "just ingest
and analyze what we have." DS-5 synthesis proceeds now on the
machine-extracted catalog (64 records / 359 claims) without prior
per-record review upgrades; the pre-DS-5 process items (ds5 citation gate
mode, SNF deep sweep) are deferred, not required for the draft. All DS-5
outputs remain DRAFT with the standing banners; nothing is presented as
confirmed by any Nation; the external ratification path (Advisory Board →
Nation outreach → Tribal IRB) is unchanged and still gates any non-draft
use. Review upgrades remain available later and would strengthen specific
citations.
