#!/usr/bin/env bash
# Wake the orchestrator only when something needs it. Polls GitHub from the shell and prints one
# line per event that calls for an action:
#   - PR #n … comment: a worker's READY, QUESTION, DESIGN or BLOCKED on a task PR (heads named
#     <pr>-<words>, as open-task.sh makes them, or the older task-*). READY also moves the card
#     to In review;
#   - COMMENT #n by <login>: a comment by a person other than me on any issue or PR;
#   - BOARD #n: a vecs card someone else moved to Approved, In review or back to Backlog;
#   - NEXT #n: the first card of Ready that nothing blocks changed, so there is work to start
#     (a new card, a reorder, or a blocker that closed);
#   - LAUNCH #n: an issue the owner approved can be opened as a task now. It fires when the issue
#     is approved with nothing blocking it, and later when the last blocker of an approved issue
#     closes;
#   - ASSIGNED #n: an open issue or PR newly assigned to me, which means I must act on it;
#   - OWNER DONE #n: the owner took themselves off a card that was waiting for them;
#   - STALE: my latest [orchestrator] review has had no reply or commit for 30+ minutes;
#   - PR #n is now MERGED/CLOSED: a missing task PR confirmed closed over REST, once per
#     missing PR per poll. OPEN or failed lookups keep its marker and stay quiet;
#   - CONFLICT #n (<branch>): its worker must merge origin/<base> and push; once per head SHA.
#     UNKNOWN mergeability stays quiet; uses the existing PR query, not another call;
#   - WORKER #n: the worker of a task PR that is In progress waits for a permission, or its turn
#     failed. Neither shows on the PR. Asked of the worker server once a minute (worker.sh);
#   - BUDGET: the account's GraphQL budget is spent down to the reserve. Until the reset it
#     names, the watcher sees comments and assignments only (those don't need GraphQL): no
#     board moves, no READY of a worker.
# What needs nobody is kept quiet and shown with the next real event, under "quiet since the last
# wake-up": other [worker] notes (ACK, standing by, progress), a worker's first commit, cards that
# moved to In progress (our scripts or GitHub's automation), cards put in Ready (NEXT
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
# The budget: GitHub gives an account 5,000 GraphQL points an hour, and the board can only be read
# with GraphQL. A poll costs 2 points (the task PRs, and the board without its Done column), so
# polling every 10 s takes 720 an hour. The headers of every GraphQL answer say how many points
# are left and when they come back: the watcher keeps BUDGET_RESERVE (500) for the scripts run by
# hand and spreads the rest over the time until the reset, never faster than INTERVAL. It only
# slows down when something else has been spending the budget. Comments and assignments are read
# without GraphQL and keep their INTERVAL in any case.
# Only the headers are right. `gh api rate_limit` and the rateLimit field inside a query both
# lag, and GitHub keeps more than one counter for an account (answers carry different reset
# times): the watcher remembers each and goes by the lowest.
# Usage: [INTERVAL=10] [ONESHOT=1] [MAX_MINUTES=n] [BUDGET_RESERVE=500] scripts/orchestrator/watch-prs.sh
# Orchestrators: run it as a tracked background task that notifies you when it exits,
# never with `nohup … &`: an untracked watcher reports to a file nobody reads.
# Answers with GraphQL errors are failed polls: ignore their data and back off.
set -uo pipefail
. "$(dirname "$0")/../lib/common.sh"
. "$(dirname "$0")/../lib/board.sh"
STATE="$WATCH_STATE"
mkdir -p "$STATE"
exec 9> "$STATE/watcher.lock"
if ! flock -n 9; then
  printf 'watch-prs: another watcher is already running for %s\n' "$STATE" >&2
  exit 4
fi
INTERVAL="${INTERVAL:-10}"
BUDGET_RESERVE="${BUDGET_RESERVE:-500}"
POLL_COST=2 # GraphQL points a poll costs
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
started="$(date +%s)"
# emit runs inside pipeline subshells, so "fired" is a marker file, not a variable.
FIRED="$STATE/.fired"
QUIET="$STATE/quiet.log"
rm -f "$FIRED"
emit() {
  printf '%s\n' "$*"
  touch "$FIRED"
}
# quiet <line>: worth knowing, not worth a wake-up.
quiet() { printf '%s\n' "$*" >> "$QUIET"; }
once() {
  [ -e "$STATE/$1" ] && return 1
  touch "$STATE/$1"
}
key() { printf '%s' "$1" | md5sum | cut -c1-16; }
report_graphql_error() {
  local message="$1"
  [ -n "$message" ] || message="GitHub returned an unspecified GraphQL error"
  message="${message//$'\r'/ }"
  message="${message//$'\n'/ }"
  message="${message//$'\t'/ }"
  once "graphql-error-$(key "$message")" && emit "watcher: GraphQL error: $message"
}
report_transport_error() {
  local message="$1"
  [ "$BLIND" != true ] || return 0
  [ "$fails" -ge 3 ] || return 0
  [ -n "$message" ] || message="GitHub request failed without an error message"
  message="${message//$'\r'/ }"
  message="${message//$'\n'/ }"
  message="${message//$'\t'/ }"
  once "graphql-transport-error-$(key "$message")" && emit "watcher: GraphQL transport failure: $message"
}
# needs_me <first line of a comment>: a worker's READY, QUESTION, DESIGN and BLOCKED do; its
# other notes don't. Anything that is not a [worker] note does.
needs_me() {
  case "$1" in
    "[worker] READY"* | "[worker] QUESTION"* | "[worker] DESIGN"* | "[worker] BLOCKED"*) return 0 ;;
    "[worker]"*) return 1 ;;
    *) return 0 ;;
  esac
}
# Watcher-only board writes must not spend the remaining GraphQL reserve when BLIND.
watch_progress() {
  [ "${BLIND:-false}" != true ] || return 2
  board_progress "$@" || {
    quiet "watcher: Progress update failed for #$1 ($*)"
    return 1
  }
}
watch_progress_clear() { watch_progress "$1" state=- round=- ci=ok; }
watch_progress_move() {
  [ "${BLIND:-false}" != true ] || return 2
  board_move "$@"
}
# report_comment <number> <first line> <event line>: wake or stay quiet, and on a worker's READY
# for an open task PR move its card to In review.
report_comment() {
  local number="$1" first="$2" line="$3" confirmed_open="${4:-false}"
  if needs_me "$first"; then emit "$line"; else quiet "$line"; fi
  [ -e "$STATE/open-$number" ] || [ "$confirmed_open" = true ] || return 0
  local round
  case "$first" in
    "[worker] READY"*)
      watch_progress_move "$number" "In review" 2> /dev/null || quiet "watcher: In review move failed for #$number"
      round="$(grep -o -i -E 'round [0-9]+' <<< "$first" | grep -o -E '[0-9]+' | head -1)"
      watch_progress "$number" state=ready ${round:+round=$round} 2> /dev/null || true
      ;;
    "[worker] QUESTION"*) watch_progress "$number" state=question 2> /dev/null || true ;;
    "[worker] DESIGN"*) watch_progress "$number" state=design 2> /dev/null || true ;;
    "[worker] BLOCKED"*) watch_progress "$number" state=blocked 2> /dev/null || true ;;
    "[worker]"*) revive "$number" ;;
  esac
}
revive() { watch_progress "$1" state=working if="${PROGRESS_STUCK// /,}" 2> /dev/null || true; }
# The board is shared with other repos: only vecs cards are reported. Moves made by the
# orchestrator scripts are already recorded (board_remember), so they aren't reported back. The
# first poll only records where every card is. READY_ROWS and APPROVED_ROWS keep those columns
# for watch_next.
READY_ROWS="" APPROVED_ROWS="" OTHER_ROWS="" INPROGRESS_PRS=""
watch_board() {
  board_enabled || return 0
  local items first=false item column kind repo number title who old was mark line
  # Without the Done column: it only grows, and nothing there needs anyone.
  items="$(board_items "-status:Done" 2> /dev/null)" || return 0
  mkdir -p "$BOARD_STATE"
  [ -e "$BOARD_STATE/.seen" ] || {
    touch "$BOARD_STATE/.seen"
    first=true
  }
  while IFS=$'\t' read -r item column kind repo number _ title who; do
    [ -n "${item:-}" ] || continue
    if [ "$repo" = "$REPO_SLUG" ] && [[ "$number" =~ ^[0-9]+$ ]] && ! board_ours "$number"; then continue; fi
    [ "$column" != Done ] || continue
    was="$(cat "$BOARD_STATE/$item.who" 2> /dev/null || true)"
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
    old="$(cat "$BOARD_STATE/$item" 2> /dev/null || true)"
    [ "$old" = "$column" ] && continue
    printf '%s\n' "$column" > "$BOARD_STATE/$item"
    $first && continue
    [ "$repo" = "$REPO_SLUG" ] || continue
    line="BOARD #$number ($kind): ${old:-new card} → $column: $title"
    case "$column" in
      # Our scripts and GitHub's own automation put cards here; there is nothing to do.
      "In progress") quiet "$line" ;;
      # A card in Ready matters when it can be started, and NEXT says that; a blocked one waits.
      "Ready") quiet "$line" ;;
      # A new idea parked in Backlog waits for the owner; a card sent back to it is news.
      "Backlog") if [ -z "$old" ]; then quiet "$line"; else emit "$line"; fi ;;
      *) emit "$line" ;;
    esac
  done <<< "$items"
  # Drop state for cards no longer returned (Done, archived or removed).
  local f id
  for f in "$BOARD_STATE"/PVTI_*; do
    [ -e "$f" ] || continue
    id="${f##*/}" id="${id%.who}"
    awk -F'\t' -v id="$id" '$1 == id && $2 != "Done" { found = 1 } END { exit !found }' <<< "$items" || rm -f "$f"
  done
  READY_ROWS="$(board_ours_rows "$(awk -F'\t' -v here="$REPO_SLUG" '$2 == "Ready" && $4 == here { print $5 "\t" $3 "\t" $7 }' <<< "$items")")"
  APPROVED_ROWS="$(board_ours_rows "$(awk -F'\t' -v here="$REPO_SLUG" '$2 == "Approved" && $4 == here && $3 == "ISSUE" { print $5 "\t" $3 "\t" $7 }' <<< "$items")")"
  INPROGRESS_PRS="$(awk -F'\t' -v here="$REPO_SLUG" '$2 == "In progress" && $4 == here && $3 == "PR" { print $5 }' <<< "$items" | while read -r number; do board_ours "$number" && printf '%s\n' "$number"; done)"
  # Open cards of the other repos, for watch_assigned: repo, number, kind, title, assignees.
  OTHER_ROWS="$(awk -F'\t' -v here="$REPO_SLUG" '$4 != here && $4 != "-" && $6 == "OPEN" { print $4 "\t" $5 "\t" $3 "\t" $7 "\t" $8 }' <<< "$items")"
}
# What can be started now: the first card of Ready that nothing blocks (NEXT), and the first
# approved issue that nothing blocks (LAUNCH). A card can become startable without moving, when
# its last blocker closes or the relation is removed, so this is looked at again whenever those
# columns changed, a task PR closed, or a minute has passed. Blockers cost a request per issue.
NEXT_SIG="" NEXT_AT=0
watch_next() {
  board_enabled || return 0
  ! board_startable_held || return 0
  local now sig next launch
  now="$(date +%s)"
  sig="$READY_ROWS|$APPROVED_ROWS"
  [ "$sig" != "$NEXT_SIG" ] || [ -e "$STATE/.recheck-next" ] || [ $((now - NEXT_AT)) -ge 60 ] || return 0
  next="$(board_first_unblocked "$READY_ROWS")" || return 0
  launch="$(board_first_unblocked "$APPROVED_ROWS")" || return 0
  rm -f "$STATE/.recheck-next"
  NEXT_SIG="$sig" NEXT_AT="$now"
  if [ "$launch" != "$(cat "$BOARD_STATE/.launch" 2> /dev/null || true)" ]; then
    printf '%s\n' "$launch" > "$BOARD_STATE/.launch"
    [ -z "$launch" ] || emit "LAUNCH $launch: approved and nothing blocks it"
  fi
  if [ "$next" != "$(cat "$BOARD_STATE/.next" 2> /dev/null || true)" ]; then
    printf '%s\n' "$next" > "$BOARD_STATE/.next"
    [ -z "$next" ] || emit "NEXT $next"
  fi
}
# Whatever is assigned to me needs an action from me, on the board or not. Reported once per
# assignment: taking me off and putting me back reports it again.
watch_assigned() {
  board_enabled || return 0
  local me mine number kind title
  me="$(board_me 2> /dev/null)" || return 0
  mine="$(gh api --paginate "repos/$REPO_SLUG/issues?state=open&assignee=$me&per_page=100" \
    --jq '.[] | "\(.number)\t\(if .pull_request then "PR" else "ISSUE" end)\t\(.title)"' 2> /dev/null)" || return 0
  while IFS=$'\t' read -r number kind title; do
    [ -n "${number:-}" ] || continue
    board_ours "$number" || continue
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
    [ "$repo" = "$REPO_SLUG" ] || [ -z "$VECS_TRACK" ] || continue
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
  since="$(cat "$STATE/.comments-since" 2> /dev/null || true)"
  if [ -z "$since" ]; then
    printf '%s\n' "$now" > "$STATE/.comments-since"
    return 0
  fi
  me="$(board_me 2> /dev/null)" || return 0
  lines="$(gh api "repos/$REPO_SLUG/issues/comments?since=$since&sort=created&direction=asc&per_page=100" --jq '
      .[] | select(.user.type != "Bot") | select(.user.login != "'"$me"'")
      | select(.body | startswith("[orchestrator]") | not)
      | [(.issue_url | split("/") | last), .user.login, .html_url,
         (.body | gsub("\r"; "") | split("\n")[0] | gsub("\t"; " ") | .[0:200])] | @tsv' 2> /dev/null)" || return 0
  while IFS=$'\t' read -r number login url first; do
    [ -n "${number:-}" ] || continue
    board_ours "$number" || continue
    once "c-$(key "$url")" || continue
    report_comment "$number" "$first" "COMMENT #$number by $login: $first"
  done <<< "$lines"
  printf '%s\n' "$now" > "$STATE/.comments-since"
}
# A worker that waits for a permission, or whose turn failed, says nothing on its PR. Ask the
# worker server about the task PRs that are In progress. <lines> are the PR query's lines.
watch_workers() {
  [ -n "${OPENCODE_SERVER_PASSWORD:-}" ] || return 0
  local what num branch dir line
  while IFS=$'\t' read -r what num branch _; do
    [ "${what:-}" = O ] || continue
    grep -q -x -- "$num" <<< "$INPROGRESS_PRS" || continue
    dir="$ROOT/.worktrees/auto-$branch"
    [ -d "$dir" ] || continue
    line="$("$ROOT/scripts/orchestrator/worker.sh" status "$dir" 2> /dev/null)" || continue
    # The key leaves the "(3m12s ago)" out: one report per stop, not one per minute.
    case "$line" in
      *"WAITING on"*)
        once "w-$num-$(key "${line% (*}")" \
          && emit "WORKER #$num ($branch): waits for a permission; see worker.sh permit ${dir#"$ROOT"/}" \
          && { watch_progress "$num" state=permission if=working,silent,idle,failed 2> /dev/null || true; }
        ;;
      *" idle (failed) "*)
        once "w-$num-$(key "${line% (*}")" \
          && emit "WORKER #$num ($branch): its turn failed; see worker.sh log ${dir#"$ROOT"/}" \
          && { watch_progress "$num" state=failed if=working,silent,idle,permission 2> /dev/null || true; }
        ;;
    esac
  done <<< "$1"
}
# pace <points left> <reset, epoch seconds>: when the next GraphQL poll may run (GQL_AT), and
# whether the budget is spent (BLIND). Comments and assignments keep their INTERVAL.
GQL_AT=0 BLIND=false
pace() {
  local now left wait pause at
  now="$(date +%s)"
  left=$(($1 - BUDGET_RESERVE))
  wait=$(($2 - now))
  [ "$wait" -gt 0 ] || wait=1
  at="$(date -u -d "@$2" +%H:%M:%SZ)"
  GQL_AT=0 BLIND=false
  if [ "$left" -le 0 ]; then
    once "budget-$2" \
      && emit "BUDGET: $1 GraphQL points left of 5000; until $at the watcher sees comments and assignments only"
    GQL_AT=$(($2 + 5)) BLIND=true
    return 0
  fi
  pause=$(((POLL_COST * wait + left - 1) / left))
  if [ "$pause" -gt "$INTERVAL" ]; then
    GQL_AT=$((now + pause))
    once "slow-$2" && quiet "watcher: $1 GraphQL points left, board and PRs polled slower until $at"
  fi
  return 0
}
# note_budget <file with a GraphQL answer and its headers>: remember this answer's counter,
# drop expired counters, and pace by the lowest. Fails when there are no budget headers.
declare -A BUDGETS=()
note_budget() {
  local left="" reset="" now k low="" low_reset=""
  read -r left reset < <(tr -d '\r' < "$1" 2> /dev/null | awk -F': ' '
    /^$/ { exit }
    tolower($1) == "x-ratelimit-remaining" { r = $2 }
    tolower($1) == "x-ratelimit-reset" { t = $2 }
    END { print r, t }') || true
  [[ "$left" =~ ^[0-9]+$ && "$reset" =~ ^[0-9]+$ ]] || return 1
  now="$(date +%s)"
  BUDGETS[$reset]="$left"
  for k in "${!BUDGETS[@]}"; do
    if [ "$k" -le "$now" ]; then
      unset "BUDGETS[$k]"
    elif [ -z "$low" ] || [ "${BUDGETS[$k]}" -lt "$low" ]; then
      low="${BUDGETS[$k]}" low_reset="$k"
    fi
  done
  pace "${low:-$left}" "${low_reset:-$reset}"
  [ -z "${WATCH_DEBUG:-}" ] \
    || log "poll $polls: this answer $left left; lowest of ${#BUDGETS[@]} counter(s) ${low:-$left}; next GraphQL poll in $((GQL_AT > 0 ? GQL_AT - now : INTERVAL))s"
}
# One GraphQL call per poll covers every open task PR. Lines: O = open task PR,
# C = comment, S = stale review, P = commit count, F = conflict.
PR_QUERY='
  query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 50, orderBy: {field: CREATED_AT, direction: DESC}) { nodes {
      number headRefName headRefOid baseRefName mergeable
      comments(last: 40) { nodes { url createdAt body author { login } } }
      commits(last: 1) { totalCount nodes { commit { committedDate statusCheckRollup { state } } } } } } } }'
PR_LINES='
  if (.errors // [] | length) > 0 then error("GraphQL errors") else . end
  |
  .data.repository.pullRequests.nodes[]
  | select(.headRefName | test("^(task-|[0-9]+-)"))
  | . as $pr
  | ([.comments.nodes[] | select(.author.login != "github-actions")]) as $comments
  | ($pr.commits.nodes[0].commit.committedDate // "") as $last
  | (["O", $pr.number, $pr.headRefName, $pr.headRefOid, $pr.mergeable, ($pr.commits.nodes[0].commit.statusCheckRollup.state // "NONE")] | @tsv),
    (select($pr.mergeable == "CONFLICTING")
      | ["F", $pr.number, $pr.headRefName, $pr.headRefOid, $pr.baseRefName] | @tsv),
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
      | ["P", $pr.number, $pr.headRefName, $pr.commits.totalCount] | @tsv),
    ([$pr.createdAt, $last, ($comments | last | .createdAt // "")] | max) as $seen
    | (select((now - ($seen | fromdateiso8601)) > 2400)
      | ["Q", $pr.number, $pr.headRefName, $seen] | @tsv)'
# Keep Progress tied to the current head, using fields already returned by the PR query.
progress_of_head() {
  local num="$1" head="$2" mergeable="$3" ci="$4" old
  old="$(cat "$STATE/head-$num" 2> /dev/null || true)"
  if [ "$old" != "$head" ]; then
    printf '%s\n' "$head" > "$STATE/head-$num"
    [ -z "$old" ] || revive "$num"
  fi
  if [ "$mergeable" = MERGEABLE ] && [ -e "$STATE/conflict-$num" ]; then
    rm -f "$STATE/conflict-$num"
    watch_progress "$num" state=working if=conflict 2> /dev/null || true
  fi
  case "$ci" in FAILURE | ERROR) ci=red ;; *) ci=ok ;; esac
  if [ "$ci" != "$(cat "$STATE/ci-$num" 2> /dev/null || true)" ]; then
    watch_progress "$num" ci="$ci" 2> /dev/null && printf '%s\n' "$ci" > "$STATE/ci-$num"
  fi
}
watch_filter_pr_lines() {
  local what num rest
  while IFS=$'\t' read -r what num rest; do
    [[ "${num:-}" =~ ^[1-9][0-9]*$ ]] && board_ours "$num" && printf '%s\t%s\t%s\n' "$what" "$num" "$rest"
  done <<< "$1"
  return 0
}
polls=0
tracks_read=false
fails=0
settling=false
while :; do
  polls=$((polls + 1))
  lines=""
  if [ $((polls % 3)) -eq 1 ] || ! $tracks_read; then
    board_load_tracks "$STATE/tracks" 2> /dev/null && tracks_read=true
  fi
  turn=true
  [ "$(date +%s)" -ge "$GQL_AT" ] || turn=false
  answered=false
  graphql_failed=false
  transport_failed=false
  transport_error=""
  if $turn; then
    gh api graphql -i -f owner="${REPO_SLUG%/*}" -f name="${REPO_SLUG#*/}" -f query="$PR_QUERY" \
      > "$STATE/.answer" 2> "$STATE/.error" && answered=true
    note_budget "$STATE/.answer" || true
    graphql_errors="$(sed '1,/^\r\{0,1\}$/d' "$STATE/.answer" | jq -r '.errors[]?.message // empty' 2> /dev/null || true)"
    if [ -n "$graphql_errors" ]; then
      while IFS= read -r graphql_error; do
        [ -n "$graphql_error" ] || continue
        report_graphql_error "$graphql_error"
      done <<< "$graphql_errors"
      answered=false
      graphql_failed=true
    elif ! $answered; then
      transport_error="$(head -1 "$STATE/.error" | tr '\t\r\n' '   ' | cut -c1-300)"
      graphql_failed=true
      transport_failed=true
    fi
  fi
  if ! $turn; then
    :
  elif $answered && lines="$(sed '1,/^\r\{0,1\}$/d' "$STATE/.answer" | jq -r "$PR_LINES" 2> /dev/null)"; then
    fails=0
    # Open markers first, so a READY in this same poll finds its PR open.
    while IFS=$'\t' read -r what num _; do
      if [ "${what:-}" = O ]; then touch "$STATE/open-$num"; fi
    done <<< "$lines"
    while IFS=$'\t' read -r what num branch url first second; do
      case "${what:-}" in
        O) progress_of_head "$num" "$url" "$first" "$second" ;;
        C)
          once "c-$(key "$url")" || continue
          report_comment "$num" "$first" "PR #$num ($branch) comment: $first" true
          ;;
        S)
          once "s-$(key "$url")" \
            && emit "PR #$num ($branch) STALE: no worker reply for 30+ min after my last review" \
            && { watch_progress "$num" state=idle if=working 2> /dev/null || true; }
          ;;
        P) once "picked-$num" && quiet "PR #$num ($branch) picked up: $url commits" ;;
        F) once "conflict-$num-$url" && emit "CONFLICT #$num ($branch): its worker must merge origin/$first and push" \
          && {
            touch "$STATE/conflict-$num"
            watch_progress "$num" state=conflict 2> /dev/null || true
          } ;;
        Q)
          grep -q -x -- "$num" <<< "$INPROGRESS_PRS" || continue
          grep -q "^S"$'\t'"$num"$'\t' <<< "$lines" && continue
          once "q-$num-$(key "$url")" \
            && emit "PR #$num ($branch) SILENT: no commit or comment for 40+ min while In progress; see worker.sh status and log" \
            && { watch_progress "$num" state=silent if=working 2> /dev/null || true; }
          ;;
      esac
    done < <(watch_filter_pr_lines "$lines")
    for f in "$STATE"/open-*; do
      [ -e "$f" ] || continue
      num="${f##*/open-}"
      if ! board_ours "$num"; then
        rm -f "$f"
        continue
      fi
      if ! grep -q "^O"$'\t'"$num"$'\t' <<< "$lines"; then
        state="$(gh api "repos/$REPO_SLUG/pulls/$num" --jq '
          if .merged == true then "MERGED"
          elif .state == "closed" then "CLOSED"
          elif .state == "open" then "OPEN"
          else empty end' 2> /dev/null)" || continue
        case "$state" in MERGED | CLOSED) ;; *) continue ;; esac
        rm -f "$f" "$STATE/head-$num" "$STATE/ci-$num" "$STATE/conflict-$num"
        touch "$STATE/.recheck-next"
        # merge-task.sh leaves "merged-<pr>": our own merge is not news.
        if [ -e "$STATE/merged-$num" ]; then
          rm -f "$STATE/merged-$num"
        else
          emit "PR #$num is now $state"
          watch_progress_clear "$num" 2> /dev/null || true
        fi
      fi
    done
  elif ! $BLIND; then
    # GitHub did not answer, or refused: don't hammer it. Back off up to five minutes.
    lines=""
    if ! $graphql_failed; then
      report_graphql_error "Invalid GraphQL response or PR_LINES parsing failure"
    fi
    fails=$((fails + 1))
    [ "$transport_failed" != true ] || report_transport_error "$transport_error"
    backoff=$((INTERVAL * (1 << (fails < 5 ? fails : 5))))
    [ "$backoff" -le 300 ] || backoff=300
    GQL_AT=$(($(date +%s) + backoff))
  fi
  watch_comments
  if $turn && ! $BLIND; then
    watch_board
    watch_next
  fi
  watch_assigned
  if [ $((polls % 6)) -eq 1 ]; then watch_workers "$lines"; fi
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
