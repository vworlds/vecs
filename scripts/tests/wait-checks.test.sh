#!/usr/bin/env bash
# Offline contract tests: mock REST, time and sleep, never contact GitHub.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$root/.tmp"
tmp="$(mktemp -d "$root/.tmp/wait-checks-test.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"
export PATH="$tmp/bin:$PATH" TEST_TMP="$tmp" FIXTURES="$root/scripts/tests/fixtures"

cat > "$tmp/bin/gh" << 'MOCK'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == 'auth token' ]]; then echo offline-token; exit; fi
[[ "$1" == api ]] || exit 90
shift
query='.' endpoint=''
while (( $# )); do
  case "$1" in
    --jq) query="$2"; shift ;;
    --paginate) ;;
    repos/*) endpoint="$1" ;;
    *) printf 'unknown flag: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done
printf '%s\n' "$endpoint" >> "$TEST_TMP/calls"
count=$(grep -Fc "$endpoint" "$TEST_TMP/calls")
case "$endpoint" in
  */pulls/293)
    [[ "$CASE" != pr-error ]] || exit 1
    sha=head
    [[ "$CASE" != changed || "$count" == 1 ]] || sha=newhead
    printf '{"state":"open","head":{"sha":"%s"}}' "$sha" ;;
  */actions/workflows/ci.yml/runs\?head_sha=*\&per_page=1)
    [[ "$CASE" != no-run ]] || { echo '{"workflow_runs":[]}'; exit; }
    echo '{"workflow_runs":[{"id":123}]}' ;;
  */actions/runs/123)
    [[ "$CASE" != run-error ]] || exit 1
    [[ "$CASE" != retry || "$count" != 1 ]] || exit 1
    if [[ "$CASE" == queued ]]; then
      echo '{"status":"queued","conclusion":null}'
    elif [[ "$CASE" == green || "$CASE" == changed || "$CASE" == retry ]]; then
      echo '{"status":"completed","conclusion":"success"}'
    else
      echo '{"status":"completed","conclusion":"failure"}'
    fi ;;
  */commits/*/check-runs\?filter=all\&per_page=100)
    [[ "$CASE" != checks-error ]] || exit 1
    [[ "$CASE" != checks-retry || "$count" != 1 ]] || exit 1
    echo '{"check_runs":[{"id":456,"name":"ci","conclusion":"failure","details_url":"https://github.com/vworlds/vecs/actions/runs/123/job/456"},{"id":999,"name":"unrelated","conclusion":"failure","details_url":"https://github.com/vworlds/vecs/actions/runs/999/job/999"}]}' ;;
  */actions/jobs/456)
    if [[ "$CASE" == billing ]]; then
      echo '{"steps":[]}'
    else
      step='Run tests'
      case "$CASE" in typecheck) step=Typecheck ;; lint) step=Lint ;; format) step=Format ;; esac
      printf '{"steps":[{"name":"%s","conclusion":"failure"}]}' "$step"
    fi ;;
  */actions/jobs/456/logs)
    if [[ "$CASE" == no-log || "$CASE" == billing ]]; then echo 'gh: Not Found (HTTP 404)' >&2; exit 1; fi
    if [[ "$CASE" == tool-error ]]; then echo 'gh: mock transport failed' >&2; exit 2; fi
    if [[ "$CASE" == escaped-log ]]; then echo 'the response contains terminal escape sequences; pass --allow-escape-sequences to output it anyway' >&2; exit 1; fi
    fixture=tests
    case "$CASE" in typecheck | lint | format | fallback) fixture="$CASE" ;; esac
    if [[ "$CASE" == cap || "$CASE" == test-cap ]]; then
      [[ "$CASE" != test-cap ]] || echo ' FAIL tests/world.test.ts > fails'
      for (( i=1; i<=100; i++ )); do echo "file.ts($i,1): error TS2307: missing module"; done
      [[ "$CASE" != test-cap ]] || echo 'Tests  1 failed | 99 passed (100)'
    else
      cat "$FIXTURES/wait-checks-$fixture.txt"
    fi
    exit ;;
  *) exit 92 ;;
esac | { if [[ "$endpoint" == */logs ]]; then cat; else jq -r "$query"; fi; }
MOCK
cat > "$tmp/bin/curl" << 'MOCK'
#!/usr/bin/env bash
set -euo pipefail
[[ "$CASE" == escaped-log ]] || exit 90
[[ "$*" == *'https://api.github.com/repos/vworlds/vecs/actions/jobs/456/logs'* ]] || exit 91
[[ "$*" == *'Authorization: Bearer offline-token'* ]] || exit 92
printf '\033[31m'
cat "$FIXTURES/wait-checks-tests.txt"
printf '\033[0m'
MOCK
cat > "$tmp/bin/date" << 'MOCK'
#!/usr/bin/env bash
cat "$TEST_TMP/clock"
MOCK
cat > "$tmp/bin/sleep" << 'MOCK'
#!/usr/bin/env bash
echo $(( $(cat "$TEST_TMP/clock") + $1 )) > "$TEST_TMP/clock"
MOCK
chmod +x "$tmp/bin/gh" "$tmp/bin/curl" "$tmp/bin/date" "$tmp/bin/sleep"

passed=0
check() {
  export CASE="$1"
  local expected="$2" text="$3" minutes="${4:-0}" code=0
  echo 1000 > "$tmp/clock"
  : > "$tmp/calls"
  "$root/scripts/agent/wait-checks.sh" 293 "$minutes" > "$tmp/output" || code=$?
  [[ "$code" == "$expected" ]] || {
    cat "$tmp/output"
    echo "FAIL $CASE: exit $code, wanted $expected"
    exit 1
  }
  grep -Fq "$text" "$tmp/output" || {
    cat "$tmp/output"
    echo "FAIL $CASE: missing $text"
    exit 1
  }
  tail -1 "$tmp/output" | grep -q '^checks: ' || exit 1
  ! grep -q '/runs/123/jobs' "$tmp/calls" || exit 1
  ! grep -q 'unrelated' "$tmp/output" || exit 1
  passed=$((passed + 1))
  printf 'PASS %s (exit %s)\n' "$CASE" "$code"
}
check green 0 'checks: green'
check legacy-flags 1 'AssertionError: expected 2 to be 1'
check tests 1 'checks: RED: ci'
grep -Fq 'step: Run tests' "$tmp/output"
grep -Fq 'FAIL tests/world.test.ts > removes entities' "$tmp/output"
grep -Fq 'FAIL tests/query.test.ts > filters entities' "$tmp/output"
grep -Fq 'AssertionError: expected 2 to be 1' "$tmp/output"
grep -Fq 'Tests  2 failed | 3 passed (5)' "$tmp/output"
! grep -q 'cleanup\|939 passed\|npm ci' "$tmp/output"
check typecheck 1 'step: Typecheck'
[[ "$(grep -c 'error TS' "$tmp/output")" == 3 ]]
check lint 1 'step: Lint'
grep -Fq '/workspace/src/world.ts' "$tmp/output"
grep -Fq '2:3  error' "$tmp/output"
check format 1 '[warn] src/world.ts'
check fallback 1 'dependency installation failed'
check cap 1 'checks: RED: ci'
[[ "$(wc -l < "$tmp/output")" -le 61 ]]
check test-cap 1 'Tests  1 failed | 99 passed (100)'
[[ "$(wc -l < "$tmp/output")" -le 61 ]]
check no-log 1 'its log could not be read'
grep -Fq 'HTTP 404' "$tmp/output"
check tool-error 1 'gh: mock transport failed'
check escaped-log 1 'AssertionError: expected 2 to be 1'
grep -Fq 'Tests  2 failed | 3 passed (5)' "$tmp/output"
! grep -q $'\033' "$tmp/output"
check billing 1 'no failed step reported'
grep -Fq 'its log could not be read' "$tmp/output"
check no-run 2 'checks: no verdict after 0 min (no CI run for head yet)'
check pr-error 2 'cannot read PR #293'
check run-error 2 'run 123 is unreadable'
check queued 2 'run 123 is queued'
check checks-error 2 'cannot read failed checks for run 123'
check changed 2 'the PR head changed while waiting'
check retry 0 'checks: green' 1
[[ "$(grep -Fc '/actions/runs/123' "$tmp/calls")" == 2 ]]
check checks-retry 1 'checks: RED: ci' 1
[[ "$(grep -Fc '/check-runs?' "$tmp/calls")" == 2 ]]
export WAIT_CHECKS_SHA=override
check green 0 'checks: green'
grep -Fq 'head_sha=override' "$tmp/calls"
! grep -q '/pulls/' "$tmp/calls"
unset WAIT_CHECKS_SHA
printf '%s offline cases passed\n' "$passed"
