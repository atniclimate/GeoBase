# GeoBase — Release Definition (DG-1)

> **STATUS: DRAFT — PENDING PATRICK RATIFICATION.** This document encodes the
> stated *default* answer to Decision Gate DG-1 (`PLAN_1.0.md` § Decision
> Gates) as drafted by Claude Code per `PLAN_1.0.md` P0.1. Committing this file
> is the mechanism `PLAN_1.0.md` names for making a DG-1 answer *tracked*
> (never an untracked note) — but drafting and committing is not the same act
> as the owner ratifying it. **This draft does not resolve DG-1.** Nothing in
> `docs/ROADMAP.md`, `PLAN_1.0.md`, or any other tracked doc may cite this file
> as a ratified decision until Patrick records ratification (see "Ratification
> record" below) — either by accepting this draft as-is or by overriding it,
> in either case via a dated `docs/DECISIONS.md` entry plus this file's status
> line flipped from DRAFT to RATIFIED.

## Purpose

Every fact about GeoBase's release scope has exactly one authoritative home.
This file is that home for **the 1.0 line** — what "product-1.0" (the
version the author would tag `v1.0.0`) includes, what it defers, and how the
platform's other status docs must agree with it. It exists because
`PLAN_1.0.md`'s Phase 0 found the platform's own planning material was
untracked and self-contradictory (see `docs/DECISIONS.md` 2026-07-11): a
tracked, single-source answer replaces that drift.

## The default (DG-1)

**Product-1.0 is the sovereignty core: Phases 1.2 and 1.3 combined into one
acceptance gate, plus release hardening.**

Concretely, for `v1.0.0` to be tagged:

1. **TSDF enforcement is real, end-to-end.** The sovereign FPIC ceremony
   replaces `ProvisionalDevGate` at its single composition point
   (`crates/geobase-engine-desktop/src/server.rs` `router()`); at-rest
   encryption of T3 is live **and fail-closed** behind the shipped
   `AtRestCipher` seam (`crates/geobase-gpkg/src/cipher.rs`; default
   `FailClosedCipher` — a missing or failed cipher refuses, never falls back
   to plaintext); the requester is authenticated; the architectural T3 egress
   guarantee is proven by an adversarial egress test suite — **T3 provably
   non-exportable and non-networkable**; **T2 export requires a recorded
   agreement**; and the **audit trail is complete** (append-only, every
   authorization and refusal recorded). These are acceptance properties in
   their own right, not implementation details: naming FPIC and
   authentication does not by itself evidence the recorded agreement or
   audit completeness, and naming the seam does not by itself evidence
   fail-closed behavior — each is separately asserted at acceptance. This is
   roadmap Phase 1.2 (`AGENTS.md` §3; `governance-config.yaml`).
2. **RStep ships the paint-and-export flow, accepted exactly once, against
   the sovereign gate** — never against `ProvisionalDevGate`. The 1.3d
   end-to-end observed-behavior gate is green in CI, asserting the sovereign
   ceremony record. This is roadmap Phase 1.3.
3. **Release hardening is real**: signed desktop installers from an actual
   packaging CI matrix, a license/attribution audit
   (`THIRD_PARTY_NOTICES.md`), demonstrated `LocalServerSource` governance
   portability, a demonstrated TSDF version-bump adoption flow, the local
   adversarial-egress bar met with the IRB review track documented (DG-6),
   and all status docs congruent with the code.

Phases 1.2 and 1.3 are accepted **together, exactly once**, against the real
sovereign mechanism — never partially, and never against a placeholder.
Acceptance against `ProvisionalDevGate` (the current-only ceremony
implementation, which refuses T3 unconditionally but authorizes T0-T2 for any
unverified requester) counts as acceptance of nothing. See
`crates/geobase-gpkg/src/ceremony.rs` and `docs/CEREMONY-GATE.md`.

**Non-gating 1.x backlog (serial, one active workstream at a time, after the
sovereignty core ships):** public-data acquisition (F4, `tools/acquire/`),
the simulation engine (F1, `geobase-sim`), federation (roadmap 2.0, FIDP),
and the secure LiDAR/digital-twin path (F2+F3, roadmap 2.1). These carry
grounded work breakdowns in `PLAN_1.0.md`'s Backlog Queue and in the
now-superseded `docs/GEOBASE-BUILD-DIRECTIVE.md` /
`docs/GEOBASE-DIGITAL-TWIN-FEATURES.md` (retained as raw research material
only — see their in-file SUPERSEDED banners and `docs/DECISIONS.md`
2026-07-11). None of this backlog gates the `v1.0.0` tag.

**Explicitly out of scope entirely for 1.0** (unchanged regardless of DG-1's
resolution): the QField field-survey round-trip (F5 "GroundTruth", post-2.0),
the local AI query layer (F6, parking lot), COPC *write*, and a CesiumJS
heavy-3D path (documented escalation only, per `docs/ARCHITECTURE.md`'s
rendering decision — a native heavy-render path is "a deferred Phase 2.1
option, not a v1 requirement").

## Acceptance-integrity rule

A phase gate is accepted **exactly once**, and only against the mechanism
that will actually ship. Concretely:

- Phase 1.2 and Phase 1.3 are never marked accepted-complete in
  `docs/ROADMAP.md` while `ProvisionalDevGate` is the composed ceremony.
- Building and green-running a harness against the provisional gate (Phase A
  in `PLAN_1.0.md`) is legitimate engineering progress and may be recorded as
  such, but it is never conflated with acceptance.
- The one combined acceptance run happens at Phase B's exit, against the
  real `CeremonyGate` + real `AtRestCipher` + real requester authentication,
  with the RStep gate re-run asserting the sovereign ceremony record (never
  `PROVISIONAL_BASIS`).

## Source-of-truth hierarchy

Restated from `PLAN_1.0.md` § Plan Congruence so it is anchored in the
document DG-1 itself resolves through:

| Subject | Single source of truth |
|---|---|
| The 1.0 line / scope | This file, once RATIFIED (until then, `PLAN_1.0.md`'s 1.0 Definition + DG-1 row, marked pending) |
| Phase acceptance status | `docs/ROADMAP.md` (authoritative), mirrored in `docs/PROCESS-MAP.md` §8 |
| Decisions + rationale | `docs/DECISIONS.md` (append-only, dated) |
| Process / component map | `docs/PROCESS-MAP.md` |
| Sovereignty invariants | `AGENTS.md` §§1-10 + `governance-config.yaml` (IMMUTABLE FOR LLM EXECUTION) |
| Proposed repo layout | `MANIFEST.md` (proposal only — nothing moved; DG-5 defers execution post-1.0) |
| Verification evidence | `docs/verification/` (human-endorsed captures) + CI gate history |

**Drift resolution order:** this file (once ratified) → `docs/DECISIONS.md` →
`docs/ROADMAP.md` + `docs/PROCESS-MAP.md` → status docs (`README.md`,
`MANIFEST.md`, `PLAN_1.0.md`). A lower layer never contradicts a higher one;
when it does, the higher layer wins and the lower is corrected in the same
session that finds the drift (`CONTRIBUTING.md`'s congruence-grep procedure).

## Invariants this file never weakens

- T3 has no egress path — architectural, not a feature gate. Nothing in this
  release definition authorizes, schedules, or implies an exception.
- `ProvisionalDevGate` remains a documented known-insecure placeholder until
  Phase B; no export authorized under it is evidence of anything shipping.
- Default classification is T3 when in doubt (`spec/tsdf/tiers.toml`).

## Ratification record

*(Owner-authored or owner-approved entries only. Empty until Patrick acts.)*

- **Status:** DRAFT, drafted 2026-07-11 by Claude Code per `PLAN_1.0.md` P0.1.
  Not yet ratified. To ratify: Patrick either (a) accepts this draft as
  written — flip this line to `RATIFIED 2026-0X-0X by Patrick Freeland`, add
  a matching `docs/DECISIONS.md` entry, and update the DG-1 row in
  `PLAN_1.0.md` to resolved — or (b) records an override default and its
  rationale here and in `docs/DECISIONS.md`.
