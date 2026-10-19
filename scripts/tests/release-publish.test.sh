#!/usr/bin/env bash
# Offline integration tests; never source or execute release.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$ROOT/.tmp"
TMP="$(mktemp -d "$ROOT/.tmp/release-publish-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/repo/modules/alpha" "$TMP/repo/modules/beta" "$TMP/repo/modules/private" "$TMP/repo/modules/foreign" "$TMP/repo/modules/unpublished" "$TMP/repo/modules/wire/dist" "$TMP/repo/lib/outside" "$TMP/repo/scripts"
export STATE="$TMP" PATH="$TMP/bin:$PATH"
cat > "$TMP/repo/package.json" << 'JSON'
{"workspaces":["modules/*"]}
JSON
printf '%s\n' '{"name":"@vworlds/alpha"}' > "$TMP/repo/modules/alpha/package.json"
printf '%s\n' '{"name":"@vworlds/beta"}' > "$TMP/repo/modules/beta/package.json"
printf '%s\n' '{"name":"@vworlds/private","private":true}' > "$TMP/repo/modules/private/package.json"
printf '%s\n' '{"name":"@vworlds/vecs-wire","private":true}' > "$TMP/repo/modules/wire/package.json"
printf '%s\n' '{"name":"@vworlds/vecs-wire"}' > "$TMP/repo/modules/wire/dist/package.json"
printf '%s\n' '{"name":"@vworlds/unpublished"}' > "$TMP/repo/modules/unpublished/package.json"
printf '%s\n' '{"name":"@other/foreign"}' > "$TMP/repo/modules/foreign/package.json"
printf '%s\n' '{"name":"@vworlds/outside"}' > "$TMP/repo/lib/outside/package.json"
cat > "$TMP/repo/scripts/published-packages.txt" << 'PACKAGES'
modules/alpha
modules/beta
modules/wire
PACKAGES
cat > "$TMP/bin/gh" << 'SH'
#!/usr/bin/env bash
set -eu
[[ "$*" == *'--workflow publish.yml --commit pushed-sha --branch master --event push'* ]]
count=$(cat "$STATE/gh-count" 2>/dev/null || echo 0)
echo $((count + 1)) > "$STATE/gh-count"
case "$SCENARIO" in
  gh-stall) sleep 20 ;;
  failed) printf '42\037completed\037failure\037https://example.test/run/42\n' ;;
  publish-timeout) printf '42\037in_progress\037pending\037https://example.test/run/42\n' ;;
  lag)
    if ((count == 0)); then exit 0; fi
    if ((count == 1)); then printf '42\037in_progress\037pending\037https://example.test/run/42\n'; exit 0; fi
    printf '42\037completed\037success\037https://example.test/run/42\n' ;;
  empty-conclusion)
    if ((count == 0)); then printf '42\037in_progress\037\037https://example.test/run/42\n'; else printf '42\037completed\037success\037https://example.test/run/42\n'; fi ;;
  *) printf '42\037completed\037success\037https://example.test/run/42\n' ;;
esac
SH
cat > "$TMP/bin/npm" << 'SH'
#!/usr/bin/env bash
set -eu
[[ "$1" == view && "$3" == dist-tags.latest && "$4" == --prefer-online ]]
echo "$2" >> "$STATE/npm-calls"
name=${2#*/}
if [[ "$SCENARIO" == npm-stall && "$name" == beta ]]; then sleep 20; fi
count=$(cat "$STATE/$name-count" 2>/dev/null || echo 0)
echo $((count + 1)) > "$STATE/$name-count"
if [[ "$SCENARIO" == registry-timeout && "$name" == beta ]]; then echo 1.0.0
elif [[ "$SCENARIO" == npm-error && "$name" == beta ]]; then exit 1
elif [[ "$SCENARIO" == lag && "$count" -lt 2 ]]; then echo 1.0.0
else echo 1.2.3; fi
SH
chmod +x "$TMP/bin/gh" "$TMP/bin/npm"
. "$ROOT/scripts/lib/release-publish.sh"
log() { printf '[release] %s\n' "$*"; }
err() { printf '[release][error] %s\n' "$*" >&2; }
export POLL_INTERVAL_SEC=1 PUBLISH_MAX_WAIT_SEC=5 REGISTRY_MAX_WAIT_SEC=4

run_case() {
  export SCENARIO="$1"
  rm -f "$TMP/gh-count" "$TMP/alpha-count" "$TMP/beta-count" "$TMP/npm-calls"
  local code=0
  (
    set -e
    wait_release_publish pushed-sha 1.2.3 "$TMP/repo"
  ) > "$TMP/output" 2>&1 || code=$?
  if [ "$code" -ne "$2" ]; then
    cat "$TMP/output"
    echo "FAIL: $1 returned $code, expected $2" >&2
    exit 1
  fi
}
assert_output() { grep -Fq -- "$1" "$TMP/output"; }

run_case lag 0
assert_output 'npm: 3/3 packages at 1.2.3'
assert_output 'npm: @vworlds/alpha 1.2.3'
assert_output 'npm: @vworlds/beta 1.2.3'
assert_output 'npm: @vworlds/vecs-wire 1.2.3'
test "$(cat "$TMP/alpha-count")" -eq 3
test "$(cat "$TMP/gh-count")" -eq 3
echo 'PASS: publish discovery, pending run, and registry lag'

run_case empty-conclusion 0
test "$(cat "$TMP/gh-count")" -eq 2
assert_output 'Publish run succeeded: https://example.test/run/42'
echo 'PASS: empty in-progress conclusion remains pending until success'

run_case failed 1
assert_output 'Publish run failed (failure): https://example.test/run/42'
test ! -e "$TMP/npm-calls"
echo 'PASS: failed publish run stops before registry'

PUBLISH_MAX_WAIT_SEC=1 run_case publish-timeout 1
assert_output 'Publish run timeout'
assert_output 'https://example.test/run/42'
test ! -e "$TMP/npm-calls"
echo 'PASS: publish deadline'

REGISTRY_MAX_WAIT_SEC=1 run_case registry-timeout 1
assert_output 'Registry timeout: still behind 1.2.3: @vworlds/beta.'
assert_output 'nothing needs repairing in git'
echo 'PASS: registry timeout identifies only the lagging package'

REGISTRY_MAX_WAIT_SEC=1 run_case npm-error 1
assert_output 'Registry timeout: still behind 1.2.3: @vworlds/beta.'
echo 'PASS: npm errors remain pending until deadline'

started=$SECONDS
PUBLISH_MAX_WAIT_SEC=1 run_case gh-stall 1
test "$((SECONDS - started))" -lt 10
assert_output 'Publish run timeout'
echo 'PASS: stalled gh request is bounded'

started=$SECONDS
REGISTRY_MAX_WAIT_SEC=1 run_case npm-stall 1
test "$((SECONDS - started))" -lt 10
assert_output 'Registry timeout: still behind 1.2.3: @vworlds/beta'
echo 'PASS: stalled npm request is bounded'

run_case success 0
diff -u <(printf '@vworlds/alpha\n@vworlds/beta\n@vworlds/vecs-wire\n') "$TMP/npm-calls"
assert_output '3 workspace packages'
echo 'PASS: published list includes dist-published private packages and excludes private, foreign, unpublished, and non-workspace packages'

PUBLISH_MAX_WAIT_SEC=0 run_case success 1
assert_output 'must be positive integer seconds'
echo 'PASS: invalid timeout rejected'
