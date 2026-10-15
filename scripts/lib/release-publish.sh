#!/usr/bin/env bash
# Sourced after the release's git work is complete. Caller supplies log/err.

wait_release_publish() {
  local commit="$1" version="$2" root="${3:-.}"
  local publish_wait="${PUBLISH_MAX_WAIT_SEC:-1200}" registry_wait="${REGISTRY_MAX_WAIT_SEC:-600}"
  local interval="${POLL_INTERVAL_SEC:-15}"
  local start deadline remaining run id status conclusion url packages package latest
  local -a pending next

  for remaining in "$publish_wait" "$registry_wait" "$interval"; do
    if ! [[ "$remaining" =~ ^[1-9][0-9]*$ ]]; then
      err "Publish/registry timeouts and poll interval must be positive integer seconds. Git is complete; no git repair is needed."
      return 1
    fi
  done

  start=$SECONDS
  deadline=$((start + publish_wait))
  url="<run not found for $commit>"
  log "Waiting for publish.yml at $commit (timeout ${publish_wait}s)..."
  while ((SECONDS < deadline)); do
    remaining=$((deadline - SECONDS))
    ((remaining > 0)) || break
    if run="$(timeout "${remaining}s" gh run list --workflow publish.yml --commit "$commit" --branch master --event push --limit 1 \
      --json databaseId,status,conclusion,url --jq '.[0] | select(. != null) | [.databaseId, .status, (if (.conclusion // "") == "" then "pending" else .conclusion end), .url] | map(tostring) | join("\u001f")')" && [ -n "$run" ]; then
      IFS=$'\x1f' read -r id status conclusion url <<< "$run"
      if [ "$status" = completed ]; then
        if [ "$conclusion" != success ]; then
          err "Publish run failed ($conclusion): $url. Git is complete; inspect the publish failure, not git state."
          return 1
        fi
        log "Publish run succeeded: $url"
        break
      fi
    fi
    release_poll_pause "$deadline" "$interval"
  done
  if [ "${status:-}" != completed ] || [ "${conclusion:-}" != success ]; then
    err "Publish run timeout after ${publish_wait}s: $url. Git is complete; no git repair is needed. Inspect the run before retrying verification."
    return 1
  fi

  if ! packages="$(release_workspace_packages "$root")" || [ -z "$packages" ]; then
    err "Could not discover non-private @vworlds/* workspaces. Git is complete; no git repair is needed."
    return 1
  fi
  mapfile -t pending <<< "$packages"
  local count="${#pending[@]}"
  log "Waiting for npm latest=$version for $count workspace packages (timeout ${registry_wait}s)..."
  start=$SECONDS
  deadline=$((start + registry_wait))
  while ((${#pending[@]} > 0 && SECONDS < deadline)); do
    next=()
    for package in "${pending[@]}"; do
      remaining=$((deadline - SECONDS))
      latest=""
      if ((remaining > 0)); then
        latest="$(timeout "${remaining}s" npm view "$package" dist-tags.latest --prefer-online 2> /dev/null)" || latest=""
      fi
      if [ "$latest" = "$version" ]; then
        log "npm: $package $latest"
      else
        next+=("$package")
      fi
    done
    pending=("${next[@]}")
    ((${#pending[@]} == 0)) || release_poll_pause "$deadline" "$interval"
  done
  if ((${#pending[@]} > 0)); then
    err "Registry timeout: still behind $version: ${pending[*]}. Git is complete; nothing needs repairing in git — only the registry is late or unavailable. Retry verification, not the release."
    return 1
  fi
  log "npm: $count/$count packages at $version after $((SECONDS - start)) s"
}

release_poll_pause() {
  local remaining=$(($1 - SECONDS)) interval="$2"
  ((remaining > 0)) || return 0
  ((interval <= remaining)) || interval=$remaining
  sleep "$interval"
}

# Beta verification is tag-specific: it must never inspect or change latest.
wait_beta_registry() {
  local version="$1" tag="$2" packages="$3"
  local wait="${REGISTRY_MAX_WAIT_SEC:-600}" interval="${POLL_INTERVAL_SEC:-15}"
  local start=$SECONDS deadline remaining package actual count
  local -a pending next
  mapfile -t pending <<< "$packages"
  count=${#pending[@]}
  deadline=$((SECONDS + wait))
  log "Waiting for npm $tag=$version for $count packages (timeout ${wait}s)..."
  while ((${#pending[@]} > 0 && SECONDS < deadline)); do
    next=()
    for package in "${pending[@]}"; do
      remaining=$((deadline - SECONDS))
      actual=""
      if ((remaining > 0)); then
        actual="$(timeout "${remaining}s" npm view "$package" "dist-tags.$tag" --prefer-online 2> /dev/null)" || actual=""
      fi
      if [ "$actual" = "$version" ]; then
        log "npm: $package $actual"
      else
        next+=("$package")
      fi
    done
    pending=("${next[@]}")
    ((${#pending[@]} == 0)) || release_poll_pause "$deadline" "$interval"
  done
  if ((${#pending[@]} > 0)); then
    err "Registry timeout: still behind $version under $tag: ${pending[*]}. Retry verification, not dispatch; nothing needs repairing in git."
    return 1
  fi
  log "npm: $count/$count packages at $version after $((SECONDS - start)) s"
}

release_workspace_packages() {
  node --input-type=module - "$1" << 'NODE'
import { globSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(process.argv[2]);
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const patterns = manifest.workspaces?.packages ?? manifest.workspaces;
if (!Array.isArray(patterns)) throw new Error('Missing workspaces');
const names = new Set();
for (const path of globSync(patterns.map(pattern => `${pattern}/package.json`), { cwd: root })) {
  const pkg = JSON.parse(readFileSync(resolve(root, path), 'utf8'));
  if (!pkg.private && pkg.name?.startsWith('@vworlds/')) names.add(pkg.name);
}
console.log([...names].sort().join('\n'));
NODE
}
