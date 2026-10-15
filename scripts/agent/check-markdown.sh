#!/usr/bin/env bash
# Validate Markdown fences and Mermaid diagrams before publishing a GitHub body.
set -euo pipefail
file="${1:?usage: check-markdown.sh <file> }"
[ -r "$file" ] || {
  echo "cannot read $file" >&2
  exit 2
}
root="$(cd "$(dirname "$0")/../.." && pwd)"
if ! (cd "$root" && node --input-type=module -e "import.meta.resolve('jsdom')" > /dev/null 2>&1); then
  echo "check-markdown: dependencies missing in $root; run HUSKY=0 npm ci there" >&2
  exit 2
fi
node "$(dirname "$0")/check-markdown.mjs" "$file"
