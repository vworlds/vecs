#!/usr/bin/env bash
# Verify one or more PRs together against origin/dev in the orchestrator's review worktree.
# Exits non-zero on the first failing step; logs stay in /tmp/vecs-verify/.
# Usage: scripts/orchestrator/verify.sh [--bench] <pr> [<pr>…]
set -euo pipefail
. "$(dirname "$0")/../lib/common.sh"
bench=false
if [ "${1:-}" = --bench ]; then bench=true; shift; fi
[ $# -gt 0 ] || die "usage: verify.sh [--bench] <pr>…"
main="$(git rev-parse --path-format=absolute --git-common-dir | sed 's|/.git$||')"
wt="${VECS_REVIEW_WORKTREE:-$main/.worktrees/orchestrator-review}"
logs="/tmp/vecs-verify"
mkdir -p "$logs"
[ -d "$wt" ] || git -C "$main" worktree add -q --detach "$wt" origin/dev
cd "$wt"

refs=("+dev:refs/remotes/origin/dev")
for pr in "$@"; do refs+=("+refs/pull/$pr/head:refs/remotes/origin/verify/$pr"); done
fetch_refs "${refs[@]}" || die "fetch failed"
git reset -q --hard
git checkout -q --detach origin/dev
for pr in "$@"; do
  git -c user.name=orchestrator -c user.email=orchestrator@localhost merge -q --no-edit "origin/verify/$pr" ||
    { git merge --abort 2>/dev/null; die "PR #$pr does not merge cleanly onto dev (with the PRs before it)"; }
done
log "verifying $(git rev-parse --short HEAD): dev + PR $*"

step() {
  local name="$1"; shift
  if "$@" > "$logs/$name.log" 2>&1; then log "ok    $name"; else log "FAIL  $name ($logs/$name.log)"; tail -20 "$logs/$name.log" >&2; exit 1; fi
}
step npm-ci env HUSKY=0 npm ci
step typecheck npm run typecheck
step lint npm run lint
step format-check npm run format:check
step test npm run test
step build npm run build
if $bench; then
  step bench npm run bench:sector
  grep -E 'checksum .*trace' "$logs/bench.log" || die "benchmark did not print its fingerprint line"
fi
log "all checks passed for PR $*"
