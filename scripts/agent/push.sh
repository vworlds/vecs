#!/usr/bin/env bash
# Push your current task branch to GitHub (force-with-lease), retrying and falling back to SSH.
# Refuses to push a branch with no commits on top of origin/dev: GitHub would close the PR.
# Usage: scripts/agent/push.sh
set -euo pipefail
. "$(dirname "$0")/../lib/common.sh"
branch="$(git rev-parse --abbrev-ref HEAD)"
case "$branch" in dev | master | main | HEAD) die "refusing to push $branch" ;; esac
fetch_refs "+dev:refs/remotes/origin/dev" || die "fetch failed"
[ "$(git rev-list --count origin/dev..HEAD)" -gt 0 ] || die "$branch has no commits on top of origin/dev"
lease="$(git rev-parse -q --verify "refs/remotes/origin/$branch" || true)"
push_ref "HEAD:refs/heads/$branch" --force-with-lease="refs/heads/$branch:${lease}" || die "push failed"
git update-ref "refs/remotes/origin/$branch" HEAD
log "pushed $branch at $(git rev-parse --short HEAD)"
