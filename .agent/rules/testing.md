# Testing Rules

Run the full test suite before committing behavior changes:

```bash
npm run test
npm run typecheck
```

When fixing a bug, add a regression test that fails before the fix and passes after it. Put the test in the affected workspace's `tests/` directory:

- `lib/dgram-client/tests/` for browser client socket behavior.
- `lib/dgram-server/tests/` for server sockets, signaling routes, and node-datachannel integration wrappers.
- `lib/dgram-common/tests/` for shared socket contracts, events, constants, and common types.

When adding a feature, add tests for the public behavior, not implementation trivia. Cover the happy path and the important failure or edge path. For example, a signaling route feature should test success and missing/invalid connection cases; a socket feature should test emitted events and sent payloads.

Tests use Vitest. Prefer small unit tests with explicit mocks over real WebRTC connections unless the task specifically requires integration coverage. Mock browser APIs, `node-datachannel`, Express request/response objects, and timing boundaries directly in the test file.

Write assertions that prove what users or callers observe:

- Returned values and thrown errors.
- Emitted events and event payloads.
- Calls to public methods such as `send`, `close`, and signaling route handlers.
- State changes that are part of the public contract.

Avoid weak assertions such as `toBeDefined()` when a concrete value, event, or behavior can be checked.

Place future test policy, examples, and package-specific testing conventions in this file. If a task needs a step-by-step testing workflow, create or update a file in `.agent/workflows/` and link to this rule file.
