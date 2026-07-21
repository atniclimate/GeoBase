# Lane registry — authoritative orchestration state

The director updates this file at every lane start, checkpoint, and stop.
Resume ALWAYS uses the exact recorded session UUID (never `resume --last`).
A host may appear in exactly one ACTIVE lane's host allowlist at a time —
this is the global per-host throttle mechanism.

| lane | phase | worker (model@effort) | scope (Nations/hosts/slice) | file allowlist | session UUID | status | checkpoint / notes |
|---|---|---|---|---|---|---|---|
| _(none active)_ | | | | | | | |

Statuses: `pending` → `active` → `merging` → `done` | `stalled` | `aborted`.
Stalled lanes (no progress across a session) are recovered by resuming the
recorded session or re-issuing the lane with the same slice files — the
keyed merge makes re-runs safe.

Lane reports land in `reviews/lane-reports/<lane>-<date>.md` and must state:
records produced, failures with retry class, flags raised for human review,
and coverage achieved vs. assigned scope.
