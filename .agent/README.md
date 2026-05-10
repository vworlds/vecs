# Agent Instructions

This directory contains repo-specific instructions for AI coding agents and humans who want the same operating rules.

The structure is intentionally tool-agnostic. Any agent can read plain Markdown from here without depending on OpenCode, Claude, Cursor, Codex, or another app-specific format.

## Layout

- `rules/`: durable policies that apply across tasks.
- `workflows/`: step-by-step procedures for recurring task types.

Use this structure for repo-specific agent instructions:

```text
.agent/
  README.md
  rules/
    commits.md
    formatting.md
    testing.md
  workflows/
    bug-fix.md
    feature.md
```

Put durable rules in `.agent/rules/`:

- Commit message format and commit policy: `rules/commits.md`.
- Formatting, linting, hooks, and CI checks: `rules/formatting.md`.
- Test requirements, test locations, mocking style, and assertion standards: `rules/testing.md`.

Put step-by-step procedures in `.agent/workflows/`:

- Bug investigation and fix flow: `workflows/bug-fix.md`.
- Feature implementation flow: `workflows/feature.md`.
- Release, publish, or deploy flows: `workflows/release.md`.

## Updating Instructions

Keep `AGENTS.md` as the short routing index. Put detailed instructions here instead:

- Add or update commit rules in `rules/commits.md`.
- Add or update formatting, linting, hook, or CI rules in `rules/formatting.md`.
- Add or update test rules in `rules/testing.md`.
- Add task-specific procedures in `workflows/`.

If a new agent tool requires its own instruction file, create a thin adapter in that tool's expected location and link back to these files. Do not copy large rule blocks into tool-specific files.
