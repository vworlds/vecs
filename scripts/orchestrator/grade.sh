#!/usr/bin/env bash
# Grade vecs cards; empty on purpose (none) still counts as graded. Revise when scope changes.
# Usage: grade.sh <points|none> <ref>… | grade.sh ungraded | grade.sh list
# Scale and calibration: .agents/workflows/orchestrator.md, "Estimates and models".
set -euo pipefail
. "$(dirname "$0")/../lib/common.sh"
. "$(dirname "$0")/../lib/board.sh"
usage() { die "usage: grade.sh <points|none> <ref>… | grade.sh ungraded | grade.sh list"; }
[ $# -ge 1 ] || usage
case "$1" in
  ungraded | list)
    [ $# -eq 1 ] || usage
    board_enabled || exit 0
    board_load_tracks "$WATCH_STATE/tracks" || die "cannot read tracks"
    items="$(board_items '-status:Done')" || die "cannot read board"
    while IFS=$'\t' read -r _ column kind repo number _ title _ estimate model extra; do
      [ "$repo" = "$REPO_SLUG" ] && board_ours "$number" || continue
      if [ "$1" = ungraded ]; then
        [ "$kind" = ISSUE ] && [ "$estimate" = - ] && [ ! -e "$BOARD_STATE/graded-$number" ] || continue
        printf '#%s\t%s\t%s\n' "$number" "$column" "$title"
      else
        printf '#%s\t%s\t%s\t%s\t%s\t%s\n' "$number" "$kind" "$column" "$estimate" "$model" "$title"
      fi
    done <<< "$items"
    ;;
  *)
    [ $# -ge 2 ] || usage
    points="$1"
    shift
    # Validate the entire invocation before changing any card, including repository boundaries.
    case " $ESTIMATE_POINTS none " in *" $points "*) ;; *)
      log "invalid estimate: $points"
      exit 2
      ;;
    esac
    for ref in "$@"; do
      IFS=$'\t' read -r repo number < <(board_ref "$ref") || die "invalid ref: $ref"
      [ "$repo" = "$REPO_SLUG" ] || die "grade only $REPO_SLUG cards"
    done
    board_enabled || exit 0
    board_load_tracks "$WATCH_STATE/tracks" || die "cannot read tracks"
    for ref in "$@"; do
      IFS=$'\t' read -r repo number < <(board_ref "$ref")
      board_ours "$number" || die "#$number is not in this session's track"
    done
    failed=0
    for ref in "$@"; do
      if board_estimate "$ref" "$points"; then
        IFS=$'\t' read -r repo number < <(board_ref "$ref")
        mkdir -p "$BOARD_STATE"
        touch "$BOARD_STATE/graded-$number"
      else failed=1; fi
    done
    exit "$failed"
    ;;
esac
