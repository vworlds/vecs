#!/usr/bin/env bash
# Consumer fixtures through the pinned Markdown validator; no GitHub calls.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
check="$root/scripts/agent/check-markdown.sh"
fixtures="$root/tests/fixtures/markdown"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export VMETHOD_ROOT="$root"

if bash "$check" "$fixtures/broken-272.md" > "$tmp/out" 2> "$tmp/err"; then
  echo "expected the broken #272 Mermaid diagram to fail" >&2
  exit 1
fi
bash "$check" "$fixtures/fixed-272.md"
bash "$check" "$fixtures/valid-flowchart.md"
bash "$check" "$fixtures/no-mermaid.md"
if bash "$check" "$fixtures/unclosed-fence.md" > "$tmp/out" 2> "$tmp/err"; then
  echo "expected an unclosed fence to fail" >&2
  exit 1
fi
echo "Markdown validation tests passed"
