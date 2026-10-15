#!/usr/bin/env bash
# Ported from vworlds/spacerocks at ed419c54; adapted to Vecs' single ci job.
# Usage: scripts/agent/wait-checks.sh <pr> [max minutes, default 30]
# WAIT_CHECKS_SHA=<commit> selects that commit instead of the PR's current head.
# Run ONCE with a 30-minute tool timeout. Read the digest, not more logs, unless a log
# could not be read. Exit 2 means post [worker] BLOCKED: checks gave no verdict and stop.
# Exit 3 means merge origin/<base>, push, and run again (never rebase or force-push).
# The last line is checks: green (0), checks: RED: <checks> (1),
# checks: no verdict after N min (<why>) (2), or checks: CONFLICT with <base> (3).
# GitHub errors are not code failures.
set -uo pipefail
. "$(dirname "$0")/../lib/common.sh"

main() {
  local pr="${1:?usage: wait-checks.sh <pr> [max minutes]}" minutes="${2:-30}"
  [[ "$minutes" =~ ^[0-9]+$ ]] || no_verdict "invalid minute limit: $minutes"
  limit=$((10#$minutes * 60))
  local head="${WAIT_CHECKS_SHA:-}" run="" state status="" conclusion="" now_head failed job name step
  local override="${WAIT_CHECKS_SHA:-}" mergeable base_ref check_mergeable=true
  if [ -n "$override" ]; then
    now_head="$(api "repos/$REPO_SLUG/pulls/$pr" --jq '.head.sha // empty')" || now_head=""
    if [ "$now_head" != "$override" ]; then
      # The PR's mergeability describes its head, not the explicitly selected SHA.
      check_mergeable=false
    fi
  fi
  until [ -n "$head" ]; do
    head="$(api "repos/$REPO_SLUG/pulls/$pr" --jq 'select(.state == "open") | .head.sha // empty')" || head=""
    [ -n "$head" ] || pause 10 "cannot read PR #$pr, or it is not open"
  done

  # Pin this head; after a push GitHub can still show the previous head's checks.
  until [ -n "$run" ]; do
    run="$(api "repos/$REPO_SLUG/actions/workflows/ci.yml/runs?head_sha=$head&per_page=1" \
      --jq '.workflow_runs[0].id // empty')" || run=""
    if [ -z "$run" ]; then
      if [ "$check_mergeable" = true ]; then
        state="$(api "repos/$REPO_SLUG/pulls/$pr" --jq '[(.mergeable | tostring), (.mergeable_state // ""), (.base.ref // "")] | map(tostring) | join("\u001f")')" || state=""
        IFS=$'\x1f' read -r mergeable status base_ref <<< "$state"
        if [ "$mergeable" = false ] && [ "$status" = dirty ]; then
          printf 'checks: CONFLICT with %s: merge origin/%s, push, run again\n' "$base_ref" "$base_ref"
          exit 3
        fi
      fi
      pause 10 "no CI run for ${head:0:8} yet"
    fi
  done
  while :; do
    if state="$(api "repos/$REPO_SLUG/actions/runs/$run" --jq '"\(.status) \(.conclusion)"')"; then
      read -r status conclusion <<< "$state"
      [ "$status" != completed ] || break
    fi
    pause 15 "run $run is ${status:-unreadable}"
  done

  if [ -z "${WAIT_CHECKS_SHA:-}" ]; then
    until now_head="$(api "repos/$REPO_SLUG/pulls/$pr" --jq '.head.sha // empty')" && [ -n "$now_head" ]; do
      pause 10 "cannot confirm PR #$pr head"
    done
    [ "$now_head" = "$head" ] || no_verdict "the PR head changed while waiting: run it again"
  fi
  [ "$conclusion" != success ] || verdict green 0

  # No job-list endpoint: a broken list must not prevent waiting or reading a job log.
  # Match the selected run, not other workflows or older attempts on this commit.
  until failed="$(api "repos/$REPO_SLUG/commits/$head/check-runs?filter=all&per_page=100" --paginate \
    --jq ".check_runs[] | select((.details_url // \"\") | contains(\"/runs/$run/job/\"))
      | select(.conclusion == \"failure\" or .conclusion == \"timed_out\" or .conclusion == \"cancelled\")
      | \"\(.id)\t\(.name)\"")"; do
    pause 5 "cannot read failed checks for run $run"
  done
  [ -n "$failed" ] || verdict "RED: run $run ended as $conclusion, but GitHub names no failed check" 1
  while IFS=$'\t' read -r job name; do
    step="$(api "repos/$REPO_SLUG/actions/jobs/$job" --jq '[.steps[]? | select(.conclusion == "failure" or .conclusion == "timed_out") | .name] | join(", ")')" || step=""
    printf -- '--- %s failed (step: %s):\n' "$name" "${step:-unavailable; no failed step reported}"
    digest_log "$job" "$run"
  done <<< "$failed"
  verdict "RED: $(cut -f2 <<< "$failed" | paste -sd, - | sed 's/,/, /g')" 1
}

api() { gh api "$@" 2> /dev/null; }
verdict() {
  printf 'checks: %s\n' "$1"
  exit "$2"
}
no_verdict() { verdict "no verdict after $(((($(date +%s) - started) + 59) / 60)) min ($1)" 2; }
pause() {
  local remaining=$((limit - ($(date +%s) - started))) seconds="$1"
  [ "$remaining" -gt 0 ] || no_verdict "$2"
  [ "$seconds" -le "$remaining" ] || seconds="$remaining"
  sleep "$seconds"
}

digest_log() {
  local job="$1" run="$2" log_text part digest totals error
  if ! fetch_log "repos/$REPO_SLUG/actions/jobs/$job/logs" || [ -z "$log_text" ]; then
    error="$(grep -o -m1 -E 'HTTP [0-9]{3}' <<< "$log_text" | head -1)" || error=""
    if [ -z "$error" ]; then
      error="$(grep -m1 -E '^gh: |^curl: |^unknown flag: ' <<< "$log_text")" || error="$(head -1 <<< "$log_text")"
    fi
    error="$(printf '%s' "$error" | tr '\r\n' '  ' | cut -c1-220)"
    printf '  (its log could not be read: %s; https://github.com/%s/actions/runs/%s/job/%s)\n' "${error:-empty log response}" "$REPO_SLUG" "$run" "$job"
    return
  fi
  # Keep the failing step, not successful workspaces or runner cleanup. Do not stop
  # at the first error annotation: tsc emits one annotation per compiler error.
  part="$(sed -e 's/\x1b\[[0-9;]*[A-Za-z]//g' -e 's/^[0-9T:.Z-]\{20,\} //' -e 's/^#[0-9]* [0-9.]* //' <<< "$log_text" \
    | awk '/^##\[group\]Run / { text="" }
      { text=text $0 "\n" }
      /##\[error\]Process completed with exit code/ { print text; done=1; exit }
      END { if (!done) printf "%s", text }')"
  digest="$(awk '
    /^ *FAIL / { context=12 }
    /Test Files|^ *Tests +/ { next }
    context > 0 { print; context--; next }
    /error TS[0-9]+|[0-9]+:[0-9]+ +error |\[warn\]|^ERROR: |^Error: |^##\[error\]/ { print; next }
    /^\/.*\.(ts|tsx|js|mjs|cjs)$/ { print }
  ' <<< "$part")"
  totals="$(awk '/^ *FAIL / { failed=1 }
    /Test Files|^ *Tests +/ { if (failed || /failed/) print }
  ' <<< "$part" | tail -4)"
  [ -n "$digest" ] || digest="$(tail -n 25 <<< "$part")"
  # Header + digest <= 60 lines per failed check. Avoid collapsing identical test
  # names/errors from different workspaces; each failure remains visible.
  if [ -n "$totals" ]; then
    cut -c1-220 <<< "$digest" | head -55
    cut -c1-220 <<< "$totals"
  else
    cut -c1-220 <<< "$digest" | head -59
  fi
}

# gh 2.45 prints raw ANSI logs; newer gh refuses them without a newer-only flag.
# Use the portable API call first, and only on that refusal download the same REST
# endpoint with curl. Both paths return raw ANSI for the sed in digest_log to strip.
# log_text is local to the caller; keep stderr on failure so tool/HTTP errors survive.
fetch_log() {
  # Clear an inherited export before shadowing it: Bash can otherwise retain the
  # global value in child environments even when the local variable is unexported.
  export -n token
  local endpoint="$1" status=0
  local +x token
  if log_text="$(gh api "$endpoint" 2>&1)"; then return 0; fi
  if [[ "$log_text" == *'the response contains terminal escape sequences'* ]]; then
    if ! token="$(gh auth token 2> /dev/null)" || [ -z "$token" ]; then
      # Never echo a failed auth command's output: it might include a credential.
      log_text="gh: authentication token could not be read"
      return 1
    fi
    # Keep credentials out of argv and the download process's environment.
    log_text="$(
      unset GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN
      printf 'Authorization: Bearer %s\n' "$token" | curl --fail --silent --show-error --location \
        --header @- "https://api.github.com/$endpoint" 2>&1
    )" || status=$?
    # Even a failed downloader that echoes its input must not leak the token.
    log_text="${log_text//"$token"/[REDACTED]}"
    return "$status"
  fi
  return 1
}

started="$(date +%s)"
main "$@"
