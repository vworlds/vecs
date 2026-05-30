# Pull Request Workflow

Use this workflow when preparing or creating pull requests for this repo.

1. Start from the latest `origin/dev` unless the user explicitly requests another base branch:

```bash
git fetch origin
git checkout -b <branch-name> origin/dev
```

2. Review the relevant rules before preparing the PR:

- `.agent/rules/commits.md` for commit message format and commit policy.
- `.agent/rules/formatting.md` for formatting, linting, and hook expectations.
- `.agent/rules/testing.md` for test expectations.

3. Push the branch to `origin`:

```bash
git push -u origin <branch-name>
```

4. Create the PR against the source branch with `gh pr create`. Use a complete body that explains the change, the verification performed, and any risks or follow-ups.

```bash
gh pr create --base dev --title "<type>: <concise description>" --body "$(cat <<'EOF'
## Summary

- <what changed>
- <why it changed>

## Notes

- <risks, limitations, migration notes, or follow-ups; use "None" if not applicable>
EOF
)"
```

6. If the change affects public behavior, APIs, or user-facing setup, update the relevant README or docs before opening the PR.
