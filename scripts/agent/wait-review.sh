#!/usr/bin/env bash
# Block until the orchestrator replies on a task PR, or the PR stops being open.
# Prints every [orchestrator] comment newer than your latest [worker] comment, so it is
# safe to (re)start at any time. Usage: scripts/agent/wait-review.sh <pr> [poll-seconds]
set -uo pipefail
. "$(dirname "$0")/../lib/common.sh"
pr="${1:?usage: wait-review.sh <pr> [poll-seconds]}"
poll="${2:-120}"
newer='([.comments[] | select(.body | startswith("[worker]"))] | last | .createdAt // "") as $mine
  | [.comments[] | select(.body | startswith("[orchestrator]")) | select(.createdAt > $mine) | .body]
  | join("\n\n---\n\n")'
while :; do
  if state=$(gh pr view "$pr" -R "$REPO_SLUG" --json state --jq .state); then
    if [ "$state" != OPEN ]; then
      echo "PR #$pr is $state: you are dismissed"
      exit 0
    fi
    if reply=$(gh pr view "$pr" -R "$REPO_SLUG" --json comments --jq "$newer") && [ -n "$reply" ]; then
      printf '%s\n' "$reply"
      exit 0
    fi
  fi
  sleep "$poll"
done
