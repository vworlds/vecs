#!/usr/bin/env bash
# Rare issue-only Model hint, backed by a technical analysis posted on the issue.
# Usage: suggest-model.sh <family|none> <issue> <reason.md> [--owner-approved]
# Do not use merely because you wrote an issue; PR families are maintained by worker scripts.
set -euo pipefail
. "$(dirname "$0")/../lib/common.sh"
. "$(dirname "$0")/../lib/board.sh"
[ $# -ge 3 ] && [ $# -le 4 ] || die "usage: suggest-model.sh <family|none> <issue> <reason.md> [--owner-approved]"
family="$1" ref="$2" reason="$3" approved=false
[ $# -lt 4 ] || {
  [ "$4" = --owner-approved ] || die "unknown option $4"
  approved=true
}
[ -r "$reason" ] && grep -q '[^[:space:]]' "$reason" || die "a nonempty technical analysis file is required"
if [ "$family" != none ]; then
  model_row "$family" > /dev/null || die "unknown family $family"
  model_gate_ok "$family" "$approved" || exit 1
fi
IFS=$'\t' read -r repo number < <(board_ref "$ref") || die "invalid issue ref"
[ "$repo" = "$REPO_SLUG" ] || die "hints go on $REPO_SLUG issues only"
is_pr="$(retry 3 gh api "repos/$repo/issues/$number" --jq 'has("pull_request")')" || die "cannot read #$number"
[ "$is_pr" = false ] || die "#$number is a PR: worker scripts set its Model"
board_require_ours "$number"
body="$(mktemp)"
trap 'rm -f "$body"' EXIT
{
  printf '[orchestrator] Model hint: **%s**\n\n' "$family"
  cat "$reason"
} > "$body"
"$(dirname "$0")/../agent/check-markdown.sh" "$body"
board_enabled || exit 0
board_model "$number" "$family" || die "could not set Model"
retry 3 gh api -X POST "repos/$repo/issues/$number/comments" -F body=@"$body" > /dev/null \
  || die "hint set but analysis not posted: post the reason with review.sh $number answer"
