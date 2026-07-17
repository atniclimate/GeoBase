# /trueup — GeoBase clean-stop: verify, document, commit, push, stop

Leave the project clean, coherent, verified, and recoverable. Do NOT begin the
next major task afterward.

1. **Inspect:** branch, remote, `git status`, uncommitted/untracked work.
2. **Validate what changed this session.** Code touched → run the battery:
   `cargo fmt --all --check`; `cargo clippy --workspace --all-targets -- -D warnings`;
   `cargo test --workspace`; `cargo build --workspace --release`;
   `node solo/rstep/scripts/verify-rstep.mjs` (kill orphaned GeoBase-path
   `node.exe` gate processes first; gate stdout block-buffers to file).
   Docs-only → validate YAML parse + link targets instead. Record any check
   not run and why.
3. **Reconcile docs:** README accurate; `docs/ROADMAP.yaml` statuses + resume
   block current (update `last_trueup` and `verified_green_commit`); PLAN_1.0.md
   checkboxes match reality; superseded docs get in-file STATUS banners +
   a `docs/DECISIONS.md` entry when a decision was made (physical file moves
   are deferred to post-1.0 per DG-5 — do not relocate docs).
4. **Memory:** update the auto-memory project file only with durable lessons or
   status milestones (never session ephemera).
5. **Handoff:** refresh `docs/handoffs/` current handoff (gitignored): state,
   what changed, validation results, exact next microtask, blockers, pending
   gates, required reading, stop conditions.
6. **Safety review of the diff:** no secrets/tokens/keys; no data files
   (*.gpkg/*.tif/…); no gitignored material; no unintended scope.
7. **Commit** in few logical commits; **push**; verify push (`git status -sb`
   shows in-sync) and confirm CI workflows green on the pushed SHA
   (`gh run list --branch main`). If push fails: keep commits, record the exact
   error + the command to retry — never report success.
8. **Stop** at the documented resume point. Owner-reserved acts (acceptance
   flips, DG ratifications, merges, scope changes) are never part of /trueup.
