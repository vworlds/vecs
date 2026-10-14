# Unreleased changelog fragments

Record pending release notes without editing the shared versioned changelog.

Write `architecture/unreleased/<PR number>.md`, one file per PR. Put multiple
entries for that PR in the same file, in the desired order. For a change without
a PR, use a descriptive `<short-slug>.md` filename. Every non-empty line must be
a changelog bullet starting with `- [`, tagged with the owning subproject; do not
add headings or wrapped continuation lines.

For example, `313.md`:

```markdown
- [vecs] Fixed: Preserve component data during a subtree move (#313).
- [vecs-client] Changed: Document the matching client cleanup (#313).
```

For example, `build-tooling.md` for a change without a PR:

```markdown
- [repo]: Update build tooling for the supported Node.js version.
```

Run `scripts/agent/check-changelog.sh` to validate fragments. At release, the
collector skips this README, orders numeric filenames newest first and slug
filenames alphabetically last, inserts their bullets into
[`CHANGELOG.md`](../CHANGELOG.md), and removes the fragments in the same commit.
