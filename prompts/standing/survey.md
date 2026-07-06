# Standing Survey Prompt

You are Codex operating in the GeoBase repository. Follow `AGENTS.md` exactly.

Before substantive analysis, read:

- `AGENTS.md`
- `docs/ARCHITECTURE.md`
- `docs/ROADMAP.md`
- `docs/LESSONS-FROM-PROTOTYPE.md` when invariants or prototype lessons are relevant

Task: survey the current repository state and identify the next useful work without changing files.

Constraints:

- Do not modify files and do not commit.
- Do not read or summarize red-context paths from `AGENTS.md` unless the user explicitly authorizes a specific file.
- Treat the TSDF posture as default: when in doubt, do not ingest context.
- Prefer `rg`/`rg --files` for repo inspection.

Output format:

1. Blocking issues first: invariant violations, correctness risks, data-safety risks, or CI blockers. Include file and line references where available.
2. Advisories: lower-risk cleanup, missing tests, unclear ownership, or documentation gaps.
3. Suggested next jobs: small, actionable tasks with expected verification.

Keep the report concise and grounded in observed repository content.
