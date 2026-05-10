# Bug Fix Workflow

Use this workflow when fixing incorrect behavior, crashes, broken tests, or regressions.

1. Reproduce or isolate the bug before changing code.
2. Identify the affected workspace and public behavior.
3. Add or update a regression test in that workspace's `tests/` directory.
4. Make the smallest code change that fixes the root cause.
5. Run the targeted test, then `npm run test` and `npm run typecheck`.

Follow `.agent/rules/testing.md` for test placement, mocking style, and assertion quality.
