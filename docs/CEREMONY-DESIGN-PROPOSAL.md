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
> Claude Code per the overnight directive; strengthened after a Codex
> (gpt-5.6-sol) adversarial design review (verdict GAPS, **no invariant
> reversal**; `_reviews/geobase/2026-07-16_ceremony-proposal-review.md`) whose
> findings are folded into §§3.1, 4, 4.1, 5, and the §6 owner-decisions table.

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
   `TierNeverExports` **before authentication or any agreement-store access**.
   *Invariant.* (Precondition, must be designed + tested per §3.1 below: the
   floor is only sound if `source_tier`/`product_tier` are authoritative — see
   the tier-provenance requirement.)
2. **Authenticate** — verify the requester credential (D1a) resolves to a known
   app identity; else `Declined { reason: "unauthenticated requester" }` + row.
3. **Find the agreement** — query the local ceremony store (D3a) for an
   **`active` (not merely non-declined — a revoked record is non-declined but
   invalid)**, unexpired agreement whose **canonical source-pack set + product
   class** covers *the actual sources this export derives from* (not the output
   product name — see §3.1), at `product_tier = T2`, for this requester/
   authority. None → `Declined { reason: "no active recorded FPIC agreement
   covering these sources" }` + row.
4. **Build the record** — `process = "<sovereign-process-name — owner picks>"`,
   `basis` = a sovereign basis string (NOT `PROVISIONAL_BASIS`),
   `authorized_by` = the agreement's recorded authority (tribal signatory or
   witnessed consenter — never the requester echo), `conditions` = the
   agreement's conditions (incl. expiry).
5. **Return `CeremonyRecord`** — the export pipeline writes `export.ceremony`
   with it **and `export.t2` as one atomic unit with the published product**
   (§5 requires this be made transactional — the current machinery appends the
   two rows separately, which a failure could tear).

This is a thin, auditable gate over an agreements store. It adds **one** new
store and **one** new gate impl behind the frozen trait, swapped at the single
composition point in `server.rs` `router()` — nowhere else.

### 3.1 Preconditions the floor + lookup depend on (design + test these)

The candidate above is only sound if these are part of the design (Codex
review, 2026-07-16):

- **Authoritative tiers.** `source_tier` must be the maximum *effective* tier
  of every actual source artifact (re-resolved/revalidated, not
  requester-supplied or stale); missing/unclassifiable sources resolve to T3.
  `product_tier` must be trusted and un-downgradable by the request.
- **Canonical source identity.** `ExportAuthorization` today carries a single
  `pack_id` that the caller fills with the *output product name*
  (`export.rs`), while an export can derive from **multiple** source packs.
  The seam needs a canonical **set** of source artifact identities (ids +
  hashes + effective tiers) for the agreement matcher, with the output product
  name a **separate** field. This is a seam extension B3/owner must specify.
- **Not the sole boundary.** The ceremony gate is one chokepoint; the
  architectural "T3 non-exportable/non-networkable" property is proven by the
  independent adversarial-egress + network-denial suites (B6/B7), not by
  ceremony unit tests.

## 4. Recorded-agreement store — proposed schema (owner edits freely)

A T3-tagged, append-only store (a GPKG table like the audit ledger, or a signed
JSON log). Proposed fields per agreement:

| Field | Meaning |
|---|---|
| `agreement_id` | Stable id (operator-assigned). |
| `kind` | `"tribal_signed"` \| `"individual_witnessed"`. |
| `source_scope` | Canonical **set** of source artifact ids (+ optional hashes) this authorizes — matched against the export's actual sources, NOT the output name. |
| `product_class` / `product_name` | The product class/name authorized (separate from `source_scope`). |
| `product_tier` | The tier authorized to export. **The store must REJECT any record not scoped to T2** (T3 is never authorizable) — a typed constraint, not prose. |
| `authority` | Tribal signatory, or the individual consenter. |
| `witnesses` + `witness_verification` | For `individual_witnessed`: witness identities AND the evidence they were verified (governance-config requires *verified* witnesses). |
| `method` | For `individual_witnessed`: `"verbal"` (the immutable semantics). |
| `document_reference` + `document_hash` | Reference (locator) + SHA-256 of the signed agreement doc. **The legal document bytes are never stored** — reference + hash only. |
| `acknowledged_at` | Signature/acknowledgment date (tribal formal-acknowledgment evidence). |
| `requester` / `app_identity` | Who the agreement authorizes to request. |
| `conditions` | expiry date; purpose limit; geography (optional). |
| `recorded_at` / `recorded_by` | Append-only provenance. |
| `status` | Typed state machine: `"active"` \| `"declined"` \| `"revoked"` \| `"superseded"`. The FPIC boolean is true **only** when `status == active` AND the kind-specific evidence above is complete; the store defines how `active` is produced (append-only; revocation is a later append that supersedes, never an in-place edit). |

The store is **T3** (it records sovereign consent). "T3" here must mean an
**artifact-level TSDF tag** (framework version + classification basis, verified
after create/open — not merely an app label), and the store must be **excluded
by construction** from catalog scans, file-serving, export, backup/sync, and
every network route (the same treatment the export ledger's reserved name
gets). "Never leaves the node" is a boundary to *design*, not an assertion.

### 4.1 The store needs REAL encryption (an independent B4 / DG-2 choice)

Routing through today's `AtRestCipher` is **not** encryption — the current
trait only *authorizes/refuses* a write and explicitly does not apply a cipher
(`crates/geobase-gpkg/src/cipher.rs`; `docs/DECISIONS.md` 2026-07-16 DG-2
spike). This T3 consent store (like the export ledger) needs the *real*
open/seal + atomic-replace + key-loss + corruption behavior that B4 implements
behind the DG-2 choice. **B4 is an independent owner-open decision; do not read
this proposal as implying the present seam protects bytes.**

## 5. Contract + integration tests the sovereign gate must pass

Unit tests in `ceremony.rs` can only prove the returned
`CeremonyRecord`/`ExportRefused` — the gate does **not** write audit rows.
Audit completeness + atomicity must be proven through `export_product` and the
HTTP route (integration/failure-injection), not unit tests.

**Contract (gate) tests:**
- **T3 refusal** (shipped CONTRACT TEST) — green against the sovereign gate.
- **Provisional-wording exclusivity** — the sovereign gate NEVER emits
  `PROVISIONAL_BASIS` (shipped CONTRACT TEST).
- **★ Floor-first PRECEDENCE (the decisive one, currently missing):** with a
  fully valid `active` T2 agreement AND an authenticated requester present,
  submit `(T3 source, T2 product)` and `(lower-tier source, T3 product)`;
  assert `TierNeverExports`, assert **the agreement store was never consulted**
  (a store spy with zero reads), and assert at the export/HTTP boundary that no
  product bytes exist and exactly the refusal audit outcome occurs. A plain T3
  refusal *without* an otherwise-authorizing agreement does NOT prove
  floor-first precedence.
- **No / declined / revoked / expired / superseded agreement → refused** (a
  revoked record is non-declined — test it explicitly), `export.refused` row,
  no product.
- **Wrong-scope / wrong-requester / wrong-authority agreement → refused.**
- **Malformed tribal (missing acknowledgment/reference) and malformed
  individual (missing witness verification / method) → refused** — row presence
  alone must not authorize.
- **Store unavailable / corrupt → fail closed**, no product.
- **Active agreement → authorized** — `authorized_by` = the agreement
  authority (not the requester); `basis` is the sovereign basis; positive tests
  for **both** immutable paths (tribal formal acknowledgment; witnessed verbal
  individual consent).
- **Unauthenticated requester → refused** even with an agreement present;
  generic refusal attribution (no body/requester echo).

**Audit atomicity (integration/failure-injection):**
- valid agreement → **exactly one** `export.ceremony` + **one** `export.t2`,
  committed **as one unit** with the published product (define a transactional
  publication protocol — the current code appends the two rows separately;
  a failure on the second append can orphan the first).
- every refusal → exactly one refusal row, no product/partial product.
- ledger open / first-append / second-append / seal failure → fail closed, no
  released product, a defined non-misleading audit state.

**Combined acceptance (B8/M5):** `verify-rstep.mjs`'s `EXPECT_BASIS` flips from
the provisional basis to the sovereign process name; the gate re-runs green
asserting the sovereign record, while the separate B6/B7 adversarial-egress +
network-denial suites prove all T3 export/network paths.

## 6. Owner decisions required (for Patrick's B2 sitting)

The full set of decisions this document surfaces but does **not** make. (An
earlier draft listed six; the Codex review correctly noted several more B2
semantics were silently defaulted in prose — they are all promoted here.)

| # | Decision | Options / note |
|---|---|---|
| 1 | **Requester identity (D1)** | per-app credential + operator-attested authority (a/b), or stronger (c)? |
| 2 | **Credential lifecycle** | who issues/rotates/revokes a requester credential; binding of credential → authority. |
| 3 | **Agreement store location (D3)** | local T3 store (recommended) vs the Phase 2.2 governance server. |
| 4 | **Store format** | T3 GPKG table (fits the in-artifact `gpkg_metadata` rule) vs a signed JSON log (needs an owner-approved artifact contract — a sidecar tag does not satisfy the rule). |
| 5 | **Source-scope semantics** | exact source set vs named collection vs product class; behavior when the source set or an artifact hash/version changes. |
| 6 | **Tribal formal-acknowledgment form** | signed agreement only, or another formal form (the immutable wording says "*typically* signed"). |
| 7 | **Individual-consent capture** | how witnesses are *verified* (governance-config requires verified witnesses); the `method="verbal"` evidence. |
| 8 | **FPIC-boolean derivation** | the exact kind-specific evidence that makes `status=active` true. |
| 9 | **Record authority** | who may record / activate / revoke / supersede / correct; how withdrawal takes effect in an append-only store; revocation precedence. |
| 10 | **Conditions (D4)** | enforce expiry in 1.0 (recommended)? geography/purpose enforced or record-but-advisory? clock/time-zone rules. |
| 11 | **Multiple/conflicting matches** | behavior when >1 agreement matches, or matches conflict; fail-closed when the store is unavailable. |
| 12 | **Sovereign process name** | the exact `process` string (distinct from the basis string). |
| 13 | **Basis string** | the exact sovereign `basis` wording — it becomes the `EXPECT_BASIS` the RStep gate asserts at B8. |
| 14 | **T3 store lifecycle** | retention, local backup/restore, key-loss, access control for the consent store (interacts with the DG-2 cipher). |
| 15 | **Cipher (DG-2, already owner-open)** | the real at-rest cipher for the ledger AND this consent store — an independent decision (`docs/DECISIONS.md` 2026-07-16). |

**Readiness note (corrected):** answering the above specifies **B3** (the gate
+ store + seam extension). **B4** remains an independent DG-2 cipher choice +
implementation contract; **B5** needs the credential lifecycle/revocation +
binding semantics (rows 2, 9), not just the identity choice (row 1). The
combined 1.2+1.3 acceptance (B8/M5) runs the RStep gate against the real
mechanism — exactly once — only after B3+B4+B5+B6+B7 land.

## 7. What this proposal deliberately does NOT do

- It does not compose or swap any gate (`ProvisionalDevGate` remains the only
  composed gate).
- It does not decide FPIC semantics (those are `governance-config.yaml` +
  Patrick's authority).
- It does not authorize any export or ratify DG-1.
- It does not add code — it is a design menu. B3 is the implementing phase,
  after the owner's B2 decisions above.
