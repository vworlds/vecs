# Feature Workflow

Use this workflow when adding new behavior or expanding an existing public API.

1. Identify the public behavior callers will observe.
2. Add tests for the happy path and the important failure or edge path.
3. Implement the smallest change that provides the behavior.
4. Update docs (see `rules/documentation.md`): the JSDoc on touched public symbols and the relevant prose guides, plus the README landing and docs map when the public surface changes.
5. Run `npm run format`, `npm run lint`, `npm run test`, and `npm run typecheck` before committing.

Follow `.agents/rules/testing.md` for test expectations, `.agents/rules/documentation.md` for documentation expectations, and `.agents/rules/formatting.md` for formatting and linting.
