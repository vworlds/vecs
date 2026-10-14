#!/usr/bin/env bash
# Offline regression checks for the SpaceRocks board/watcher port. No live API calls.
# Run from the repository root: bash scripts/tests/orchestrator.test.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
mkdir -p .tmp
TEST_DIR="$(mktemp -d "$ROOT/.tmp/orchestrator-test.XXXXXX")"
export TMPDIR="$TEST_DIR" XDG_STATE_HOME="$TEST_DIR/state"
export TEST_DIR
checks=0
check() {
  "$@" || {
    printf 'FAIL: %s\n' "$*" >&2
    exit 1
  }
  checks=$((checks + 1))
}

# Fail closed: any unmocked GitHub request is a test error.
gh() {
  printf 'unexpected gh request: %s\n' "$*" >&2
  return 1
}
export -f gh
# Load functions but not the live polling loop. The scripts share the same parent depth.
source <(sed '/^polls=0$/,$d' scripts/orchestrator/watch-prs.sh)
polls=0
NOW="$(date +%s)"
date() { if [ "${1:-}" = +%s ]; then printf '%s\n' "$NOW"; else command date "$@"; fi; }

# Owner's pacing examples, plus budget exhaustion and recovery.
pace 4000 "$((NOW + 3600))"
check test "$GQL_AT:$BLIND" = 0:false
pace 1500 "$((NOW + 1800))"
check test "$GQL_AT:$BLIND" = 0:false
pace 800 "$((NOW + 1800))"
check test "$GQL_AT" = "$((NOW + 12))"
pace 600 "$((NOW + 1800))"
check test "$GQL_AT" = "$((NOW + 36))"
pace 500 "$((NOW + 1800))" > "$TEST_DIR/budget-events"
check test "$GQL_AT:$BLIND" = "$((NOW + 1805)):true"
pace 0 "$((NOW + 1800))" >> "$TEST_DIR/budget-events"
check test "$(grep -c '^BUDGET:' "$TEST_DIR/budget-events")" = 1
pace 4500 "$((NOW + 3600))"
check test "$GQL_AT:$BLIND" = 0:false

# Headers, not misleading query body fields; lowest of multiple reset counters wins.
printf 'HTTP/2.0 200 OK\r\nX-RateLimit-Remaining: 600\r\nX-RateLimit-Reset: %s\r\n\r\n{"rateLimit":{"remaining":4999}}\n' "$((NOW + 1800))" > "$TEST_DIR/answer"
note_budget "$TEST_DIR/answer"
check test "$GQL_AT" = "$((NOW + 36))"
printf 'HTTP/2.0 200 OK\nx-ratelimit-remaining: 4000\nx-ratelimit-reset: %s\n\n{}\n' "$((NOW + 3600))" > "$TEST_DIR/answer"
note_budget "$TEST_DIR/answer"
check test "${#BUDGETS[@]}:$GQL_AT" = "2:$((NOW + 36))"
NOW=$((NOW + 1801))
note_budget "$TEST_DIR/answer"
check test "${#BUDGETS[@]}:$GQL_AT:$BLIND" = 1:0:false
printf 'HTTP/2.0 403 Forbidden\nX-RateLimit-Remaining: 0\nX-RateLimit-Reset: %s\n\n{}\n' "$((NOW + 600))" > "$TEST_DIR/answer"
note_budget "$TEST_DIR/answer" > "$TEST_DIR/denied"
check test "$BLIND" = true
printf '{}\n' > "$TEST_DIR/answer"
# Missing headers must not overwrite the known budget.
if note_budget "$TEST_DIR/answer"; then exit 1; fi
checks=$((checks + 1))
unset -f date

# One exhausted-budget polling turn: REST keeps running, no board GraphQL call is made.
# MAX_MINUTES=0 exits after that single turn, so this cannot poll even a mocked API in a loop.
gh() {
  printf '%s\n' "$*" >> "$TEST_DIR/blind-calls"
  case "$*" in
    *'api graphql -i'*)
      printf 'HTTP/2.0 403 Forbidden\nX-RateLimit-Remaining: 0\nX-RateLimit-Reset: %s\n\n{}\n' "$(($(date +%s) + 600))"
      return 1
      ;;
    *'api user'*) printf 'tester\n' ;;
    *'/issues/comments?'* | *'/issues?state=open&assignee='*) : ;;
    *)
      printf 'unexpected gh request: %s\n' "$*" >&2
      return 1
      ;;
  esac
}
export -f gh
mkdir -p "$TEST_DIR/blind-state/vecs-watch"
printf '2026-01-01T00:00:00Z\n' > "$TEST_DIR/blind-state/vecs-watch/.comments-since"
XDG_STATE_HOME="$TEST_DIR/blind-state" MAX_MINUTES=0 bash scripts/orchestrator/watch-prs.sh > "$TEST_DIR/blind-events"
check grep -q '^BUDGET:' "$TEST_DIR/blind-events"
check grep -q '/issues/comments?' "$TEST_DIR/blind-calls"
check grep -q '/issues?state=open&assignee=' "$TEST_DIR/blind-calls"
check test "$(grep -c 'api graphql' "$TEST_DIR/blind-calls")" = 1

# A missing task PR needs confirmation; even a partial GraphQL answer can be valid JSON.
gh() {
  printf '%s\n' "$*" >> "$TEST_DIR/missing-calls"
  case "$*" in
    *'api graphql -i'*)
      printf 'HTTP/2.0 200 OK\n\n'
      cat "$TEST_DIR/pr-answer.json"
      ;;
    'pr view 42 '*)
      [ "$MISSING_STATE" != failure ] || return 1
      printf '%s\n' "$MISSING_STATE"
      ;;
    *) return 1 ;;
  esac
}
export -f gh
for scenario in OPEN MERGED CLOSED failure errors; do
  export MISSING_STATE="$scenario"
  missing_state="$TEST_DIR/missing-$scenario/vecs-watch"
  mkdir -p "$missing_state"
  touch "$missing_state/open-42"
  printf '{"data":{"repository":{"pullRequests":{"nodes":[]}}}}\n' > "$TEST_DIR/pr-answer.json"
  if [ "$scenario" = errors ]; then
    jq '. + {errors:[{message:"partial answer"}]}' "$TEST_DIR/pr-answer.json" > "$TEST_DIR/partial.json"
    mv "$TEST_DIR/partial.json" "$TEST_DIR/pr-answer.json"
  fi
  : > "$TEST_DIR/missing-calls"
  XDG_STATE_HOME="${missing_state%/vecs-watch}" VECS_BOARD=off MAX_MINUTES=0 \
    bash scripts/orchestrator/watch-prs.sh > "$TEST_DIR/missing-events"
  check test "$(grep -c 'api graphql' "$TEST_DIR/missing-calls")" = 1
  if [ "$scenario" = errors ]; then
    check test "$(grep -c '^pr view' "$TEST_DIR/missing-calls" || true)" = 0
  else
    check test "$(grep -c '^pr view 42 ' "$TEST_DIR/missing-calls")" = 1
  fi
  case "$scenario" in
    MERGED | CLOSED)
      check grep -qx "PR #42 is now $scenario" "$TEST_DIR/missing-events"
      check test ! -e "$missing_state/open-42"
      check test -e "$missing_state/.recheck-next"
      ;;
    *)
      check test ! -s "$TEST_DIR/missing-events"
      check test -e "$missing_state/open-42"
      check test ! -e "$missing_state/.recheck-next"
      ;;
  esac
done

# Worker HTTP fakes record request order/body, never contact the server.
curl() {
  local method="" url="" body="" out="" arg
  printf '%s\n' "$@" >> "$TEST_DIR/curl-args"
  while [ $# -gt 0 ]; do
    arg="$1"
    shift
    case "$arg" in
      -X)
        method="$1"
        shift
        ;;
      -d)
        body="$1"
        shift
        ;;
      -o)
        out="$1"
        shift
        ;;
      --config)
        [ "$1" != - ] || cat > "$TEST_DIR/curl-config"
        shift
        ;;
      http*) url="$arg" ;;
    esac
  done
  jq -nc --arg method "$method" --arg url "$url" --arg body "$body" \
    '{method:$method,url:$url,body:(if $body == "" then null else ($body|fromjson) end)}' >> "$TEST_DIR/requests"
  printf '{"interrupted":true}\n' > "$out"
  printf '%s' "${HTTP_STATUS:-204}"
}
export -f curl
export OPENCODE_SERVER_PASSWORD=fixture-secret OPENCODE_BASE_URL=http://fixture
worker_state="$XDG_STATE_HOME/vecs-orchestrator/workers"
mkdir -p "$worker_state" "$TEST_DIR/worktree"
printf 'ses_fixture\n' > "$worker_state/$(realpath "$TEST_DIR/worktree" | tr / _)"
bash scripts/orchestrator/worker.sh model "$TEST_DIR/worktree" ollama-cloud/glm-5.3 2> "$TEST_DIR/model-log"
check jq -se 'length == 1 and .[0] == {method:"POST",url:"http://fixture/api/session/ses_fixture/model",body:{model:{providerID:"ollama-cloud",id:"glm-5.3"}}}' "$TEST_DIR/requests"
check test "$(grep -c fixture-secret "$TEST_DIR/curl-args" || true)" = 0
check grep -q fixture-secret "$TEST_DIR/curl-config"
for invalid in noslash /model provider/ 'provider/model extra'; do
  if bash scripts/orchestrator/worker.sh model ses_fixture "$invalid" 2> "$TEST_DIR/model-log"; then exit 1; fi
  checks=$((checks + 1))
done
check test "$(wc -l < "$TEST_DIR/requests")" = 1
if HTTP_STATUS=429 bash scripts/orchestrator/worker.sh model ses_fixture opencode/big-pickle 2> "$TEST_DIR/model-log"; then exit 1; fi
check grep -q 429 "$TEST_DIR/model-log"
: > "$TEST_DIR/requests"
printf 'continue where you left off\n' > "$TEST_DIR/prompt.md"
bash scripts/orchestrator/worker.sh send --now "$TEST_DIR/worktree" "$TEST_DIR/prompt.md" 2> "$TEST_DIR/send-log"
check jq -se 'map(.url) == ["http://fixture/api/session/ses_fixture/interrupt","http://fixture/api/session/ses_fixture/prompt"] and all(.method == "POST") and .[1].body == {text:"continue where you left off",delivery:"steer"}' "$TEST_DIR/requests"
: > "$TEST_DIR/requests"
if HTTP_STATUS=500 bash scripts/orchestrator/worker.sh send --now ses_fixture "$TEST_DIR/prompt.md" 2> "$TEST_DIR/send-log"; then exit 1; fi
check jq -se 'length == 1 and .[0].url == "http://fixture/api/session/ses_fixture/interrupt"' "$TEST_DIR/requests"
: > "$TEST_DIR/requests"
bash scripts/orchestrator/worker.sh send ses_fixture "$TEST_DIR/prompt.md" --queue 2> "$TEST_DIR/send-log"
check jq -se 'length == 1 and .[0].body.delivery == "queue"' "$TEST_DIR/requests"
: > "$TEST_DIR/requests"
bash scripts/orchestrator/worker.sh send ses_fixture "$TEST_DIR/prompt.md" --now 2> "$TEST_DIR/send-log"
check jq -se 'map(.url) == ["http://fixture/api/session/ses_fixture/interrupt","http://fixture/api/session/ses_fixture/prompt"]' "$TEST_DIR/requests"
: > "$TEST_DIR/requests"
if bash scripts/orchestrator/worker.sh send --now ses_fixture "$TEST_DIR/prompt.md" --queue 2> "$TEST_DIR/send-log"; then exit 1; fi
check test ! -s "$TEST_DIR/requests"
bash scripts/orchestrator/worker.sh send ses_fixture "$TEST_DIR/prompt.md" 2> "$TEST_DIR/send-log"
check jq -se 'length == 1 and .[0].body.delivery == "steer"' "$TEST_DIR/requests"
unset -f curl
unset OPENCODE_SERVER_PASSWORD OPENCODE_BASE_URL

# Board fixtures include both repos, a draft, a closed card and owner assignments.
jq -nc '{data:{node:{items:{pageInfo:{hasNextPage:false,endCursor:null},nodes:[
  {id:"PVTI_ready",status:{name:"Ready"},content:{__typename:"PullRequest",number:10,title:"ready",state:"OPEN",repository:{nameWithOwner:"vworlds/vecs"},assignees:{nodes:[]}}},
  {id:"PVTI_work",status:{name:"In progress"},content:{__typename:"PullRequest",number:11,title:"work",state:"OPEN",repository:{nameWithOwner:"vworlds/vecs"},assignees:{nodes:[{login:"jpeletier"}]}}},
  {id:"PVTI_done",status:{name:"Done"},content:{__typename:"Issue",number:12,title:"done",state:"CLOSED",repository:{nameWithOwner:"vworlds/vecs"},assignees:{nodes:[]}}},
  {id:"PVTI_other",status:{name:"Ready"},content:{__typename:"Issue",number:13,title:"other",state:"OPEN",repository:{nameWithOwner:"vworlds/spacerocks"},assignees:{nodes:[{login:"tester"}]}}},
  {id:"PVTI_draft",status:{name:"Backlog"},content:{__typename:"DraftIssue",title:"draft"}}
]}}}}' > "$TEST_DIR/board.json"
gh() {
  printf '%s\n' "$*" >> "$TEST_DIR/calls"
  case "$*" in
    *'api graphql'*)
      if [[ "$*" == *'q=-status:Done'* ]]; then
        jq '.data.node.items.nodes |= map(select(.status.name != "Done"))' "$TEST_DIR/board.json"
      else cat "$TEST_DIR/board.json"; fi
      ;;
    *'api user'*) printf 'tester\n' ;;
    *'/issues?state=open&assignee='*) : ;;
    *)
      printf 'unexpected gh request: %s\n' "$*" >&2
      return 1
      ;;
  esac
}
export -f gh
items="$(board_items '-status:Done')"
check test "$(wc -l <<< "$items")" = 4
check test "$(cut -f3 <<< "$items" | tail -1)" = DRAFT
check test "$(board_items | wc -l)" = 5
check grep -q 'query: $q, orderBy:' "$TEST_DIR/calls"
bash scripts/orchestrator/board.sh list > "$TEST_DIR/list"
check test "$(grep -c 'done' "$TEST_DIR/list" || true)" = 0
bash scripts/orchestrator/board.sh list --all > "$TEST_DIR/list"
check grep -q 'done' "$TEST_DIR/list"
bash scripts/orchestrator/board.sh list Done > "$TEST_DIR/list"
check grep -q 'done' "$TEST_DIR/list"
bash scripts/orchestrator/board.sh next > "$TEST_DIR/next"
check grep -q '^#10' "$TEST_DIR/next"
bash scripts/orchestrator/board.sh mine > "$TEST_DIR/mine"
check grep -q '^spacerocks#13' "$TEST_DIR/mine"

# Filtering survives pagination, with the returned cursor passed to the second page.
_board_gql() {
  printf '%s\n' "$*" >> "$TEST_DIR/paged-calls"
  if [[ "$*" == *after=cursor-one* ]]; then
    jq '.data.node.items.nodes |= .[1:2]' "$TEST_DIR/board.json"
  else
    jq '.data.node.items.nodes |= .[0:1] | .data.node.items.pageInfo = {hasNextPage:true,endCursor:"cursor-one"}' "$TEST_DIR/board.json"
  fi
}
paged="$(board_items '-status:Done')"
check test "$(wc -l <<< "$paged")" = 2
check test "$(grep -c 'q=-status:Done' "$TEST_DIR/paged-calls")" = 2
check grep -q 'after=cursor-one' "$TEST_DIR/paged-calls"
# Restore the real wrapper, with gh still mocked.
_board_gql() { retry 3 gh api graphql -f p="$BOARD_PROJECT" "$@"; }

# Watcher must not report Done/owner departure; prune vanished state, then report re-entry.
watch_board > "$TEST_DIR/events"
check test "$INPROGRESS_PRS" = 11
check test ! -e "$BOARD_STATE/PVTI_done"
printf 'In progress\n' > "$BOARD_STATE/PVTI_gone"
printf 'jpeletier\n' > "$BOARD_STATE/PVTI_gone.who"
printf 'Done\n' > "$BOARD_STATE/PVTI_done"
printf 'jpeletier\n' > "$BOARD_STATE/PVTI_done.who"
watch_board >> "$TEST_DIR/events"
check test ! -e "$BOARD_STATE/PVTI_gone"
check test ! -e "$BOARD_STATE/PVTI_gone.who"
check test ! -e "$BOARD_STATE/PVTI_done.who"
check test ! -s "$TEST_DIR/events"
jq '.data.node.items.nodes |= map(if .id == "PVTI_done" then .status.name = "In review" else . end)' "$TEST_DIR/board.json" > "$TEST_DIR/moved.json"
mv "$TEST_DIR/moved.json" "$TEST_DIR/board.json"
watch_board >> "$TEST_DIR/events"
check grep -q 'BOARD #12 (ISSUE): new card → In review' "$TEST_DIR/events"

# Archive collection and mutation are mocked; only old, closed, local cards qualify.
jq -nc '{data:{node:{items:{pageInfo:{hasNextPage:false},nodes:[
  {id:"PVTI_old",content:{closedAt:"2020-01-01T00:00:00Z",repository:{nameWithOwner:"vworlds/vecs"}}},
  {id:"PVTI_foreign",content:{closedAt:"2020-01-01T00:00:00Z",repository:{nameWithOwner:"vworlds/spacerocks"}}},
  {id:"PVTI_open",content:{closedAt:null,repository:{nameWithOwner:"vworlds/vecs"}}},
  {id:"PVTI_recent",content:{closedAt:(now|strftime("%Y-%m-%dT%H:%M:%SZ")),repository:{nameWithOwner:"vworlds/vecs"}}},
  {id:"PVTI_draft",content:{}}
]}}}}' > "$TEST_DIR/archive.json"
_board_gql() {
  printf '%s\n' "$*" >> "$TEST_DIR/archive-calls"
  if [[ "$*" == *archiveProjectV2Item* ]]; then printf '{}\n'; else cat "$TEST_DIR/archive.json"; fi
}
touch "$BOARD_STATE/PVTI_old" "$BOARD_STATE/PVTI_old.who"
board_archive_done 2 2> "$TEST_DIR/archive-log"
check test "$(grep -c archiveProjectV2Item "$TEST_DIR/archive-calls")" = 1
check grep -q 'i=PVTI_old' "$TEST_DIR/archive-calls"
check test ! -e "$BOARD_STATE/PVTI_old"
check test ! -e "$BOARD_STATE/PVTI_old.who"
check grep -q 'archived 1 Done' "$TEST_DIR/archive-log"

# Worker status stub lives entirely in the fixture root. No real worker is started or changed.
ROOT="$TEST_DIR/repo"
mkdir -p "$ROOT/scripts/orchestrator" "$ROOT/.worktrees/auto-11-work" "$ROOT/.worktrees/auto-14-other"
printf '#!/usr/bin/env bash\ncat "$TEST_DIR/worker-line"\n' > "$ROOT/scripts/orchestrator/worker.sh"
chmod +x "$ROOT/scripts/orchestrator/worker.sh"
export OPENCODE_SERVER_PASSWORD=fixture
lines=$'O\t11\t11-work\nO\t14\t14-other\nC\t11\t11-work'
printf 'ses_fixture idle | work | WAITING on 1 permission request(s) (1m00s ago)\n' > "$TEST_DIR/worker-line"
watch_workers "$lines" > "$TEST_DIR/worker-events"
printf 'ses_fixture idle | work | WAITING on 1 permission request(s) (2m00s ago)\n' > "$TEST_DIR/worker-line"
watch_workers "$lines" >> "$TEST_DIR/worker-events"
check test "$(grep -c '^WORKER #11' "$TEST_DIR/worker-events")" = 1
printf 'ses_fixture idle (failed) | work (2m00s ago)\n' > "$TEST_DIR/worker-line"
watch_workers "$lines" >> "$TEST_DIR/worker-events"
check test "$(grep -c '^WORKER #11' "$TEST_DIR/worker-events")" = 2
check grep -q 'turn failed' "$TEST_DIR/worker-events"
check test "$(grep -c '^WORKER #14' "$TEST_DIR/worker-events" || true)" = 0
unset OPENCODE_SERVER_PASSWORD
watch_workers "$lines" >> "$TEST_DIR/worker-events"
check test "$(grep -c '^WORKER' "$TEST_DIR/worker-events")" = 2
printf 'PASS: %s offline checks (fixtures: %s)\n' "$checks" "$TEST_DIR"
