# vecs-physics — Progress

Mutable execution status for the plan in `PLAN.md`. **This file is the handoff
note**: a fresh context should read it first, then the relevant `PLAN.md`
section and the named box2d sources for the next ticket.

- `PLAN.md` = stable design (what/why). Only edited when the design or a
  cross-cutting decision changes.
- `PROGRESS.md` (this file) = mutable status (what's done, what's next, caveats).
- The **code** is ground truth; implementation caveats live as comments there,
  and the cross-cutting ones are mirrored into `PLAN.md` → _Settled Decisions_.

## Workflow

1. Read this file → find **NEXT**. Read the linked `PLAN.md` ticket + section
   and the named box2d source/test files (scoped, not the whole plan).
2. Test-first: port the box2d golden test, watch it fail, implement, go green.
3. Gate before finishing a ticket: `npm run typecheck`, `npm run test`,
   `npm run lint` all clean (run from `lib/vecs-physics/`); `npx prettier --check`.
4. On finish: update this file (status + commit ref + caveats), put any
   cross-cutting decision in `PLAN.md` → _Settled Decisions_, then commit.
5. The session is now disposable — it can be rewound/cleared.

## Status by ticket

### ✅ VP-1 — math layer (commit 265a213)

`src/math/{constants,vec2,rot,transform,aabb}.ts` + `tests/math/`.
Ports box2d `math_functions.h` + `constants.h`. 30 tests incl. a port of
`test/test_math.c::MathTest` (`tests/math/math_parity.test.ts`).

- **Caveat:** uses `Math.cos/sin/atan2`, not box2d's polynomial approximations.
  Documented in `rot.ts` header and `PLAN.md` _Settled Decisions_.

### ✅ VP-2 — util layer (commit: pending this commit)

`src/util/{handle,id_pool,dense_array,warn,bitset}.ts` + `tests/util/`. 15 tests.

- `IdPool<H>` owns per-slot generations (bumped on `free`); diverges from box2d
  (generation-on-object) — see `id_pool.ts` and _Settled Decisions_.
- Branded `BodyHandle`/`ShapeHandle` so the two cannot be mixed.
- `bitset.ts` re-exports Vecs' `Bitset` (`@vworlds/vecs` exports it publicly).
- `WarnDedupe` takes an injectable sink for testability.

### ⬜ NEXT: VP-3 — public components + `src/index.ts` exports

All public component classes (defaults table in `PLAN.md` → _Authoritative
Component Defaults_) with zero-arg validity, plus `Box.width/height` accessors.
Tests: defaults verified component-by-component. No engine work yet.
Pairs naturally with VP-4 (`installPhysics` skeleton).

## Environment / conventions learned

- Run all checks from `lib/vecs-physics/`: `npm run typecheck | test | lint`.
- Private class members **must** be `_`-prefixed (`local/internal-underscore`
  lint rule). Free-function modules (the math layer) are unaffected.
- ESM imports use explicit `.js` extensions.
- Commit style: `<type>: <subject>` + body, no scope (see `.agent/rules/commits.md`).

## Cross-library / open items

- `System.ignoreSource` (pose-sync feedback suppression, VP-6) **has landed** in
  `physics` (dev merged at 3af1cab). The plan originally called it `silenceFrom`;
  the real name is `ignoreSource(source: QueryDSL | Query)`. Re-verify its
  source-attribution semantics with a focused test at VP-6.
- Open design questions still to settle before **M3 (solver)**: TGS vs PGS, and
  CCD scope. See `PLAN.md` → _Open Questions_.
- `Query.groupBy` (optional, mass-recompute convenience) is uncommitted in the
  `cascade` worktree. Not on the critical path.
