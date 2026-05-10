# Feature Workflow

Use this workflow when adding new behavior or expanding an existing public API.

1. Identify the public behavior callers will observe.
2. Add tests for the happy path and the important failure or edge path.
3. Implement the smallest change that provides the behavior.
4. Update README or API docs when the behavior affects users.
5. Run `npm run format`, `npm run lint`, `npm run test`, and `npm run typecheck` before committing.

Follow `.agent/rules/testing.md` for test expectations and `.agent/rules/formatting.md` for formatting and linting.
