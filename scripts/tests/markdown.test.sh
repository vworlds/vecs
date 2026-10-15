#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
check="$root/scripts/agent/check-markdown.sh"
fixtures="$root/tests/fixtures/markdown"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

if "$check" "$fixtures/broken-272.md" > "$tmp/out" 2> "$tmp/err"; then
  echo "expected the broken #272 Mermaid diagram to fail" >&2
  exit 1
fi
grep -q 'Mermaid block .*diagram line' "$tmp/err"
"$check" "$fixtures/fixed-272.md"
"$check" "$fixtures/valid-flowchart.md"
"$check" "$fixtures/no-mermaid.md"
if "$check" "$fixtures/unclosed-fence.md" > "$tmp/out" 2> "$tmp/err"; then
  echo "expected an unclosed fence to fail" >&2
  exit 1
fi
grep -q 'Unclosed code fence opened at line 1' "$tmp/err"
echo "Markdown validation tests passed"
