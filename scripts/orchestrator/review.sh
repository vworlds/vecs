#!/usr/bin/env bash
# Post a review outcome or a reply on a task PR or an issue, move its card and say whose move it
# is now (docs/agents/orchestrator.md, "The board").
# Usage: scripts/orchestrator/review.sh <pr or issue> <outcome> <comment.md>
#   changes   back to the worker: the card goes to In progress, nobody is assigned
#   owner     the owner should read, playtest or decide: the card goes to (or stays in) In review
#             and is assigned to the owner
#   approve   the owner accepts the delivery: the card stays In review, nobody is assigned;
#             merge-task.sh moves it to Done
#   answer    a reply that needs nothing more from anyone: the card doesn't move, I am unassigned
#   ask       a reply that asks the owner something: the card doesn't move, the owner is assigned
# The comment must start with "[orchestrator]", the marker workers wait for. Everything the owner
# needs to decide (results, what to look at, how to run it, open questions) belongs in that comment.
set -euo pipefail
. "$(dirname "$0")/../lib/common.sh"
. "$(dirname "$0")/../lib/board.sh"
pr="${1:?usage: review.sh <pr or issue> changes|owner|approve|answer|ask <comment.md>}"
outcome="${2:?outcome required: changes, owner, approve, answer or ask}"
file="${3:?comment file required}"
[ -r "$file" ] || die "cannot read $file"
case "$outcome" in changes | owner | approve | answer | ask) ;; *) die "unknown outcome $outcome" ;; esac
head -c 14 "$file" | grep -q '^\[orchestrator\]' || die "the comment must start with [orchestrator]"
url="$(retry 3 gh api -X POST "repos/$REPO_SLUG/issues/$pr/comments" -F body=@"$file" --jq .html_url)" ||
  die "could not post the comment"
log "posted $url"
case "$outcome" in
  changes)
    board_move "$pr" "In progress" || true
    board_turn "$pr" nobody || true
    ;;
  owner)
    board_move "$pr" "In review" || true
    board_turn "$pr" owner || true
    ;;
  approve | answer) board_turn "$pr" nobody || true ;;
  ask) board_turn "$pr" owner || true ;;
esac
