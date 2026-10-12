#!/usr/bin/env bash
# Wake the orchestrator only when something needs it. Polls GitHub from the shell and prints one
# line per event that calls for an action:
#   - PR #n … comment: a worker's READY, QUESTION, DESIGN or BLOCKED on a task PR (heads named
#     <pr>-<words>, as open-task.sh makes them, or the older task-*). READY also moves the card
#     to In review;
#   - COMMENT #n by <login>: a comment by a person other than me on any issue or PR;
#   - BOARD #n: a Space Rocks card someone else moved to Approved, In review or back to Backlog;
#   - NEXT #n: the first card of Ready that nothing blocks changed, so there is work to start
#     (a new card, a reorder, or a blocker that closed);
#   - LAUNCH #n: an issue the owner approved can be opened as a task now. It fires when the issue
#     is approved with nothing blocking it, and later when the last blocker of an approved issue
#     closes;
#   - ASSIGNED #n: an open issue or PR newly assigned to me, which means I must act on it;
#   - OWNER DONE #n: the owner took themselves off a card that was waiting for them;
#   - STALE: my latest [orchestrator] review has had no reply or commit for 30+ minutes;
#   - PR #n is now MERGED/CLOSED: a task PR left the open list by someone else's hand.
# What needs nobody is kept quiet and shown with the next real event, under "quiet since the last
# wake-up": other [worker] notes (ACK, standing by, progress), a worker's first commit, cards that
# moved to In progress or Done (our scripts or GitHub's automation), cards put in Ready (NEXT
# speaks when one can be started), new cards in Backlog. Our own moves, merges and assignments are
# never reported back.
# After the first event it polls once more before exiting, so one action of the owner (comment,
# take themselves off, move the card) arrives as one wake-up instead of three.
# State lives in ${XDG_STATE_HOME:-~/.local/state}/vecs-watch, so a restart doesn't
# repeat events already reported, and nothing that happens between two runs is lost.
# ONESHOT=1 exits after an event (and its settling poll). MAX_MINUTES=n ends the watch quietly
# after n minutes without an event, for runners that limit how long a background task may live.
# A watch that ends this way is not restarted: nobody has done anything for that long, so the
# owner is away and will say when work resumes.
# Usage: [INTERVAL=10] [ONESHOT=1] [MAX_MINUTES=n] scripts/orchestrator/watch-prs.sh
# Orchestrators: run it as a tracked background task that notifies you when it exits,
# never with `nohup … &`: an untracked watcher reports to a file nobody reads.
set -uo pipefail
. "$(dirname "$0")/../lib/common.sh"
. "$(dirname "$0")/../lib/board.sh"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/vecs-watch"
mkdir -p "$STATE"
INTERVAL="${INTERVAL:-10}"
started="$(date +%s)"
# emit runs inside pipeline subshells, so "fired" is a marker file, not a variable.
FIRED="$STATE/.fired"
QUIET="$STATE/quiet.log"
rm -f "$FIRED"
emit() { printf '%s\n' "$*"; touch "$FIRED"; }
# quiet <line>: worth knowing, not worth a wake-up.
quiet() { printf '%s\n' "$*" >> "$QUIET"; }
once() { [ -e "$STATE/$1" ] && return 1; touch "$STATE/$1"; }
key() { printf '%s' "$1" | md5sum | cut -c1-16; }
# needs_me <first line of a comment>: a worker's READY, QUESTION, DESIGN and BLOCKED do; its
# other notes don't. Anything that is not a [worker] note does.
needs_me() {
  case "$1" in
    "[worker] READY"* | "[worker] QUESTION"* | "[worker] DESIGN"* | "[worker] BLOCKED"*) return 0 ;;
    "[worker]"*) return 1 ;;
    *) return 0 ;;
  esac
}
# report_comment <number> <first line> <event line>: wake or stay quiet, and on a worker's READY
# for an open task PR move its card to In review.
report_comment() {
  local number="$1" first="$2" line="$3"
  if needs_me "$first"; then emit "$line"; else quiet "$line"; fi
  case "$first" in
    "[worker] READY"*)
      if [ -e "$STATE/open-$number" ]; then board_move "$number" "In review" 2>/dev/null || true; fi
      ;;
  esac
}
# The board is shared with other repos: only Space Rocks cards are reported. Moves made by the
# orchestrator scripts are already recorded (board_remember), so they aren't reported back. The
# first poll only records where every card is. READY_ROWS and APPROVED_ROWS keep those columns
# for watch_next.
READY_ROWS="" APPROVED_ROWS="" OTHER_ROWS=""
watch_board() {
  board_enabled || return 0
  local items first=false item column kind repo number title who old was mark line
  items="$(board_items 2>/dev/null)" || return 0
  mkdir -p "$BOARD_STATE"
  [ -e "$BOARD_STATE/.seen" ] || { touch "$BOARD_STATE/.seen"; first=true; }
  while IFS=$'\t' read -r item column kind repo number _ title who; do
    [ -n "${item:-}" ] || continue
    was="$(cat "$BOARD_STATE/$item.who" 2>/dev/null || true)"
    if [ "$was" != "$who" ]; then
      printf '%s\n' "$who" > "$BOARD_STATE/$item.who"
      mark="$BOARD_STATE/.turn-${repo//\//_}-$number"
      if grep -q -w -- "$BOARD_OWNER" <<< "${who//,/ }"; then
        # Assigned to the owner again: whoever takes them off next, it is news unless marked.
        rm -f "$mark"
      elif grep -q -w -- "$BOARD_OWNER" <<< "${was//,/ }"; then
        # The owner left the card. Not reported when a script of ours did it (board_turn's mark).
        if [ -e "$mark" ]; then
          rm -f "$mark"
        elif ! $first && [ "$repo" = "$REPO_SLUG" ]; then
          emit "OWNER DONE #$number ($kind, $column): $title"
        fi
      fi
    fi
    old="$(cat "$BOARD_STATE/$item" 2>/dev/null || true)"
    [ "$old" = "$column" ] && continue
    printf '%s\n' "$column" > "$BOARD_STATE/$item"
    $first && continue
    [ "$repo" = "$REPO_SLUG" ] || continue
    line="BOARD #$number ($kind): ${old:-new card} → $column: $title"
    case "$column" in
      # Our scripts and GitHub's own automation put cards here; there is nothing to do.
      "In progress" | "Done") quiet "$line" ;;
      # A card in Ready matters when it can be started, and NEXT says that; a blocked one waits.
      "Ready") quiet "$line" ;;
      # A new idea parked in Backlog waits for the owner; a card sent back to it is news.
      "Backlog") if [ -z "$old" ]; then quiet "$line"; else emit "$line"; fi ;;
      *) emit "$line" ;;
    esac
  done <<< "$items"
  READY_ROWS="$(awk -F'\t' -v here="$REPO_SLUG" '$2 == "Ready" && $4 == here { print $5 "\t" $3 "\t" $7 }' <<< "$items")"
  APPROVED_ROWS="$(awk -F'\t' -v here="$REPO_SLUG" '$2 == "Approved" && $4 == here && $3 == "ISSUE" { print $5 "\t" $3 "\t" $7 }' <<< "$items")"
  # Open cards of the other repos, for watch_assigned: repo, number, kind, title, assignees.
  OTHER_ROWS="$(awk -F'\t' -v here="$REPO_SLUG" '$4 != here && $4 != "-" && $6 == "OPEN" { print $4 "\t" $5 "\t" $3 "\t" $7 "\t" $8 }' <<< "$items")"
}
# What can be started now: the first card of Ready that nothing blocks (NEXT), and the first
# approved issue that nothing blocks (LAUNCH). A card can become startable without moving, when
# its last blocker closes or the relation is removed, so this is looked at again whenever those
# columns changed, a task PR closed, or a minute has passed. Blockers cost a request per issue.
NEXT_SIG="" NEXT_AT=0
# first_unblocked <rows>: "#n (KIND): title" of the first row with no open blocker, or nothing.
first_unblocked() {
  local number kind title blocked
  while IFS=$'\t' read -r number kind title; do
    [ -n "${number:-}" ] || continue
    if [ "$kind" = ISSUE ]; then
      blocked="$(board_blockers "$number" 2>/dev/null | head -1)" || return 1
      [ -z "$blocked" ] || continue
    fi
    printf '#%s (%s): %s\n' "$number" "$kind" "$title"
    return 0
  done <<< "$1"
}
watch_next() {
  board_enabled || return 0
  local now sig next launch
  now="$(date +%s)"
  sig="$READY_ROWS|$APPROVED_ROWS"
  [ "$sig" != "$NEXT_SIG" ] || [ -e "$STATE/.recheck-next" ] || [ $((now - NEXT_AT)) -ge 60 ] || return 0
  next="$(first_unblocked "$READY_ROWS")" || return 0
  launch="$(first_unblocked "$APPROVED_ROWS")" || return 0
  rm -f "$STATE/.recheck-next"
  NEXT_SIG="$sig" NEXT_AT="$now"
  if [ "$launch" != "$(cat "$BOARD_STATE/.launch" 2>/dev/null || true)" ]; then
    printf '%s\n' "$launch" > "$BOARD_STATE/.launch"
    [ -z "$launch" ] || emit "LAUNCH $launch: approved and nothing blocks it"
  fi
  if [ "$next" != "$(cat "$BOARD_STATE/.next" 2>/dev/null || true)" ]; then
    printf '%s\n' "$next" > "$BOARD_STATE/.next"
    [ -z "$next" ] || emit "NEXT $next"
  fi
}
# Whatever is assigned to me needs an action from me, on the board or not. Reported once per
# assignment: taking me off and putting me back reports it again.
watch_assigned() {
  board_enabled || return 0
  local me mine number kind title
  me="$(board_me 2>/dev/null)" || return 0
  mine="$(gh api --paginate "repos/$REPO_SLUG/issues?state=open&assignee=$me&per_page=100" \
    --jq '.[] | "\(.number)\t\(if .pull_request then "PR" else "ISSUE" end)\t\(.title)"' 2>/dev/null)" || return 0
  while IFS=$'\t' read -r number kind title; do
    [ -n "${number:-}" ] || continue
    once "mine-$number" && emit "ASSIGNED #$number ($kind): $title"
  done <<< "$mine"
  for f in "$STATE"/mine-*; do
    [ -e "$f" ] || continue
    grep -q "^${f##*/mine-}"$'\t' <<< "$mine" || rm -f "$f"
  done
  # The board is shared: another repo's orchestrator asks for something by assigning me on
  # one of its cards. Only cards on the board are seen, since that is all we read of that repo.
  local repo who theirs=""
  while IFS=$'\t' read -r repo number kind title who; do
    [ -n "${number:-}" ] || continue
    grep -q -w -- "$me" <<< "${who//,/ }" || continue
    theirs="$theirs ${repo//\//_}-$number "
    once "theirs-${repo//\//_}-$number" && emit "ASSIGNED ${repo#*/}#$number ($kind): $title"
  done <<< "$OTHER_ROWS"
  for f in "$STATE"/theirs-*; do
    [ -e "$f" ] || continue
    case "$theirs" in *" ${f##*/theirs-} "*) ;; *) rm -f "$f" ;; esac
  done
}
# Comments anywhere in the repo since the last poll, one REST call. Task-PR comments already
# reported above share the same key, so they are not repeated. The first run starts from now.
watch_comments() {
  local since now me lines number login url first
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  since="$(cat "$STATE/.comments-since" 2>/dev/null || true)"
  if [ -z "$since" ]; then printf '%s\n' "$now" > "$STATE/.comments-since"; return 0; fi
  me="$(board_me 2>/dev/null)" || return 0
  lines="$(gh api "repos/$REPO_SLUG/issues/comments?since=$since&sort=created&direction=asc&per_page=100" --jq '
      .[] | select(.user.type != "Bot") | select(.user.login != "'"$me"'")
      | select(.body | startswith("[orchestrator]") | not)
      | [(.issue_url | split("/") | last), .user.login, .html_url,
         (.body | gsub("\r"; "") | split("\n")[0] | gsub("\t"; " ") | .[0:200])] | @tsv' 2>/dev/null)" || return 0
  while IFS=$'\t' read -r number login url first; do
    [ -n "${number:-}" ] || continue
    once "c-$(key "$url")" || continue
    report_comment "$number" "$first" "COMMENT #$number by $login: $first"
  done <<< "$lines"
  printf '%s\n' "$now" > "$STATE/.comments-since"
}
# One GraphQL call per poll covers every open task PR, so a short INTERVAL stays far inside the
# API budget (about 4 points a poll; the budget is 5000 an hour). Lines: O = open task PR,
# C = comment, S = stale review, P = commit count.
PR_QUERY='
  query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 50, orderBy: {field: CREATED_AT, direction: DESC}) { nodes {
      number headRefName
      comments(last: 40) { nodes { url createdAt body author { login } } }
      commits(last: 1) { totalCount nodes { commit { committedDate } } } } } } }'
PR_LINES='
  .data.repository.pullRequests.nodes[]
  | select(.headRefName | test("^(task-|[0-9]+-)"))
  | . as $pr
  | ([.comments.nodes[] | select(.author.login != "github-actions")]) as $comments
  | ($pr.commits.nodes[0].commit.committedDate // "") as $last
  | (["O", $pr.number, $pr.headRefName] | @tsv),
    ($comments[] | select(.body | startswith("[orchestrator]") | not)
      | ["C", $pr.number, $pr.headRefName, .url,
         (.body | gsub("\r"; "") | split("\n")[0] | gsub("\t"; " ") | .[0:200])] | @tsv),
    ($comments | last
      | select(. != null)
      | select(.body | test("^\\[orchestrator\\] (CHANGES|ANSWER|GO)"))
      | select($last < .createdAt)
      | select((now - (.createdAt | fromdateiso8601)) > 1800)
      | ["S", $pr.number, $pr.headRefName, .url] | @tsv),
    (select($pr.commits.totalCount > 1)
      | ["P", $pr.number, $pr.headRefName, $pr.commits.totalCount] | @tsv)'
polls=0
settling=false
while :; do
  # When the API budget runs low, slow down instead of going blind until it resets.
  polls=$((polls + 1))
  if [ $((polls % 30)) -eq 0 ] &&
    [ "$(gh api rate_limit --jq '.resources.graphql.remaining' 2>/dev/null || echo 5000)" -lt 400 ]; then
    sleep 120
  fi
  if lines="$(gh api graphql -f owner="${REPO_SLUG%/*}" -f name="${REPO_SLUG#*/}" -f query="$PR_QUERY" --jq "$PR_LINES" 2>/dev/null)"; then
    # Open markers first, so a READY in this same poll finds its PR open.
    while IFS=$'\t' read -r what num _; do
      if [ "${what:-}" = O ]; then touch "$STATE/open-$num"; fi
    done <<< "$lines"
    while IFS=$'\t' read -r what num branch url first; do
      case "${what:-}" in
        C)
          once "c-$(key "$url")" || continue
          report_comment "$num" "$first" "PR #$num ($branch) comment: $first"
          ;;
        S)
          once "s-$(key "$url")" &&
            emit "PR #$num ($branch) STALE: no worker reply for 30+ min after my last review"
          ;;
        P) once "picked-$num" && quiet "PR #$num ($branch) picked up: $url commits" ;;
      esac
    done <<< "$lines"
    for f in "$STATE"/open-*; do
      [ -e "$f" ] || continue
      num="${f##*/open-}"
      if ! grep -q "^O"$'\t'"$num"$'\t' <<< "$lines"; then
        rm -f "$f"
        touch "$STATE/.recheck-next"
        # merge-task.sh leaves "merged-<pr>": our own merge is not news.
        if [ -e "$STATE/merged-$num" ]; then
          rm -f "$STATE/merged-$num"
        else
          emit "PR #$num is now $(gh pr view "$num" -R "$REPO_SLUG" --json state --jq .state 2>/dev/null || echo '?')"
        fi
      fi
    done
  fi
  watch_comments
  watch_board
  watch_next
  watch_assigned
  if [ -n "${ONESHOT:-}" ] && [ -e "$FIRED" ]; then
    # One more poll, so the rest of the same action arrives in this wake-up.
    if $settling; then
      if [ -s "$QUIET" ]; then
        printf 'quiet since the last wake-up:\n'
        sed 's/^/  /' "$QUIET"
        : > "$QUIET"
      fi
      rm -f "$FIRED"
      exit 0
    fi
    settling=true
  fi
  if [ -n "${MAX_MINUTES:-}" ] && [ $(($(date +%s) - started)) -ge $((MAX_MINUTES * 60)) ]; then exit 0; fi
  sleep "$INTERVAL"
done
