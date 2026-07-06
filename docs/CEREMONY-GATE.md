# CeremonyGate — Phase 1.2 handoff (for Patrick)

Phase 1.3 ships the **seam**: `geobase_gpkg::ceremony::CeremonyGate`, the
trait every export authorization passes through, plus `ProvisionalDevGate`,
the only implementation until Phase 1.2. This note lists exactly what 1.2
must implement against the trait. The ceremony *mechanism* — the sovereign
process itself — is deliberately not designed here; that is 1.2's work and
authority.

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
  The export pipeline writes `record.audit_details(&auth)` as the
  `export.ceremony` audit row **in the same transaction discipline as the
  export itself**; the RStep gate (1.3d) asserts the row exists, so no
  export path can skip the seam and still pass CI.
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
   string. 1.2 decides the identity mechanism (per-app tokens were already
   flagged in the 1.0 loopback decision, docs/DECISIONS.md) and extends
   `ExportAuthorization` with whatever identity evidence it needs — new
   fields are non-breaking; the struct is the extension point.
3. **Keep the tier floor.** T3 must remain refused *by construction* —
   keep returning `ExportRefused::TierNeverExports` for T3 source or
   product regardless of any consent recorded. This is an invariant, not a
   policy default (AGENTS.md §3).
4. **Never emit the provisional basis.** `PROVISIONAL_BASIS` belongs to
   the dev gate alone. The 1.3d gate treats its presence as "no sovereign
   process ran"; a sovereign gate emitting it would mislabel real consent.
5. **Record conditions.** If the ceremony attaches conditions (expiry,
   geography, purpose limits), they go in `CeremonyRecord::conditions`
   so they travel with the audit trail. Enforcement of conditions at
   export time is 1.2 scope.
6. **Handle refusal as a first-class outcome.** `ExportRefused::Declined`
   with a reason the requester can read; the pipeline writes the refusal
   audit row and returns 403 — no partial exports, no silent drops.
7. **Keep the contract tests green.** `ceremony.rs` marks two tests as
   CONTRACT TESTS: T3 refusal (run it against the 1.2 gate too) and
   provisional-wording exclusivity. Add equivalents for the sovereign
   implementation in 1.2's own test suite.

## Where the seam is consumed (as of 1.3)

- `export_product()` (1.3b) calls the gate before writing anything; the
  ceremony record and the `export.t2` row land in the audit trail
  together.
- `POST /api/export` (engine-desktop) constructs `ExportAuthorization`
  from the request + catalog tier and passes the node's configured gate.
- The RStep gate (1.3d) asserts: export succeeded ⇒ trail contains
  `export.ceremony` with the provisional basis (until 1.2 replaces it —
  then the assertion flips to the sovereign process name; that flip is
  1.2's one-line gate change, listed here so it isn't forgotten).
