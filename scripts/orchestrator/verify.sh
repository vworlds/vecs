#!/usr/bin/env bash
# Verify one or more PRs together against origin/dev in the orchestrator's review worktree; remove dist output so checks start as in CI.
# Exits non-zero on the first failing step; logs stay in /tmp/vecs-verify/.
# Usage: scripts/orchestrator/verify.sh [--bench] [--packages "<ws> <ws>…"] <pr> [<pr>…]
#   --packages limits only the test step to the listed npm workspaces; other checks stay full-repo.
set -euo pipefail
. "$(dirname "$0")/../lib/common.sh"
. "$(dirname "$0")/../lib/board.sh"
bench=false
packages_arg=""
packages_requested=false
while [ $# -gt 0 ]; do
  case "$1" in
    --bench)
      bench=true
      shift
      ;;
    --packages)
      [ $# -ge 2 ] || die "--packages requires a space-separated workspace list"
      packages_arg="$2"
      packages_requested=true
      shift 2
      ;;
    *) break ;;
  esac
done
[ $# -gt 0 ] || die "usage: verify.sh [--bench] [--packages \"<ws> <ws>…\"] <pr>…"
packages=()
if $packages_requested; then
  [ -n "$packages_arg" ] || die "--packages requires a space-separated workspace list"
  read -r -a packages <<< "$packages_arg"
  [ "${#packages[@]}" -gt 0 ] || die "--packages requires a space-separated workspace list"
fi
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
  git -c user.name=orchestrator -c user.email=orchestrator@localhost merge -q --no-edit "origin/verify/$pr" \
    || {
      git merge --abort 2> /dev/null
      die "PR #$pr does not merge cleanly onto dev (with the PRs before it)"
    }
done
log "verifying $(git rev-parse --short HEAD): dev + PR $*"
for pr in "$@"; do board_progress "$pr" state=verifying || true; done

step() {
  local name="$1"
  shift
  if "$@" > "$logs/$name.log" 2>&1; then log "ok    $name"; else
    log "FAIL  $name ($logs/$name.log)"
    tail -20 "$logs/$name.log" >&2
    exit 1
  fi
}
step npm-ci env HUSKY=0 npm ci
step typecheck npm run typecheck
step lint npm run lint
step format-check npm run format:check
if [ "${#packages[@]}" -gt 0 ]; then
  test_index=0
  for workspace in "${packages[@]}"; do
    test_index=$((test_index + 1))
    step "test-$test_index" npm run test -w "$workspace"
  done
else
  step test npm run test
fi
step build npm run build
if $bench; then
  step bench npm run bench:sector
  grep -E 'checksum .*trace' "$logs/bench.log" || die "benchmark did not print its fingerprint line"
fi
log "all checks passed for PR $*"
