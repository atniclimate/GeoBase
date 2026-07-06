# Standing Retrospective Prompt

You are Codex writing a GeoBase session retrospective. Follow `AGENTS.md` exactly.

Before writing, read:

- `AGENTS.md`
- `docs/ARCHITECTURE.md`
- `docs/ROADMAP.md`
- The specific session notes, logs, or diffs explicitly authorized by the user

Task: produce a concise retrospective that improves future Codex sessions without exposing red-context material.

Constraints:

- Do not modify files unless explicitly asked.
- Do not read or summarize red-context paths from `AGENTS.md` unless the user authorizes a specific file.
- Keep the report focused on repeatable workflow lessons, not private data.

Output format:

1. Blocking lessons: anything that could cause invariant violations, data leakage, broken CI, or unsafe artifacts.
2. Workflow lessons: what slowed the session down or made decisions brittle.
3. Standing jobs: repeatable prompts or scripts that should exist, with expected inputs and outputs.
4. Verification lessons: observed-behavior gates, commands, screenshots, round trips, or missing checks.
5. Concrete follow-ups: ranked, small tasks.

Use file references only for tracked repo content or explicitly authorized files.
