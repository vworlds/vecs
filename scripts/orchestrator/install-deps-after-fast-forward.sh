#!/usr/bin/env bash
# Refresh root dependencies when a fast-forward changes the lockfile.
set -euo pipefail
root="${1:?usage: install-deps-after-fast-forward.sh <root> <old-head> <new-head>}"
old_head="${2:?usage: install-deps-after-fast-forward.sh <root> <old-head> <new-head>}"
new_head="${3:?usage: install-deps-after-fast-forward.sh <root> <old-head> <new-head>}"
if ! git -C "$root" diff --quiet "$old_head" "$new_head" -- package-lock.json; then
  echo "package-lock.json changed; running HUSKY=0 npm ci --no-audit --no-fund in $root" >&2
  (cd "$root" && HUSKY=0 npm ci --no-audit --no-fund)
fi
