# Shared helpers for scripts/agent and scripts/orchestrator. Source it; don't run it.
# shellcheck shell=bash

REPO_SLUG="${VECS_REPO:-vworlds/vecs}"
SSH_KEY="${VECS_SSH_KEY:-$HOME/.ssh/id_ed25519}"

log() { printf '%s\n' "$*" >&2; }
die() {
  log "error: $*"
  exit 1
}

# retry <attempts> <cmd...>: run cmd until it succeeds, backing off 2, 4, 8… seconds.
retry() {
  local attempts="$1" n=1 delay=2
  shift
  until "$@"; do
    if [ "$n" -ge "$attempts" ]; then return 1; fi
    log "retry $n/$((attempts - 1)) in ${delay}s: $*"
    sleep "$delay"
    n=$((n + 1))
    delay=$((delay * 2))
  done
}

# git_https <git args…>: git with the GitHub CLI as the HTTPS credential helper.
git_https() { git -c credential.helper= -c credential.helper='!gh auth git-credential' "$@"; }

# git_ssh <git args…>: git over SSH with the machine key, when HTTPS misbehaves.
git_ssh() { GIT_SSH_COMMAND="ssh -i $SSH_KEY -o IdentitiesOnly=yes -o BatchMode=yes" git "$@"; }

# push_ref <refspec> [git push options…]: push to GitHub, retrying over HTTPS and then
# falling back to SSH (GitHub has returned HTTP 500 to HTTPS pushes of new branches).
push_ref() {
  local refspec="$1"
  shift
  retry 3 git_https push "$@" "https://github.com/$REPO_SLUG.git" "$refspec" && return 0
  if [ -r "$SSH_KEY" ]; then
    log "HTTPS push failed; trying SSH"
    retry 3 git_ssh push "$@" "git@github.com:$REPO_SLUG.git" "$refspec" && return 0
  fi
  return 1
}

# fetch_refs <src:dst>…: fetch from GitHub with the same HTTPS→SSH fallback.
fetch_refs() {
  retry 3 git_https fetch -q "https://github.com/$REPO_SLUG.git" "$@" && return 0
  [ -r "$SSH_KEY" ] && retry 3 git_ssh fetch -q "git@github.com:$REPO_SLUG.git" "$@"
}

# pr_field <pr> <jq>: one PR field through `gh pr view --json` (plain `gh pr view` fails here).
pr_field() {
  local pr="$1" jq="$2" field
  field="$(printf '%s' "$jq" | sed -E 's/^\.([a-zA-Z]+).*/\1/')"
  retry 3 gh pr view "$pr" -R "$REPO_SLUG" --json "$field" --jq "$jq"
}
