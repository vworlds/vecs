#!/usr/bin/env bash
# Print a task PR's description and every comment, oldest first.
# (Plain `gh pr view --comments` fails on this repo.) Usage: scripts/agent/read-pr.sh <pr>
set -euo pipefail
. "$(dirname "$0")/../lib/common.sh"
pr="${1:?usage: read-pr.sh <pr>}"
retry 3 gh pr view "$pr" -R "$REPO_SLUG" --json title,body,comments \
  --jq '"# \(.title)\n\n\(.body)\n" + ([.comments[] | "\n----- \(.createdAt)\n\(.body)\n"] | join(""))'
