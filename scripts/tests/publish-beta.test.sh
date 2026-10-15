#!/usr/bin/env bash
# Offline only: every gh/npm invocation is intercepted, including dispatch.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d "$ROOT/.publish-beta-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"
export STATE="$TMP" PATH="$TMP/bin:$PATH"
cat > "$TMP/bin/gh" << 'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$STATE/gh-calls"
case "$1 $2" in
  'api repos/vworlds/vecs/branches/pack%2Fidle-keepalive') echo pushed-sha ;;
  'api repos/vworlds/vecs/contents/lib/vecs/package.json?ref=pushed-sha') printf '{"version":"1.0.55"}' | base64 ;;
  'workflow run')
    [[ "$*" == *'publish.yml -R vworlds/vecs --ref pack/idle-keepalive -f request_id='* ]]
    printf '%s' "${!#}" > "$STATE/request" ;;
  'run list')
    [[ "$*" == *'--branch pack/idle-keepalive --event workflow_dispatch'* ]]
    request=$(cat "$STATE/request")
    [[ "$*" == *"Beta pack/idle-keepalive (${request#request_id=})"* ]]
    count=$(cat "$STATE/run-count" 2>/dev/null || echo 0)
    echo $((count + 1)) > "$STATE/run-count"
    case "$SCENARIO" in
      failed) printf '42\0377\037completed\037failure\037https://example.test/42\037pushed-sha\n' ;;
      moved) printf '42\0377\037completed\037success\037https://example.test/42\037other-sha\n' ;;
      timeout) printf '42\0377\037in_progress\037pending\037https://example.test/42\037pushed-sha\n' ;;
      empty-conclusion) if ((count == 0)); then printf '42\0377\037in_progress\037\037https://example.test/42\037pushed-sha\n'; else printf '42\0377\037completed\037success\037https://example.test/42\037pushed-sha\n'; fi ;;
      lag) if ((count == 0)); then exit 0; fi
        printf '42\0377\037completed\037success\037https://example.test/42\037pushed-sha\n' ;;
      *) printf '42\0377\037completed\037success\037https://example.test/42\037pushed-sha\n' ;;
    esac ;;
  *) echo "Unexpected gh call" >&2; exit 1 ;;
esac
SH
cat > "$TMP/bin/npm" << 'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == view && "$3" == dist-tags.pack-idle-keepalive && "$4" == --prefer-online ]]
echo "$2" >> "$STATE/npm-calls"
name=${2#*/}
count=$(cat "$STATE/$name-count" 2>/dev/null || echo 0)
echo $((count + 1)) > "$STATE/$name-count"
if [[ "$SCENARIO" == registry-timeout && "$name" == vecs-wire ]]; then echo old
elif [[ "$SCENARIO" == lag && "$name" == vecs-wire && "$count" -lt 2 ]]; then echo old
else echo 1.0.56-pack-idle-keepalive.7; fi
SH
chmod +x "$TMP/bin/gh" "$TMP/bin/npm"
export POLL_INTERVAL_SEC=1 PUBLISH_MAX_WAIT_SEC=5 REGISTRY_MAX_WAIT_SEC=4

run_case() {
  export SCENARIO="$1"
  rm -f "$TMP/gh-calls" "$TMP/npm-calls" "$TMP/"*-count "$TMP/request"
  local code=0
  (cd "$TMP" && bash "$ROOT/scripts/orchestrator/publish-beta.sh" "${3:-pack/idle-keepalive}") > "$TMP/output" 2>&1 || code=$?
  if [ "$code" -ne "$2" ]; then
    cat "$TMP/output"
    echo "FAIL: $1 returned $code, expected $2" >&2
    exit 1
  fi
}
assert_output() { grep -Fq -- "$1" "$TMP/output"; }

run_case success 0
assert_output 'npm: 9/9 packages at 1.0.56-pack-idle-keepalive.7'
assert_output 'Install: npm i @vworlds/vecs@1.0.56-pack-idle-keepalive.7'
assert_output 'Or track this branch: npm i @vworlds/vecs@pack-idle-keepalive'
test "$(sort -u "$TMP/npm-calls" | wc -l)" -eq 9
test "$(grep -c '^workflow run' "$TMP/gh-calls")" -eq 1
echo 'PASS: correlated dispatch, all nine packages verified, exact install line (outside repo cwd)'

run_case failed 1
assert_output 'Publish run failed (failure): https://example.test/42'
test ! -f "$TMP/npm-calls"
echo 'PASS: failed run stops before registry'

run_case lag 0
assert_output 'npm: 9/9 packages'
test "$(cat "$TMP/vecs-wire-count")" -eq 3
test "$(cat "$TMP/vecs-count")" -eq 1
test "$(cat "$TMP/run-count")" -eq 2
echo 'PASS: discovery lag and registry catch-up poll only pending packages'

run_case empty-conclusion 0
assert_output 'Publish run succeeded: https://example.test/42'
test "$(cat "$TMP/run-count")" -eq 2
echo 'PASS: empty in-progress conclusion remains pending until success'

PUBLISH_MAX_WAIT_SEC=1 run_case timeout 1
assert_output 'Publish run timeout'
test ! -f "$TMP/npm-calls"
echo 'PASS: run deadline'

REGISTRY_MAX_WAIT_SEC=1 run_case registry-timeout 1
assert_output 'under pack-idle-keepalive: @vworlds/vecs-wire.'
assert_output 'Retry verification, not dispatch'
echo 'PASS: registry deadline identifies lagging package'

run_case moved 1
assert_output 'Branch moved before dispatch'
test ! -f "$TMP/npm-calls"
echo 'PASS: branch movement cannot report wrong version'

for branch in master latest 123; do
  run_case success 1 "$branch"
  test ! -f "$TMP/gh-calls"
done
echo 'PASS: master and unsafe dist-tags rejected before dispatch'

PUBLISH_MAX_WAIT_SEC=0 run_case success 1
assert_output 'must be positive integer seconds'
test ! -f "$TMP/gh-calls"
echo 'PASS: invalid deadline rejected before dispatch'
