# /pickup — resume GeoBase from the documented state

Resume work from the canonical resume point. Read before changing anything.

1. Confirm repo root `C:\dev\GeoBase`, branch, and remote state
   (`git status -sb`, `git log --oneline -5`, `git fetch` if network is fine).
2. Read `docs/ROADMAP.yaml` — the machine-readable index. Its `resume:` block
   names the current phase/step and the exact next microtask. **Subordination
   rule:** if it disagrees with `docs/ROADMAP.md` (acceptance authority),
   `PLAN_1.0.md` (task authority), or `docs/DECISIONS.md`, the documents win —
   fix the YAML in the next commit.
3. Read the `required_reading` list in the resume block, starting with the
   current handoff in `docs/handoffs/` (gitignored, local-only — if missing on
   this machine, reconstruct state from ROADMAP.yaml + DECISIONS.md + git log).
4. Check for repo changes made after the last true-up
   (`git log --oneline <verified_green_commit>..HEAD`).
5. Review pending decision gates in ROADMAP.yaml. Do NOT begin a step whose
   `blocks_progress: true` gate is pending — those are owner (Patrick) acts.
   The major-start interview for the current cycle must be `completed`.
6. Summarize the state in plain language, state the intended next action, then
   begin the next microtask if nothing blocks it.

Hard boundaries (always): no acceptance flips (B8's single commit is the sole
acceptance act, owner-observed), no DG ratifications, no scope changes, no PR
merges — surface these to Patrick. Gitignored/local material never goes into
Codex prompts (`AGENTS.md` data gate).
