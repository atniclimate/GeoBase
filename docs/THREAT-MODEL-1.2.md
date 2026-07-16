# Phase 1.2 Threat Model — Attacker Classes, Non-Goals, and Ratified Crypto Constraints

> **STATUS: TRACKED 2026-07-16.** Graduated from a gitignored working
> handoff (originally drafted 2026-07-07) by owner decision at the
> 2026-07-16 B2 sitting (`docs/DECISIONS.md` same date), edited for
> tracking: the schema sections that doc carried are superseded by their
> normative home, `docs/CEREMONY-DESIGN.md`; a historical Codex sub-prompt
> was removed; the ratification record is restated exactly (the working
> doc's own header had overclaimed it — see §4).
>
> This document scopes what the 1.2 cryptography and ceremony DEFEND
> AGAINST and — just as deliberately — what they do not. Overclaiming
> protection is treated as a defect (`docs/RELEASE-DEFINITION.md`
> acceptance-integrity; the completion-plan red-team finding that Class C
> must not be claimed).

## 1. Finalized sovereign decisions (inputs, not open questions)

- **Lost-key policy: DELIBERATELY UNRECOVERABLE** (owner, 2026-07-07). No
  escrow, no master key, no developer backdoor, no support path. If a
  Tribe loses their key, the T3 data on that node is cryptographically
  destroyed. Rationale: a recovery mechanism is a systemic sovereignty
  compromise. The adversarial review checks for this property's *absence*
  — finding a recovery path is a blocking defect.
- **T3 egress is absolute.** The FPIC boolean gates **T2 derived-product
  export only**; T3 has no export path and none may be built
  (`governance-config.yaml`; `AGENTS.md` §3; enforced by the shipped
  egress gate and proven again at B6/B7).

## 2. Attacker classes

| Class | Attacker capability | Defense | Status |
|---|---|---|---|
| **A — app-mediated** | loopback API / a local web page | tier refusals + ceremony gate + requester authentication | egress gate shipped (2026-07-07/08); interim export token shipped (Phase A); sovereign gate + OS-peer-identity boundary land at B3/B5 |
| **B — at-rest / filesystem** | reads vault/exports/store bytes off disk | at-rest encryption (B4 envelope for ledger + consent store; B4b for staging) | ledger fail-closed today (refuses T3 write without a cipher); real encryption is B4/B4b |
| **C — physical / admin / OS** | memory dump, admin copy of an *unlocked* node, screenshot | operational controls (device custody, OS full-disk encryption, physical security) — **not software** | **out of scope by design** — the crypto must never claim to defend Class C |

**Explicit non-goals (say so, don't overclaim):** the key protects data
**at rest**. It cannot protect a running, unlocked node from its own
authenticated operator, nor from Class C. "Architectural egress guarantee"
means: Class A prevented, Class B mitigated by encryption, Class C
operational. Backup copies are availability backups of sealed ciphertext —
after key loss they are unreadable **by design** (that is the lost-key
policy working, not failing).

## 3. Ratified at-rest cipher constraints (owner, 2026-07-16 — enumerated)

Ratified as an enumerated list, deliberately not as a section label, so no
open mechanism choice is swept in (`docs/DECISIONS.md` 2026-07-16):

1. T3 artifacts at rest use **authenticated encryption**.
2. **Fail-closed**: a missing key, failed derivation, or corrupt/
   unauthenticatable artifact refuses — never falls back to plaintext.
3. **No unwrapped key material at rest** — only salt and KDF parameters
   travel with the artifact, never keys.
4. **No escrow, no master key, no support recovery path** — key loss
   destroys access, by construction (§1).
5. **Rotation is an explicit, audited event** (re-encrypt under a new
   derived key; recorded in the audit trail).
6. A production cipher **refuses to open** an artifact stamped
   `UNENCRYPTED-DEV` — a dev-plaintext artifact never silently continues
   into production.
7. **Multi-operator key wrapping remains OPEN** — whether several people
   may open one node (N wrapped copies of the data key, still no master
   key) is a sovereign choice the owner has explicitly not yet made.

Algorithm specifics — XChaCha20-Poly1305, Argon2id and its parameters,
passphrase vs keyfile modes, envelope/header format — are **DG-2's
answers**, not part of this ratification. DG-2 was confirmed 2026-07-16
(`docs/DECISIONS.md`): a bounded pure-Rust envelope for the two small T3
metadata artifacts (B4), plus **B4b**, the named closure of the plaintext
T3 staging paths, condition precedent to B6/B8.

## 4. Consent & identity schema — where it lives, and the ratification record

The typed schema (`ExportIdentity`, `ConsentBasis`, `FpicAuthorization`,
`Conditions`, the authority-of-record split) has exactly one normative
home: **`docs/CEREMONY-DESIGN.md` §2** (single-source-of-truth rule; this
document does not duplicate shapes).

Ratification record, restated exactly:

- **2026-07-08:** the original §4 (typed `FpicAuthorization`/`ConsentBasis`)
  and §5 (typed `ExportIdentity`) of the working threat-model doc were
  ratified by the owner. §3 (key lifecycle) was **not** ratified then —
  the working doc's own later sections overclaimed "ratified §3–§5"; that
  overclaim is corrected by the 2026-07-16 enumerated ratification (§3
  above).
- **2026-07-16:** `ConsentBasis` **re-ratified richer** (structured
  evidence; evidence-thin authorizations unconstructible) and the
  authority-of-record split adopted — see `docs/CEREMONY-DESIGN.md` and
  `docs/DECISIONS.md` (same date).

## 5. What ships against this model (Phase B mapping)

1. **B3** — sovereign `CeremonyGate` + consent store + session provenance
   + recoverable publication protocol (`docs/CEREMONY-DESIGN.md`).
2. **B4** — the bounded at-rest envelope for the export ledger and consent
   store; **B4b** — plaintext T3 staging closure (ingest/package), before
   B6/B8.
3. **B5** — LocalOperator credential (OS keychain + OS-peer-identity
   boundary); retires the interim export token.
4. **B6** — adversarial-egress suite extended with **Class B**: write an
   encrypted T3 artifact, attempt to read it off-key, assert unreadable —
   and assert **no escrow/recovery path exists** (§1).
5. **B7** — runtime network-denial harness.
6. **B8** — the single combined 1.2+1.3 acceptance run against the real
   mechanism.
