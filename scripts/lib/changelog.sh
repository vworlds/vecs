#!/usr/bin/env bash
# Shared release collection and CI validation; paths are relative to the repo root.

collect_changelog() {
  local version="${1:?version required}" release_date="${2:?date required}"
  local changelog=architecture/CHANGELOG.md file temporary
  local -a fragments=()
  validate_changelog_fragments || return 1
  while IFS= read -r file; do fragments+=("$file"); done < <(changelog_fragments)
  if [ "${#fragments[@]}" -eq 0 ]; then
    printf '[release] No changelog fragments. Continuing.\n'
    return 0
  fi
  [ -f "$changelog" ] || {
    printf 'Missing %s\n' "$changelog" >&2
    return 1
  }
  temporary="$(mktemp "${changelog}.XXXXXX")" || return 1
  if ! {
    awk '/^## v/ { exit } { print }' "$changelog"
    printf '## v%s (%s)\n\n' "$version" "$release_date"
    for file in "${fragments[@]}"; do
      awk 'length { print }' "$file"
    done
    printf '\n'
    awk '/^## v/ { versions = 1 } versions { print }' "$changelog"
  } > "$temporary"; then
    rm -f "$temporary"
    return 1
  fi
  mv "$temporary" "$changelog" || return 1
  git add -- "$changelog" || return 1
  git rm -- "${fragments[@]}"
}

validate_changelog_fragments() {
  local file failed=0
  while IFS= read -r file; do
    if ! awk 'length && substr($0, 1, 3) != "- [" { bad = 1 } END { exit bad }' "$file"; then
      printf 'Invalid changelog fragment: %s (each non-empty line must start with "- [")\n' "$file" >&2
      failed=1
    fi
  done < <(changelog_fragments)
  return "$failed"
}

changelog_fragments() {
  local file name
  local -a numbered=() slugs=()
  for file in architecture/unreleased/*.md; do
    [ -f "$file" ] || continue
    name="${file##*/}"
    [ "$name" != README.md ] || continue
    if [[ "$name" =~ ^[0-9]+\.md$ ]]; then
      numbered+=("$name")
    else
      slugs+=("$name")
    fi
  done
  if [ "${#numbered[@]}" -gt 0 ]; then
    printf '%s\n' "${numbered[@]}" | LC_ALL=C sort -nr | sed 's#^#architecture/unreleased/#'
  fi
  if [ "${#slugs[@]}" -gt 0 ]; then
    printf '%s\n' "${slugs[@]}" | LC_ALL=C sort | sed 's#^#architecture/unreleased/#'
  fi
}
