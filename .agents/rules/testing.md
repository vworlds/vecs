# Testing Rules

Run the full test suite before committing behavior changes:

```bash
npm run test
npm run typecheck
```

The root `npm run test` caps each workspace's Vitest pool at two workers by default to
limit resource use on shared builders. Override it with `VITEST_MAX_WORKERS=4 npm run test`
(or another worker count). Forks and per-file isolation retain their Vitest defaults.
Running a single workspace directly, for example `npm run test -w @vworlds/vecs-physics`,
retains Vitest's default worker count unless you set `VITEST_MAX_WORKERS` yourself.

## Correctness, stress, and measurements

- `npm run test` answers “does it work?” with deterministic behavior assertions. Keep
  measurements and minute-long simulation horizons out of this tier.
- Put long correctness scenarios in `*.stress.test.ts`. Every workspace's normal Vitest
  configuration excludes those files. `npm run test:stress` runs only stress files,
  using the same root worker cap as `test`; workspaces with stress files expose the
  same script with a stress configuration that retains their aliases and setup.
- Use separate entry files and shared case-registration helpers for short and long
  versions. Do not env-gate or `skipIf` tests in normal files.
- Before shortening a regression scenario, temporarily mutate its guarded behavior
  and confirm every shortened case fails. Revert the mutation, confirm the cases pass,
  and report the mutation/results in review evidence. Without that evidence, keep the
  original scenario in the normal tier.
- Keep full measurement scenes in `bench/`. `npm run bench:release-check` compares
  built HEAD packages against the previous release and warns about regressions without
  failing the build. See [benchmark commands and comparison policy](../../bench/README.md).

The nightly/manual `stress-and-bench.yml` workflow runs stress correctness and release
comparison separately from push/PR CI. A stress assertion failure fails the job;
benchmark warnings become annotations and appear in the job summary.

When fixing a bug, add a regression test that fails before the fix and passes after it. Put the test in the affected workspace's `tests/` directory:

- `lib/vecs/tests/` for ECS internals (world, entity, query, system, dsl, bitset, ordered-set, etc.).
- `lib/vecs-wire/tests/` for encoder, decoder, and `@type` decorator round-trips.
- `lib/vecs-protocol/tests/` for `Server2Client` / `Client2Server` / `StateDiff` / `RPC` round-trips.
- `lib/vecs-server/tests/` for `VecsServer` and `VecsListener` behavior, mocking `VecsSocket` / `VecsSocketListener`.
- `lib/vecs-client/tests/` for `VecsClient` and `DiffBuffer` behavior, mocking `VecsSocket`.

Mirror the source hierarchy when a package has scoped subdirectories. Put tests for code under `src/<area>/` in `tests/<area>/`, with one focused test file per source module. Keep cross-cutting API behavior in the nearest top-level test file instead of mixing it into area-specific tests.

When adding a feature, add tests for the public behavior, not implementation trivia. Cover the happy path and the important failure or edge path. For example, a protocol message feature should test encode/decode round-trips and rejection of malformed input; a server feature should test the resulting `Server2Client` payloads emitted to mock sockets.

Tests use Vitest. Prefer small unit tests with explicit in-memory mocks over real transports. The `VecsSocket` and `VecsSocketListener` interfaces in `@vworlds/vecs-protocol` are small on purpose: tests should provide their own implementations (see `MemorySocket` and `MockListener` in `lib/vecs-server/tests/server.test.ts` and `lib/vecs-client/tests/client.test.ts` for the existing pattern). Mock timing boundaries directly in the test file.

Write assertions that prove what users or callers observe:

- Returned values and thrown errors.
- Emitted events and event payloads.
- Calls to public methods such as `send`, `close`, and registered RPC handlers.
- State changes that are part of the public contract.

Avoid weak assertions such as `toBeDefined()` when a concrete value, event, or behavior can be checked.

Place future test policy, examples, and package-specific testing conventions in this file. Shared task procedures live in the pinned vmethod worker guide; project hook checks live in [the local tooling guide](../vmethod.md).
