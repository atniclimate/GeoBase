# CeremonyGate — Phase 1.2 handoff (for Patrick)

Phase 1.3 ships the **seam**: `geobase_gpkg::ceremony::CeremonyGate`, the
trait every export authorization passes through, plus `ProvisionalDevGate`,
the only implementation until Phase 1.2. This note lists exactly what 1.2
must implement against the trait. The ceremony *mechanism* — the sovereign
process itself — is deliberately not designed here; that was 1.2's work and
authority. **The mechanism design is now ratified**
(`docs/CEREMONY-DESIGN.md`, 2026-07-16), and **B3 has landed against it**:
the sovereign `RecordedConsentGate`
(`geobase_gpkg::consent_gate`) is the gate composed at the single
`server.rs` `router()` composition point — `ProvisionalDevGate` survives
only for tests and store-less tooling. B4 (cipher), B5 (credentials), and
the single combined acceptance (B8) remain open: **green gates are still
not acceptance.** Where this handoff note and that design differ, the
design of record wins (clauses 2 and 5 below are amended by it).

## The seam as shipped (Phase 1.3)

```rust
pub trait CeremonyGate {
    fn authorize_export(&self, auth: &ExportAuthorization<'_>)
        -> Result<CeremonyRecord, ExportRefused>;
}
```

- `ExportAuthorization` carries: pack id, **source tier** (effective tier of
  what the product derives from), **product tier** (what the export is
  stamped), requester, optional purpose.
- `CeremonyRecord` carries: process name, basis, authorized_by, conditions.
  The export pipeline writes `record.audit_details(...)` as the
  `export.ceremony` audit row. **Current state (B3, landed): the
  `export.ceremony` and `export.t2` rows are sealed in ONE SQLite
  transaction inside the recoverable publication protocol
  (`docs/CEREMONY-DESIGN.md` §6) — intent → staged bundle → seal →
  atomic rename → finalize, with startup recovery. The pre-B3 torn-pair
  defect is closed.** The RStep gate (1.3d) asserts the full protocol
  row sequence, so no export path can skip the seam and still pass CI.
- `ProvisionalDevGate` authorizes T0–T2 with the basis **verbatim**:
  `"provisional — no sovereign ceremony process ran (Phase 1.2 pending)"`
  (`ceremony::PROVISIONAL_BASIS`), and **refuses T3 unconditionally** —
  the dev seam must not be the hole in invariant §3.

## What Phase 1.2 must implement

A sovereign implementation of `CeremonyGate` that replaces
`ProvisionalDevGate` at the node's composition point (the export route in
`geobase-engine-desktop` takes the gate as a trait object/generic — swap
happens there, nowhere else). It must:

1. **Bind to the FPIC process.** `authorize_export` consults the actual
   permissions ceremony (however 1.2 designs it: recorded consent,
   councils, delegated authorities). The `process` field names that
   process; `authorized_by` names the real authority, never the requester
   echo.
2. **Authenticate the requester.** The seam currently passes an actor
   string. **Amended 2026-07-16 (`docs/CEREMONY-DESIGN.md` §2.4, §7):** the
   owner decided the free-text `requester` is **REPLACED by typed identity
   at B3 — one deliberate, recorded breaking seam change**, not a
   non-breaking addition as this clause originally promised (a deprecated
   free-text identity field would be a shadow path the ratified "no free
   text" rule exists to kill). Identity is `ExportIdentity`
   (LocalOperator-only issuable in 1.0); the session id is the one
   genuinely non-breaking addition.
3. **Keep the tier floor.** T3 must remain refused *by construction* —
   keep returning `ExportRefused::TierNeverExports` for T3 source or
   product regardless of any consent recorded. This is an invariant, not a
   policy default (AGENTS.md §3).
4. **Never emit the provisional basis.** `PROVISIONAL_BASIS` belongs to
   the dev gate alone. The 1.3d gate treats its presence as "no sovereign
   process ran"; a sovereign gate emitting it would mislabel real consent.
5. **Record conditions.** If the ceremony attaches conditions (expiry,
   geography, purpose limits), they travel with the audit trail.
   **Amended 2026-07-16 (`docs/CEREMONY-DESIGN.md` §2.5):** the free-text
   `CeremonyRecord::conditions` vec this clause originally named is
   **abolished at B3**, replaced by a typed `Conditions` struct; expiry is
   enforced fail-closed in 1.0, geography/purpose are
   recorded-but-advisory.
6. **Handle refusal as a first-class outcome.** `ExportRefused::Declined`
   with a reason the requester can read; the pipeline writes the refusal
   audit row and returns 403 — no partial exports, no silent drops.
7. **Keep the contract tests green.** `ceremony.rs` marks two tests as
   CONTRACT TESTS: T3 refusal (run it against the 1.2 gate too) and
   provisional-wording exclusivity. Add equivalents for the sovereign
   implementation in 1.2's own test suite.

## Where the seam is consumed (as of 1.3)

- `export_product()` (1.3b) calls the gate before writing anything; the
  ceremony record and the `export.t2` row both land in the audit trail
  (as two separate appends today — see the current-state note above; the
  B3 publication protocol makes them one prepared transaction).
- `POST /api/export` (engine-desktop) constructs `ExportAuthorization`
  from the request + catalog tier and passes the node's configured gate.
- The RStep gate (1.3d) asserts: export succeeded ⇒ trail contains
  `export.ceremony` with the provisional basis (until 1.2 replaces it —
  then the assertion flips to the sovereign process name; that flip is
  1.2's one-line gate change, listed here so it isn't forgotten).
