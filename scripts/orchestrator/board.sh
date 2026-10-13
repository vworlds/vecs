#!/usr/bin/env bash
# Read and update the owner's kanban board (.agents/workflows/orchestrator.md, "The board").
# Usage: scripts/orchestrator/board.sh <command>
#   list [column] [--all] [--tsv]     cards top to bottom, by column (Done only with --all or by name),
#                                     with assignees; Ready cards also show what blocks them
#   move <ref> <column> [--top|--bottom]   put a card in a column; adds the issue or PR if missing
#   next                              the first Space Rocks card of Ready that nothing blocks: the
#                                     next thing to start (blocked cards stay in Ready)
#   mine                              open issues and PRs assigned to me: each needs an action
#   turn <ref> owner|me|nobody        say whose move it is, by assignee
#   blocked <ref>                     the open issues that block an issue
#   block <issue> <blocker…>          add "blocked by" relations
#   unblock <issue> <blocker…>        remove them
#   issue <title> <body.md> [column] [label…]   open an issue (new work, a follow-up, an idea)
#                                     and add it at the bottom of a column (default Backlog)
#   remove <ref>                      take a card off the board; its issue or PR is untouched
# <ref> is 212, #212, owner/repo#212, a github.com URL or a PVTI_… card id.
# <column> is Backlog, Ready, "In progress", "In review", Approved or Done; any case, and the short
# forms progress and review work too.
set -euo pipefail
. "$(dirname "$0")/../lib/common.sh"
. "$(dirname "$0")/../lib/board.sh"
usage() { sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }

# blockers_of <number>: " blocked by #a, #b" for an issue of this repo, or nothing.
blockers_of() {
  local list
  list="$(board_blockers "$1" 2> /dev/null | cut -f1 | sed 's/^/#/' | paste -sd, - | sed 's/,/, /g')" || true
  [ -z "$list" ] || printf ' blocked by %s' "$list"
}

# new_issue <title> <body file>: an open issue with that exact title, created if missing.
new_issue() {
  local title="$1" body="$2" number
  number="$(retry 3 gh api --paginate "repos/$REPO_SLUG/issues?state=open&per_page=100" |
    jq -r --arg t "$title" '[.[] | select(.pull_request | not) | select(.title == $t)][0].number // empty')"
  if [ -z "$number" ]; then
    number="$(retry 3 gh api -X POST "repos/$REPO_SLUG/issues" -f title="$title" -F body=@"$body" --jq .number)" ||
      die "could not create the issue"
    log "opened #$number: $title"
  else
    log "issue already open: #$number"
  fi
  printf '%s\n' "$number"
}

cmd="${1:-list}"
[ $# -gt 0 ] && shift
case "$cmd" in
  list)
    want="" all=false tsv=false
    for arg in "$@"; do
      case "$arg" in
        --all) all=true ;;
        --tsv) tsv=true ;;
        *) want="$(board_column "$arg")" || die "unknown column $arg" ;;
      esac
    done
    items="$(board_items)" || die "could not read the board"
    if $tsv; then printf '%s\n' "$items"; exit 0; fi
    for column in "Backlog" "Ready" "In progress" "In review" "Approved" "Done" "-"; do
      [ -z "$want" ] || [ "$want" = "$column" ] || continue
      [ "$column" != Done ] || $all || [ -n "$want" ] || continue
      rows="$(awk -F'\t' -v c="$column" '$2 == c' <<< "$items")"
      [ -n "$rows" ] || { [ "$column" = "-" ] || printf '== %s (0)\n' "$column"; continue; }
      printf '== %s (%s)\n' "$([ "$column" = "-" ] && echo "No status" || echo "$column")" "$(wc -l <<< "$rows")"
      while IFS=$'\t' read -r _ _ kind repo number _ title who; do
        if [ "$number" = "-" ]; then ref="(draft)"; elif [ "$repo" = "$REPO_SLUG" ]; then ref="#$number"; else ref="${repo#*/}#$number"; fi
        note=""
        [ "$who" = "-" ] || note=" [@${who//,/ @}]"
        if [ "$column" = Ready ] && [ "$repo" = "$REPO_SLUG" ] && [ "$kind" = ISSUE ]; then
          note="$note$(blockers_of "$number")"
        fi
        printf '  %-12s %-6s %s%s\n' "$ref" "$kind" "$title" "$note"
      done <<< "$rows"
    done
    ;;
  move)
    [ $# -ge 2 ] || usage
    where=""
    case "${3:-}" in --top) where=top ;; --bottom) where=bottom ;; "") ;; *) usage ;; esac
    board_move "$1" "$2" $where || exit 1
    ;;
  next)
    while IFS=$'\t' read -r _ column kind repo number _ title _; do
      [ "$column" = Ready ] && [ "$repo" = "$REPO_SLUG" ] || continue
      if [ "$kind" = ISSUE ]; then
        blocked="$(blockers_of "$number")"
        if [ -n "$blocked" ]; then log "skipped #$number:$blocked"; continue; fi
      fi
      printf '#%s\t%s\t%s\n' "$number" "$kind" "$title"
      break
    done < <(board_items)
    ;;
  mine)
    me="$(board_me)" || die "cannot read my login"
    retry 3 gh api --paginate "repos/$REPO_SLUG/issues?state=open&assignee=$me&per_page=100" \
      --jq '.[] | "#\(.number)\t\(if .pull_request then "PR" else "ISSUE" end)\t\(.title)"'
    # Cards of the other repos on the shared board that are assigned to me.
    board_items | awk -F'\t' -v here="$REPO_SLUG" -v me="$me" '
      $4 != here && $4 != "-" && $6 == "OPEN" && ("," $8 ",") ~ ("," me ",") {
        sub(/^[^\/]*\//, "", $4); print $4 "#" $5 "\t" $3 "\t" $7 }'
    ;;
  turn)
    [ $# -eq 2 ] || usage
    board_turn "$1" "$2" || exit 1
    ;;
  blocked)
    [ $# -eq 1 ] || usage
    board_blockers "$1" | sed 's/^/#/'
    ;;
  block | unblock)
    [ $# -ge 2 ] || usage
    "board_$cmd" "$@" || exit 1
    ;;
  issue)
    [ $# -ge 2 ] || usage
    [ -r "$2" ] || die "cannot read $2"
    column="$(board_column "${3:-Backlog}")" || die "unknown column ${3:-}"
    number="$(new_issue "$1" "$2")"
    for label in "${@:4}"; do
      retry 3 gh api -X POST "repos/$REPO_SLUG/issues/$number/labels" -f "labels[]=$label" >/dev/null ||
        log "warning: could not add label $label"
    done
    board_move "$number" "$column" bottom || exit 1
    echo "$number"
    ;;
  remove)
    [ $# -ge 1 ] || usage
    item="$(board_item "$1")" || die "cannot find $1"
    board_archive "$item" || die "could not remove $1"
    log "board: $1 removed"
    ;;
  *) usage ;;
esac
