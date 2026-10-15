#!/usr/bin/env bash
# Dispatch a branch test release; never modifies git or publishes locally.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
. "$ROOT/scripts/lib/common.sh"
. "$ROOT/scripts/lib/release-publish.sh"
log() { printf '[beta] %s\n' "$*"; }
err() { printf '[beta][error] %s\n' "$*" >&2; }

main() {
  local branch="${1:?usage: publish-beta.sh <branch>}" encoded commit base metadata slug version
  local request title title_json run id number status conclusion url remaining deadline
  local wait="${PUBLISH_MAX_WAIT_SEC:-1200}" interval="${POLL_INTERVAL_SEC:-15}"
  local registry_wait="${REGISTRY_MAX_WAIT_SEC:-600}"
  for remaining in "$wait" "$interval" "$registry_wait"; do
    [[ "$remaining" =~ ^[1-9][0-9]*$ ]] || {
      err 'Timeouts and poll interval must be positive integer seconds'
      return 1
    }
  done
  # Validate before any network requests, especially before dispatching.
  node "$ROOT/scripts/beta-versions.mjs" metadata "$branch" 1 0.0.0 > /dev/null
  encoded="$(node -p 'encodeURIComponent(process.argv[1])' "$branch")"
  commit="$(timeout "${wait}s" gh api "repos/$REPO_SLUG/branches/$encoded" --jq .commit.sha)"
  base="$(timeout "${wait}s" gh api "repos/$REPO_SLUG/contents/lib/vecs/package.json?ref=$commit" --jq .content \
    | node --input-type=module -e 'let s=""; for await (const c of process.stdin) s+=c; console.log(JSON.parse(Buffer.from(s,"base64")).version)')"
  request="$(node -p 'crypto.randomUUID()')"
  title="Beta $branch ($request)"
  title_json="$(node -p 'JSON.stringify(process.argv[1])' "$title")"
  deadline=$((SECONDS + wait))
  log "Dispatching publish.yml on $branch ($commit); request $request"
  timeout "${wait}s" gh workflow run publish.yml -R "$REPO_SLUG" --ref "$branch" -f "request_id=$request"
  url="<run not found for request $request>"
  log "Waiting for beta publish (timeout ${wait}s)..."
  while ((SECONDS < deadline)); do
    remaining=$((deadline - SECONDS))
    if run="$(timeout "${remaining}s" gh run list -R "$REPO_SLUG" --workflow publish.yml --branch "$branch" --event workflow_dispatch --limit 100 \
      --json databaseId,number,status,conclusion,url,displayTitle,headSha \
      --jq ".[] | select(.displayTitle == $title_json) | [.databaseId, .number, .status, (if (.conclusion // \"\") == \"\" then \"pending\" else .conclusion end), .url, .headSha] | map(tostring) | join(\"\u001f\")")" && [ -n "$run" ]; then
      local sha
      IFS=$'\x1f' read -r id number status conclusion url sha <<< "$run"
      if [ "$sha" != "$commit" ]; then
        err "Branch moved before dispatch: $url. Inspect the run; do not redispatch blindly."
        return 1
      fi
      if [ "$status" = completed ]; then
        if [ "$conclusion" != success ]; then
          err "Publish run failed ($conclusion): $url. Inspect the failure before retrying; packages may be partially published."
          return 1
        fi
        log "Publish run succeeded: $url"
        break
      fi
    fi
    release_poll_pause "$deadline" "$interval"
  done
  if [ "${status:-}" != completed ] || [ "${conclusion:-}" != success ]; then
    err "Publish run timeout after ${wait}s: $url. Inspect Actions before retrying; do not redispatch blindly."
    return 1
  fi
  metadata="$(node "$ROOT/scripts/beta-versions.mjs" metadata "$branch" "$number" "$base")"
  IFS=$'\t' read -r version slug <<< "$metadata"
  local packages
  packages="$(node --input-type=module -e 'const { betaPackageNames } = await import(process.argv[1]); console.log(betaPackageNames.map(n=>`@vworlds/${n}`).join("\n"))' "$ROOT/scripts/beta-versions.mjs")"
  wait_beta_registry "$version" "$slug" "$packages"
  log "Version: $version"
  log "Install: npm i @vworlds/vecs@$version"
  log "Or track this branch: npm i @vworlds/vecs@$slug"
}

main "$@"
