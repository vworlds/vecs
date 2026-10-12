#!/usr/bin/env bash
# Prepare your worktree for a task PR. Safe to re-run.
#   - checks out the PR's branch (creating it from the remote if needed);
#   - if the branch still holds only the orchestrator's placeholder commit, resets it to origin/dev;
#     otherwise keeps your commits and tells you how far behind dev you are;
#   - installs dependencies with `HUSKY=0 npm ci` when package-lock.json changed since the last install.
# Usage: scripts/agent/start-task.sh <pr>
set -euo pipefail
. "$(dirname "$0")/../lib/common.sh"
pr="${1:?usage: start-task.sh <pr>}"
cd "$(git rev-parse --show-toplevel)"
[ "$(git rev-parse --git-common-dir)" != "$(git rev-parse --git-dir)" ] ||
  die "run this inside your own worktree, not the main checkout"

branch="$(pr_field "$pr" .headRefName)" || die "cannot read PR #$pr"
fetch_refs "+dev:refs/remotes/origin/dev" "+$branch:refs/remotes/origin/$branch" || die "fetch failed"
if [ "$(git rev-parse --abbrev-ref HEAD)" != "$branch" ]; then
  [ -z "$(git status --porcelain)" ] || die "worktree has uncommitted changes; commit or stash them first"
  if git show-ref -q --verify "refs/heads/$branch"; then git checkout -q "$branch"; else git checkout -q -b "$branch" "origin/$branch"; fi
fi
git branch -q --set-upstream-to="origin/$branch" 2>/dev/null || true

mine="$(git rev-list --count origin/dev..HEAD)"
only_placeholder=false
if [ "$mine" -le 1 ] && git log -1 --format=%s HEAD | grep -q '^chore: open task'; then only_placeholder=true; fi
if [ "$mine" -eq 0 ] || $only_placeholder; then
  git reset -q --hard origin/dev
  log "branch $branch reset to origin/dev ($(git rev-parse --short HEAD))"
else
  log "branch $branch keeps your $mine commit(s); $(git rev-list --count HEAD..origin/dev) behind origin/dev"
fi

stamp=node_modules/.package-lock.sha
want="$(sha256sum package-lock.json | cut -d' ' -f1)"
if [ ! -f "$stamp" ] || [ "$(cat "$stamp")" != "$want" ]; then
  HUSKY=0 npm ci
  printf '%s\n' "$want" > "$stamp"
else
  log "dependencies already match package-lock.json"
fi
log "ready. Next: scripts/agent/read-pr.sh $pr"
