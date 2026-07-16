# Sovereign Ceremony — Design Proposal (DRAFT for Patrick, B2)

> **STATUS: DRAFT PROPOSAL / DECISION-SUPPORT ONLY. Not a design of record,
> not a decision.** The sovereign ceremony *mechanism* is deliberately
> reserved to the owner (`docs/CEREMONY-GATE.md`: "The ceremony mechanism —
> the sovereign process itself — is deliberately not designed here; that is
> 1.2's work and authority"; `PLAN_1.0.md` B2). This document is prepared
> support for that sitting: it lays out the constraints the mechanism must
> satisfy, the design space with trade-offs, a *candidate* default composition,
> a recorded-agreement schema, and the contract tests — so the owner can
> accept, modify, or reject quickly. **Nothing here composes a gate, swaps
> `ProvisionalDevGate`, or decides FPIC semantics.** Drafted 2026-07-16 by
> Claude Code per the overnight directive; reviewed by Codex (gpt-5.6-sol).

## 1. What the sovereign `CeremonyGate` must satisfy (the fixed constraints)

These are not proposals — they are the invariants and clauses any sovereign
implementation must honor, gathered in one place.

**From `docs/CEREMONY-GATE.md` (the seven clauses):**
1. **Bind to the FPIC process** — `authorize_export` consults the actual
   permissions ceremony; `process` names it; `authorized_by` names the real
   authority, never the requester echo.
2. **Authenticate the requester** — the seam passes an actor string today; 1.2
   decides the identity mechanism and extends `ExportAuthorization` with
   identity evidence (non-breaking additions).
3. **Keep the tier floor** — T3 remains refused *by construction*
   (`ExportRefused::TierNeverExports`) regardless of any consent recorded. An
   invariant, not a policy (`AGENTS.md` §3).
4. **Never emit the provisional basis** — `PROVISIONAL_BASIS` belongs to the
   dev gate alone.
5. **Record conditions** — expiry, geography, purpose limits travel in
   `CeremonyRecord::conditions`.
6. **Refusal is first-class** — `ExportRefused::Declined { reason }`; the
   pipeline writes the refusal audit row and returns 403; no partial exports.
7. **Keep the contract tests green** — T3 refusal; provisional-wording
   exclusivity; plus the sovereign gate's own equivalents.

**From `governance-config.yaml` (`fpic_semantics`, IMMUTABLE):**
- **Tribal sharing** → "formal acknowledgment of sharing, typically via a
  signed agreement."
- **Individual consent** → "verbal consent with verified witnesses."
- The FPIC boolean gates **T2 derived-product export only**. **T3 has no
  export path to gate, ever.**

**From `docs/RELEASE-DEFINITION.md` (acceptance properties, each separately
asserted):** the shipping cipher is fail-closed; **T2 export requires a
recorded agreement**; the **audit trail is complete** (every authorization and
refusal recorded); the requester is authenticated.

## 2. The design space (decision points, each with options + trade-offs)

### D1 — Requester identity (satisfies clause 2, authentication)
- **(a) Per-app token bound to an app identity** (extends the Phase A interim
  token into a real per-app credential with an identity record). *Pro:* reuses
  the shipped seam; least new surface. *Con:* an app identity is not a person.
- **(b) Operator-attested identity** — the node operator vouches for the
  requester at ceremony time, recorded in the agreement. *Pro:* matches how a
  Tribal data steward actually authorizes. *Con:* trust rests on the operator.
- **(c) Cryptographic per-requester keypair.** *Pro:* strongest. *Con:* key
  management burden for a small deployment; likely over-engineered for 1.0.
- *Proposal leans (a)+(b): a per-app credential AND an operator-attested
  authority recorded in the agreement, so `authorized_by` names a real
  authority, not the app.*

### D2 — Recorded-agreement capture (satisfies clause 1 + the "recorded
agreement" acceptance property)
- Tribal path: a **signed agreement reference** (agreement id + signatory +
  date + document hash) — the code stores the reference and hash, not the legal
  document. Individual path: a **witnessed-consent record** (consenter +
  witness(es) + timestamp + method="verbal").
- The gate consults a **local, append-only agreements store** (schema in §4);
  it does not invent consent, it *verifies a recorded act exists* for this
  (pack, product-tier, requester) and is unexpired.

### D3 — Where the gate reads agreements from
- **(a) A local ceremony store** (a T3-tagged GPKG alongside the export
  ledger, or a signed file). *Pro:* offline, sovereign, no network. *Con:* new
  store to manage. **Recommended** — matches the offline-first invariant.
- **(b) The TSDF `LocalServerSource` governance server.** *Con:* Phase 2.2,
  networked — out of scope for the 1.0 sovereignty core.

### D4 — Condition enforcement (clause 5)
- Conditions (expiry date, purpose limit, geography) are recorded in the
  agreement and copied into `CeremonyRecord::conditions`. **Enforcement at
  export time** (e.g. refuse an expired agreement) is 1.2 scope — the proposal
  recommends enforcing *expiry* at minimum in 1.0 (cheap, high-value), with
  geography/purpose recorded-but-advisory unless the owner wants them enforced.

### D5 — Refusal taxonomy (clause 6)
- `TierNeverExports` (T3, unchanged) · `Declined { reason }` (no agreement / a
  declined agreement) · a new `AgreementExpired`/`AgreementMissing` reason
  string under `Declined` (keep the enum stable; carry specificity in the
  reason). Every refusal writes an `export.refused` row.

## 3. Candidate default composition (a PROPOSAL — owner accepts/edits/rejects)

A `SovereignCeremonyGate` that, on `authorize_export(auth)`:
1. **T3 floor first** — if `source_tier == T3 || product_tier == T3` → return
   `TierNeverExports` (before touching anything else). *Invariant.*
2. **Authenticate** — verify the requester credential (D1a) resolves to a known
   app identity; else `Declined { reason: "unauthenticated requester" }` + row.
3. **Find the agreement** — query the local ceremony store (D3a) for an
   unexpired, non-declined agreement covering (pack_id, product_tier=T2,
   requester/authority). None → `Declined { reason: "no recorded FPIC
   agreement for this export" }` + row.
4. **Build the record** — `process = "sovereign-fpic"`, `basis` = a sovereign
   basis string (NOT `PROVISIONAL_BASIS`), `authorized_by` = the agreement's
   recorded authority (tribal signatory or witnessed consenter — never the
   requester echo), `conditions` = the agreement's conditions (incl. expiry).
5. **Return `CeremonyRecord`** — the export pipeline writes `export.ceremony`
   with it (unchanged machinery), then `export.t2`.

This is a thin, auditable gate over an agreements store. It adds **one** new
store and **one** new gate impl behind the frozen trait, swapped at the single
composition point in `server.rs` `router()` — nowhere else.

## 4. Recorded-agreement store — proposed schema (owner edits freely)

A T3-tagged, append-only store (a GPKG table like the audit ledger, or a signed
JSON log). Proposed fields per agreement:

| Field | Meaning |
|---|---|
| `agreement_id` | Stable id (operator-assigned). |
| `kind` | `"tribal_signed"` \| `"individual_witnessed"`. |
| `pack_id` / `pack_scope` | Which pack(s)/product this authorizes. |
| `product_tier` | The tier authorized to export (T2; T3 is never valid here). |
| `authority` | Tribal signatory, or the individual consenter. |
| `witnesses` | For `individual_witnessed`: verified witness identities. |
| `document_hash` | SHA-256 of the signed agreement doc (the doc itself is NOT stored — only its hash + reference). |
| `requester` / `app_identity` | Who the agreement authorizes to request. |
| `conditions` | expiry date; purpose limit; geography (optional). |
| `recorded_at` / `recorded_by` | Append-only provenance. |
| `status` | `"active"` \| `"declined"` \| `"revoked"`. |

The store is **T3** (it records sovereign consent) → it never leaves the node,
and it routes through the same fail-closed `AtRestCipher` seam as the ledger.

## 5. Contract tests the sovereign gate must pass (extend `ceremony.rs`)

- **T3 refusal** (the shipped CONTRACT TEST) — green against the sovereign gate.
- **Provisional-wording exclusivity** — the sovereign gate NEVER emits
  `PROVISIONAL_BASIS` (shipped CONTRACT TEST).
- **No agreement → refused** — a T2 export with no recorded agreement is
  `Declined` + an `export.refused` row, no product written.
- **Recorded agreement → authorized** — a T2 export WITH an unexpired agreement
  succeeds; `authorized_by` = the agreement authority, not the requester;
  `basis` is the sovereign basis.
- **Expired agreement → refused** (if D4 expiry adopted).
- **Unauthenticated requester → refused** even with an agreement present.
- **Audit completeness** — every authorize and every refuse writes a row
  (the RELEASE-DEFINITION "audit trail complete" property).
- **RStep gate flip** — `verify-rstep.mjs`'s `EXPECT_BASIS` flips from the
  provisional basis to the sovereign process name; the gate re-runs green
  asserting the sovereign record (this is the M5/B8 combined-acceptance run).

## 6. Morning decision checklist (for Patrick)

1. **Identity (D1):** per-app credential + operator-attested authority (a/b), or
   something stronger?
2. **Agreement store (D3):** local T3 store (recommended), or defer to the
   Phase 2.2 governance server?
3. **Conditions (D4):** enforce expiry in 1.0? Enforce geography/purpose, or
   record-but-advisory?
4. **Basis string:** the exact sovereign `basis` wording (it becomes the
   `EXPECT_BASIS` the RStep gate asserts — pick it deliberately).
5. **Store format:** GPKG table (like the ledger) vs a signed JSON log.
6. **Individual-consent capture:** how witnesses are "verified" in practice
   (operational, may be out-of-band + recorded).

Once these six are answered, B3 (implement `SovereignCeremonyGate`) and B4/B5
(cipher + auth) are well-specified, and the combined 1.2+1.3 acceptance (B8/M5)
runs the RStep gate against the real mechanism — exactly once.

## 7. What this proposal deliberately does NOT do

- It does not compose or swap any gate (`ProvisionalDevGate` remains the only
  composed gate).
- It does not decide FPIC semantics (those are `governance-config.yaml` +
  Patrick's authority).
- It does not authorize any export or ratify DG-1.
- It does not add code — it is a design menu. B3 is the implementing phase,
  after the owner's B2 decisions above.
