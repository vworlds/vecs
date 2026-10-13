#!/usr/bin/env bash
# Post a [worker] comment on a task PR from a file (never inline: the shell would run backticks).
# Adds the "[worker] " prefix if the file lacks it. Usage: scripts/agent/pr-comment.sh <pr> <file>
set -euo pipefail
. "$(dirname "$0")/../lib/common.sh"
pr="${1:?usage: pr-comment.sh <pr> <file>}"
file="${2:?usage: pr-comment.sh <pr> <file>}"
body="$(mktemp)"
trap 'rm -f "$body"' EXIT
if head -c 8 "$file" | grep -q '^\[worker\]'; then cp "$file" "$body"; else { printf '[worker] '; cat "$file"; } > "$body"; fi
retry 3 gh pr comment "$pr" -R "$REPO_SLUG" --body-file "$body"
