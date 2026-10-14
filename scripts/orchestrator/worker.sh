#!/usr/bin/env bash
# Delegate work to an opencode worker and look after it, over the opencode 2 HTTP API.
# Usage: scripts/orchestrator/worker.sh <command>
#   start <dir> <prompt.md|-> [--title t] [--model provider/id]
#                             a new session working in <dir> (a worktree); prints its id. Returns
#                             at once: the worker runs on the server
#   send [--now] <session> <prompt.md|-> [--queue|--now]
#                             a new message for a session: it resumes an idle worker, and steers a
#                             running one at its next step (--queue: only after it finishes;
#                             --now: interrupt first, then send; cannot combine with --queue)
#   model <session> <provider/id>  switch models in the same session, retaining context
#   status [session]          one line: running or idle, outcome, last activity, tokens, pending
#                             permission requests. Without a session: every running one
#   log <session> [n]         the last n (default 15) steps: what it said and the commands it ran
#   stop <session>            interrupt the running turn (do it before a merge)
#   wait <session> [seconds]  block until the session is idle (default 600); exit 1 if still running
#   permit <session> [once|always|reject]   answer its pending permission requests (default: list)
#   models [filter]           the models the server offers
#   health                    is the server there, and does it accept our login
# <session> is a session id (ses_…) or a directory given to start (its last session is used).
# Needs OPENCODE_BASE_URL and OPENCODE_SERVER_PASSWORD (OPENCODE_SERVER_USERNAME defaults to
# opencode). The default model is WORKER_MODEL, or codexbal/gpt-6.1-sol.
# Authentication goes to curl through stdin, never in command-line arguments.
set -euo pipefail
. "$(dirname "$0")/../lib/common.sh"
BASE="${OPENCODE_BASE_URL:-http://127.0.0.1:4096}"
MODEL="${WORKER_MODEL:-codexbal/gpt-6.1-sol}"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/vecs-orchestrator/workers"
usage() {
  sed -n '2,/^set /{ /^set /d; p; }' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}
[ -n "${OPENCODE_SERVER_PASSWORD:-}" ] || die "OPENCODE_SERVER_PASSWORD is not set"

# api <method> <path> [json body]: the body on stdout; fails on a non-2xx answer.
api() {
  local method="$1" path="$2" body="${3:-}" out code
  out="$(mktemp)"
  code="$(printf 'user = %s\n' "$(jq -nr '(env.OPENCODE_SERVER_USERNAME | select(. != "")) // "opencode" | . + ":" + env.OPENCODE_SERVER_PASSWORD | tojson')" \
    | curl --config - -s -m "${API_TIMEOUT:-30}" -X "$method" \
      -H 'content-type: application/json' ${body:+-d "$body"} -o "$out" -w '%{http_code}' "$BASE$path")" || code=000
  if [[ "$code" != 2* ]]; then
    log "opencode $method $path → $code $(head -c 300 "$out")"
    rm -f "$out"
    return 1
  fi
  cat "$out"
  rm -f "$out"
}
# session <id or directory>: the session id.
session() {
  case "$1" in
    ses*) printf '%s\n' "$1" ;;
    *) cat "$STATE/$(realpath "$1" | tr / _)" 2> /dev/null || die "no session recorded for $1" ;;
  esac
}
text_of() { if [ "$1" = - ]; then cat; else cat "$1"; fi; }
interrupt() {
  local result
  result="$(api POST "/api/session/$1/interrupt")" || return 1
  if [ "$(jq -r .interrupted <<< "$result")" = true ]; then
    log "interrupted $1"
  else
    log "$1 was not running"
  fi
}
ago() {
  local s=$(($(date +%s) - ${1%???}))
  printf '%dm%02ds ago' $((s / 60)) $((s % 60))
}

status_line() {
  local id="$1" info running perms
  info="$(api GET "/api/session/$id")" || return 1
  running="$(api GET /api/session/active | jq -r --arg id "$id" 'if .data[$id] then "running" else "idle" end')"
  perms="$(api GET "/api/session/$id/permission" | jq '.data | length')"
  jq -r --arg run "$running" --arg perms "$perms" '.data
    | "\(.id) \($run)\(if $run == "idle" and .outcome then " (" + .outcome + ")" else "" end)"
      + " | \(.title // "-") | \(.location.directory)"
      + " | tokens in \(.tokens.input) out \(.tokens.output)"
      + (if $perms != "0" then " | WAITING on \($perms) permission request(s)" else "" end)
      + " | updated \(.time.updated)"' <<< "$info" \
    | while IFS= read -r line; do printf '%s (%s)\n' "${line% | updated *}" "$(ago "${line##* | updated }")"; done
}

cmd="${1:-}"
[ $# -gt 0 ] && shift
case "$cmd" in
  start)
    [ $# -ge 2 ] || usage
    dir="$(realpath "$1")" prompt="$(text_of "$2")" title=""
    shift 2
    while [ $# -gt 0 ]; do
      case "$1" in
        --title)
          title="$2"
          shift 2
          ;;
        --model)
          MODEL="$2"
          shift 2
          ;;
        *) usage ;;
      esac
    done
    [ -d "$dir" ] || die "$dir is not a directory"
    id="$(api POST /api/session "$(jq -nc --arg d "$dir" --arg t "$title" --arg p "${MODEL%%/*}" --arg m "${MODEL#*/}" \
      '{location: {directory: $d}, model: {providerID: $p, id: $m}} + (if $t == "" then {} else {title: $t} end)')" \
      | jq -r .data.id)" || die "could not create the session"
    mkdir -p "$STATE"
    printf '%s\n' "$id" > "$STATE/$(tr / _ <<< "$dir")"
    api POST "/api/session/$id/prompt" "$(jq -nc --arg t "$prompt" '{text: $t}')" > /dev/null \
      || die "session $id was created but the prompt was refused"
    log "started $id in $dir on $MODEL"
    printf '%s\n' "$id"
    ;;
  send)
    now=false
    if [ "${1:-}" = --now ]; then
      now=true
      shift
    fi
    [ $# -ge 2 ] || usage
    id="$(session "$1")" prompt="$(text_of "$2")" delivery=steer
    shift 2
    if [ $# -gt 0 ]; then
      [ $# -eq 1 ] || usage
      case "$1" in
        --queue)
          $now && usage
          delivery=queue
          ;;
        --now) now=true ;;
        *) usage ;;
      esac
    fi
    if $now; then interrupt "$id"; fi
    api POST "/api/session/$id/prompt" "$(jq -nc --arg t "$prompt" --arg d "$delivery" '{text: $t, delivery: $d}')" > /dev/null
    log "sent to $id ($delivery)"
    ;;
  model)
    [ $# -eq 2 ] || usage
    [[ "$2" =~ ^[^/[:space:]]+/[^[:space:]]+$ ]] || die "model must be provider/id"
    id="$(session "$1")" MODEL="$2"
    api POST "/api/session/$id/model" "$(jq -nc --arg p "${MODEL%%/*}" --arg m "${MODEL#*/}" \
      '{model:{providerID:$p,id:$m}}')" > /dev/null
    log "switched $id to $MODEL"
    ;;
  status)
    if [ $# -eq 0 ]; then
      api GET /api/session/active | jq -r '.data | keys[]' | while read -r id; do status_line "$id"; done
    else
      status_line "$(session "$1")"
    fi
    ;;
  log)
    [ $# -ge 1 ] || usage
    id="$(session "$1")"
    api GET "/api/session/$id/message?limit=${2:-15}" | jq -r '.data | reverse | .[]
      | (.time.created / 1000 | strftime("%H:%M:%S")) as $at
      | if .type == "user" then "\($at) > \((.text // .payload.text // "") | gsub("\n"; " ") | .[0:200])"
        elif .type == "assistant" then (.content[]?
          | if .type == "text" then "\($at) worker: \(.text | gsub("\n"; " ") | .[0:400])"
            elif .type == "tool" then "\($at) \(.name) [\(.state.status)\(if .state.metadata.exit != null then " exit " + (.state.metadata.exit | tostring) else "" end)] \((.state.input.command // .state.input.filePath // (.state.input | tostring)) | gsub("\n"; " ") | .[0:200])\(if .state.error then " ! " + (.state.error.message | gsub("\n"; " ") | .[0:160]) else "" end)"
            else empty end),
          (select(.finish == "error") | "\($at) turn ended in error: \((.error // {}) | tostring | .[0:300])")
        else "\($at) [\(.type)]" end'
    ;;
  stop)
    [ $# -eq 1 ] || usage
    id="$(session "$1")"
    interrupt "$id"
    ;;
  wait)
    [ $# -ge 1 ] || usage
    id="$(session "$1")"
    if API_TIMEOUT="${2:-600}" api POST "/api/experimental/session/$id/wait" > /dev/null 2>&1; then
      status_line "$id"
    else
      status_line "$id"
      exit 1
    fi
    ;;
  permit)
    [ $# -ge 1 ] || usage
    id="$(session "$1")"
    requests="$(api GET "/api/session/$id/permission")"
    if [ -z "${2:-}" ]; then
      jq -r '.data[] | "\(.id) \(del(.id, .sessionID) | tostring | .[0:300])"' <<< "$requests"
    else
      case "$2" in once | always | reject) ;; *) usage ;; esac
      jq -r '.data[].id' <<< "$requests" | while read -r request; do
        api POST "/api/session/$id/permission/$request/reply" "$(jq -nc --arg d "$2" '{decision: $d}')" > /dev/null
        log "$request: $2"
      done
    fi
    ;;
  models)
    api GET /api/model | jq -r '.data[] | "\(.providerID)/\(.id)"' | grep -i -- "${1:-}" || true
    ;;
  health)
    api GET /api/session/active > /dev/null && log "opencode at $BASE answers and accepts our login"
    ;;
  *) usage ;;
esac
