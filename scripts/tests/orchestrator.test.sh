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

# Keep the embedded PR query structurally balanced and prove its response pipeline emits open PRs.
query_open_braces="$(grep -o '{' <<< "$PR_QUERY" | wc -l | tr -d ' ')"
query_close_braces="$(grep -o '}' <<< "$PR_QUERY" | wc -l | tr -d ' ')"
check test "$query_open_braces" = "$query_close_braces"
python3 - "$ROOT/scripts" << 'PY'
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1])
documents = []
for path in root.rglob("*.sh"):
    for match in re.finditer(r"\bquery\s*=\s*(['\"])(.*?)\1", path.read_text(), re.DOTALL):
        document = match.group(2)
        if not document.strip().startswith(("query", "mutation")):
            continue
        stack = []
        pairs = {")": "(", "}": "{"}
        for char in document:
            if char in "({":
                stack.append(char)
            elif char in ")}":
                if not stack or stack.pop() != pairs[char]:
                    raise SystemExit(f"unbalanced GraphQL delimiters in {path}: {document}")
        if stack:
            raise SystemExit(f"unbalanced GraphQL delimiters in {path}: {document}")
        documents.append((path, document))

if len(documents) < 10:
    raise SystemExit(f"expected to check all embedded GraphQL documents, found {len(documents)}")
print(f"checked balanced GraphQL delimiters in {len(documents)} embedded documents")
PY
cat > "$TEST_DIR/pr-query-fixture.json" << 'EOF'
{"data":{"repository":{"pullRequests":{"nodes":[{"number":42,"headRefName":"42-work","headRefOid":"head-sha","baseRefName":"dev","mergeable":"MERGEABLE","createdAt":"2026-01-01T00:00:00Z","comments":{"nodes":[]},"commits":{"totalCount":1,"nodes":[{"commit":{"committedDate":"2026-01-01T00:00:00Z","statusCheckRollup":{"state":"SUCCESS"}}}]}}]}}}}
EOF
query_fixture_lines="$(jq -r "$PR_LINES" "$TEST_DIR/pr-query-fixture.json")"
check grep -qx $'O\t42\t42-work\thead-sha\tMERGEABLE\tSUCCESS' <<< "$query_fixture_lines"
: > "$TEST_DIR/graphql-events"
report_graphql_error 'Expected NAME, actual: (none)' > "$TEST_DIR/graphql-events"
report_graphql_error 'Expected NAME, actual: (none)' >> "$TEST_DIR/graphql-events" || true
report_graphql_error 'a different GraphQL error' >> "$TEST_DIR/graphql-events"
check test "$(grep -c '^watcher: GraphQL error:' "$TEST_DIR/graphql-events" || true)" = 2
fails=1 BLIND=false
report_transport_error 'temporary gateway error' > "$TEST_DIR/transport-events" || true
fails=2
report_transport_error 'temporary gateway error' >> "$TEST_DIR/transport-events" || true
check test ! -s "$TEST_DIR/transport-events"
fails=3
report_transport_error 'temporary gateway error' >> "$TEST_DIR/transport-events"
report_transport_error 'temporary gateway error' >> "$TEST_DIR/transport-events" || true
check test "$(grep -c '^watcher: GraphQL transport failure:' "$TEST_DIR/transport-events")" = 1
fails=4 BLIND=true
report_transport_error 'budget 403' >> "$TEST_DIR/transport-events" || true
check test "$(grep -c '^watcher: GraphQL transport failure:' "$TEST_DIR/transport-events")" = 1
BLIND=false

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

# Progress formatting, partial updates, conditional writes, and no-op suppression use offline fakes.
check test "$(progress_text working 12 red)" = '🤖🔨 🔁1️⃣2️⃣ 🔴'
check test "$(progress_parse '🤖👍 🔁2️⃣ 🔴')" = $'ready\t2\tred'
while IFS= read -r assignment; do
  state="${assignment#state=}"
  case "$state" in
    - | all | closed | open) continue ;;
  esac
  check test -n "${PROGRESS_STATES[$state]:-}"
done < <(grep -hoE 'state=[a-z-]+' scripts/orchestrator/*.sh | sort -u)
export VECS_BOARD=on
_board_gql() {
  local arg
  case "$*" in
    *'field(name: "Progress")'*) printf 'PVTF_progress\n' ;;
    *'fieldValueByName'*) printf '%s\n' "${TEST_PROGRESS:-}" ;;
    *'updateProjectV2ItemFieldValue'*)
      TEST_WRITES=$((${TEST_WRITES:-0} + 1))
      for arg in "$@"; do case "$arg" in t=*) TEST_PROGRESS="${arg#t=}" ;; esac done
      ;;
    *'clearProjectV2ItemFieldValue'*)
      TEST_WRITES=$((${TEST_WRITES:-0} + 1))
      TEST_PROGRESS=''
      ;;
    *)
      printf 'unexpected gh request: %s\n' "$*" >&2
      return 1
      ;;
  esac
}
board_item() { printf 'PVTI_progress\n'; }
TEST_PROGRESS='' TEST_WRITES=0
board_progress 999 state=working round=1
check test "$TEST_PROGRESS" = '🤖🔨 🔁1️⃣'
board_progress 999 ci=red
check test "$TEST_PROGRESS" = '🤖🔨 🔁1️⃣ 🔴'
board_progress 999 state=ready if=silent
check test "$TEST_PROGRESS" = '🤖🔨 🔁1️⃣ 🔴'
board_progress 999 state=ready if=working round=2
check test "$TEST_PROGRESS" = '🤖👍 🔁2️⃣ 🔴'
board_progress 999 state=ready round=2
check test "$TEST_WRITES" = 3
board_progress 999 state=- round=- ci=ok
check test "$TEST_PROGRESS" = ''
check test "$TEST_WRITES" = 4
unset VECS_BOARD
_board_gql() { retry 3 gh api graphql -f p="$BOARD_PROJECT" "$@"; }
unset -f board_item
BLIND=false
# Track discovery is REST-only and associates task PRs with their labelled issue.
gh() {
  case "$*" in
    *'issues?state=open&per_page=100'*)
      jq -nc '[
        {number:339,labels:[{name:"track:mcp"}]},
        {number:340,pull_request:{},labels:[{name:"track:mcp"}],body:""},
        {number:341,pull_request:{},labels:[],body:"Part of #339"},
        {number:342,labels:[],body:"ordinary"}
      ]'
      ;;
    *'/issues/comments?'*)
      printf '339\tworker\thttps://example/339\tcomment\n340\tworker\thttps://example/340\tcomment\n350\tworker\thttps://example/350\tcomment\n'
      ;;
    *'/issues/343'*) printf '%s\n' '{"number":343,"pull_request":{},"labels":[],"body":"Closes #339"}' ;;
    *)
      printf 'unexpected gh request: %s\n' "$*" >&2
      return 1
      ;;
  esac
}
BOARD_TRACK=() BOARD_KNOWN=() BOARD_LISTED=false
export VECS_TRACK=mcp
board_load_tracks "$TEST_DIR/tracks"
check test "${BOARD_TRACK[339]}:${BOARD_TRACK[340]}:${BOARD_TRACK[341]}" = mcp:mcp:mcp
board_ours 339 && board_ours 340 && board_ours 341
check test ! "$(VECS_TRACK=other board_ours 339 && echo yes)"
board_ours 343
check test "${BOARD_TRACK[343]}" = mcp
BOARD_KNOWN[350]=1
watch_lines=$'F\t339\t339-task\thead\tdev\nS\t340\t340-task\tcomment\nQ\t341\t341-task\tseen\nC\t343\t343-task\turl\ttext\nF\t350\t350-task\thead\tdev'
check test "$(watch_filter_pr_lines "$watch_lines" | cut -f1-2 | tr '\t\n' '  ')" = 'F 339 S 340 Q 341 C 343 '
check test "$(board_ours_rows $'339\tISSUE\ttracked\n350\tISSUE\tuntracked')" = $'339\tISSUE\ttracked'
board_me() { printf 'tester\n'; }
STATE="$TEST_DIR/comment-track"
mkdir -p "$STATE"
printf '2026-01-01T00:00:00Z\n' > "$STATE/.comments-since"
check test "$(watch_comments | sed -nE 's/^COMMENT #([0-9]+).*/\1/p' | tr '\n' ' ')" = '339 340 '
VECS_TRACK=
check test ! "$(board_ours 339 && echo yes)"
check test "$(watch_filter_pr_lines "$watch_lines" | cut -f1-2 | tr '\t\n' '  ')" = 'F 350 '
check test "$(board_ours_rows $'339\tISSUE\ttracked\n350\tISSUE\tuntracked')" = $'350\tISSUE\tuntracked'
STATE="$TEST_DIR/comment-main"
mkdir -p "$STATE"
printf '2026-01-01T00:00:00Z\n' > "$STATE/.comments-since"
check test "$(watch_comments | sed -nE 's/^COMMENT #([0-9]+).*/\1/p' | tr '\n' ' ')" = '350 '
unset -f board_me
VECS_TRACK=mcp
declare -f board_items > "$TEST_DIR/board-items-original.sh"
board_items() {
  printf 'PVTI_339\tIn review\tISSUE\tvworlds/vecs\t339\tOPEN\ttracked card\t-\nPVTI_350\tIn review\tISSUE\tvworlds/vecs\t350\tOPEN\tordinary card\t-\n'
}
BOARD_STATE="$TEST_DIR/board-track/board"
mkdir -p "$BOARD_STATE"
touch "$BOARD_STATE/.seen"
printf 'Backlog\n' > "$BOARD_STATE/PVTI_339"
printf 'Backlog\n' > "$BOARD_STATE/PVTI_350"
check test "$(watch_board | sed -nE 's/^BOARD #([0-9]+).*/\1/p')" = 339
printf 'Backlog\n' > "$BOARD_STATE/PVTI_339"
printf 'Backlog\n' > "$BOARD_STATE/PVTI_350"
VECS_TRACK=
check test "$(watch_board | sed -nE 's/^BOARD #([0-9]+).*/\1/p')" = 350
export VECS_TRACK=mcp
source "$TEST_DIR/board-items-original.sh"
gh() {
  case "$*" in
    *'issues?state=open&assignee='*) printf '339\tISSUE\ttracked\n340\tPR\ttracked PR\n350\tISSUE\tordinary\n' ;;
    *)
      printf 'unexpected gh request: %s\n' "$*" >&2
      return 1
      ;;
  esac
}
board_me() { printf 'tester\n'; }
STATE="$TEST_DIR/assigned-track"
mkdir -p "$STATE"
check test "$(watch_assigned | sed -nE 's/^ASSIGNED #([0-9]+).*/\1/p' | tr '\n' ' ')" = '339 340 '
VECS_TRACK=
STATE="$TEST_DIR/assigned-main"
mkdir -p "$STATE"
check test "$(watch_assigned | sed -nE 's/^ASSIGNED #([0-9]+).*/\1/p' | tr '\n' ' ')" = '350 '
unset -f board_me
VECS_TRACK=
gh() {
  case "$*" in
    *'issues?state=open&per_page=100'*) jq -nc '[{number:339,labels:[{name:"track:mcp"}]},{number:340,pull_request:{},labels:[{name:"track:mcp"}]}]' ;;
    *'/issues/339'*) printf 'open\tfalse\tVecs MCP\n' ;;
    *)
      printf 'unexpected gh request: %s\n' "$*" >&2
      return 1
      ;;
  esac
}
printf 'placeholder task\n' > "$TEST_DIR/task.md"
if VECS_TRACK='' VECS_BOARD=off XDG_STATE_HOME="$TEST_DIR/no-track" \
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="$ROOT" \
  bash scripts/orchestrator/open-task.sh 339 "$TEST_DIR/task.md" > "$TEST_DIR/open-refusal" 2>&1; then
  printf 'FAIL: open-task accepted a track issue without VECS_TRACK\n' >&2
  exit 1
fi
check grep -q "#339 is in track 'mcp'" "$TEST_DIR/open-refusal"
if VECS_TRACK='' VECS_BOARD=off XDG_STATE_HOME="$TEST_DIR/no-track-merge" \
  bash scripts/orchestrator/merge-task.sh 340 > "$TEST_DIR/merge-refusal" 2>&1; then
  printf 'FAIL: merge-task accepted a track PR without VECS_TRACK\n' >&2
  exit 1
fi
check grep -q "#340 is in track 'mcp'" "$TEST_DIR/merge-refusal"
gh() {
  case "$*" in
    *'pr list '*) : ;;
    *'issues?state=all'*) printf '100\n' ;;
    *'api graphql'*) printf '100\n100\n' ;;
    *'pr create '*)
      printf '%s\n' "$*" > "$TEST_DIR/create-args"
      while [ $# -gt 0 ]; do
        if [ "$1" = --body-file ]; then
          cp "$2" "$TEST_DIR/create-body"
          break
        fi
        shift
      done
      printf 'https://github.com/vworlds/vecs/pull/101\n'
      ;;
    *'/issues/101/labels'*) printf '%s\n' "$*" > "$TEST_DIR/label-call" ;;
    *)
      printf 'unexpected gh request: %s\n' "$*" >&2
      return 1
      ;;
  esac
}
git() {
  case "$*" in
    'rev-parse --show-toplevel') printf '%s\n' "$ROOT" ;;
    *'ls-remote '*) return 2 ;;
    *'commit-tree '*) printf 'fixture-placeholder-sha\n' ;;
    *'fetch '* | *' push '*) : ;;
    *) command git "$@" ;;
  esac
}
export -f gh git
VECS_TRACK=mcp VECS_BASE=dev VECS_BOARD=off ROOT="$ROOT" \
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="$ROOT" \
  bash scripts/orchestrator/open-task.sh --direct 'Base Test' "$TEST_DIR/task.md" --slug base-test --base integration > "$TEST_DIR/open-success"
check grep -q -- '--base integration' "$TEST_DIR/create-args"
check grep -q 'base `integration`' "$TEST_DIR/create-body"
check grep -q 'track:mcp' "$TEST_DIR/label-call"
unset -f gh git
gh() {
  case "$*" in
    *'issues?state=open&per_page=100'*) jq -nc '[{number:360,pull_request:{},labels:[{name:"track:mcp"}]}]' ;;
    *'pr view 360 '*)
      if [ "${MERGE_CASE:-merged}" = conflict ]; then
        printf 'OPEN\t360-track-task\tfalse\tCONFLICTING\tTrack task\tintegration\n'
      elif [ "${MERGE_CASE:-merged}" = merge-open ]; then
        printf 'OPEN\tpack/idle-keepalive\tfalse\tMERGEABLE\tPack integration\tdev\n'
      elif [ "${MERGE_CASE:-merged}" = squash-open ]; then
        printf 'OPEN\t360-track-task\tfalse\tMERGEABLE\tTrack task\tdev\n'
      else
        printf 'MERGED\t360-track-task\tfalse\tMERGEABLE\tTrack task\tintegration\n'
      fi
      ;;
    *'pr ready 360 '*) : ;;
    *'pr merge 360 '*) printf '%s\n' "$*" >> "$TEST_DIR/merge-gh-args" ;;
    *'api -X DELETE '*) printf '%s\n' "$*" >> "$TEST_DIR/merge-deletes" ;;
    *'api graphql'*) : ;;
    *'pulls/360'*) printf '0123456789abcdef0123456789abcdef01234567\n' ;;
    *'api -X DELETE '*) : ;;
    *)
      printf 'unexpected gh request: %s\n' "$*" >&2
      return 1
      ;;
  esac
}
git() {
  case "$*" in
    'rev-parse --path-format=absolute --git-common-dir') printf '%s/.git\n' "$ROOT" ;;
    'rev-parse --abbrev-ref HEAD') printf 'dev\n' ;;
    rev-parse\ origin/*) printf '0123456789abcdef0123456789abcdef01234567\n' ;;
    'status --porcelain --untracked-files=no') [[ "${MERGE_CASE:-}" == *-open ]] && printf ' M mocked\n' ;;
    *' fetch -q '*) printf '%s\n' "$*" >> "$TEST_DIR/merge-fetches" ;;
    *' update-ref '*) : ;;
    *' merge '*) printf '%s\n' "$*" >> "$TEST_DIR/merge-git-merges" ;;
    *)
      printf 'unexpected git request: %s\n' "$*" >&2
      return 1
      ;;
  esac
}
export -f gh git
if VECS_TRACK=mcp VECS_BOARD=off XDG_STATE_HOME="$TEST_DIR/merge-conflict-state" MERGE_CASE=conflict \
  ROOT="$ROOT" GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="$ROOT" \
  bash scripts/orchestrator/merge-task.sh 360 > "$TEST_DIR/merge-conflict" 2>&1; then
  printf 'FAIL: merge-task accepted a conflicting integration-branch PR\n' >&2
  exit 1
fi
check grep -q 'conflicts with integration.*origin/integration' "$TEST_DIR/merge-conflict"
VECS_TRACK=mcp VECS_BOARD=off XDG_STATE_HOME="$TEST_DIR/merge-success-state" ROOT="$ROOT" \
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="$ROOT" \
  bash scripts/orchestrator/merge-task.sh 360 > "$TEST_DIR/merge-success" 2>&1
check grep -q '+integration:refs/remotes/origin/integration' "$TEST_DIR/merge-fetches"
check test "$(grep -c '+dev:refs/remotes/origin/dev' "$TEST_DIR/merge-fetches" || true)" = 0
check test ! -s "$TEST_DIR/merge-git-merges"
check grep -q 'main checkout left alone (PR base is integration)' "$TEST_DIR/merge-success"
: > "$TEST_DIR/merge-deletes"
: > "$TEST_DIR/merge-gh-args"
VECS_TRACK=mcp VECS_BOARD=off XDG_STATE_HOME="$TEST_DIR/merge-commit-state" MERGE_CASE=merge-open ROOT="$ROOT" \
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="$ROOT" \
  bash scripts/orchestrator/merge-task.sh 360 --merge-commit > "$TEST_DIR/merge-commit" 2>&1
check grep -q -- '--merge ' "$TEST_DIR/merge-gh-args"
check grep -q 'kept integration branch pack/idle-keepalive' "$TEST_DIR/merge-commit"
check test ! -s "$TEST_DIR/merge-deletes"
: > "$TEST_DIR/merge-gh-args"
: > "$TEST_DIR/merge-deletes"
VECS_TRACK=mcp VECS_BOARD=off XDG_STATE_HOME="$TEST_DIR/squash-state" MERGE_CASE=squash-open ROOT="$ROOT" \
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="$ROOT" \
  bash scripts/orchestrator/merge-task.sh 360 > "$TEST_DIR/squash-default" 2>&1
check grep -q -- '--squash ' "$TEST_DIR/merge-gh-args"
check grep -q 'deleted branch 360-track-task' "$TEST_DIR/squash-default"
unset -f gh git
export VECS_TRACK=mcp
unset -f gh
VECS_TRACK=
BOARD_TRACK=() BOARD_KNOWN=() BOARD_LISTED=false
board_progress() { printf '%s\n' "$*" >> "$TEST_DIR/progress-events"; }
board_move() { printf 'move %s\n' "$*" >> "$TEST_DIR/progress-events"; }
touch "$STATE/open-77"
report_comment 77 '[worker] READY FOR REVIEW (round 3)' 'ready'
report_comment 77 '[worker] QUESTION: clarify' 'question'
report_comment 77 '[worker] DESIGN: option' 'design'
report_comment 77 '[worker] BLOCKED: needs help' 'blocked'
report_comment 77 '[worker] progress note' 'note'
check grep -q 'state=ready round=3' "$TEST_DIR/progress-events"
check grep -q 'state=question' "$TEST_DIR/progress-events"
check grep -q 'state=design' "$TEST_DIR/progress-events"
check grep -q 'state=blocked' "$TEST_DIR/progress-events"
check grep -q 'state=working if=silent,permission,failed,idle,conflict' "$TEST_DIR/progress-events"
# GraphQL C records come only from open task PRs, so they can update Progress without relying on
# a marker left by an earlier poll. REST comments still require the marker established by a poll.
rm -f "$STATE/open-78"
report_comment 78 '[worker] READY FOR REVIEW (round 4)' 'graphql-ready' true
check grep -q 'state=ready round=4' "$TEST_DIR/progress-events"
report_comment 79 '[worker] READY FOR REVIEW (round 5)' 'rest-ready'
check test "$(grep -c 'state=ready round=5' "$TEST_DIR/progress-events" || true)" = 0
touch "$STATE/open-79"
report_comment 79 '[worker] READY FOR REVIEW (round 5)' 'rest-ready'
check grep -q 'state=ready round=5' "$TEST_DIR/progress-events"
# Exercise the REST watcher itself: its event claims the shared key and updates the open PR's
# Progress. If GraphQL claimed the same key first, REST must not duplicate that event.
board_me() { printf 'tester\n'; }
gh() {
  case "$*" in
    *'issues?state=open&per_page=100'*) printf '[]\n' ;;
    *'/issues/comments?'*)
      printf '81\tworker\thttps://github.com/vworlds/vecs/pull/81#issuecomment-81\t[worker] READY FOR REVIEW (round 7)\n'
      ;;
    *) return 1 ;;
  esac
}
printf '2026-01-01T00:00:00Z\n' > "$STATE/.comments-since"
touch "$STATE/open-81"
watch_comments > "$TEST_DIR/rest-first-events"
check grep -q 'state=ready round=7' "$TEST_DIR/progress-events"
printf '2026-01-01T00:00:00Z\n' > "$STATE/.comments-since"
touch "$STATE/open-82"
once "c-$(key 'https://github.com/vworlds/vecs/pull/81#issuecomment-81')" || true
watch_comments > "$TEST_DIR/rest-duplicate-events"
check test ! -s "$TEST_DIR/rest-duplicate-events"
unset -f board_me
gh() {
  printf 'unexpected gh request: %s\n' "$*" >&2
  return 1
}
# The watcher keeps failed Progress writes in its quiet stream instead of discarding them.
board_progress() { return 1; }
report_comment 80 '[worker] READY FOR REVIEW (round 6)' 'failed-ready' true
check grep -q 'Progress update failed for #80' "$QUIET"
board_progress() { printf '%s\n' "$*" >> "$TEST_DIR/progress-events"; }
touch "$STATE/conflict-77"
printf 'old-head\n' > "$STATE/head-77"
progress_of_head 77 new-head MERGEABLE FAILURE
check grep -q 'state=working if=silent,permission,failed,idle,conflict' "$TEST_DIR/progress-events"
check grep -q 'state=working if=conflict' "$TEST_DIR/progress-events"
check grep -q 'ci=red' "$TEST_DIR/progress-events"
check test ! -e "$STATE/conflict-77"
check test "$(cat "$STATE/head-77")" = new-head
unset -f board_progress board_move

# A competing watcher sharing the state directory exits immediately and distinctly.
mkdir -p "$TEST_DIR/lock-state/vecs-watch"
exec {lock_fd}> "$TEST_DIR/lock-state/vecs-watch/watcher.lock"
flock -n "$lock_fd"
if XDG_STATE_HOME="$TEST_DIR/lock-state" bash scripts/orchestrator/watch-prs.sh > "$TEST_DIR/lock-output" 2>&1; then
  printf 'FAIL: second watcher unexpectedly started\n' >&2
  exit 1
else
  lock_status=$?
fi
check test "$lock_status" = 4
check grep -q 'another watcher is already running' "$TEST_DIR/lock-output"
flock -u "$lock_fd"
exec {lock_fd}>&-

# One exhausted-budget polling turn: REST keeps running, no board GraphQL call is made.
# MAX_MINUTES=0 exits after that single turn, so this cannot poll even a mocked API in a loop.
gh() {
  printf '%s\n' "$*" >> "$TEST_DIR/blind-calls"
  case "$*" in
    *'api graphql -i'*)
      printf 'HTTP/2.0 403 Forbidden\nX-RateLimit-Remaining: 0\nX-RateLimit-Reset: %s\n\n{}\n' "$(($(date +%s) + 600))"
      return 1
      ;;
    *'api graphql'*)
      printf '%s\n' "$*" >> "$TEST_DIR/blind-graphql"
      return 1
      ;;
    *'api user'*) printf 'tester\n' ;;
    *'issues?state=open&per_page=100'*) printf '[]\n' ;;
    *'/issues/comments?'*)
      printf '42\tworker\thttps://github.com/vworlds/vecs/pull/42#issuecomment-1\t[worker] READY FOR REVIEW (round 2)\n'
      ;;
    *'/issues/42'*)
      if [[ "$*" == *'--jq .node_id'* ]]; then printf 'NODE\n'; else printf '%s\n' '{"number":42,"labels":[]}'; fi
      ;;
    *'/issues?state=open&assignee='*) : ;;
    *)
      printf 'unexpected gh request: %s\n' "$*" >&2
      return 1
      ;;
  esac
}
export -f gh
mkdir -p "$TEST_DIR/blind-state/vecs-watch"
printf '2026-01-01T00:00:00Z\n' > "$TEST_DIR/blind-state/vecs-watch/.comments-since"
touch "$TEST_DIR/blind-state/vecs-watch/open-42"
XDG_STATE_HOME="$TEST_DIR/blind-state" MAX_MINUTES=0 bash scripts/orchestrator/watch-prs.sh > "$TEST_DIR/blind-events"
check grep -q '^BUDGET:' "$TEST_DIR/blind-events"
check test "$(grep -c 'GraphQL transport failure' "$TEST_DIR/blind-events" || true)" = 0
check grep -q '/issues/comments?' "$TEST_DIR/blind-calls"
check grep -q '/issues?state=open&assignee=' "$TEST_DIR/blind-calls"
check test "$(grep -c 'api graphql' "$TEST_DIR/blind-calls")" = 1
check grep -q 'COMMENT #42 by worker: \[worker\] READY FOR REVIEW' "$TEST_DIR/blind-events"
check test ! -s "$TEST_DIR/blind-graphql"

# A missing task PR needs confirmation; even a partial GraphQL answer can be valid JSON.
gh() {
  printf '%s\n' "$*" >> "$TEST_DIR/missing-calls"
  case "$*" in
    *'api graphql -i'*)
      printf 'HTTP/2.0 200 OK\n\n'
      cat "$TEST_DIR/pr-answer.json"
      ;;
    *'issues?state=open&per_page=100'*) printf '[]\n' ;;
    'api repos/vworlds/vecs/pulls/42 '*)
      [ "$MISSING_STATE" != failure ] || return 1
      jq -r "$4" "$TEST_DIR/pr-state.json"
      ;;
    *)
      printf 'unexpected gh request: %s\n' "$*" >&2
      return 1
      ;;
  esac
}
export -f gh
for scenario in OPEN MERGED CLOSED failure unreadable errors; do
  export MISSING_STATE="$scenario"
  missing_state="$TEST_DIR/missing-$scenario/vecs-watch"
  mkdir -p "$missing_state"
  touch "$missing_state/open-42"
  printf '{"data":{"repository":{"pullRequests":{"nodes":[]}}}}\n' > "$TEST_DIR/pr-answer.json"
  jq -nc --arg state "$scenario" '{state:(if $state == "OPEN" then "open" else "closed" end),merged:($state == "MERGED")}' > "$TEST_DIR/pr-state.json"
  if [ "$scenario" = unreadable ]; then printf '{}\n' > "$TEST_DIR/pr-state.json"; fi
  if [ "$scenario" = errors ]; then
    jq '. + {errors:[{message:"partial answer"}]}' "$TEST_DIR/pr-answer.json" > "$TEST_DIR/partial.json"
    mv "$TEST_DIR/partial.json" "$TEST_DIR/pr-answer.json"
  fi
  : > "$TEST_DIR/missing-calls"
  XDG_STATE_HOME="${missing_state%/vecs-watch}" VECS_BOARD=off MAX_MINUTES=0 \
    bash scripts/orchestrator/watch-prs.sh > "$TEST_DIR/missing-events"
  check test "$(grep -c 'api graphql' "$TEST_DIR/missing-calls")" = 1
  if [ "$scenario" = errors ]; then
    check test "$(grep -c '/pulls/42' "$TEST_DIR/missing-calls" || true)" = 0
  else
    check test "$(grep -c '^api repos/vworlds/vecs/pulls/42 ' "$TEST_DIR/missing-calls")" = 1
  fi
  case "$scenario" in
    MERGED | CLOSED)
      check grep -qx "PR #42 is now $scenario" "$TEST_DIR/missing-events"
      check test ! -e "$missing_state/open-42"
      check test -e "$missing_state/.recheck-next"
      ;;
    errors)
      check grep -q '^watcher: GraphQL error: partial answer$' "$TEST_DIR/missing-events"
      check test -e "$missing_state/open-42"
      check test ! -e "$missing_state/.recheck-next"
      ;;
    *)
      check test ! -s "$TEST_DIR/missing-events"
      check test -e "$missing_state/open-42"
      check test ! -e "$missing_state/.recheck-next"
      ;;
  esac
done

# Conflicts share the existing query, fire once per head, and ignore UNKNOWN/mergeable heads.
for turn in 'UNKNOWN sha1' 'CONFLICTING sha1' 'CONFLICTING sha1' 'CONFLICTING sha2' 'MERGEABLE sha3'; do
  read -r mergeable head <<< "$turn"
  jq -nc --arg mergeable "$mergeable" --arg head "$head" '{data:{repository:{pullRequests:{nodes:[
    {number:42,headRefName:"42-work",headRefOid:$head,baseRefName:"dev",mergeable:$mergeable,
     comments:{nodes:[]},commits:{totalCount:1,nodes:[{commit:{committedDate:"2026-01-01T00:00:00Z"}}]}}
  ]}}}}' > "$TEST_DIR/pr-answer.json"
  XDG_STATE_HOME="$TEST_DIR/conflict-state" VECS_BOARD=off MAX_MINUTES=0 \
    bash scripts/orchestrator/watch-prs.sh >> "$TEST_DIR/conflict-events"
  case "$turn" in
    'UNKNOWN sha1') check test ! -s "$TEST_DIR/conflict-events" ;;
    'CONFLICTING sha1') check test "$(wc -l < "$TEST_DIR/conflict-events")" = 1 ;;
    *) check test "$(wc -l < "$TEST_DIR/conflict-events")" = 2 ;;
  esac
done
check test "$(grep -cx 'CONFLICT #42 (42-work): its worker must merge origin/dev and push' "$TEST_DIR/conflict-events")" = 2
check test "$(grep -c 'api graphql' "$TEST_DIR/missing-calls")" = 6
check test "$(grep -c '/pulls/42' "$TEST_DIR/missing-calls" || true)" = 0
check grep -q 'mergeable' "$TEST_DIR/missing-calls"

# Worker HTTP fakes record request order/body, never contact the server.
curl() {
  local method="" url="" body="" out="" arg timeout=""
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
      -m)
        timeout="$1"
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
  if [[ "$url" == */wait ]]; then
    printf '%s\n' "$timeout" > "$TEST_DIR/wait-timeout"
    if [ "${WAIT_TIMEOUT:-0}" = 1 ]; then return 28; fi
    printf '%s' "${WAIT_STATUS:-204}"
    return
  fi
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
check jq -se 'map(.url) == ["http://fixture/api/session/ses_fixture/interrupt","http://fixture/api/experimental/session/ses_fixture/wait","http://fixture/api/session/ses_fixture/prompt"] and all(.method == "POST") and .[2].body == {text:"continue where you left off",delivery:"steer"}' "$TEST_DIR/requests"
check test "$(cat "$TEST_DIR/wait-timeout")" = 30
: > "$TEST_DIR/requests"
if WAIT_TIMEOUT=1 bash scripts/orchestrator/worker.sh send --now ses_fixture "$TEST_DIR/prompt.md" 2> "$TEST_DIR/send-log"; then exit 1; fi
check jq -se 'map(.url) == ["http://fixture/api/session/ses_fixture/interrupt","http://fixture/api/experimental/session/ses_fixture/wait"]' "$TEST_DIR/requests"
check grep -q '30s.*not sent' "$TEST_DIR/send-log"
: > "$TEST_DIR/requests"
if WAIT_STATUS=503 bash scripts/orchestrator/worker.sh send --now ses_fixture "$TEST_DIR/prompt.md" 2> "$TEST_DIR/send-log"; then exit 1; fi
check jq -se 'map(.url) == ["http://fixture/api/session/ses_fixture/interrupt","http://fixture/api/experimental/session/ses_fixture/wait"]' "$TEST_DIR/requests"
check grep -q 503 "$TEST_DIR/send-log"
: > "$TEST_DIR/requests"
if HTTP_STATUS=500 bash scripts/orchestrator/worker.sh send --now ses_fixture "$TEST_DIR/prompt.md" 2> "$TEST_DIR/send-log"; then exit 1; fi
check jq -se 'length == 1 and .[0].url == "http://fixture/api/session/ses_fixture/interrupt"' "$TEST_DIR/requests"
: > "$TEST_DIR/requests"
bash scripts/orchestrator/worker.sh send ses_fixture "$TEST_DIR/prompt.md" --queue 2> "$TEST_DIR/send-log"
check jq -se 'length == 1 and .[0].body.delivery == "queue"' "$TEST_DIR/requests"
: > "$TEST_DIR/requests"
bash scripts/orchestrator/worker.sh send ses_fixture "$TEST_DIR/prompt.md" --now 2> "$TEST_DIR/send-log"
check jq -se 'map(.url) == ["http://fixture/api/session/ses_fixture/interrupt","http://fixture/api/experimental/session/ses_fixture/wait","http://fixture/api/session/ses_fixture/prompt"]' "$TEST_DIR/requests"
: > "$TEST_DIR/requests"
if bash scripts/orchestrator/worker.sh send --now ses_fixture "$TEST_DIR/prompt.md" --queue 2> "$TEST_DIR/send-log"; then exit 1; fi
check test ! -s "$TEST_DIR/requests"
bash scripts/orchestrator/worker.sh send ses_fixture "$TEST_DIR/prompt.md" 2> "$TEST_DIR/send-log"
check jq -se 'length == 1 and .[0].body.delivery == "steer"' "$TEST_DIR/requests"
: > "$TEST_DIR/requests"
bash scripts/orchestrator/worker.sh stop ses_fixture 2> "$TEST_DIR/send-log"
check jq -se 'map(.url) == ["http://fixture/api/session/ses_fixture/interrupt"]' "$TEST_DIR/requests"
unset -f curl
unset OPENCODE_SERVER_PASSWORD OPENCODE_BASE_URL

# Board fixtures include both repos, a draft, a closed card and owner assignments.
gh() {
  case "$*" in
    *'repos/vworlds/vecs/issues/909'*) printf 'NODE_909\n' ;;
    *'projectItems(first: 100)'*) printf 'PVTI_909\tReady\n' ;;
    *)
      printf 'unexpected gh request: %s\n' "$*" >&2
      return 1
      ;;
  esac
}
check test "$(board_lookup_item vworlds/vecs 909)" = $'PVTI_909\tReady'
declare -f board_items > "$TEST_DIR/board-items-before-missing.sh"
board_items() { :; }
check test "$(board_where 909)" = Ready
source "$TEST_DIR/board-items-before-missing.sh"

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
    *'issues?state=open&per_page=100'*) printf '[]\n' ;;
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

# Done keeps the six newest closed cards across repositories; only our older cards are archived.
jq -nc '{data:{node:{items:{pageInfo:{hasNextPage:false},nodes:[
  {id:"ours-8",content:{closedAt:"2026-01-01T00:00:00Z",repository:{nameWithOwner:"vworlds/vecs"}}},
  {id:"other-2",content:{closedAt:"2026-02-01T00:00:00Z",repository:{nameWithOwner:"vworlds/spacerocks"}}},
  {id:"ours-5",content:{closedAt:"2026-04-01T00:00:00Z",repository:{nameWithOwner:"vworlds/vecs"}}},
  {id:"ours-1",content:{closedAt:"2026-08-01T00:00:00Z",repository:{nameWithOwner:"vworlds/vecs"}}},
  {id:"other-1",content:{closedAt:"2026-09-01T00:00:00Z",repository:{nameWithOwner:"vworlds/spacerocks"}}},
  {id:"ours-7",content:{closedAt:"2026-02-15T00:00:00Z",repository:{nameWithOwner:"vworlds/vecs"}}},
  {id:"ours-3",content:{closedAt:"2026-06-01T00:00:00Z",repository:{nameWithOwner:"vworlds/vecs"}}},
  {id:"ours-2",content:{closedAt:"2026-07-01T00:00:00Z",repository:{nameWithOwner:"vworlds/vecs"}}},
  {id:"ours-4",content:{closedAt:"2026-05-01T00:00:00Z",repository:{nameWithOwner:"vworlds/vecs"}}},
  {id:"ours-6",content:{closedAt:"2026-03-01T00:00:00Z",repository:{nameWithOwner:"vworlds/vecs"}}},
  {id:"open",content:{closedAt:null,repository:{nameWithOwner:"vworlds/vecs"}}},
  {id:"draft",content:{}}
]}}}}' > "$TEST_DIR/archive.json"
_board_gql() {
  printf '%s\n' "$*" >> "$TEST_DIR/archive-calls"
  if [[ "$*" == *archiveProjectV2Item* ]]; then
    for arg in "$@"; do case "$arg" in i=*) printf '%s\n' "${arg#i=}" >> "$TEST_DIR/archived" ;; esac done
    printf '{}\n'
  else cat "$TEST_DIR/archive.json"; fi
}
touch "$BOARD_STATE/ours-7" "$BOARD_STATE/ours-7.who"
board_archive_done 6 2> "$TEST_DIR/archive-log"
check test "$(grep -c archiveProjectV2Item "$TEST_DIR/archive-calls")" = 3
check test "$(sort "$TEST_DIR/archived" | tr '\n' ' ')" = 'ours-6 ours-7 ours-8 '
check test ! -e "$BOARD_STATE/ours-7"
check test ! -e "$BOARD_STATE/ours-7.who"
check grep -q 'archived 3 Done' "$TEST_DIR/archive-log"
check test "$(grep -c 'query(\$p: ID!, \$after: String)' "$TEST_DIR/archive-calls")" = 1

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
