#!/usr/bin/env bash
# Validate Markdown fences and Mermaid diagrams before publishing a GitHub body.
set -euo pipefail
file="${1:?usage: check-markdown.sh <file> }"
[ -r "$file" ] || {
  echo "cannot read $file" >&2
  exit 2
}
node "$(dirname "$0")/check-markdown.mjs" "$file"
