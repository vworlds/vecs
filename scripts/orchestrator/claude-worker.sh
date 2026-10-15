#!/usr/bin/env bash
# Headless Claude Code backend for worker.sh (sonnet/opus). Same review-loop verbs, no opencode login.
# Usage: claude-worker.sh start <dir> <prompt.md|-> --model <family|id>
#        claude-worker.sh send [--now] <session|dir> <prompt.md|-> [--queue|--now]
#        claude-worker.sh status|log|stop|wait|model <session|dir> [argument]
# acceptEdits with Bash/Edit/Write/Read/Grep/Glob only; never bypassPermissions.
# CLAUDE_WORKER_GH_TOKEN, if set, is passed by environment, never on argv. Otherwise inherits login.
set -euo pipefail
. "$(dirname "$0")/../lib/common.sh"
. "$(dirname "$0")/../lib/board.sh"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/vecs-orchestrator/claude-workers"
CLAUDE="${CLAUDE_BIN:-claude}"
mkdir -p "$STATE"
record() {
  local f
  if [ -d "$1" ]; then
    f="$STATE/$(printf '%s' "$(realpath "$1")" | sha256sum | cut -d' ' -f1)"
  else
    f="$(grep -l -x -- "id=$1" "$STATE"/* 2> /dev/null | head -1)" || true
  fi
  [ -n "${f:-}" ] && [ -f "$f" ] || return 1
  printf '%s\n' "$f"
}
get() { sed -n "s/^$2=//p" "$1" | tail -1; }
put() {
  sed -i "/^$2=/d" "$1"
  printf '%s=%s\n' "$2" "$3" >> "$1"
}
running() {
  local pid born
  pid="$(get "$1" pid)"
  born="$(get "$1" born)"
  [ -n "$pid" ] && kill -0 "$pid" 2> /dev/null \
    && [ -n "$born" ] && [ "$(ps -o lstart= -p "$pid")" = "$born" ] \
    && [ "$(ps -o stat= -p "$pid" | cut -c1)" != Z ]
}
idle() {
  local end=$(($(date +%s) + $2))
  while running "$1"; do
    [ "$(date +%s)" -lt "$end" ] || return 1
    sleep 1
  done
}
stop_turn() {
  if running "$1"; then kill -- "-$(get "$1" pid)" 2> /dev/null || kill "$(get "$1" pid)"; fi
}
turn() {
  local f="$1" resume="$2" dir id model prompt
  dir="$(get "$f" dir)" id="$(get "$f" id)" model="$(get "$f" model)"
  mkdir -p "$dir/.tmp"
  prompt="$dir/.tmp/claude-worker-prompt"
  # The caller has established idle. The prompt is reused next turn and removed by the child.
  if [ "$3" = - ]; then cat > "$prompt"; else cat "$3" > "$prompt"; fi
  (
    cd "$dir"
    [ -z "${CLAUDE_WORKER_GH_TOKEN:-}" ] || export GH_TOKEN="$CLAUDE_WORKER_GH_TOKEN"
    exec setsid bash -c 'prompt="$1"; trap '\''rm -f "$prompt"'\'' EXIT; shift;
      "$@" < "$prompt"' bash "$prompt" "$CLAUDE" -p "$resume" "$id" --model "$model" \
      --output-format stream-json --verbose --permission-mode acceptEdits \
      --allowedTools Bash Edit Write Read Grep Glob >> "$dir/.tmp/claude-worker.log" 2>&1
  ) < /dev/null > /dev/null 2>&1 &
  local pid="$!"
  put "$f" pid "$pid"
  put "$f" born "$(ps -o lstart= -p "$pid" || true)"
}
cmd="${1:?command required}"
shift
case "$cmd" in
  start)
    [ $# -eq 4 ] && [ "$3" = --model ] || die "start <dir> <prompt> --model <family|id>"
    resolved="$(model_resolve "$4" false)" || exit 1
    IFS=$'\t' read -r family model kind <<< "$resolved"
    [ "$kind" = claude ] || die "not a Claude family"
    command -v "$CLAUDE" > /dev/null || die "Claude executable not found"
    dir="$(realpath "$1")"
    [ -d "$dir" ] || die "no directory $dir"
    f="$STATE/$(printf '%s' "$dir" | sha256sum | cut -d' ' -f1)"
    [ ! -e "$f" ] || die "a Claude session is already recorded: resume it"
    id="$(cat /proc/sys/kernel/random/uuid)"
    printf 'id=%s\ndir=%s\nmodel=%s\n' "$id" "$dir" "$model" > "$f"
    turn "$f" --session-id "$2"
    printf '%s\n' "$id"
    ;;
  *)
    now=false
    if [ "$cmd" = send ] && [ "${1:-}" = --now ]; then
      now=true
      shift
    fi
    f="$(record "${1:?session or directory required}")" || die "no Claude session for $1"
    shift
    case "$cmd" in
      location) get "$f" dir ;;
      send)
        [ $# -ge 1 ] && [ $# -le 2 ] || die "send <session> <prompt> [--queue|--now]"
        case "${2:-}" in
          --now) now=true ;;
          --queue)
            ! $now || die "cannot combine --queue and --now"
            idle "$f" 600 || die "session still running"
            ;;
          '') ;;
          *) die "invalid send option" ;;
        esac
        if $now; then
          stop_turn "$f"
          idle "$f" 30 || die "cannot confirm idle; prompt not sent"
        fi
        ! running "$f" || die "session running: use --queue or --now"
        turn "$f" --resume "$1"
        ;;
      status)
        activity=idle
        if running "$f"; then activity=running; fi
        last="$(tail -n 50 "$(get "$f" dir)/.tmp/claude-worker.log" | jq -Rr 'fromjson? | select(.type == "result") | .subtype' | tail -1)"
        if [ "$activity" = idle ] && [[ "$last" == error* ]]; then activity='idle (failed)'; fi
        printf '%s %s | %s | %s | %s\n' "$(get "$f" id)" "$activity" "$(get "$f" model)" "$(get "$f" dir)" "$last"
        ;;
      log)
        jq -Rr 'fromjson? | select(.type == "assistant") | .message.content[]?
          | if .type == "text" then "said: " + (.text | gsub("\n"; " ") | .[0:400])
          elif .type == "tool_use" then .name + " " + ((.input.command // .input.file_path // .input.pattern // "") | tostring | .[0:200])
          else empty end' "$(get "$f" dir)/.tmp/claude-worker.log" | tail -n "${1:-15}"
        ;;
      stop) stop_turn "$f" ;;
      wait) idle "$f" "${1:-600}" ;;
      model)
        resolved="$(model_resolve "${1:?model required}" false)" || exit 1
        IFS=$'\t' read -r family model kind <<< "$resolved"
        [ "$kind" = claude ] || die "cannot switch backend and retain context"
        put "$f" model "$model"
        ;;
      *) die "unknown Claude worker command: $cmd" ;;
    esac
    ;;
esac
