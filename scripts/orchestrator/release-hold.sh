#!/usr/bin/env bash
# Lift the hold on a task PR opened with open-task.sh --hold: strip the banner and the title prefix,
# then post "[orchestrator] GO" (plus an optional note file) and move the card to In progress.
# Idempotent. Usage: scripts/orchestrator/release-hold.sh <pr> [note.md]
set -euo pipefail
. "$(dirname "$0")/../lib/common.sh"
. "$(dirname "$0")/../lib/board.sh"
pr="${1:?usage: release-hold.sh <pr> [note.md]}"
note="${2:-}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
pr_field "$pr" .body > "$tmp/body"
title="$(pr_field "$pr" .title)"
sed -i '/^> ⛔ \*\*ON HOLD/,/^$/d' "$tmp/body"
new_title="${title#\[HOLD: owner review\] }"
retry 3 gh api -X PATCH "repos/$REPO_SLUG/pulls/$pr" -F "body=@$tmp/body" -f "title=$new_title" >/dev/null
if ! pr_field "$pr" '.comments' | grep -q '\[orchestrator\] GO'; then
  { printf '[orchestrator] GO\n\nThe hold is lifted; work may begin.\n'; [ -n "$note" ] && { printf '\n'; cat "$note"; }; } > "$tmp/go"
  retry 3 gh pr comment "$pr" -R "$REPO_SLUG" --body-file "$tmp/go" >/dev/null
fi
board_move "$pr" "In progress" || true
board_turn "$pr" nobody || true
log "#$pr released: $new_title"
