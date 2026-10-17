# Agent instructions

Use [AGENTS.md](../AGENTS.md) as the single routing entry point for every backend.
Shared procedures come from the exact pinned `@vworlds/vmethod` package, not copied
workflow documents. Restore dependencies with `npm ci` before reading them.

Keep vecs-specific engineering and domain requirements in `rules/`, model
calibration in [model-log.md](model-log.md), tooling integration in
[vmethod.md](vmethod.md), and the vecs release recipe in `skills/release/`.
Only change instructions when explicitly asked. Keep routing short, cross-link
single sources of truth, and do not edit owner-controlled permissions.
