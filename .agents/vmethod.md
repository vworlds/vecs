# Vecs methodology integration

Use the pinned package for shared automation and keep vecs recipes local.

## Commands and hooks

Install with `npm ci` in each worktree. Run `npm exec --no -- vmethod <verb>`;
compatibility scripts in `scripts/agent/` and `scripts/orchestrator/` only route to
that local install. `scripts/orchestrator/watch-prs.sh` and `board.sh` preserve
the old entry-point paths, not old argument conventions. See the installed
[gateway reference](../node_modules/@vworlds/vmethod/docs/gateway.md).

`scripts/vmethod-hooks/verify` implements the review recipe: install, typecheck,
lint, format, tests, offline tooling tests, build, and optionally the sector
benchmark. Only workspace tests can be narrowed. vmethod owns the detached review
worktree and passes `--logs`, `--packages` and `--bench` to this hook.
`merge-task` passes `--scope merge` when it re-verifies an open PR merged onto the
live base (`merge.requireCurrentBase: false`); that scope runs only install,
typecheck and lint, since CI already ran the full recipe on the head. Owner button
merges get no merge-time verification, only the follow-up.
Run `npm run test:tooling` to validate the local integration offline; no test may
write to the real board. The old bash-implementation tests move with their generic
implementation to vmethod; local tests cover configuration, stubs and project hooks.

The `postMerge` configuration replaces `install-deps-after-fast-forward`:
`package-lock.json` triggers `HUSKY=0 npm ci --no-audit --no-fund` as the final merge
step. The standalone legacy installer remains available and tested for vecs callers.

Keep the release skill and its script, `scripts/orchestrator/publish-beta.sh`,
`scripts/lib/release-publish.sh`, `scripts/published-packages.txt`,
`scripts/lib/changelog.sh`, and `scripts/agent/check-changelog.sh` local.
`release.sh` still sources both library scripts at those exact paths. The
collector retains vecs bullet fragments, not vmethod's `kind:` format. The beta
script needs only its local repository selection and release helpers, not the old
generic common/board implementation. Release and beta tests retain their offline
command fakes. Never run a real release from a worker worktree.

`format` and `format:check` retain explicit `.worktrees/` and `.tmp/` exclusions;
the unreadable-worktree regression test protects both commands.

## Environment and state handover

Use `VMETHOD_BOARD`, `VMETHOD_TRACK` and `VMETHOD_BASE`, not the former project
prefix. Select a board with `VMETHOD_BOARD_OWNER` and `VMETHOD_BOARD_NUMBER`;
owner authority comes only from `people.yaml`, never a legacy owner override.
There are no old-prefix aliases. The local beta script accepts `VMETHOD_REPO`.
Credential settings contain environment variable names only.

Before switching watchers, the owner/orchestrator stops the old watchers, runs
`npm ci`, supplies `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`,
`GIT_COMMITTER_EMAIL` and configured credentials in its wrapper environment, then
starts one `vmethod watch` reader per track. Do not read identity from git config.
Only `vecs-watch` (or `vecs-watch-<track>`) is imported into `stateName: vecs`;
never import another project's state. Keep `.agents/model-log.md` checked in for
calibration; after each merge append PR, family, points, rounds and findings,
separating design churn and owner questions from model errors. The package's
`.vmethod/model-log.jsonl` does not replace this checked-in project calibration.
The owner chose `merge.requireCurrentBase: false` on 2026-10-17.

The MCP track is stopped. Tell its next session to use `VMETHOD_TRACK=mcp`; the
post-merge track criterion needs a fresh, separate short task, not work in this PR.
Board 4 is shared with SpaceRocks: status and migration dry-run only in this pilot;
the owner coordinates any actual migration. Owner verification of `people.yaml`
is required before relying on its pins.

The orchestrator posted both read-only results on PR #370: exit 0, no drift, and
an expect-only v2 migration with no changes. Applying its version stamp remains
deferred to owner/SpaceRocks coordination.

## Pilot gaps and remaining rollout

- [vmethod#60](https://github.com/vworlds/vmethod/issues/60): rc.1's offline check
  requires owner-installed permissions despite their approved deferral. Report the
  finding locally; do not edit permissions or filter it into a pass. Add the CI
  check with the fixing rc before merge (orchestrator amendment on PR #370).

rc.3 resolves the remaining rc.1 gaps:

- [vmethod#58](https://github.com/vworlds/vmethod/issues/58): `branches.worktreePrefix`
  is set to `auto-`, matching the existing `.worktrees/auto-<branch>` worktrees.
- [vmethod#59](https://github.com/vworlds/vmethod/issues/59): the watcher checks
  workers started by `worker start`; no local monitoring is added.
- [vmethod#63](https://github.com/vworlds/vmethod/issues/63): the watcher emits
  `button-merge` rather than completing owner button merges. The orchestrator runs
  `merge-task <pr>` for the idempotent follow-up (issues, board cleanup,
  branch/main-checkout refresh and dependency reinstall).
- [vmethod#61](https://github.com/vworlds/vmethod/issues/61): `legacyWorkers` lists
  `vecs-orchestrator/workers` and `vecs-orchestrator/claude-workers`. Run
  `worker adopt --from-legacy` as the orchestrator and review every result; records
  whose opencode session no longer resolves (the pre-move `/home/vecsmaster` paths)
  are reported skips, never relocated or rewritten.

`scope.fastPath: [bug]` keeps the vecs gating: an issue labelled `bug` still needs a
SCOPE REVIEW but does not wait for owner scope approval. Delivery approval is
unchanged.

After merge, report a task/review/merge cycle, an owner button-merge follow-up,
the separate fresh track task and a release with the fixed check in CI to
[vmethod#13](https://github.com/vworlds/vmethod/issues/13).
