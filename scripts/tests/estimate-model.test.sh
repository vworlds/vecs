#!/usr/bin/env bash
# Offline behavioral tests: no request can escape the gh/curl/git fakes.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
mkdir -p .tmp
TEST_DIR="$(mktemp -d "$ROOT/.tmp/estimate-model.XXXXXX")"
export ROOT TEST_DIR TMPDIR="$TEST_DIR" XDG_STATE_HOME="$TEST_DIR/state"
export VECS_BOARD=on VECS_TRACK='' VECS_REPO=vworlds/vecs
checks=0
check() {
  "$@" || {
    printf 'FAIL: %s\n' "$*" >&2
    exit 1
  }
  checks=$((checks + 1))
}
refuse() {
  if "$@" > "$TEST_DIR/refused" 2>&1; then
    echo "FAIL: accepted $*" >&2
    exit 1
  fi
  checks=$((checks + 1))
}
gh() {
  printf '%s\n' "$*" >> "$TEST_DIR/calls"
  local query='' input='' prev='' arg
  for arg in "$@"; do
    case "$prev" in --jq) query="$arg" ;; --input) input="$arg" ;; esac
    prev="$arg"
  done
  if [ -n "$input" ]; then
    cat "$input" >> "$TEST_DIR/writes"
    printf '{}\n'
    return
  fi
  case "$*" in
    *'items(first: 100'*) cat "$TEST_DIR/items.json" ;;
    *'issues?state=open&per_page=100'*) cat "$TEST_DIR/tracks.json" ;;
    *'fieldValueByName(name: $name)'*)
      if [[ "$*" == *'name=Estimate'* ]]; then
        printf '{"data":{"node":{"fieldValueByName":{"number":%s}}}}' "${FIELD_POINTS:-5.0}" | jq -r "$query"
      else printf '%s\n' "${HINT:-}"; fi
      ;;
    *'field(name: $name)'*)
      if [[ "$*" == *'name=Model'* ]]; then
        printf 'PVTF_model\nOPT_sol\tsol\nOPT_luna\tluna\nOPT_astra\tastra\nOPT_other\tother\nOPT_sonnet\tsonnet\nOPT_opus\topus\n'
      else printf 'PVTF_estimate\n'; fi
      ;;
    *'addProjectV2ItemById'*) printf 'PVTI_card\n' ;;
    *'field(name: "Status")'*) printf 'PVTF_status\tOPT_progress\tIn progress\n' ;;
    *'field(name: "Progress")'*) printf 'PVTF_progress\n' ;;
    *'fieldValueByName(name: "Progress")'*) printf '\n' ;;
    *'updateProjectV2ItemFieldValue'* | *'updateProjectV2ItemPosition'*) : ;;
    *'clearProjectV2ItemFieldValue'*) printf 'clear\n' >> "$TEST_DIR/writes" ;;
    *'issues/7 '*'@tsv'*) printf 'open\tfalse\tIssue title\n' ;;
    *'has("pull_request")'*) printf '%s\n' "${IS_PR:-false}" ;;
    *'issues/'*'node_id'*) printf 'NODE\n' ;;
    *'issues/7/dependencies/blocked_by'*) : ;;
    *'api user'*) printf 'tester\n' ;;
    *'api -X DELETE '*'/assignees'*) : ;;
    *'pr view '*) cat "$TEST_DIR/pr.json" ;;
    *'pr list '*) : ;;
    *'issues?state=all'*) printf '100\n' ;;
    *'issues(last: 1)'*) printf '100\n100\n' ;;
    *'pr create '*)
      while [ $# -gt 0 ]; do
        if [ "$1" = --body-file ]; then
          cp "$2" "$TEST_DIR/body"
          break
        fi
        shift
      done
      printf 'https://github.com/vworlds/vecs/pull/101\n'
      ;;
    *'/dependencies/blocking'*)
      printf '[{"number":12,"state":"open","repository_url":"https://api.github.com/repos/vworlds/vecs"},{"number":13,"state":"closed","repository_url":"https://api.github.com/repos/vworlds/vecs"},{"number":14,"state":"open","repository_url":"https://api.github.com/repos/vworlds/spacerocks"}]' | jq -r "$query"
      ;;
    *'api -X POST '*'/comments'*) printf '{}\n' ;;
    *)
      printf 'unexpected gh request: %s\n' "$*" >&2
      return 1
      ;;
  esac
}
curl() {
  cat > "$TEST_DIR/curl-config"
  local out='' prev='' arg url="${*: -1}"
  printf '%s\n' "$*" >> "$TEST_DIR/requests"
  for arg in "$@"; do
    [ "$prev" != -o ] || out="$arg"
    prev="$arg"
  done
  if [ "${CURL_FAIL:-false}" = true ]; then
    printf '{}' > "$out"
    printf 503
    return
  fi
  case "$url" in
    */api/session) printf '{"data":{"id":"ses_fake"}}' > "$out" ;;
    */api/session/ses_fake) jq -nc --arg d "$TEST_DIR/auto-101-task" '{data:{location:{directory:$d}}}' > "$out" ;;
    *) printf '{}' > "$out" ;;
  esac
  printf 200
}
git() {
  case "$*" in
    'rev-parse --show-toplevel') printf '%s\n' "$ROOT" ;;
    *'ls-remote '*) return 2 ;;
    *'commit-tree '*) printf 'fake-sha\n' ;;
    *'fetch '* | *' push '*) : ;;
    *)
      printf 'unexpected git: %s\n' "$*" >&2
      return 1
      ;;
  esac
}
export -f gh curl git
printf '[]\n' > "$TEST_DIR/tracks.json"
printf 'task\n' > "$TEST_DIR/task.md"
printf '{"state":"OPEN","title":"Task","body":"> Worker model: `ollama-cloud/glm-5.3`"}' > "$TEST_DIR/pr.json"
. scripts/lib/common.sh
. scripts/lib/board.sh

# Float normalization in both TSV snapshots and action reads; zero must not become empty.
for pair in 5.0:5 0.5:0.5 999.0:999 0.0:0; do
  answer="${pair%:*}" shown="${pair#*:}"
  printf '{"data":{"node":{"items":{"pageInfo":{"hasNextPage":false},"nodes":[{"id":"PVTI_a","status":{"name":"Backlog"},"estimate":{"number":%s},"model":{"name":"sol"},"content":{"__typename":"Issue","number":7,"state":"OPEN","title":"","repository":{"nameWithOwner":"vworlds/vecs"},"assignees":{"nodes":[]}}}]}}}}' "$answer" > "$TEST_DIR/items.json"
  check test "$(board_items | cut -f7-10)" = $'-\t-\t'"$shown"$'\tsol'
  check test "$(FIELD_POINTS="$answer" board_field_get 7 Estimate)" = "$shown"
done
check test "$(board_field_get 7 Estimate)" = 5
check test "$(board_blocking 7)" = 12

# Every scale value writes a JSON number, never a string (including gh's float trap).
for points in $ESTIMATE_POINTS; do
  bash scripts/orchestrator/grade.sh "$points" 7
  check test "$(tail -1 "$TEST_DIR/writes" | jq -r '.variables.value.number | type')" = number
  check test "$(tail -1 "$TEST_DIR/writes" | jq -r '.variables.value.number')" = "$points"
done
check test -e "$BOARD_STATE/graded-7"
before="$(wc -l < "$TEST_DIR/calls")"
for invalid in 4 -1 0.25 nope ''; do refuse bash scripts/orchestrator/grade.sh "$invalid" 7; done
refuse bash scripts/orchestrator/grade.sh 3 vworlds/spacerocks#7
check test "$(wc -l < "$TEST_DIR/calls")" = "$before"
bash scripts/orchestrator/grade.sh none 8 9
check test "$(grep -c '^clear$' "$TEST_DIR/writes")" = 2
check test -e "$BOARD_STATE/graded-8"
check test -e "$BOARD_STATE/graded-9"

# Expanded board rows: list's assignee must not absorb points/model; next's title stays one field.
check grep -q 'Backlog' <(bash scripts/orchestrator/board.sh list)
check grep -q '(0 pt) <sol>' <(bash scripts/orchestrator/board.sh list)
check test "$(bash scripts/orchestrator/board.sh list --tsv | awk -F'\t' '{print NF}')" = 10

# GRADE uses one board snapshot and no writes/lookups; preserves track scope and none markers.
# Load watcher functions only, never its live polling loop.
source <(sed '/^polls=0$/,$d' scripts/orchestrator/watch-prs.sh)
board_items() {
  printf 'snapshot\n' >> "$TEST_DIR/snapshots"
  printf 'PVTI_a\tBacklog\tISSUE\tvworlds/vecs\t7\tOPEN\tordinary\t-\t-\tsol\n'
  printf 'PVTI_b\tBacklog\tISSUE\tvworlds/vecs\t8\tOPEN\tnone\t-\t-\t-\n'
  printf 'PVTI_c\tBacklog\tISSUE\tvworlds/vecs\t10\tOPEN\ttracked\tjpeletier\t-\tluna\n'
  printf 'PVTI_d\tBacklog\tISSUE\tvworlds/spacerocks\t11\tOPEN\tforeign\t-\t-\t-\n'
  printf 'PVTI_e\tBacklog\tISSUE\tvworlds/vecs\t12\tOPEN\tgraded\t-\t3\tsol\n'
  printf 'PVTI_f\tBacklog\tPR\tvworlds/vecs\t13\tOPEN\tPR\t-\t-\tsol\n'
  printf 'PVTI_g\tBacklog\tISSUE\tvworlds/vecs\t14\tOPEN\tungraded\t-\t-\t-\n'
}
BOARD_TRACK[10]=mcp
BOARD_LISTED=false
before="$(wc -l < "$TEST_DIR/calls")"
watch_board > "$TEST_DIR/events"
watch_board >> "$TEST_DIR/events"
check test "$(grep '^GRADE' "$TEST_DIR/events")" = 'GRADE #14: no estimate yet: ungraded'
check test "$(wc -l < "$TEST_DIR/calls")" = "$before"
check test "$(wc -l < "$TEST_DIR/snapshots")" = 2
VECS_TRACK=mcp
watch_board > "$TEST_DIR/track-events"
check test "$(grep '^GRADE' "$TEST_DIR/track-events")" = 'GRADE #10: no estimate yet: tracked'
check test "$(cat "$BOARD_STATE/PVTI_c.who")" = jpeletier
VECS_TRACK=''

# Registry, central gates, default/header launch and switch, including raw gated ids.
check test "$(model_family codexbal/gpt-6-astra)" = astra
check test "$(model_family unknown/model)" = other
check test "$(model_resolve sol false)" = $'sol\tcodexbal/gpt-6.1-sol\topencode'
while IFS=$'\t' read -r family id kind gate; do
  [[ "$family" != \#* ]] || continue
  check test "$(model_resolve "$id" true)" = "$family"$'\t'"$id"$'\t'"$kind"
done < scripts/orchestrator/models.tsv
refuse model_resolve astra false
check test "$(model_resolve astra true | cut -f1)" = astra
mkdir -p "$TEST_DIR/normal" "$TEST_DIR/auto-101-task"
export OPENCODE_SERVER_PASSWORD='offline-test-secret'
refuse bash scripts/orchestrator/worker.sh start "$TEST_DIR/normal" "$TEST_DIR/task.md" --model codexbal/gpt-6-astra
check test ! -e "$TEST_DIR/requests"
VECS_BOARD=off bash scripts/orchestrator/worker.sh start "$TEST_DIR/normal" "$TEST_DIR/task.md"
check grep -q '"id":"gpt-6.1-sol"' "$TEST_DIR/requests"
VECS_BOARD=off bash scripts/orchestrator/worker.sh start "$TEST_DIR/auto-101-task" "$TEST_DIR/task.md"
check grep -q '"id":"glm-5.3"' "$TEST_DIR/requests"
bash scripts/orchestrator/worker.sh model "$TEST_DIR/auto-101-task" luna
check test "$(tail -1 "$TEST_DIR/writes" | jq -r '.variables.value.singleSelectOptionId')" = OPT_luna
bash scripts/orchestrator/worker.sh model ses_fake sol
check test "$(tail -1 "$TEST_DIR/writes" | jq -r '.variables.value.singleSelectOptionId')" = OPT_sol
check test "$(grep -c 'offline-test-secret' "$TEST_DIR/requests" || true)" = 0
before="$(wc -l < "$TEST_DIR/writes")"
refuse env CURL_FAIL=true bash scripts/orchestrator/worker.sh model ses_fake luna
check test "$(wc -l < "$TEST_DIR/writes")" = "$before"
refuse bash scripts/orchestrator/worker.sh model ses_fake astra
refuse bash scripts/orchestrator/worker.sh model ses_fake sonnet

# Task creation writes the default header; the fake git never writes any branch.
VECS_BOARD=off bash scripts/orchestrator/open-task.sh --direct 'Model task' "$TEST_DIR/task.md" > "$TEST_DIR/opened"
check grep -q 'Worker model: `codexbal/gpt-6.1-sol`' "$TEST_DIR/body"
refuse env VECS_BOARD=off bash scripts/orchestrator/open-task.sh --direct 'Model task' "$TEST_DIR/task.md" --model astra
printf '[{"number":7,"labels":[],"body":""}]\n' > "$TEST_DIR/tracks.json"
HINT=luna bash scripts/orchestrator/open-task.sh 7 "$TEST_DIR/task.md" --unapproved > "$TEST_DIR/opened"
check grep -q 'Worker model: `codexbal/gpt-6-luna`' "$TEST_DIR/body"
check test "$(tail -1 "$TEST_DIR/writes" | jq -r '.variables.value.number')" = 5
HINT=luna bash scripts/orchestrator/open-task.sh 7 "$TEST_DIR/task.md" --unapproved --model sol > "$TEST_DIR/opened"
check grep -q 'Worker model: `codexbal/gpt-6.1-sol`' "$TEST_DIR/body"
refuse env HINT=astra bash scripts/orchestrator/open-task.sh 7 "$TEST_DIR/task.md" --unapproved
HINT=astra bash scripts/orchestrator/open-task.sh 7 "$TEST_DIR/task.md" --unapproved --owner-approved > "$TEST_DIR/opened"
check grep -q 'Worker model: `codexbal/gpt-6-astra`' "$TEST_DIR/body"

# Issue hints need substantive analysis, reject PRs and astra before any field write.
refuse bash scripts/orchestrator/suggest-model.sh sol 7 "$TEST_DIR/missing.md"
printf ' \n' > "$TEST_DIR/reason.md"
refuse bash scripts/orchestrator/suggest-model.sh sol 7 "$TEST_DIR/reason.md"
printf 'A concrete code analysis.\n' > "$TEST_DIR/reason.md"
refuse bash scripts/orchestrator/suggest-model.sh astra 7 "$TEST_DIR/reason.md"
export IS_PR=true
refuse bash scripts/orchestrator/suggest-model.sh luna 7 "$TEST_DIR/reason.md"
unset IS_PR
bash scripts/orchestrator/suggest-model.sh luna 7 "$TEST_DIR/reason.md"
check test "$(tail -1 "$TEST_DIR/writes" | jq -r '.variables.value.singleSelectOptionId')" = OPT_luna

# Claude uses the same interface with no opencode password, acceptEdits, and resume keeps its id.
cat > "$TEST_DIR/claude" << 'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$TEST_DIR/claude-args"
case "$*" in *--session-id*) if [ "${CLAUDE_SLOW:-false}" = true ]; then touch "$TEST_DIR/slow-started"; sleep 30; fi ;; esac
cat >> "$TEST_DIR/claude-prompts"
printf '{"type":"assistant","message":{"content":[{"type":"text","text":"offline Claude transcript"}]}}\n'
printf '{"type":"result","subtype":"success","is_error":false}\n'
EOF
chmod +x "$TEST_DIR/claude"
export CLAUDE_BIN="$TEST_DIR/claude"
unset OPENCODE_SERVER_PASSWORD
mkdir -p "$TEST_DIR/claude-dir"
id="$(bash scripts/orchestrator/worker.sh start "$TEST_DIR/claude-dir" "$TEST_DIR/task.md" --model sonnet)"
bash scripts/orchestrator/worker.sh wait "$id" 10
check test -s "$TEST_DIR/claude-dir/.tmp/claude-worker.log"
check test ! -e "$TEST_DIR/claude-dir/.claude-worker.log"
check grep -q 'said: offline Claude transcript' <(bash scripts/orchestrator/worker.sh log "$id")
check grep -q -- '--session-id' "$TEST_DIR/claude-args"
check grep -q -- '--permission-mode acceptEdits' "$TEST_DIR/claude-args"
check test "$(grep -c 'bypassPermissions' "$TEST_DIR/claude-args" || true)" = 0
check grep -q 'idle | claude-sonnet-5-5' <(bash scripts/orchestrator/worker.sh status "$id")
bash scripts/orchestrator/worker.sh model "$id" opus
bash scripts/orchestrator/worker.sh send "$id" "$TEST_DIR/task.md"
bash scripts/orchestrator/worker.sh wait "$id" 10
check test "$(grep -c 'offline Claude transcript' "$TEST_DIR/claude-dir/.tmp/claude-worker.log")" = 2
check grep -q -- "--resume $id --model claude-opus-5-5" "$TEST_DIR/claude-args"
refuse bash scripts/orchestrator/worker.sh model "$id" sol
check test ! -e "$TEST_DIR/claude-dir/.tmp/claude-worker-prompt"
mkdir -p "$TEST_DIR/slow-claude"
slow="$(CLAUDE_SLOW=true bash scripts/orchestrator/worker.sh start "$TEST_DIR/slow-claude" "$TEST_DIR/task.md" --model sonnet)"
for attempt in {1..50}; do
  [ ! -e "$TEST_DIR/slow-started" ] || break
  sleep 0.1
done
check test -e "$TEST_DIR/slow-started"
refuse bash scripts/orchestrator/worker.sh send "$slow" "$TEST_DIR/task.md"
refuse bash scripts/orchestrator/worker.sh send --now "$slow" "$TEST_DIR/task.md" --queue
bash scripts/orchestrator/worker.sh send --now "$slow" "$TEST_DIR/task.md"
bash scripts/orchestrator/worker.sh wait "$slow" 10
check grep -q -- "--resume $slow" "$TEST_DIR/claude-args"
printf 'estimate/model checks passed: %s\n' "$checks"
