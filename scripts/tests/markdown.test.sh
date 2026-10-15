#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
check="$root/scripts/agent/check-markdown.sh"
fixtures="$root/tests/fixtures/markdown"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/bin"
cat > "$tmp/bin/node" << 'EOF'
#!/usr/bin/env bash
if [[ "$*" == *"import.meta.resolve('jsdom')"* ]]; then exit 1; fi
exec "${REAL_NODE:?}" "$@"
EOF
chmod +x "$tmp/bin/node"
if PATH="$tmp/bin:$PATH" REAL_NODE="$(command -v node)" "$check" "$fixtures/no-mermaid.md" > "$tmp/out" 2> "$tmp/err"; then
  echo "expected missing dependencies to fail" >&2
  exit 1
else
  status=$?
fi
test "$status" = 2
grep -Fq "check-markdown: dependencies missing in $root; run HUSKY=0 npm ci there" "$tmp/err"
! grep -q 'ERR_MODULE_NOT_FOUND\|at ModuleJob' "$tmp/err"

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
