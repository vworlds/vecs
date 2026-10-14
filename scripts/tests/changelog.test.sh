#!/usr/bin/env bash
# Exercise the exact release collector in an isolated fixture repository.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
. "$root/scripts/lib/changelog.sh"
temporary="$(mktemp -d "$root/.changelog-test.XXXXXX")"
trap 'rm -rf "$temporary"' EXIT
cd "$temporary"
git init -q
mkdir -p architecture/unreleased
printf '# Changelog\n\nIntro.\n\n## v1.0.0 (2026-01-01)\n\n- [repo]: Old.\n' > architecture/CHANGELOG.md
cp architecture/CHANGELOG.md original.md
printf '# Not a fragment\n' > architecture/unreleased/README.md
printf '\n- [repo]: Ten first.\n- [vecs]: Ten second.\n\n' > architecture/unreleased/10.md
printf '%s\n' '- [repo]: Two.' > architecture/unreleased/2.md
printf '%s\n' '- [repo]: Zulu.' > architecture/unreleased/zulu.md
printf '%s\n' '- [repo]: Alpha.' > architecture/unreleased/alpha.md
git add architecture
git -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm 'test: fixture'

collect_changelog 1.0.1 2026-10-14
cat > expected.md << 'EOF'
# Changelog

Intro.

## v1.0.1 (2026-10-14)

- [repo]: Ten first.
- [vecs]: Ten second.
- [repo]: Two.
- [repo]: Alpha.
- [repo]: Zulu.

## v1.0.0 (2026-01-01)

- [repo]: Old.
EOF
cmp expected.md architecture/CHANGELOG.md
printf 'ok 1 - numeric descending, slug ascending, bullet order and history preserved\n'
[ -f architecture/unreleased/README.md ]
! grep -q 'Not a fragment' architecture/CHANGELOG.md
printf 'ok 2 - README skipped and retained\n'
[ "$(git diff --cached --diff-filter=D --name-only | wc -l)" -eq 4 ]
[ "$(find architecture/unreleased -name '*.md' | wc -l)" -eq 1 ]
git diff --cached --name-only | grep -qx architecture/CHANGELOG.md
git diff --quiet
printf 'ok 3 - fragments removed and staged with changelog\n'

cp architecture/CHANGELOG.md before.md
git diff --cached > before-index.patch
printf '%s\n' '- [repo]: Valid first.' > architecture/unreleased/999.md
printf '%s\n' '- [repo]: Valid.' 'not a bullet' > architecture/unreleased/bad.md
if collect_changelog 1.0.2 2026-10-15 > error.log 2>&1; then
  printf 'FAIL: invalid fragment accepted\n' >&2
  exit 1
fi
grep -q 'architecture/unreleased/bad.md' error.log
cmp before.md architecture/CHANGELOG.md
git diff --cached > after-index.patch
cmp before-index.patch after-index.patch
[ -f architecture/unreleased/999.md ] && [ -f architecture/unreleased/bad.md ]
printf 'ok 4 - invalid fragment names file and aborts before any writes or removals\n'
if validate_changelog_fragments > error.log 2>&1; then exit 1; fi
grep -q 'architecture/unreleased/bad.md' error.log
printf 'ok 5 - CI validator rejects malformed fragment\n'
rm architecture/unreleased/999.md architecture/unreleased/bad.md

collect_changelog 1.0.2 2026-10-15 > empty.log
grep -q 'No changelog fragments' empty.log
cmp before.md architecture/CHANGELOG.md
printf 'ok 6 - README-only directory logs and leaves changelog unchanged\n'
rm architecture/unreleased/README.md
collect_changelog 1.0.2 2026-10-15 > empty.log
cmp before.md architecture/CHANGELOG.md
printf 'ok 7 - empty directory is a no-op\n'
rmdir architecture/unreleased
collect_changelog 1.0.2 2026-10-15 > empty.log
cmp before.md architecture/CHANGELOG.md
printf 'ok 8 - missing directory is a no-op\n'
mkdir architecture/unreleased
printf '\n- [repo]: Valid.\n\n' > architecture/unreleased/3.md
validate_changelog_fragments
printf 'ok 9 - blank lines accepted\n'
rm architecture/CHANGELOG.md
if collect_changelog 1.0.2 2026-10-15 > error.log 2>&1; then exit 1; fi
grep -q 'Missing architecture/CHANGELOG.md' error.log
[ -f architecture/unreleased/3.md ]
printf 'ok 10 - missing changelog aborts without removing fragments\n'
printf 'PASS: 10 changelog tests\n'
