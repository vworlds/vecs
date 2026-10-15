#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
repo="$tmp/repo"
mkdir -p "$repo" "$tmp/bin"
git -C "$repo" init -q
git -C "$repo" config user.email test@example.com
git -C "$repo" config user.name test
printf 'old\n' > "$repo/package-lock.json"
git -C "$repo" add package-lock.json
git -C "$repo" commit -qm old
old="$(git -C "$repo" rev-parse HEAD)"
printf 'new\n' > "$repo/package-lock.json"
git -C "$repo" add package-lock.json
git -C "$repo" commit -qm new
new="$(git -C "$repo" rev-parse HEAD)"
cat > "$tmp/bin/npm" << 'EOF'
#!/usr/bin/env bash
printf '%s|%s\n' "$HUSKY" "$*" >> "$NPM_CALLS"
EOF
chmod +x "$tmp/bin/npm"
export NPM_CALLS="$tmp/npm-calls"
PATH="$tmp/bin:$PATH" "$root/scripts/orchestrator/install-deps-after-fast-forward.sh" "$repo" "$old" "$new"
grep -Fxq '0|ci --no-audit --no-fund' "$NPM_CALLS"
: > "$NPM_CALLS"
PATH="$tmp/bin:$PATH" "$root/scripts/orchestrator/install-deps-after-fast-forward.sh" "$repo" "$new" "$new"
test ! -s "$NPM_CALLS"
echo "Fast-forward dependency tests passed"
