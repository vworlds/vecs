---
name: release
description: Cut a vecs release by merging dev into master, pushing, and waiting for CI to bump the version and tag.
---

# Release

Cut a vecs release. This merges `dev` into `master`, pushes `master`, waits for
the `Publish to npm` GitHub Actions workflow to bump versions and tag, then
fast-forwards `dev` onto the new `master`.

## When to use

Use when asked to "release", "cut a release", "ship to master", "bump the
version", or "publish a new vecs version".

## Mechanism

All git work is performed by `.agents/skills/release/release.sh`. Run it from
the repo root:

```bash
./.agents/skills/release/release.sh
```

The script is the source of truth for the release flow. It is idempotent for
the pre-push checks and refuses to destroy data:

1. **Refuse in a worktree** — only runs in the repo's main worktree, not in a
   linked `git worktree`.
2. **Clean index** — aborts if there are staged, unstaged, or untracked files.
3. **dev ahead of master** — fetches `origin`, verifies `origin/dev` is a
   descendant of `origin/master` and strictly ahead.
4. **Merge dev into master** — fast-forward only; never creates a merge commit
   and never rewrites history.
5. **Label the changelog** — relabel the `## Unreleased` section as
   `## vX.Y.Z (YYYY-MM-DD)` (next patch from the latest tag), leave a fresh
   empty `## Unreleased` above it, and commit on master. Aborts if the changelog
   is missing or the rewrite doesn't match the expected headings.
6. **Push master** — plain `git push origin master`; no force.
7. **Wait for CI** — polls `origin` until `origin/master` advances past the
   pushed commit (the `[skip ci]` bump commit) AND a new `vX.Y.Z` tag appears.
   20-minute hard cap.
8. **Pull master** — fast-forwards local `master` to `origin/master`.
9. **Reset dev to master** — fast-forwards `dev` onto `master` and pushes
   `dev`. Never force-updates or rewrites `dev`.

## How CI bumps the version

`.github/workflows/publish.yml` runs on every push to `master`. It runs
`scripts/bump-vecs-versions.mjs` (patch bump), commits the bumped
`package.json`/`package-lock.json` with `chore: bump vecs packages [skip ci]`,
tags `vX.Y.Z`, and pushes the commit + tag to `master`. The next release will
be `v1.0.36`.

## What the agent should do

1. Read `.agents/rules/commits.md` and `.agents/workflows/pr-workflow.md` for
   context (the release script follows the same no-force, fast-forward-only
   discipline).
2. Confirm the user wants to release now; the script pushes to `master` and
   triggers a public npm publish.
3. Run the script and stream its output. Report the new version tag when it
   completes.
4. If the script fails, do NOT attempt to fix git state by hand. Surface the
   error and the script's suggested remediation, and ask the user how to
   proceed.

## Safety

- Never run `git reset --hard`, `git push --force`, or `git branch -D` as part
  of a release. The script never does either.
- Never commit on `master` directly; all changes land on `dev` first.
- The script leaves the working tree on `dev` when it finishes.
