# GeoBase — Plan to 1.0

**v0.2 — draft; DG-1 (the 1.0 line) pending owner ratification.** *(Corrected
2026-07-11, Phase 0 congruence pass: this document previously carried a stray
"v1.0 — final (Phase 4 expansion complete)" header inconsistent with an
unrelated template, which flatly contradicted this document's own body — DG-1
unresolved, Phase 0 not started, every manifest still `0.1.0`. Corrected in
place; see `docs/DECISIONS.md` 2026-07-11.)*

> A note on the word "1.0." GeoBase's own roadmap uses `1.0` as an *internal
> phase label* — "Phase 1.0 — Desktop Engine core," which is **already
> complete** (`docs/ROADMAP.md`). This document uses **product-1.0** to mean the
> shippable, release-hardened version a Tribe could deploy and the author would
> tag `v1.0.0`. Every workspace manifest still reads `0.1.0` (`Cargo.toml`,
> `package.json`, `engine-light/package.json`, `solo/sdk/package.json`,
> `solo/rstep/package.json` — all five verified 2026-07-11), so no `1.0` claim
> exists anywhere in tracked code — the line must be *ratified*, not inferred.
> That ratification is Decision Gate DG-1 below.

## 1.0 Definition

**Product-1.0 is the sovereignty core, accepted once against the real
sovereign mechanism, packaged and defensible.** This is the v0.2 default,
pending owner ratification at DG-1. It replaces v0.1's inferred
"roadmap-through-2.2 plus digital-twin scope" definition, which adversarial
review found unsupported: the deck.gl/digital-twin expansion exists only in
**untracked** docs (`docs/GEOBASE-BUILD-DIRECTIVE.md`,
`docs/GEOBASE-DIGITAL-TWIN-FEATURES.md` — both confirmed untracked by
`git status`, 2026-07-11) and directly contradicts tracked
`docs/ARCHITECTURE.md`, which calls heavy-LiDAR rendering "a **deferred Phase
2.1 option**, not a v1 requirement." Tracked `docs/ROADMAP.md` 2.1 still reads
"optional native Rust/`wgpu`," reinforcing the contradiction the untracked
directive would introduce.

Concretely, for the author to tag `v1.0.0`, GeoBase must:

1. **Enforce TSDF end-to-end for real.** The sovereign FPIC ceremony replaces
   `ProvisionalDevGate` at the single composition point in
   `crates/geobase-engine-desktop/src/server.rs` `router()` (verified: the gate
   is constructed there as `Arc::new(geobase_gpkg::ceremony::ProvisionalDevGate)`,
   line 137, and nowhere else), at-rest encryption of T3 is live and fail-closed
   behind the shipped `AtRestCipher` seam (`crates/geobase-gpkg/src/cipher.rs`;
   default `FailClosedCipher`), the requester is authenticated, and the
   **architectural T3 egress guarantee** is proven by an adversarial egress test
   suite — T3 provably non-exportable and non-networkable, T2 export requiring a
   recorded agreement, audit trail complete (roadmap Phase 1.2; `AGENTS.md` §3;
   `governance-config.yaml`).
2. **Ship the paint-and-export product flow accepted-complete — once, against
   the sovereign gate.** RStep paints an opportunity polygon and exports a T2
   shapefile containing *only* the product (fields exactly
   `PRODUCT_FIELDS = ["id", "area_m2", "score"]` — verified in
   `crates/geobase-engine-desktop/src/export.rs` line 85), with the end-to-end
   RStep observed-behavior gate (1.3d) green in CI **asserting the sovereign
   ceremony record**, never the provisional basis (roadmap Phase 1.3;
   `docs/PROCESS-MAP.md` §7–8). Acceptance happens exactly once; the gate is
   never marked complete against `ProvisionalDevGate`.
3. **Be release-ready.** Signed desktop installers from a real packaging CI
   matrix (new infrastructure — none exists today; all four workflows run
   `ubuntu-latest`), license/attribution audit with `THIRD_PARTY_NOTICES.md`
   (absent today), `LocalServerSource` governance portability demonstrated, a
   TSDF version-bump adoption flow demonstrated, the local adversarial-egress bar
   met with the IRB review track documented (DG-6), and all status docs
   congruent with the code.

**Non-gating 1.x backlog (default, pending DG-1):** public-data acquisition
(F4, `tools/acquire/`), the simulation engine (F1, `geobase-sim`), federation
(roadmap 2.0, FIDP), and the secure LiDAR twin (F2+F3, roadmap 2.1). These are
real committed direction — their grounded work breakdowns are preserved in the
Backlog Queue below — but they do not gate the `v1.0.0` tag, and a solo
maintainer works them **serially**, one active workstream at a time, after the
sovereignty core ships.

**Explicitly out of scope entirely** (unchanged from v0.1): the QField
field-survey round-trip (F5 "GroundTruth" SoLO app, post-2.0), the local AI
query layer (F6, parking lot), COPC *write* (a scoped follow-on with its own
oracle), and a CesiumJS heavy-3D path (Option A — documented escalation only).

## Current Position

> **Reconciliation note (2026-07-16 overnight build).** An owner-directed
> overnight build landed several items this section and the Phase A/C task
> lists below were written *before*. Reconciled here per this plan's own update
> rule (§ "When to update this plan"), **without** changing acceptance status:
> DG-1 stays open, `docs/RELEASE-DEFINITION.md` stays DRAFT *(true when this
> note was written; superseded later the same day — see the owner-sitting
> note below)*, and Phases 1.2/1.3
> stay **not** accepted-complete. What changed:
> - **Phase A (A1–A7) is BUILT and merged to local `main`** (not pushed) — the
>   interim export-token guard *and* the real RStep 1.3d harness
>   (`solo/rstep/scripts/verify-rstep.mjs` + `verify_rstep_oracle.py` +
>   `examples/verify-export-audit.rs`), with the `rstep-gate` CI job
>   (informational, provisional-labeled). This runs against `ProvisionalDevGate`
>   and is **explicitly not** Phase 1.3 acceptance (that is B8/M5). So the
>   "Missing entirely: the RStep 1.3d gate" and "No RStep job exists" statements
>   below, and the unchecked A1–A7 boxes in Phase A, are **superseded** —
>   corrected inline where they appear.
> - **B1 (DG-2 cipher) and DG-3 (S1 Whitebox) spikes recorded** in
>   `docs/DECISIONS.md`; **B2 ceremony DRAFT proposal** at
>   `docs/CEREMONY-DESIGN-PROPOSAL.md`. B3–B7 remain unimplemented/owner-open.
> - **Release hardening partial:** `THIRD_PARTY_NOTICES.md` exists (so "absent
>   today" below is superseded); C3 cargo license gate live (pnpm informational
>   — C3 partial); C4 is a trait/seam test only; C5 a procedure doc only.
> - **Backlog B-1 partial:** the `tools/acquire` staging lane exists (not the
>   full acquire→GeoPack round-trip; MB1 not complete).
> The milestone table (M1–M8) is unchanged in intent; no milestone is marked
> reached, because acceptance is reserved and DG-1 is open.

> **Reconciliation note (2026-07-16 owner sitting — later the same day).**
> The owner sat on every open decision gate and the B2 decision table
> (`docs/DECISIONS.md` 2026-07-16, four dated owner entries):
> - **DG-1 is RATIFIED** — `docs/RELEASE-DEFINITION.md` accepted as written,
>   status flipped; the sovereignty-core 1.0 line now governs. P0.1 is
>   closed; Phase 0 is complete; **M0 has landed.**
> - **B2 is RESOLVED** — the sovereign ceremony mechanism is designed and
>   ratified: `docs/CEREMONY-DESIGN.md` (design of record; the DRAFT
>   proposal is superseded-marked). B3 gains the consent store, session
>   provenance, lineage matching, and the recoverable publication protocol;
>   B5 gains the OS-peer-identity boundary (LocalOperator-only in 1.0).
> - **DG-2 is CONFIRMED** — bounded pure-Rust envelope for the two T3
>   metadata stores (B4), plus **B4b** (plaintext staging closure) inserted
>   as condition precedent to B6/B8. Enumerated cipher constraints ratified
>   (`docs/THREAT-MODEL-1.2.md` §3, now tracked).
> - **DG-3 is DEFERRED** to MB2.1 activation, by recorded decision.
> Acceptance status is UNCHANGED: `ProvisionalDevGate` is still the only
> composed gate; ROADMAP 1.2/1.3 stay not-accepted until B8.

Per tracked `docs/ROADMAP.md`, five phases are accepted-complete with observed
gates and committed evidence: scaffold/spine (0.1), local-source 3D terrain
proof (0.2), the GeoPack ingestor MVP (0.3), the grounded Rust/Tauri desktop
node serving the T0 baseline (1.0), and stackable layer packages (1.1). Each
carries a human-endorsed capture under `docs/verification/` and an ongoing gate.

**What verification actually exists today** (corrected from v0.1, which
overstated it):

- **Blocking CI** (`.github/workflows/ci.yml`, push/PR to main, `ubuntu-latest`):
  Rust `fmt --all --check`, `clippy --workspace --all-targets -- -D warnings`,
  `build --workspace --locked`, `test --workspace --locked`
  (**122 `#[test]` + 19 `#[tokio::test]` functions** across the five crates,
  counted 2026-07-11); TypeScript `pnpm -r build` (type-check + bundle only —
  **no TS unit-test runner exists**; `ci.yml` runs no `pnpm test`).
- **GeoPack oracle gate** (`.github/workflows/geopack-gate.yml`): the Phase 0.3
  round-trip against the GDAL/pyogrio cross-implementation oracle, both
  directions (T0 served, unclassified→T3 refused). Python/GDAL is a CI oracle
  only, never a product dependency (`docs/DECISIONS.md`, 2026-07-06 "pure Rust,
  narrow writer, GDAL as CI oracle only").
- **INFORMATIONAL render gates** (`.github/workflows/render-gate.yml`, jobs
  `render-gate`, `node-render-gate`, `layer-gate` — all three confirmed present):
  the workflow header explicitly states these are informational **until it
  records 5 consecutive green runs on main** (verified, line 7), after which
  they fold into `ci.yml` as blocking. The authoritative gate remains the local
  harness run plus the human-endorsed captures in `docs/verification/`. v0.1's
  claim that these "enforce continuously" was overstated; they *run*
  continuously.
- **~~Missing entirely: the RStep 1.3d gate~~ — SUPERSEDED 2026-07-16 (see the
  reconciliation note above): the real harness is now built and merged
  (`solo/rstep/scripts/verify-rstep.mjs`), the `rstep-gate` job exists in
  `.github/workflows/render-gate.yml` (informational, provisional-labeled), and
  `docs/PROCESS-MAP.md` §8 reflects "harness built — acceptance deferred to
  M5/B8". Green there is engineering evidence, NOT Phase 1.3 acceptance.** The
  pre-overnight text is preserved for history: *the previously dangling
  `verify:rstep` reference was a committed honest stub (Phase 0 P0.4); building
  the real harness was real engineering (fixtures, browser automation, ledger
  inspection, pyogrio verification, CI wiring), not "wiring" — which is exactly
  what the overnight Phase A did.*
- **Also missing:** pre-commit hooks, Windows/macOS CI of any kind,
  installer/signing/packaging jobs, release automation, SBOM/license gating,
  and any runtime network-denial harness. All CI runs on `ubuntu-latest`.

**Phase 1.3 (SoLO SDK + RStep)** is materially built — `solo/sdk/src/index.ts`
and `crates/geobase-engine-desktop/src/export.rs` are FROZEN CONTRACT, the
paint/export/verify chain is implemented, and the export verifier reopens its
own output (`export.rs`: exact feature count, exact `PRODUCT_FIELDS` whitelist,
output == painted, no output geometry equals any source geometry) — but it is
**not accepted-complete** and must not be accepted against the provisional gate
(see Phase A/B sequencing).

**Phase 1.2 (TSDF enforcement + ceremony)** has its seams shipped:
`ceremony.rs` provides only `ProvisionalDevGate` (T3 refused unconditionally via
`ExportRefused::TierNeverExports`; T0–T2 authorized for **any unverified
requester** with `PROVISIONAL_BASIS` verbatim), and `cipher.rs` provides a
fail-closed `AtRestCipher` seam (default `FailClosedCipher` refuses T3 at rest;
a `DevPlaintextCipher` exists only behind `GEOBASE_DEV_UNENCRYPTED`). The
sovereign ceremony process, real at-rest crypto, and requester authentication
remain a handoff to the author (`docs/CEREMONY-GATE.md`, "Phase 1.2 handoff (for
Patrick)").

**The dev hole, precisely** (verified in code): on an export-enabled node —
`exports_dir` set (`GEOBASE_EXPORTS`) and a ledger cipher configured or
`GEOBASE_DEV_UNENCRYPTED` set — every configured export route composes
`ProvisionalDevGate` (`server.rs` `router()`, line 137), the loopback guard
(`guard_localhost`) permits any localhost origin, and `governance-config.yaml`
requires a confirmed FPIC boolean before T2 export that nothing currently
collects. Any export-enabled local page can therefore drive an unauthenticated
T2 export today. Phase A installs an interim guard as its **first** microtask
(A1).

**Tree state** *(reconciled 2026-07-11 after the Phase 0 docs commits; the
paragraph below preserves the pre-Phase-0 baseline as history)*: local `main`
is now **ahead of `origin/main`** by the Phase 0 docs-only commits (base
`b7ad69c` — "fix(governance): FPIC boolean gates T2 product export, not T3";
nothing pushed). The documentary drift Phase 0 existed to close is closed
except DG-1 ratification: `MANIFEST.md`, this plan, `DEPENDENCIES.md` (a fifth
untracked file the original count missed — recorded in `docs/DECISIONS.md`
2026-07-11), `docs/GEOBASE-BUILD-DIRECTIVE.md`, and
`docs/GEOBASE-DIGITAL-TWIN-FEATURES.md` are all now **tracked** (the two
GEOBASE-* docs under SUPERSEDED banners); `README.md` no longer restates a
phase inline and points at `docs/ROADMAP.md`; tracked `ROADMAP.md` 2.1 keeps
"optional native Rust/`wgpu`" with a note that the superseded directive's
deck.gl direction is backlog material only. P0.1's ratification act —
formerly the one open Phase 0 item — **occurred 2026-07-16**:
`docs/RELEASE-DEFINITION.md` is RATIFIED and Phase 0 is complete.

Federation (2.0) is a placeholder (`spec/fidp/README.md`, "Not yet
implemented."); 2.1/2.2 are unstarted.

## Decision Gates

Every owner decision the plan depends on, encoded with an owner and a stated
default. A gate resolves by a **tracked commit** (the decision recorded in
`docs/DECISIONS.md` or the named artifact), never by an untracked note. The sole
maintainer (Patrick Freeland, the author/director) owns every gate; where a gate
also involves an external authority that is called out.

| Gate | Owner | Question | Default | Evidence the owner needs | Blocks |
|---|---|---|---|---|---|
| **DG-1** | Author | Where is the 1.0 line? | **Sovereignty-core 1.0**: Phases 1.2+1.3 as one combined gate + release hardening; F1–F4/federation/LiDAR are serial 1.x backlog | Tracked `ARCHITECTURE.md` ("not a v1 requirement", rendering section) and `ROADMAP.md` vs the untracked build directive; digital-twin scope roughly doubles remaining work; solo maintainer gets no parallelism benefit | Everything after Phase 0; resolved **only when the owner records RATIFIED** in `docs/RELEASE-DEFINITION.md` (file existence/commit is not resolution — the file is committed in DRAFT status) |
| **DG-2** | Author | Which at-rest cipher? | **Pure-Rust** candidate; SQLCipher's C dependency contradicts the tracked pure-Rust product decision (`docs/DECISIONS.md` 2026-07-06; `PROCESS-MAP.md` standing decisions) | Spike matrix: dependency posture, key management, migration, backup, failure semantics, lost-key (deliberately unrecoverable) policy fit | Phase B cipher implementation (B3–B4); ceremony *design* may proceed |
| **DG-3** | Author | S1 — Whitebox Next Gen licensing (F1) | If the ten F1 tools are in the open split with in-memory signatures → adopt Next Gen; else the **pre-approved legacy-MIT vendor fallback**, no new vetting round | License inventory of the vendored `wbtools_oss` tree; per the directive this is a "stop-and-choose point" | `geobase-sim` scaffolding only (Backlog B-2) — nothing on the 1.0 critical path |
| **DG-4** | Author | S2 — COPC vault storage (F2) | Lean container-is-artifact (file-backed) per the directive; decide on **measured** blob-vs-file numbers under a real client read pattern | Spike measurements into `DECISIONS.md` | The durable vault-storage decision in Backlog B-4 only — **not** the option-neutral endpoint work in the same item |
| **DG-5** | Author | Execute the MANIFEST.md repo reorganization? | **Defer to post-1.0**; record accept/defer/reject explicitly before the tag so 1.0 ships on a settled layout | The reorg touches every workspace manifest, script, workflow, and doc link — pure churn risk on the critical path | Nothing on the critical path; final disposition confirmed at C8 pre-tag |
| **DG-6** | Author + IRB | What is "security review passed" for 1.0? | **Local adversarial-egress suite green across every T3-producing and serving path + IRB track documented** (per `governance-config.yaml` `security_review`), with `ROADMAP.md` 2.2's unqualified "security review passed" wording amended to match | The tracked config explicitly says "Do not halt execution waiting for security sign-off. Ensure adversarial egress tests pass locally." — reconcile the two tracked docs one way or the other | The `v1.0.0` tag (C7) |

**DG-1 status (2026-07-16): RESOLVED — RATIFIED.** Patrick accepted
`docs/RELEASE-DEFINITION.md` as written at the 2026-07-16 owner sitting;
the file's status line reads RATIFIED with the owner date, backed by the
matching dated `docs/DECISIONS.md` entry. *(History: committed in DRAFT
2026-07-11 per P0.1; ratification was the one act reserved to the owner.)*

**DG-2 status (2026-07-16): RESOLVED — CONFIRMED.** Pure-Rust
XChaCha20-Poly1305 + Argon2id whole-file envelope for the two bounded T3
metadata artifacts (export ledger + consent store), passphrase-primary,
anti-rollback sequence headers, defined export linearization — plus
**B4b**, the plaintext-staging closure, inserted as a condition precedent
to B6/B8. See `docs/DECISIONS.md` 2026-07-16 and
`docs/CEREMONY-DESIGN.md` §10.

**DG-3 status (2026-07-16): DEFERRED by recorded decision** to MB2.1
activation — fresh pin + license/file inventory refresh there; the S1
spike stands as evidence, not a decision (`docs/DECISIONS.md` 2026-07-16).

**DG-5 status (2026-07-11):** disposition recorded as **deferred to
post-1.0** (the default) in `docs/DECISIONS.md` 2026-07-11, per P0.7. No
files move; `MANIFEST.md` remains a tracked proposal only. Final disposition
reconfirmed at Phase C, C8 pre-tag.

**DG-7 — resolved by tracked file evidence (moved to plan body, 2026-07-11).**
*Question:* must real Tribal data flow before 1.0? *Owner:* Author. *Answer:*
**No — resolved by tracked `governance-config.yaml`.** `pilot_dependency.status`
reads `"RESOLVED."` ("Multiple Tribes are actively utilizing the RStep
framework. GeoBase does not require a net-new Pilot Tribe to proceed. Proceed to
Spec-Complete immediately."), and the tracked `synthetic_fixture_scenario`
(federal-funding energy-siting scenario) is the canonical acceptance scenario.
Because the answer is backed by committed evidence, it is treated as settled
rather than as an open gate. *Residual (owner, one line):* if the owner wants a
real dataset flowed before the tag, that adds exactly one milestone between M6
and M8 and a matching `DECISIONS.md` note; nothing else in the plan moves.

## Plan Congruence

The standing rules that keep this plan, `MANIFEST.md`, and the repo's own status
docs from drifting. These rules are themselves a Phase 0 deliverable (P0.5) and
live in `CONTRIBUTING.md`/`docs/RELEASE-DEFINITION.md` once tracked; they are
restated here so the plan carries its own congruence contract.

**Single source of truth, by subject.** Each fact has exactly one authoritative
home; every other mention must agree with it or is a defect fixed in the same
commit that introduces the disagreement.

| Subject | Single source of truth | This plan's role |
|---|---|---|
| The 1.0 line / scope | `docs/RELEASE-DEFINITION.md` — status reads **RATIFIED** (2026-07-16), so the file now confers authority | Executes it; must not redefine it |
| Phase acceptance status | `docs/ROADMAP.md` (authoritative), mirrored in `docs/PROCESS-MAP.md` §8 | Reports it; never asserts a phase complete that ROADMAP does not |
| Decisions + rationale | `docs/DECISIONS.md` (append-only, dated) | Cites decisions; DG resolutions land there |
| Process / component map | `docs/PROCESS-MAP.md` | Points at it for "what runs where" |
| Sovereignty invariants | `AGENTS.md` §§1–10 + `governance-config.yaml` (IMMUTABLE FOR LLM EXECUTION) | Never weakens them; cites them |
| Proposed repo layout | `MANIFEST.md` (**proposal only — nothing moved**) | Reorg is DG-5; not current state |
| Verification evidence | `docs/verification/` (human-endorsed captures) + CI gate history | Names the gate that produces each artifact |

**Source-of-truth hierarchy (drift resolution order).**
`docs/RELEASE-DEFINITION.md` (ratified decision) → `docs/DECISIONS.md` →
`docs/ROADMAP.md` + `docs/PROCESS-MAP.md` (executable milestone/gate register) →
status docs (`README.md`, `MANIFEST.md`, this plan). Lower layers may never
contradict higher ones; when they do, the higher layer wins and the lower is
corrected in the same session.

**Untracked-doc rule.** No planning document governs work until it is tracked on
`main`. *(Status 2026-07-11: satisfied by Phase 0 P0.2 — this plan,
`MANIFEST.md`, `DEPENDENCIES.md`, and the two GEOBASE-* directives are now all
tracked; the two directives are tracked as SUPERSEDED, with invariant-conflict
notices, and carry no authority. The rule itself stands for all future
planning material.)*

**The congruence grep (the standing drift audit).** Before merging any phase
branch, grep `README.md`, `docs/ROADMAP.md`, and `docs/PROCESS-MAP.md` for
phase-status strings (e.g. `Phase 0.1`, `QUEUED`, `complete`, `accepted`) and
confirm they agree with each other and with the actual gates. This is the same
check Phase 0 runs first and every phase re-runs at exit.

**When to update this plan.** Update `PLAN_1.0.md` (and bump nothing else about
it — it is not versioned in `Cargo.toml`) whenever: a milestone flips; a
Decision Gate resolves; a phase branch merges; or `ROADMAP.md`/`PROCESS-MAP.md`
status changes. If this plan and `ROADMAP.md` ever disagree about what is
accepted, `ROADMAP.md` is right and this plan is edited to match — never the
reverse. `MANIFEST.md` is a point-in-time scan; when repo layout or phase status
changes materially, re-scan or annotate it rather than letting it silently age.

## Phased Plan

**Operating model (changed from v0.1):** one serial active workstream. v0.1
described Phases C/D/E as parallel and bundled six domains into one Phase F;
review correctly noted a solo maintainer realizes no concurrency and pays
context-switching costs. The critical path is now **Phase 0 → A → B → C →
tag**, with everything else in an explicitly ordered Backlog Queue that starts
only after the tag (or on deliberate, recorded interruption).

**Branch/worktree discipline (per review):** no phase starts until its governing
docs are tracked and congruent on `main`. Each phase is one branch that bundles
fixtures + implementation + observed gate + status-doc updates (`ROADMAP.md` /
`PROCESS-MAP.md` / `README.md`) together before merge, so `main` never carries a
claim its gates don't back. See `## Plan Congruence` for the source-of-truth
hierarchy every branch honors.

**Microtask anchor convention.** Every microtask below carries three sub-fields:
*Touches* (the exact files/modules/docs it changes or reads), *Verify* (the
command or observation that proves it done), and *Deps* (prerequisite microtasks
by ID, or `none`). Checkbox state tracks execution; anchors keep a fresh session
from re-deriving context.

### Phase 0 — Congruence & ratification (docs before code)

**Objective.** Make the tracked repo the single source of truth: ratify the
1.0 line, commit or supersede the untracked planning docs, fix stale status,
and repair the dangling verification reference. No product code changes.

**Session kickoff** *(executed 2026-07-11; preserved with corrections for the
record — a fresh session resuming Phase 0 should instead confirm the current
state described in "Tree state" above)*. The original instruction said to
confirm exactly four untracked planning files at HEAD `b7ad69c`; execution
found **five** (`DEPENDENCIES.md` was also untracked — recorded in
`docs/DECISIONS.md` 2026-07-11). All five are now committed; `git status
--porcelain` should show a clean tree, and HEAD is past `b7ad69c` (docs-only
Phase 0 commits, unpushed). Read `README.md` § Status, `docs/ROADMAP.md`, and
`docs/ARCHITECTURE.md`'s rendering section so the DG-1 default's basis is
fresh before touching `RELEASE-DEFINITION.md`.

**Verification mechanism.** Blocking `ci.yml` stays green (doc-only commits);
the congruence grep across `README.md`/`ROADMAP.md`/`PROCESS-MAP.md` passes.

- [x] **P0.1 — Ratify DG-1.** Write `docs/RELEASE-DEFINITION.md` encoding the
  sovereignty-core default (or the owner's override), the source-of-truth
  hierarchy, and the acceptance-integrity rule (a gate is accepted once, against
  the final mechanism).
  - *Touches:* `docs/RELEASE-DEFINITION.md` (new); the DG-1 row above;
    `docs/DECISIONS.md` (one dated cross-link line).
  - *Verify:* `docs/RELEASE-DEFINITION.md` status line reads **RATIFIED** with
    an owner-recorded date, backed by a matching dated `docs/DECISIONS.md`
    ratification entry; DG-1 marked resolved in this plan. File existence /
    `git ls-files` is **not** sufficient evidence — a committed DRAFT does not
    resolve DG-1.
  - *Deps:* none (root of Phase 0).
  - **Status 2026-07-16: EXECUTED — RATIFIED by Patrick.** The owner
    accepted the draft as written at the 2026-07-16 sitting; the status
    line reads RATIFIED with the owner date, the matching dated
    `docs/DECISIONS.md` entry exists, and DG-1 is marked resolved above.
    Phase 0 is now **complete**. *(History: draft written and committed
    2026-07-11 in DRAFT status; the ratification act was reserved to the
    owner.)*
- [x] **P0.2 — Commit or supersede the untracked docs.** `MANIFEST.md`,
  `PLAN_1.0.md`, `docs/GEOBASE-BUILD-DIRECTIVE.md`,
  `docs/GEOBASE-DIGITAL-TWIN-FEATURES.md` each get a status header consistent
  with DG-1 (directive scope = 1.x backlog authority under the default) and are
  committed — or explicitly superseded and removed.
  - *Touches:* the four named untracked files; `docs/DECISIONS.md` if any is
    superseded.
  - *Verify:* `git status --porcelain` shows no untracked planning material.
  - *Deps:* P0.1 (headers must be DG-1-consistent).
  - **Executed 2026-07-11** (against the DG-1 *default*, DG-1 itself still
    pending): all five formerly untracked docs committed (incl.
    `DEPENDENCIES.md`, the fifth the original count missed); both GEOBASE-*
    docs carry SUPERSEDED + invariant-conflict banners; `MANIFEST.md` carries
    a point-in-time status header. See `docs/DECISIONS.md` 2026-07-11.
- [x] **P0.3 — Fix stale status.** Correct `README.md` "Phase 0.1 — scaffold &
  spine" (line 75) to the true position; make README point at `ROADMAP.md` as
  the status source rather than restating it.
  - *Touches:* `README.md` (§ Status, line 75).
  - *Verify:* congruence grep passes; `README.md` no longer names a specific
    completed phase inline.
  - *Deps:* P0.1.
  - **Executed 2026-07-11:** README § Status now defers to `docs/ROADMAP.md`
    and links the DRAFT `docs/RELEASE-DEFINITION.md` (labeled as pending
    ratification).
- [x] **P0.4 — Repair the dangling RStep script.** `verify:rstep` in
  `solo/rstep/package.json` points at nonexistent `scripts/verify-rstep.mjs`;
  either remove the script entry until Phase A builds the harness or stub it to
  exit loudly with an honest "not yet built (Phase A)" message.
  - *Touches:* `solo/rstep/package.json` (`scripts.verify:rstep`); optionally a
    committed stub at `solo/rstep/scripts/verify-rstep.mjs`.
  - *Verify:* `pnpm --filter @geobase/rstep run verify:rstep` behaves honestly
    (exits non-zero with the "not yet built" message, or the entry is gone).
  - *Deps:* none.
  - **Executed 2026-07-11:** honest stub committed at
    `solo/rstep/scripts/verify-rstep.mjs` (`package.json` unchanged — it
    already pointed here); verified locally: exits 1 with the "NOT YET BUILT
    (Phase A)" message. The stub is not the harness (that is A3-A4).
- [x] **P0.5 — Record branch discipline + congruence rules.** Add the
  branch/worktree rules, the source-of-truth hierarchy, and the congruence-grep
  procedure to `CONTRIBUTING.md` (tracked today).
  - *Touches:* `CONTRIBUTING.md`; referenced from `docs/RELEASE-DEFINITION.md`.
  - *Verify:* tracked; `RELEASE-DEFINITION.md` links it.
  - *Deps:* P0.1.
  - **Executed 2026-07-11:** `CONTRIBUTING.md` § "Branch & congruence
    discipline" added; `RELEASE-DEFINITION.md` (DRAFT) cross-references it.
- [x] **P0.6 — Apply DG-1-consistent wording.** Under the default, tracked
  `ROADMAP.md` 2.1 keeps its "optional" heavy-render wording and gains a note
  that the deck.gl direction is recorded backlog authority; if the owner
  overrides DG-1 toward digital-twin-in-1.0, apply the directive's WP0 wording
  changes (2.1 heavy-3D → deck.gl Option C, CesiumJS escalation criterion)
  instead.
  - *Touches:* `docs/ROADMAP.md` (2.1 row + detail), `docs/DECISIONS.md`,
    cross-checked against `docs/ARCHITECTURE.md`.
  - *Verify:* `ROADMAP.md`/`DECISIONS.md`/`ARCHITECTURE.md` no longer contradict
    each other on rendering direction (manual read + grep for `wgpu`/`deck.gl`).
  - *Deps:* P0.1.
  - **Executed 2026-07-11** (default path; subject to revision if Patrick
    overrides DG-1): `ROADMAP.md` 2.1 note added; no rendering-direction
    contradiction among the three docs.
- [x] **P0.7 — Record DG-5 disposition.** One `DECISIONS.md` line: reorg
  accepted / deferred post-1.0 (default) / rejected.
  - *Touches:* `docs/DECISIONS.md`.
  - *Verify:* tracked; DG-5 row cross-references it.
  - *Deps:* none.
  - **Executed 2026-07-11:** deferred post-1.0 (the default), recorded in
    `docs/DECISIONS.md` 2026-07-11; reconfirmed at C8 pre-tag.

**Exit criteria.** All planning material tracked or superseded; no doc-vs-doc
contradiction on `main`; DG-1 resolved **only by the owner recording RATIFIED**
in `docs/RELEASE-DEFINITION.md` (plus the matching dated `docs/DECISIONS.md`
ratification entry) — a committed DRAFT does not meet this criterion.
**→ M0.**

> **Phase 0 status, 2026-07-16: COMPLETE.** P0.2–P0.7 executed 2026-07-11;
> P0.1 (DG-1 ratification) executed by the owner 2026-07-16. The exit
> criteria are met; **M0 has landed.** *(The 2026-07-16 overnight build ran
> Phase A before this ratification under a deliberate, recorded owner
> sequencing interruption — see `docs/DECISIONS.md` 2026-07-16.)*

### Phase A — Interim export guard + RStep gate harness (build, don't accept)

**Objective.** Close the dev hole immediately, then build the missing 1.3d
harness as real engineering (fixtures → harness → oracle verification → CI).
**This phase does not accept Phase 1.3.** Review identified an
acceptance-integrity flaw in v0.1: accepting RStep against `ProvisionalDevGate`
proves only provisional behavior, and Phase B would knowingly invalidate that
acceptance. The observed acceptance run happens exactly once, at Phase B exit,
against the sovereign gate (M5).

**Session kickoff.** Confirm M0 landed (Phase 0 exit criteria met; congruence
grep clean). Read `docs/PROCESS-MAP.md` §7 (export chain) and §8 (gate table,
RStep row = QUEUED), `docs/CEREMONY-GATE.md` (the seam contract), and
`crates/geobase-engine-desktop/src/server.rs` `router()` + `api_export`. Verify
the baseline test count is green locally (`cargo test --workspace --locked` →
122 `#[test]` + 19 `#[tokio::test]`) before adding to it. Note the Playwright
pin already present: `playwright 1.61.1` in `solo/rstep/package.json`
devDependencies.

**Verification mechanism.** Blocking `ci.yml` Rust suite (new server unit tests
via tower `oneshot`, the house pattern already used in `server.rs` tests); the
new local harness; a new `rstep-gate` CI job entering as INFORMATIONAL per the
house five-greens rule.

- [ ] **A1 — Interim export guard (first, before anything else).** Require an
  operator-held token (e.g. `GEOBASE_EXPORT_TOKEN`, generated at node boot or
  operator-supplied) checked on `POST /api/export` *before* the ceremony seam;
  missing/wrong token → 403 + `export.refused` audit row; SDK `NodeClient`
  passes it explicitly. Document it as provisional, replaced by real requester
  auth in B5.
  - *Touches:* `crates/geobase-engine-desktop/src/server.rs`
    (`ServerConfig`, `router()`, `api_export`, `guard_localhost` neighborhood);
    `solo/sdk/src/index.ts` (`NodeClient`); `docs/PROCESS-MAP.md` §7 note.
  - *Verify:* new `oneshot` unit tests — export without token refused with an
    `export.refused` row; with token, existing behavior byte-identical; the
    existing 122+19 suite still green.
  - *Deps:* M0.
- [ ] **A2 — Fixtures.** Add the `capacity`+`nogo` synthetic fixture sets to
  `scripts/make_geopack_fixtures.py`, committed under `data/fixtures/geopack/`
  per house pattern (the same generator that produced the dem+parcels and
  landcover+flood sets).
  - *Touches:* `scripts/make_geopack_fixtures.py`; new committed fixtures under
    `data/fixtures/geopack/`.
  - *Verify:* `geopack package` builds both `capacity` and `nogo`; tier + audit
    metadata correct on reopen (reuse the ingest reopen-verify path).
  - *Deps:* M0.
- [ ] **A3 — Harness.** Write `solo/rstep/scripts/verify-rstep.mjs` (Playwright,
  pinned `1.61.1`): boot `crates/geobase-engine-desktop/examples/node.rs` with
  exports enabled, drive RStep through the `window.__rstep` gate handle (paint →
  close polygon → export).
  - *Touches:* `solo/rstep/scripts/verify-rstep.mjs` (new); `solo/rstep/src/
    main.ts`/`paint.ts` (the `__rstep` handle, read-only); the example node.
  - *Verify:* a local run produces a shapefile + `node-audit.gpkg` ledger rows
    end-to-end.
  - *Deps:* A2 (fixtures), P0.4 (the script slot must be honest first).
- [ ] **A4 — Oracle + ledger verification.** Re-prove from outside the product
  (pyogrio, per the 0.3 oracle pattern) that the export carries *only* the
  product whitelist (`id, area_m2, score`), no source geometry, plus
  `export.ceremony` + `export.t2` rows in `exports_dir/node-audit.gpkg` and the
  `.tsdf.json` sidecar stamp. Include a negative test: a tampered product must
  fail the harness.
  - *Touches:* `solo/rstep/scripts/verify-rstep.mjs`; reads
    `crates/geobase-engine-desktop/src/export.rs` `PRODUCT_FIELDS` for the
    whitelist of record.
  - *Verify:* harness passes clean, fails tampered (both asserted in one run).
  - *Deps:* A3.
- [ ] **A5 — CI job.** Add `rstep-gate` (own workflow or a `render-gate.yml`
  job), INFORMATIONAL until five consecutive greens on main, per the tracked
  house pattern for headless-WebGL jobs (`render-gate.yml` header, line 7).
  - *Touches:* `.github/workflows/render-gate.yml` (new job) or a new workflow;
    `docs/PROCESS-MAP.md` §8 (add the CI-job cell).
  - *Verify:* job green on `main`, labeled provisional-gate.
  - *Deps:* A4.
- [ ] **A6 — F7.4 honesty check.** Confirm RStep's renewable/NoGo logic is
  pack-driven config, not hardcoded.
  - *Touches:* `solo/rstep/src/main.ts` (+ any config module); a new pinning
    test.
  - *Verify:* code inspection recorded (one `DECISIONS.md` line or PR note) + a
    test pinning the config path.
  - *Deps:* none (independent of A1–A5).
- [ ] **A7 — Status update without acceptance.** Flip `PROCESS-MAP.md` §8's
  RStep row from "QUEUED — not yet built" to "harness built — **acceptance
  deferred to the sovereignty-core gate (M5)**". `ROADMAP.md` 1.3 stays
  not-accepted.
  - *Touches:* `docs/PROCESS-MAP.md` §8; `docs/ROADMAP.md` (confirm 1.3 stays
    unmarked).
  - *Verify:* congruence grep; no doc claims 1.3 complete.
  - *Deps:* A5.

**Exit criteria.** Interim guard live and tested; `rstep-gate` harness exists,
runs locally, and is green-informational in CI **against the provisional gate,
explicitly labeled as such**; no acceptance claim made anywhere. **→ M1, M2, M3.**

### Phase B — Sovereignty core: ceremony, crypto, auth, egress proof → combined acceptance

**Objective.** Turn the shipped seams into the real mechanism — the single most
load-bearing phase for the platform's reason to exist — then run the one
combined acceptance: Phases 1.2 and 1.3 flip to accepted-complete together,
proven against the sovereign process.

**Session kickoff.** Confirm M1/M2/M3 landed and DG-2's spike (M4) is either done
or the very next task. Re-read `docs/CEREMONY-GATE.md` in full (the seven "what
Phase 1.2 must implement" clauses and the two CONTRACT TESTS), `governance-
config.yaml` `fpic_semantics` (tribal = signed agreement; individual = witnessed
verbal consent; T3 never exportable), `crates/geobase-gpkg/src/ceremony.rs`
(`ProvisionalDevGate`, `PROVISIONAL_BASIS`, `ExportRefused::TierNeverExports`,
the two `CONTRACT TEST` fns), and `crates/geobase-gpkg/src/cipher.rs`
(`AtRestCipher`, `FailClosedCipher`, `DevPlaintextCipher`). Confirm
`ProvisionalDevGate` is still composed only at `server.rs` `router()` line 137
(`grep -n ProvisionalDevGate` across the workspace) before touching it.

**Verification mechanism.** The two shipped ceremony contract tests (T3 refused
unconditionally; provisional basis never emitted by a sovereign gate) per
`docs/CEREMONY-GATE.md`; the blocking Rust suite; the new adversarial-egress
suite; the Phase A harness re-run asserting the sovereign ceremony record.

> **Phase B scope note (2026-07-16 owner sitting).** B1 and B2 are done
> (below). The ratified mechanism is `docs/CEREMONY-DESIGN.md` — it
> **adds scope** to the remaining items beyond their original one-line
> descriptions: **B3** also builds the consent store (design §3), the
> node-witnessed export-session provenance (§4), lineage-head matching
> (§5.2), the governance-vs-infrastructure refusal split (§5.3), and the
> recoverable publication protocol (§6), with the recorded breaking seam
> replacement (§2.4). **B4** implements the confirmed DG-2 envelope for
> BOTH bounded stores (§10); a new item **B4b** (below) closes the
> plaintext staging paths before B6/B8. **B5** is LocalOperator-only with
> the OS-keychain credential AND the OS-peer-identity boundary (§7).
> **B8** asserts `EXPECT_PROCESS` and `EXPECT_BASIS` independently (§8).

- [x] **B1 — DG-2 cipher spike (condition precedent to B4).** One sitting:
  candidate matrix (pure-Rust options vs SQLCipher) covering dependency posture,
  key management, migration, backup, failure semantics, and the recorded
  deliberately-unrecoverable lost-key policy.
  - *Touches:* `docs/DECISIONS.md` (new dated entry); the DG-2 row.
  - *Verify:* decision + numbers committed to `docs/DECISIONS.md`; DG-2 resolved.
  - *Deps:* M0 (spike may run any time after Phase 0; must precede B4).
  - **Executed:** spike recorded 2026-07-16 (overnight); **DG-2 CONFIRMED by
    the owner 2026-07-16** (sitting) — see the DG-2 status above.
- [x] **B2 — Ceremony process design (owner authority).** Design the sovereign
  FPIC process against `governance-config.yaml` semantics (signed tribal
  agreement / witnessed individual consent; the FPIC boolean gates T2 *product*
  export only — T3 has no export path to gate, ever). The mechanism is
  deliberately the owner's design per `docs/CEREMONY-GATE.md`.
  - *Touches:* `docs/CEREMONY-GATE.md` (or a successor design doc);
    `docs/DECISIONS.md`.
  - *Verify:* design recorded with the contract-test list it must satisfy
    (the seven CEREMONY-GATE clauses).
  - *Deps:* M0.
  - **Executed 2026-07-16 (owner sitting):** `docs/CEREMONY-DESIGN.md`
    RATIFIED (contract-test list in its §11; clauses 2/5 amended there);
    `docs/THREAT-MODEL-1.2.md` tracked; the DRAFT proposal superseded;
    decisions recorded in `docs/DECISIONS.md` 2026-07-16.
- [ ] **B3 — Sovereign `CeremonyGate`.** Implement it; swap at the single
  composition point in `server.rs` `router()`, nowhere else.
  - *Touches:* new impl in `crates/geobase-gpkg/src/ceremony.rs` (or a sibling
    module); `crates/geobase-engine-desktop/src/server.rs` `router()` (the one
    `Arc::new(...)` construction site).
  - *Verify:* both `CONTRACT TEST`s green against the sovereign gate;
    `grep -rn ProvisionalDevGate crates/` proves it is no longer reachable from
    any release-build composition.
  - *Deps:* B2.
- [ ] **B4 — Real `AtRestCipher`.** Implement the DG-2 choice behind the
  fail-closed seam; every T3-producing write path (export ledger, future
  sim/LiDAR outputs) routes through it; remove `GEOBASE_DEV_UNENCRYPTED` or
  hard-gate it out of release builds.
  - *Touches:* `crates/geobase-gpkg/src/cipher.rs`;
    `crates/geobase-engine-desktop/src/server.rs` (the
    `GEOBASE_DEV_UNENCRYPTED` branch near line 118); the ledger write path.
  - *Verify:* cipher unit tests + ledger write-path test; the fail-closed
    contract test still green; release build refuses the dev-plaintext path.
  - *Deps:* B1.
- [ ] **B4b — Plaintext T3 staging closure (condition precedent to B6/B8;
  added 2026-07-16).** Close the recorded plaintext staging paths —
  `ingest()` and `package()` write plaintext staging GPKGs for
  default/explicit-T3 inputs, bypassing the cipher seam (`docs/DECISIONS.md`
  2026-07-16 DG-2 spike). The large-artifact backend is decided here (the
  page-level/VFS question may re-open, bounded to this case) — the B4
  whole-file envelope is confirmed for the two small metadata stores only
  and must not silently expand.
  - *Touches:* `crates/geobase-ingestor` staging paths; possibly a new
    storage abstraction; failure-injection tests for large artifacts.
  - *Verify:* no code path writes plaintext T3 staging; temp/WAL/journal
    leakage reviewed; the "no plaintext T3 at rest" claim is true across
    every path before B6/B8 run.
  - *Deps:* B4 (and its backend decision).
- [ ] **B5 — Requester authentication.** Per-app tokens (already flagged in the
  1.0 loopback decision — `docs/DECISIONS.md` 2026-07-06 "per-app tokens arrive
  with the Phase 1.2 ceremony work"); extend `ExportAuthorization` with identity
  evidence; retire the A1 interim guard in the same commit.
  - *Touches:* `crates/geobase-gpkg/src/ceremony.rs` (`ExportAuthorization`);
    `crates/geobase-engine-desktop/src/server.rs`; `solo/sdk/src/index.ts`.
  - *Verify:* unauthenticated export refused with audit row; SDK integration
    test green; the A1 token path is gone.
  - *Deps:* A1 (retires it), B3.
- [ ] **B6 — Adversarial-egress suite.** Author the suite proving the
  architectural T3 guarantee: no export path, no network path, no plaintext at
  rest, across every T3-producing and serving path.
  - *Touches:* new test module(s) in `crates/geobase-engine-desktop` (and/or
    `geobase-gpkg`); `.github/workflows/ci.yml` (wired blocking — not a WebGL
    job).
  - *Verify:* suite green locally; `ci.yml` runs it as a required check.
  - *Deps:* B3, B4, B4b, B5.
- [ ] **B7 — Runtime network-denial harness.** An observable test that the
  node's runtime/data path performs zero non-loopback network I/O (OS-level
  denial or socket audit around a full boot-serve-export cycle). Scope narrowed
  per review: this proves *runtime* denial — CI itself necessarily uses the
  network for checkout/installs and no claim is made otherwise.
  - *Touches:* new harness under `crates/geobase-engine-desktop` (examples or
    tests); `.github/workflows/` wiring.
  - *Verify:* harness green locally and in CI.
  - *Deps:* B3 (needs the real serving path composed).
- [ ] **B8 — Combined acceptance run (M5).** Re-run `rstep-gate` against the
  sovereign gate; the harness asserts the ceremony record names the sovereign
  process and the provisional basis appears nowhere. Flip `ROADMAP.md` 1.2 and
  1.3 to accepted-complete and update `PROCESS-MAP.md` §8 **in this one commit**,
  with gate evidence attached.
  - *Touches:* `solo/rstep/scripts/verify-rstep.mjs` (assertion flip from
    `PROVISIONAL_BASIS` to the sovereign process name); `docs/ROADMAP.md` (1.2 +
    1.3 rows/detail); `docs/PROCESS-MAP.md` §8; a committed evidence capture
    under `docs/verification/`.
  - *Verify:* CI green (including `rstep-gate` asserting the sovereign record —
    `EXPECT_PROCESS` and `EXPECT_BASIS` asserted independently, and
    `basis != PROVISIONAL_BASIS`);
    congruence grep; acceptance recorded exactly once.
  - *Deps:* B3, B4, B4b, B5, B6, B7, A5 (the harness/job to re-run).

**Exit criteria.** T3 provably non-exportable and non-networkable under
adversarial tests; T2 export requires a recorded agreement from an authenticated
requester; complete append-only audit trail; fail-closed at-rest encryption
demonstrated with the DG-2 cipher; no path emits the provisional basis; 1.2 +
1.3 accepted together against the final mechanism. **→ M4, M5, M6.**

### Phase C — Release readiness: packaging, hardening, tag v1.0.0

**Objective.** Build the release infrastructure that does not exist today
(review verified: no Windows/macOS CI, no signing, no packaging, no
SBOM/license gate, no release automation), demonstrate governance portability,
meet the DG-6 bar, and cut the release.

**Session kickoff.** Confirm M5 + M6 landed (sovereignty core accepted; egress
and network-denial suites green in CI). Re-read `governance-config.yaml`
`security_review` (IRB deferral + "ensure adversarial egress tests pass
locally") for the DG-6 bar, `docs/ROADMAP.md` 2.2 ("security review passed"
wording to amend), and `docs/DECISIONS.md` 2026-07-06 "Desktop shell: Tauri 2,
feature-gated" (the `--features shell` build the installers wrap). Check CI
history for how many consecutive green runs `render-gate`/`node-render-gate`/
`layer-gate`/`rstep-gate` have accrued (Open Question 3 — this is CI state, not
repo state). Confirm `THIRD_PARTY_NOTICES.md` is still absent before creating it.

**Verification mechanism.** New packaging CI jobs (entering informational,
promoted to blocking once stable); the B6/B7 suites re-run; a license-audit
job; manual installer validation on a clean machine.

- [ ] **C1 — Name target platforms; build the packaging matrix.** Decide
  Windows-only vs Windows+macOS for 1.0 (owner call — record in `DECISIONS.md`);
  add CI jobs building the feature-gated Tauri shell (`--features shell`) into
  installers per platform.
  - *Touches:* `docs/DECISIONS.md` (platform decision); new packaging
    workflow(s) under `.github/workflows/`; `crates/geobase-engine-desktop`
    (`--features shell` build).
  - *Verify:* installer artifacts produced by CI on every release-branch build.
  - *Deps:* M5, M6.
- [ ] **C2 — Signing.** Establish signing authority and secret handling (Windows
  code-signing cert; Apple Developer ID if macOS is in); wire signing into the
  packaging jobs.
  - *Touches:* the packaging workflow(s); repo/org secrets (out-of-repo);
    `docs/DECISIONS.md` (signing route).
  - *Verify:* a signed installer installs and launches on a clean machine
    without trust warnings appropriate to the platform.
  - *Deps:* C1.
- [ ] **C3 — License/attribution audit.** `THIRD_PARTY_NOTICES.md` complete
  (cargo-deny/cargo-about + pnpm license listing), TSDF CC-BY-NC-SA boundary
  (`spec/tsdf/`) and vendored crates covered; add the audit as a CI job.
  - *Touches:* `THIRD_PARTY_NOTICES.md` (new); a new CI job; reads
    `Cargo.lock`/`pnpm-lock.yaml`, `spec/tsdf/ATTRIBUTION.md`.
  - *Verify:* audit job green; notices file tracked and complete.
  - *Deps:* M5 (dependency set stable after the core lands).
- [ ] **C4 — Governance portability.** Exercise `LocalServerSource` so TSDF
  governance moves to a private/local server by config alone.
  - *Touches:* `crates/geobase-tsdf` (`LocalServerSource`); a new automated test;
    a demonstration note in `docs/`.
  - *Verify:* documented demonstration + an automated test of the source swap.
  - *Deps:* M5.
- [ ] **C5 — TSDF version-bump flow.** Demonstrate end-to-end adoption:
  GitHubSource diff → sovereign review → vendored bump → existing data keeps its
  stamp.
  - *Touches:* `crates/geobase-tsdf` (`GitHubSource`), `spec/tsdf/`;
    a recorded flow doc under `docs/`.
  - *Verify:* recorded flow with artifacts (before/after stamp on the same data).
  - *Deps:* M5.
- [ ] **C6 — Promote informational gates.** Fold `render-gate`,
  `node-render-gate`, `layer-gate`, and `rstep-gate` into blocking CI once each
  has its five consecutive greens (the tracked house rule).
  - *Touches:* `.github/workflows/ci.yml` and/or branch-protection settings;
    `.github/workflows/render-gate.yml`.
  - *Verify:* branch protection / `ci.yml` shows them required.
  - *Deps:* A5 (rstep-gate exists) + CI history (Open Question 3).
- [ ] **C7 — DG-6 security bar.** Local adversarial-egress suite green across
  every T3-producing and serving path; IRB review track documented; amend
  `ROADMAP.md` 2.2's "security review passed" wording to the ratified DG-6 bar.
  - *Touches:* `docs/ROADMAP.md` (2.2 wording); `docs/DECISIONS.md` (DG-6
    resolution + IRB track); reruns the B6/B7 suites.
  - *Verify:* suites green; wording reconciled; DG-6 recorded resolved.
  - *Deps:* M6.
- [ ] **C8 — Pre-tag closeout.** Confirm DG-5 disposition (P0.7) still stands;
  release-docs polish; validate the DDM interop bridge as a first external
  consumer of the T0 baseline.
  - *Touches:* `docs/DECISIONS.md` (DG-5 reconfirm); `docs/interop/DDM-BRIDGE.md`
    (tracked — validate against the live T0 baseline); all status docs.
  - *Verify:* congruence grep across all status docs; DDM interop validation
    recorded.
  - *Deps:* C1–C7; P0.7.
- [ ] **C9 — Version + tag.** Bump workspace versions from `0.1.0`, changelog,
  tag `v1.0.0`, produce signed release artifacts.
  - *Touches:* `Cargo.toml`, `package.json`, `engine-light/package.json`,
    `solo/sdk/package.json`, `solo/rstep/package.json`; a `CHANGELOG.md`; the
    release workflow.
  - *Verify:* `git tag` shows `v1.0.0`; release CI green; signed installers
    attached to the release.
  - *Deps:* C1–C8.

**Exit criteria.** `v1.0.0` tagged on a repo where docs, gates, and installers
agree; resolver source swapped by config only; version-bump flow demonstrated;
DG-6 bar met. **→ M7, M8.**

### Backlog Queue (1.x — serial, non-gating by default per DG-1)

Preserved from v0.1 with their grounded specifics; each is one future active
workstream, entered in order unless the owner deliberately re-prioritizes. Under
a DG-1 override these re-enter the critical path *after* Phase B — never before
the sovereignty core. Backlog microtasks are keyed to their milestone (MB1.n …
MB4.n) so cross-item dependencies are unambiguous.

**Session kickoff (any backlog workstream).** Confirm `v1.0.0` is tagged (M8) or
that the owner has recorded a deliberate interruption of the post-tag order.
Re-read the governing spike gate for the item (DG-3 for MB2, DG-4 for MB4) and
`docs/PROCESS-MAP.md` §9 (TSDF enforcement points) so the new workstream reuses
the existing invariant seams rather than adding parallel ones. No backlog item
may weaken a product invariant (`AGENTS.md` §§1–10); each ends in its own
observed gate.

#### B-1 — Public-data acquisition (F4, `tools/acquire/`)

Give a data-poor Tribe a populated node from an AOI polygon. Out-of-product
tooling; cannot weaken product invariants.

- [ ] **MB1.1 — Fetchers.** Python fetchers (out-of-product, pure-Rust-product
  posture preserved) for 3DEP DEM, 3DEP LiDAR index (TNMAccess + COPC/EPT
  mirrors), LANDFIRE fuels, NHDPlus/WBD, sharing one safety module
  (advertised-size check, free-disk headroom, refuse-oversized, clip-to-AOI,
  discard raw archives).
  - *Touches:* new `tools/acquire/` tree; recorded-response fixtures.
  - *Verify:* fetcher unit tests against recorded responses.
  - *Deps:* M8.
- [ ] **MB1.2 — Staging → GeoPack.** Output lands in a staging dir consumed by
  `geopack package` — never a new packaging path; domain-pin allowed hosts;
  fail loudly on endpoint drift.
  - *Touches:* `tools/acquire/`; reuses `crates/geobase-ingestor` `package`.
  - *Verify:* ingest of staged output passes the existing GeoPack gate.
  - *Deps:* MB1.1.
- [ ] **MB1.3 — Acquire gate.** `acquire-gate.yml`: `workflow_dispatch` +
  `schedule` only, never a required check, network-permitted but isolated from
  product CI. The guarantee is **product runtime network denial** (B7 harness),
  not "CI is offline."
  - *Touches:* `.github/workflows/acquire-gate.yml` (new).
  - *Verify:* gate green on dispatch — fixture AOI from two sources, ingest,
    assert tier + audit + render.
  - *Deps:* MB1.2.
- [ ] **MB1.4 — Operator walkthrough.** Real AOI → stacked layer packages
  visible in the desktop shell.
  - *Touches:* the desktop shell (`geobase-desktop`, `--features shell`); a
    recorded demonstration.
  - *Verify:* recorded demonstration.
  - *Deps:* MB1.3.

#### B-2 — Simulation engine (F1, `geobase-sim`) — gated on DG-3 (S1)

- [ ] **MB2.1 — S1 spike first (DG-3; stop-and-choose — do not scaffold before
  it).** License-inventory the vendored Whitebox Next Gen `wbtools_oss` tree;
  confirm the ten F1 tools are in the open split with in-memory signatures, else
  take the pre-approved legacy-MIT vendor fallback.
  - *Touches:* `docs/DECISIONS.md`; the DG-3 row.
  - *Verify:* choice + inventory in `docs/DECISIONS.md`; DG-3 resolved.
  - *Deps:* M8.
- [ ] **MB2.2 — IO envelope.** GPKG coverage reader + narrow GeoTIFF staging
  writer with a round-trip assertion that WBT output stays inside `geotiff.rs`'s
  accepted envelope.
  - *Touches:* new `geobase-sim` crate; reads
    `crates/geobase-ingestor/src/geotiff.rs`.
  - *Verify:* round-trip unit tests.
  - *Deps:* MB2.1.
- [ ] **MB2.3 — Recipe registry.** Required `inferential: bool` +
  capability-ladder rung in provenance; recipes v1: `watershed`, `streams`,
  `flood_hand`, `flow_paths`, `wetness`, `spring_candidates` (inferential),
  `wildfire_exposure` (LANDFIRE fuels + slope/aspect/topo-position composite —
  *exposure, not spread*).
  - *Touches:* `geobase-sim` registry module.
  - *Verify:* registry tests; provenance asserted.
  - *Deps:* MB2.2.
- [ ] **MB2.4 — Tier policy + endpoint.** Mechanical recipes inherit
  most-restrictive input tier; inferential/unknown → unset → T3.
  `POST /api/sim/{recipe}` composes the exact `geopack package` path (zero
  artifact-writing code in the sim crate), reusing refusal-before-open +
  loopback guard.
  - *Touches:* `geobase-sim`; `crates/geobase-engine-desktop/src/server.rs`
    (new route reusing the export composition discipline).
  - *Verify:* tier-policy tests; an inferential recipe's output provably refuses
    to serve until explicitly classified.
  - *Deps:* MB2.3.
- [ ] **MB2.5 — Sim gate.** `sim-gate` CI (informational-first house rule):
  fixture `flood_hand` run → assert tier + provenance + audit + pixel-diff
  render + D8-vs-oracle value check; work-file rules (T2/T3 refusal, tempdir
  outside vault scan, cleanup on both paths) enforced.
  - *Touches:* new `sim-gate` workflow; fixtures under `data/fixtures/`.
  - *Verify:* gate green.
  - *Deps:* MB2.4.

#### B-3 — Federation (roadmap 2.0, FIDP)

- [ ] **MB3.1 — FIDP profile.** Author the profile in `spec/fidp/` (advertise/
  verify/auto-distribute T0; architectural guarantee T1–T3 never leave a node).
  - *Touches:* `spec/fidp/` (currently a placeholder README).
  - *Verify:* spec tracked; conformance checklist derived from it.
  - *Deps:* M8.
- [ ] **MB3.2 — Multi-node sync.** In `geobase-engine-desktop`, keeping the node
  API cleanly separable from the shell (F6 future-proofing).
  - *Touches:* `crates/geobase-engine-desktop` (node API vs shell boundary).
  - *Verify:* a second node auto-receives an updated T0 baseline (observed gate).
  - *Deps:* MB3.1.
- [ ] **MB3.3 — Portable-twin proof.** A Tribe's twin is `place.toml` + vault of
  GeoPacks + baseline, renderable by any conformant engine; adversarial
  multi-node egress test confirms T1/T2/T3 never transit.
  - *Touches:* `place.example.toml` shape; the multi-node egress test.
  - *Verify:* egress test green.
  - *Deps:* MB3.2.

#### B-4 — Secure high-res LiDAR twin (F2+F3, roadmap 2.1) — S2 inside (DG-4)

- [ ] **MB4.1 — COPC ingest.** COPC as the point-cloud vault format;
  `lidar ingest` (schema extension adding a `pointcloud` kind — one
  `DECISIONS.md` line), validated via `las::copc`, with **vertical-datum
  refusal** (read WKT VLR; unknown/missing → refuse), default T3.
  - *Touches:* `crates/geobase-ingestor`, `crates/geobase-gpkg`;
    `docs/DECISIONS.md` (schema line).
  - *Verify:* ingest tests incl. a refusal fixture.
  - *Deps:* M8.
- [ ] **MB4.2 — COPC range endpoint (option-neutral).** Tier-checked before byte
  one, loopback-only, `x-geobase-tier` + `no-store` (reuse the layers-endpoint
  shape). Does not wait on S2.
  - *Touches:* `crates/geobase-engine-desktop/src/server.rs`.
  - *Verify:* endpoint tests.
  - *Deps:* MB4.1.
- [ ] **MB4.3 — S2 spike (DG-4).** Measured blob-backed vs file-backed COPC
  serving under a real client read pattern; numbers into `DECISIONS.md`. Blocks
  only the durable vault-storage decision.
  - *Touches:* `docs/DECISIONS.md`; the DG-4 row.
  - *Verify:* decision recorded from measurements.
  - *Deps:* MB4.2.
- [ ] **MB4.4 — Derivation recipes.** In `geobase-sim`: `dtm`, `dsm`, `chm`,
  `tree_features`; DTM→T0 promotion documented as a sovereign reclassification
  act through the ceremony/audit path.
  - *Touches:* `geobase-sim`; the ceremony/audit path (`geobase-gpkg`).
  - *Verify:* recipe tests + audit assertion.
  - *Deps:* MB4.1, **MB2** (the `geobase-sim` crate must exist first).
- [ ] **MB4.5 — Render adapter seam.** `PointCloudView` deck.gl adapter seam
  (non-interleaved `MapboxOverlay`, frozen interface per the paint-tool
  doctrine), first impl = pinned `maplibre-gl-lidar 0.16.2` wrapped completely,
  lazy-loaded, terrain off in twin mode; CesiumJS Option A recorded as
  escalation-only with a point-budget criterion.
  - *Touches:* `engine-light/` (or a shared TS package); `docs/DECISIONS.md`
    (escalation criterion).
  - *Verify:* overlay-off path passes existing render/layer gates
    **byte-identically**.
  - *Deps:* MB4.2.
- [ ] **MB4.6 — Twin gates.** Twin-view pixel assert at pitch + OS-level
  network-off boot; mixed-vertical-datum refusal fixture.
  - *Touches:* new gate(s) under `.github/workflows/`; fixtures.
  - *Verify:* the roadmap 2.1 gate verbatim — 1 m LiDAR ingested as T3, rendered
    locally without egress.
  - *Deps:* MB4.4, MB4.5.

## Milestones

Effort classes: **S** = one sitting; **M** = 2–5 sittings; **L** = 6–15
sittings; **XL** = larger / not yet sized.

Exit evidence is deliberately unambiguous: a named command output, a committed
artifact, or a recorded decision. The **Depends on** column is by milestone ID;
`—` means only the phase's own session-kickoff preconditions.

| Milestone | Phase | Exit evidence (command output / committed artifact / recorded decision) | Depends on | Effort |
|---|---|---|---|---|
| **M0** — Repo congruence + DG-1 ratified | 0 | `docs/RELEASE-DEFINITION.md` status line reads **RATIFIED** with an owner date + a matching dated `docs/DECISIONS.md` ratification entry (**met 2026-07-16** — file existence alone was never the evidence; the owner ratification act was); `git status --porcelain` shows no untracked planning docs; congruence grep across README/ROADMAP/PROCESS-MAP returns no contradiction; `verify:rstep` exits honestly | — | M |
| **M1** — Interim export guard live | A | `cargo test --workspace --locked` green with new guard tests; export without token → 403 + `export.refused` row (test asserts it) | M0 | S |
| **M2** — RStep harness runs locally | A | `node solo/rstep/scripts/verify-rstep.mjs` produces a shapefile + ledger rows; clean pass **and** tampered-product fail both asserted | M0 | L |
| **M3** — `rstep-gate` in CI (informational) | A | `rstep-gate` job green on `main`, labeled provisional-gate; `PROCESS-MAP.md` §8 CI-job cell filled; no acceptance claim anywhere | M2 | S |
| **M4** — DG-2 cipher decision | B | `docs/DECISIONS.md` entry: choice + dependency/key/migration/backup/failure semantics + lost-key policy; DG-2 row marked resolved | M0 | S |
| **M6** — Egress + network-denial proof | B | Adversarial-egress suite (`ci.yml`, blocking) + runtime network-denial harness both green locally and in CI | M4 | L |
| **M5** — **Sovereignty core accepted** (1.2+1.3 combined) | B | `rstep-gate` green asserting the sovereign ceremony record (provisional basis absent); `grep -rn ProvisionalDevGate crates/` shows it unreachable from release composition; ROADMAP 1.2+1.3 flipped in one evidenced commit with a `docs/verification/` capture | M3, M4, M6 | XL |
| **M7** — Packaging + signing CI | C | Signed installers produced by CI for the named platform(s); installs+launches on a clean machine; license-audit job green; `THIRD_PARTY_NOTICES.md` tracked and complete | M5, M6 | L |
| **M8** — **`v1.0.0` tagged** | C | `git tag` shows `v1.0.0`; DG-5/DG-6 recorded resolved; governance-portability + version-bump flows recorded with artifacts; informational gates promoted to required; signed artifacts attached | M7 | M |
| **MB1** — Acquisition live | B-1 | `acquire-gate` green on dispatch; recorded demo: real AOI → stacked packages in the shell | M8 | L |
| **MB2** — Sim engine live | B-2 | DG-3 resolved in `DECISIONS.md`; `sim-gate` green; inferential recipe provably refuses to serve until classified | M8 | XL |
| **MB3** — Federation live | B-3 | Second node auto-receives T0 (observed gate); multi-node egress test green | M8 | XL |
| **MB4** — LiDAR twin live | B-4 | Roadmap 2.1 gate verbatim (1 m LiDAR as T3, rendered locally, no egress); DG-4 decision recorded; existing render/layer gates byte-identical with overlay off | M8, MB2 | XL |

**Ordering note.** M5 is listed as the headline acceptance but by dependency it
is the **final** Phase B step: the combined 1.2+1.3 acceptance (B8) requires the
egress and network-denial proofs (M6 = B6/B7) already green, because "T3
provably non-exportable and non-networkable" is part of what 1.2 acceptance
certifies (1.0 Definition, item 1). Execute M4 → M6 → M5 within Phase B.

### Spike & gate register (conditions precedent, scheduled — not discovered)

| Spike/Gate | Entry condition | Artifact | Fallback | Stop/go | Work blocked |
|---|---|---|---|---|---|
| DG-2 cipher spike (M4/B1) | Before B3/B4 implementation | `DECISIONS.md` entry with full semantics matrix | SQLCipher only with an explicit escalation-ladder entry overriding the pure-Rust posture | Go = pure-Rust candidate meets fail-closed + lost-key policy | Phase B cipher integration (B4) |
| S1 Whitebox licensing (DG-3 / MB2.1) | Before any `geobase-sim` scaffolding | License inventory + choice in `DECISIONS.md` | Pre-approved legacy-MIT vendor path — no new vetting round | Stop-and-choose per the directive | All of Backlog B-2 (and MB4.4, which needs `geobase-sim`) |
| S2 COPC vault (DG-4 / MB4.3) | After option-neutral COPC endpoint work (MB4.2) | Measured blob-vs-file numbers in `DECISIONS.md` | Container-is-artifact (file-backed) default | Go on measurements, not preference | Durable vault-storage decision in B-4 only |

## Risks and Mitigations

The top risks to reaching `v1.0.0`, each with a mitigation already wired into the
plan and an early-warning signal to watch for. Technical, calendar, budget, and
single-maintainer-throughput risks are all represented.

1. **Acceptance-integrity regression — 1.3 accepted against the provisional
   gate.** *(technical, process)* Accepting RStep against `ProvisionalDevGate`
   would certify only provisional behavior; Phase B would silently invalidate
   it. *Mitigation:* Phase A builds without accepting (A7); acceptance happens
   exactly once at B8/M5 against the sovereign gate; the two CONTRACT TESTS in
   `ceremony.rs` keep `PROVISIONAL_BASIS` out of any sovereign record.
   *Early warning:* any diff flipping `ROADMAP.md` 1.3 to complete before B8, or
   `grep -rn ProvisionalDevGate crates/` still reaching a release composition
   after B3.

2. **The dev hole reaches a real deployment before A1/B5.** *(technical,
   sovereignty)* An export-enabled node today authorizes unauthenticated T2
   export (`server.rs` `router()` composes `ProvisionalDevGate`; loopback guard
   permits any localhost origin). *Mitigation:* A1 is the **first** microtask —
   an operator token before the ceremony seam — retired by real requester auth
   at B5. *Early warning:* any request to enable `GEOBASE_EXPORTS` on a shared or
   user-facing node before A1 is merged and tested.

3. **Single-maintainer throughput and context-switching.** *(calendar,
   throughput)* Two milestones are XL (M5, plus every backlog MBx); a solo
   maintainer realizes no parallelism and pays re-entry costs. *Mitigation:* one
   serial active workstream; each phase is one branch bundling
   fixtures+impl+gate+status; per-phase Session-kickoff notes cut re-entry cost.
   *Early warning:* more than one phase branch open at once, or a branch idle
   long enough that its Session-kickoff assumptions have gone stale (the same
   failure mode that left a sibling repo idle 40+ days).

4. **DG-2 cipher: no pure-Rust option meets the fail-closed + unrecoverable
   lost-key policy.** *(technical)* The default pure-Rust posture may not have a
   candidate that satisfies at-rest T3 fail-closed semantics. *Mitigation:* B1 is
   a scheduled condition-precedent spike, not a discovered surprise; SQLCipher is
   a named fallback but only behind an explicit escalation-ladder entry
   overriding the tracked pure-Rust decision. *Early warning:* the B1 matrix
   comes back with every pure-Rust candidate failing key-management or
   fail-closed criteria.

5. **Documentary drift returns.** *(process)* Untracked scope, a stale README
   ("Phase 0.1"), and ROADMAP/directive rendering contradictions are the current
   state; nothing stops them recurring. *Mitigation:* Phase 0 closes them; the
   `## Plan Congruence` rules + the congruence grep run at every phase exit; the
   untracked-doc rule blocks a phase from starting on ungoverned docs.
   *Early warning:* `git status --porcelain` shows untracked planning material,
   or the congruence grep finds README/ROADMAP/PROCESS-MAP disagreeing on a
   phase's status.

6. **Release infrastructure is entirely net-new.** *(calendar, budget,
   technical)* No Windows/macOS CI, no signing, no packaging, no license gate,
   no release automation exist today; all four workflows run `ubuntu-latest`.
   *Mitigation:* Phase C treats packaging/signing/license audit as new
   infrastructure with a named platform-scope decision (C1, Windows-only default
   to cap scope) rather than assumed plumbing. *Early warning:* the Windows
   code-signing certificate (and Apple Developer ID, if macOS is in) is not
   procured by C1, or macOS runner cost/identity is unresolved when C1 closes.

7. **The sovereign ceremony process is owner-only and undesigned.** *(calendar,
   dependency)* B3 cannot proceed until B2 designs the FPIC mechanism, which
   `docs/CEREMONY-GATE.md` deliberately reserves to the author. *Mitigation:* the
   design sitting (B2) is scheduled and constrained by the seven CEREMONY-GATE
   contract clauses, so it is bounded work, not open-ended research. *Early
   warning:* the B2 sitting slips repeatedly, or B3 implementation starts against
   an un-updated `CEREMONY-GATE.md`.

8. **Informational-gate promotion depends on CI history, not repo state.**
   *(process)* Whether `render-gate`/`node-render-gate`/`layer-gate`/`rstep-gate`
   have five consecutive green runs on `main` (C6) is CI history, not something
   the working tree reveals. *Mitigation:* C6's Session-kickoff step checks CI
   history first; the gate stays informational until the five-greens rule is
   actually met. *Early warning:* gates flapping green/red on `main`, or fewer
   than five consecutive greens accrued when C6 is reached (Open Question 3).

## Open Questions

Only questions still genuinely open after the decision gates above:

1. **Signing authority and certificates (C2).** Which Windows code-signing route
   (OV/EV cert, sigstore-style, or store-based), who holds the secret, and is
   macOS a 1.0 platform at all? Owner decision inside C1/C2; no default asserted
   because it has cost and identity implications outside the repo.
2. **The sovereign ceremony process design itself (B2).** Deliberately not
   designed in advance — `docs/CEREMONY-GATE.md` reserves the mechanism as the
   author's authority. The plan schedules the design sitting but cannot
   pre-decide its content.
3. **Render-gate promotion status.** Whether `render-gate`/`node-render-gate`/
   `layer-gate` have accumulated their five consecutive green runs on `main` is
   CI history, not repo state — check before assuming C6 is a one-line change.
4. **Ingestor naming.** Tracked `ROADMAP.md` leaves the "GeoPack" codename open
   (its "Naming still open" section); crate id stays `geobase-ingestor` until
   final. Cosmetic, but a 1.0 tag freezes public naming — decide by C8.

## Provenance

This plan is the product of a deliberate four-phase pipeline, each phase a
distinct agent role, so scope, evidence, and articulation were separated rather
than conflated:

1. **Codex manifest (Phase 1).** A read-only structural scan produced
   `MANIFEST.md` — the "what this project is / current development status /
   proposed reorganization / inventory" record of the repo as it actually
   stands on disk.
2. **Opus draft (Phase 2).** A first `PLAN_1.0.md` (v0.1) drew the road to 1.0
   from the manifest and the tracked docs — but inferred an ambitious
   roadmap-through-2.2-plus-digital-twin scope.
3. **Codex adversarial review + refinement (Phase 3).** Codex (gpt-5.6-sol,
   read-only) plus the orchestrator stress-tested v0.1 against tracked code and
   produced v0.2. Every blocker and major was verified in code and resolved or
   gated; nothing was refuted. The dispositions, preserved as the Phase-3
   record:

   | Challenge (severity) | Disposition |
   |---|---|
   | 1.0 scope rests on untracked docs contradicting tracked architecture (blocker) | 1.0 Definition rewritten to the sovereignty-core default; DG-1 created; Phase 0 ratifies by tracked `RELEASE-DEFINITION.md`; digital-twin scope moved to a serial Backlog Queue |
   | `ProvisionalDevGate` dev hole — unauthenticated T2 export on export-enabled nodes (blocker) | Verified in code (`server.rs` `router()`, `ceremony.rs`); interim operator-token guard is Phase A's **first** microtask (A1), retired by real requester auth (B5) |
   | Phase A/B acceptance-integrity flaw — RStep accepted twice against two security postures (blocker) | Sequencing rewritten: guard → sovereign mechanism → **one combined observed acceptance** (B8/M5); Phase A explicitly builds without accepting (A7) |
   | No milestone table existed; S1/S2 unscheduled (major) | `## Milestones` table added plus a spike & gate register carrying entry condition, artifact, fallback, stop/go, and blocked work |
   | Stray tool-syntax artifact lines at file tail (minor) | Removed |
   | RStep gate readiness overstated as "CI wiring" (major) | Verified: `verify:rstep` → nonexistent file, no harness, no CI job; Phase A split into fixture (A2), harness (A3), oracle/ledger verification (A4), CI (A5) |
   | Solo-maintainer parallelism illusory (major) | Serial single-active-workstream model adopted; v0.1 Phases C–F reframed as ordered backlog B-1…B-4 |
   | Phase G release infrastructure assumed but nonexistent (major) | Verified (all CI ubuntu-latest; no signing/packaging); Phase C treats packaging, signing, license audit as **new infrastructure** with a named platform decision (C1) |
   | "Product CI provably network-off" overstated (major) | Claim narrowed to runtime/data-path network denial with an observable harness (B7); B-1 restates the same |
   | Cipher unresolved before Phase B (major) | DG-2 spike (B1/M4) is a condition precedent to cipher implementation; default pure-Rust per tracked 2026-07-06 decision |
   | Workflow alignment: informational vs blocking CI conflated | Current Position rewritten with the verified split; every phase names its verification mechanism; render/rstep gates follow the tracked five-greens promotion rule (C6) |
   | Tree reconciliation: untracked scope, stale README, doc drift | Phase 0 created; source-of-truth hierarchy + branch/worktree discipline codified; phase branches bundle fixture+implementation+gate+status-doc updates |

4. **Opus expansion (Phase 4, this document).** Every microtask given concrete
   file/module/doc anchors, a verifying command or check, and dependency IDs;
   per-phase Session-kickoff notes added; a `## Risks and Mitigations` section
   and a `## Plan Congruence` section added; the Milestones table sharpened with
   unambiguous exit evidence and a dependency column; DG-7 moved into the plan
   body as resolved by tracked `governance-config.yaml`. Every file path, module
   name, doc title, and count in this expansion was re-verified against the repo
   at HEAD `b7ad69c` on 2026-07-11 before being repeated here.
