# GeoBase Sovereign Ceremony — Design of Record (B2)

> **STATUS: RATIFIED 2026-07-16 by Patrick Freeland (owner).** This is the
> normative design the Phase B sovereignty core (B3–B5, B8) implements
> against. It resolves `PLAN_1.0.md` **B2** and supersedes the DRAFT
> `docs/CEREMONY-DESIGN-PROPOSAL.md` (retained as decision-support history).
> Every decision here was made by the owner at the 2026-07-16 sitting,
> recorded in `docs/DECISIONS.md` (same date, which also cites the
> adversarial design review whose blocking findings shaped §4, §5.1, §5.3,
> and §6 — review references live in the decision log, not here; this
> document stands on its normative content).
>
> **This document designs the mechanism. It does not accept anything.**
> `ProvisionalDevGate` remains the only composed gate until B3 lands, and
> Phases 1.2/1.3 remain not-accepted until the single combined acceptance
> at B8 (`docs/RELEASE-DEFINITION.md`, acceptance-integrity rule).

## 1. Fixed constraints (inputs, not choices)

- The seven `docs/CEREMONY-GATE.md` clauses, as amended by this document
  (clause 2's non-breaking promise and clause 5's conditions carrier are
  superseded — see §2.4, §2.5).
- `governance-config.yaml` `fpic_semantics` (IMMUTABLE): tribal sharing =
  formal acknowledgment, typically a signed agreement; individual consent =
  verbal with verified witnesses; the FPIC boolean gates **T2 derived-product
  export only**; **T3 has no export path, ever** (`AGENTS.md` §3).
- `docs/RELEASE-DEFINITION.md` (RATIFIED) acceptance properties: fail-closed
  cipher; T2 export requires a recorded agreement; complete audit trail;
  authenticated requester.
- Lost-key policy: **deliberately unrecoverable** (owner, 2026-07-07). No
  escrow, no master key, no recovery path — the adversarial review checks
  for its *absence*.

## 2. The typed schema (normative shapes; field types finalized at B3)

### 2.1 `ExportIdentity` — who performed the authorization act

```rust
pub enum ExportIdentity {
    /// The enrolled local operator: an OS-keychain-protected signing
    /// credential bound to the OS account (SID/UID) at enrollment.
    LocalOperator { enrollment_ref: /* opaque enrollment id */ },
    /// A delegated tribal authority. SCHEMA-PRESENT BUT UNISSUABLE in 1.0:
    /// no production issuance path exists until the owner ratifies a
    /// Tribal-authority issuer ceremony (operator-issued delegation is
    /// rejected as a sovereignty inversion — node custody must never mint
    /// Tribal authority).
    TribalDelegate { token: /* opaque; unissuable in 1.0 */ },
}
```

No free text, no app-identity variant. Ratified 2026-07-08; confirmed
2026-07-16 with the §2.3 split.

### 2.2 `ConsentBasis` — the evidence (re-ratified richer, 2026-07-16)

The 2026-07-08 single-string forms are **re-ratified** to carry structured
evidence so an evidence-thin authorization is *unconstructible*:

```rust
pub enum ConsentBasis {
    /// Tribal data: a formal signed agreement.
    SignedAgreement {
        document_ref: /* non-empty opaque reference; NEVER dereferenced
                         over any network during authorization */,
        document_hash: /* validated 32-byte SHA-256 digest type */,
        acknowledged_at: /* valid UTC instant; not future-dated */,
    },
    /// Individual data: verbal consent with verified witnesses.
    /// The verbal method is encoded by the variant, not a caller string.
    WitnessedVerbal {
        witnesses: /* non-empty typed collection of witness identities */,
        verification_attestation: /* non-empty: who verified the witnesses
                                     and by what method */,
    },
}
```

Constructors return `Err` on any violation (semantic validation, not mere
non-emptiness). The node cannot verify a human; it requires and immutably
binds the recorder's **attestation** that verification happened — that is
what "verified witnesses" means mechanically. Legal-document bytes are
never stored: reference + hash only.

### 2.3 `FpicAuthorization` and the authority-of-record split

```rust
pub struct FpicAuthorization {
    pub target_tier: Tier,          // MUST be T2; constructor rejects T3
    pub fpic_satisfied: bool,       // MUST be explicitly true; only ever
                                    // derived from an active,
                                    // evidence-complete store record
    pub consent_basis: ConsentBasis,
    pub authorized_by: ExportIdentity, // WHO PERFORMED the act (authenticated)
    pub timestamp: /* UTC instant */,
}
```

`authorized_by` and the authority-of-record are **two different facts**:

- `authorized_by: ExportIdentity` — the authenticated actor who performed
  the ceremony act at export time.
- `CeremonyRecord.authority_of_record` — the tribal signatory or witnessed
  consenter **copied from the agreement store record**, never
  request-supplied. This satisfies clause 1 ("names the real authority,
  never the requester echo"): the anti-echo property lives in the store —
  consent evidence must pre-exist as a separately recorded act.

Type-floor honesty (recorded so no one overclaims): `FpicAuthorization`
carries no `source_tier`; the T3 floor's **source half** is enforced by the
gate on the **node-derived effective source tier** (§5.1 steps 1–2 —
`ExportAuthorization.source_tier` stops being an independently trusted
input at B3; the gate consumes only session-derived provenance) and proven
by the floor-first precedence test (§11). The type makes a T3 *target*
unconstructible; it does not by itself prove the source floor.

### 2.4 `CeremonyRecord` (breaking change at B3, recorded)

`CeremonyRecord` gains: `authority_of_record` (§2.3), typed `Conditions`
(§2.5), `observed_at` (§2.5 — the node-clock UTC instant the authorization
actually used), and `consent_store_sequence` (§10). The free-text `requester` on
`ExportAuthorization` and the free-text `conditions: Vec<String>` are
**REPLACED, not extended** — one deliberate breaking seam change at B3,
with the harness and the trusted ledger reader updated in the same phase
branch. This supersedes `CEREMONY-GATE.md` clause 2's non-breaking wording
(corrected there): a deprecated free-text identity field would be a shadow
path the ratified "no free text" rule exists to kill.

### 2.5 `Conditions` — typed home (the free-text vec is abolished)

```rust
pub struct Conditions {
    /// Full UTC instant, resolved BY THE HUMAN at recording time —
    /// code never interprets a date.
    pub expires_at: Option</* UTC instant */>,
    pub purpose_limit: Option<String>,   // recorded agreement terms
    pub geography_limit: Option<String>, // recorded agreement terms
}
```

**1.0 enforcement:** expiry is **enforced fail-closed** (expired →
`Declined`, refusal row, no product). Geography and purpose are
**recorded-but-advisory** in 1.0. Export-time comparison uses the node's
UTC clock; an invalid or unavailable clock is an **infrastructure failure**
(§5.3), never an authorization. **The exact node-clock instant used for
the expiry comparison is recorded**: it is `FpicAuthorization.timestamp`,
copied into `CeremonyRecord.observed_at` and thence into the
`export.ceremony` row — the audit trail proves *which time* made the
decision, not merely that a decision was made (asserted by the expiry
tests, §11).

## 3. The consent store

A **separate local T3 GPKG artifact** alongside the export ledger: its own
reserved name, append-only-by-trigger, artifact-level TSDF tags
(`gpkg_metadata`), excluded by construction from catalog scans,
file-serving, export, every **automatic or network backup/sync
integration**, and every network route, and sealed by the DG-2 envelope
when B4 lands. The **sole permitted copy path** is the owner-directed
offline backup of the sealed, closed artifact defined in §9 — the
exclusion and §9 are one rule, not a contradiction. It is the system of record for agreement
**status, matching, and revocation**; the ledger row is self-contained for
**evidence** (§2.2).

### 3.1 Event model

Every write is an event with: immutable `event_id`; subject
`agreement_id`; **monotonic store sequence** (assigned by the store);
`event_kind` (`recorded` | `revoked` | `superseded_by` | `corrected_by`);
`recorded_at` (UTC); optional `supersedes: agreement_id`. **Status
resolution uses the store sequence, never evidence timestamps** —
`acknowledged_at` and expiry are evidence/condition times, not ordering.

### 3.2 Agreement record (proof-core vs evidence classes)

Per agreement: `agreement_id`; `kind` (tribal_signed |
individual_witnessed); `source_scope` (set of source pack ids);
`product_class`; `product_tier` — **the store rejects any record not
scoped to T2** (typed constraint); the §2.2 evidence fields;
authority-of-record; requester binding; `Conditions`; recording
provenance. Fields are partitioned into two schema classes (§9): the
permanent **proof-core** (ids, kinds, scope, status lineage, hashes,
timestamps) and **identifying evidence detail** (witness identities,
attestations, document locators) with owner-governed retention.

### 3.3 Lifecycle authority

Recording is a **LocalOperator act**; delegates request exports, they do
not record ceremonies. A record is **active the moment it is recorded
evidence-complete** — no separate activation step in 1.0. Revocation,
supersession, and correction are later appends (correction *is*
supersession); effects apply at the next authorization check —
authorization results are never cached.

## 4. Source-set provenance: node-witnessed export sessions

Today the request body declares `source_packs` — the node verifies the
declared packs exist but cannot verify completeness, so a caller could
omit a contributing higher-tier pack. **B3 closes this:**

- The node issues an unforgeable **export session id** when the app begins
  work; every pack the node serves into that session is accumulated **by
  the node**.
- At export, the request names the session; the source set is **the node's
  own record — every pack served, period**. The request can neither add
  nor subtract. Deliberate over-counting is the point: it fails closed,
  because "prove the operator didn't use it" is not a game the node can
  win.
- No valid session → refuse. Effective tiers are re-resolved from the
  catalog at export time; missing/unclassifiable → T3 → the floor refuses.
- The session id travels through the SoLO SDK as a non-breaking addition;
  the output product name is a separate seam field (never a match input).
- Hashes recorded at signing time are **evidence**, not match criteria;
  the ceremony row records agreement-time evidence hashes and export-time
  resolved source identities under **distinct field names**. Accepted
  residual (owner, 2026-07-16): a same-tier content change does not
  re-trigger ceremony in 1.0.

## 5. Authorization algorithm

### 5.1 Order (each step fail-closed)

1. **Resolve the session and derive the authoritative tiers** (§4) —
   invalid/absent session → refuse. The node re-resolves **every pack its
   session record accumulated** against the catalog; the effective source
   tier is the maximum across that set, with missing/unclassifiable packs
   resolving to T3. This step touches neither the consent store nor any
   product write, and nothing requester-supplied can add to, subtract
   from, or downgrade the result. **The floor cannot run before this step,
   because before it the node does not know the true source tier** — a
   floor evaluated on a claimed tier is the T3-omission bypass this design
   exists to close.
2. **T3 floor** — node-derived `effective_source_tier == T3 ||
   product_tier == T3` → `TierNeverExports`, **before authentication and
   before any consent-store access** (proven by the floor-first precedence
   test, §11, whose floor input is required to be the session-derived
   tier). `ExportAuthorization.source_tier` ceases to be an independently
   trusted input at B3: the gate consumes only the node-derived value.
3. **Authenticate** the requester (§7) — else `Declined`, generic
   attribution, refusal row.
4. **Match** (§5.2) — expiry filtering happens **before** multiplicity
   evaluation.
5. **Construct** the `FpicAuthorization` from the matched store record
   (evidence carried forward; `fpic_satisfied` derived, never asserted).
6. **Record** via the publication protocol (§6).

### 5.2 Matching: explicit lineage, no inference

- **ID-scoped subset match:** every pack in the session-derived source set
  must be covered by the matched agreement's `source_scope`.
- **No unions in 1.0:** exactly one agreement authorizes one export (the
  self-contained evidence row carries one agreement's evidence). If
  multiple partial permissions are legitimate, the human process records a
  new composite agreement.
- **Explicit lineage head:** a new agreement may explicitly supersede named
  predecessors. Exactly **one active lineage head** must fully cover the
  source set. Precedence is only ever something a human recorded — never
  inferred from timestamps.
- **Revoking a head suspends its lineage** — no automatic fallback to
  ancestors, ever.
- **Independent duplicate coverage refuses** until the operator records how
  the agreements relate or withdraws one.

### 5.3 Refusal taxonomy: governance vs infrastructure

- **Governance denial** — no/expired/revoked/superseded/wrong-scope/
  wrong-requester agreement, malformed evidence, unauthenticated requester:
  `Declined { reason }`, exactly one refusal row, HTTP 403.
- **Infrastructure failure** — consent store unavailable/corrupt/
  unreadable, invalid clock, ledger failures: **HTTP 503**, no product, an
  infrastructure-failure audit row *attempted*; if the ledger itself is
  unavailable, the response states that no durable audit row was possible.
  A technical outage is never attributed to the sovereign ceremony —
  "every refusal recorded" cannot truthfully include states where the
  audit artifact itself is down, and acceptance tests this degraded state
  honestly rather than fabricating completeness.

## 6. Publication protocol: recoverable atomic publication

One SQLite transaction cannot atomically publish multi-file products —
"one atomic unit" taken literally is unimplementable, so the design is a
**recoverable state machine** in which every crash point has a defined,
truthful meaning (never described as cross-resource ACID):

1. Append an **intent** row.
2. Write and verify the product bundle in a hidden staging area on the
   same volume.
3. In **one SQLite transaction**, append exactly one `export.ceremony` and
   one `export.t2`, both marked `prepared`, carrying product hashes and a
   publication id; durably seal the ledger.
4. **One atomic namespace operation** (directory or manifest-pointer
   rename) publishes the bundle.
5. Append `export.published` (finalize). The HTTP success response occurs
   **only after finalization**.
6. Startup recovery verifies hashes for any prepared-but-unfinalized
   publication and either finalizes or appends an abort.

Failure injection at every crash point (ledger seal, rename, finalize,
process kill, recovery) is part of the B3 test bar (§11).

## 7. Credentials (1.0)

- **LocalOperator-only.** One enrolled local operator credential: a random
  signing credential protected by the OS keychain (DPAPI/Credential
  Manager on Windows; Secret Service on Linux), bound to the OS account
  (SID/UID) at enrollment. **Fail-closed if no secure keyring exists** —
  never a plaintext reusable token on disk. Challenge-signing preferred
  over static bearer.
- **OS-peer-identity boundary:** export authorization moves behind Tauri
  IPC / named pipe / Unix domain socket where OS peer identity is
  observable. Plain loopback HTTP alone can no longer authorize an export;
  if HTTP remains the transport, it requires a short-lived credential
  minted over the OS-verified channel. (Owner decision 2026-07-16 —
  accepted B5 scope.)
- **`TribalDelegate` is unissuable** until the owner ratifies who may
  delegate Tribal authority and how that is evidenced. Implementation
  pressure does not answer governance questions.
- The A1 interim export token (`x-geobase-export-token`) retires at B5.
- Credential lifecycle events (enroll/rotate/revoke) are store events with
  event ids and monotonic sequence; bindings are checked on every
  authorization; revocation success is acknowledged only after the store
  is durably resealed.

## 8. Constants

```
process = "geobase-recorded-consent-check-v1"
basis   = "active recorded consent evidence matched for T2 derived-product export"
```

`process` and `basis` are distinct audit fields. **B8 asserts both
independently** — `process == EXPECT_PROCESS`, `basis == EXPECT_BASIS`,
and `basis != PROVISIONAL_BASIS`. The basis deliberately claims only what
the code establishes: an active recorded evidence-complete agreement
matched — never legal sufficiency, never that advisory conditions were
enforced. Renaming either constant is an audit-schema migration.

## 9. Lifecycle: retention, compaction, backup (both T3 artifacts)

Because the ledger row is self-contained (§2.2), identifying evidence
lives in **both** the consent store and the export ledger — lifecycle
policy covers both:

- **Proof-core is permanent and append-only:** ids, event kinds, scope,
  status lineage, hashes, timestamps — always sufficient to prove what was
  authorized or withdrawn, and when.
- **Identifying evidence detail** (witness identities, attestations,
  document locators) is a separable schema class with an owner-set
  retention period. **Compaction is a future explicit sovereign act** — a
  signed/hashed compaction record replaces detail while proof hashes
  remain. **Nothing auto-deletes in 1.0**; the schema separation ships so
  minimization is structurally possible, the tooling is backlog.
- **Backup:** operator-driven copy of the **sealed, closed artifact
  only**; keys stored separately; never networked; no in-product
  consent-store export path exists, ever (it is T3). Every artifact
  carries a monotonic sequence/head; **restore enters fail-closed
  reconciliation if the backup's head is behind the node's last-known
  head** (anti-rollback: an old backup must not resurrect revoked
  consent). This is availability backup; after key loss it is ciphertext
  garbage **by design**.

## 10. DG-2 interface assumptions (confirmed 2026-07-16)

The consent store and export ledger seal under the B4 cipher: pure-Rust
XChaCha20-Poly1305 file envelope, Argon2id passphrase-primary (keyfile as
a documented advanced mode, never stored beside artifacts), per-artifact
locks with serialized writers, synchronous reseal before success, and a
versioned AEAD-authenticated header carrying a **monotonic sequence +
previous-envelope hash** (feeds §9 anti-rollback). Export linearization:
snapshot the consent-store sequence at authorization, revalidate at the
publication point (§6 step 3/4 boundary), and record the sequence in
`export.ceremony` — a revocation committing after that point governs the
next export. The envelope is confirmed for these two bounded stores
**only**; large-artifact T3 staging closure is **B4b**, a named condition
precedent to B6/B8 (`docs/DECISIONS.md` 2026-07-16).

## 11. Contract + failure-injection tests (the B3/B8 bar)

Gate contract tests (in addition to the two shipped CONTRACT TESTS, which
must pass against the sovereign gate):

- **★ Floor-first precedence** (decisive): with a fully valid active T2
  agreement AND an authenticated requester present, drive a session whose
  **node-witnessed** source set is (T3 source, T2 product) and one that is
  (low source, T3 product); assert `TierNeverExports`, assert the consent
  store was **never consulted** (store spy, zero reads), and assert at the
  HTTP boundary no product bytes exist. **The floor input must be the
  session-derived effective tier — a test that injects `source_tier`
  directly proves nothing about this design.**
- **★ Omitted-pack floor test** (the bypass this design closes): the
  request claims/declares only low-tier input while the node's session
  record contains a T3 pack; assert `TierNeverExports`, zero consent-store
  reads, zero product bytes.
- No / expired / revoked / superseded / wrong-scope / wrong-requester
  agreement → `Declined` + row, no product. Revoked-lineage-head → refused
  with **no ancestor fallback** (test it explicitly).
- Independent duplicate full coverage → refused until related.
- Malformed tribal (missing hash/date/reference) and malformed individual
  (missing witnesses/attestation) evidence → unconstructible at the type
  level; store-side incomplete records → refused (row presence alone never
  authorizes).
- Session provenance: request cannot add or subtract source packs; absent/
  invalid session → refused; omitted-pack attack (declare fewer packs than
  served) → the node's set wins.
- Unauthenticated requester → refused even with a valid agreement.
- Store unavailable/corrupt → **503 infrastructure failure** (distinct
  from `Declined`), no product.
- Provisional-wording exclusivity: the sovereign gate never emits
  `PROVISIONAL_BASIS`; B8 asserts `EXPECT_PROCESS` and `EXPECT_BASIS`
  separately.
- Positive paths: both consent kinds authorize; `authorized_by` is the
  authenticated identity; `authority_of_record` equals the store record's
  authority; conditions carried; consent-store sequence recorded;
  `observed_at` present and equal to the instant the expiry comparison
  used (the expiry tests assert this on both the authorized and the
  expired-refusal paths).

Publication failure injection (§6): crash at every state transition;
recovery finalizes or aborts truthfully; success response only after
finalization; exactly one `export.ceremony` + one `export.t2` per export.

## 12. What this document does not do

- It does not compose or swap any gate — that is B3, implemented against
  this design.
- It does not accept Phase 1.2 or 1.3 — acceptance happens exactly once,
  at B8, against the real mechanism (`docs/RELEASE-DEFINITION.md`).
- It does not implement the cipher — that is B4/B4b behind the confirmed
  DG-2 choice.
- It contains no consent content: no real agreement parties, agreements,
  hashes of real documents, witness data, tokens, or key material — and
  never will. (The owner's name appears above solely as the ratifying
  authority — a governance record, not consent content.)
