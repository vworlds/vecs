# Testing Rules

Run the full test suite before committing behavior changes:

```bash
npm run test
npm run typecheck
```

When fixing a bug, add a regression test that fails before the fix and passes after it. Put the test in the affected workspace's `tests/` directory:

- `lib/vecs/tests/` for ECS internals (world, entity, query, system, dsl, bitset, ordered-set, etc.).
- `lib/vecs-wire/tests/` for encoder, decoder, and `@type` decorator round-trips.
- `lib/vecs-protocol/tests/` for `Server2Client` / `Client2Server` / `StateDiff` / `RPC` round-trips.
- `lib/vecs-server/tests/` for `VecsServer` and `VecsListener` behavior, mocking `VecsSocket` / `VecsSocketListener`.
- `lib/vecs-client/tests/` for `VecsClient` and `Interpolator` behavior, mocking `VecsSocket`.

When adding a feature, add tests for the public behavior, not implementation trivia. Cover the happy path and the important failure or edge path. For example, a protocol message feature should test encode/decode round-trips and rejection of malformed input; a server feature should test the resulting `Server2Client` payloads emitted to mock sockets.

Tests use Vitest. Prefer small unit tests with explicit in-memory mocks over real transports. The `VecsSocket` and `VecsSocketListener` interfaces in `@vworlds/vecs-protocol` are small on purpose: tests should provide their own implementations (see `MemorySocket` and `MockListener` in `lib/vecs-server/tests/server.test.ts` and `lib/vecs-client/tests/client.test.ts` for the existing pattern). Mock timing boundaries directly in the test file.

Write assertions that prove what users or callers observe:

- Returned values and thrown errors.
- Emitted events and event payloads.
- Calls to public methods such as `send`, `close`, and registered RPC handlers.
- State changes that are part of the public contract.

Avoid weak assertions such as `toBeDefined()` when a concrete value, event, or behavior can be checked.

Place future test policy, examples, and package-specific testing conventions in this file. If a task needs a step-by-step testing workflow, create or update a file in `.agent/workflows/` and link to this rule file.
