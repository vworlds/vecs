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

### ✅ VP-2 — util layer (commit 12f94be)

`src/util/{handle,id_pool,dense_array,warn,bitset}.ts` + `tests/util/`. 15 tests.

- `IdPool<H>` owns per-slot generations (bumped on `free`); diverges from box2d
  (generation-on-object) — see `id_pool.ts` and _Settled Decisions_.
- Branded `BodyHandle`/`ShapeHandle` so the two cannot be mixed.
- `bitset.ts` re-exports Vecs' `Bitset` (`@vworlds/vecs` exports it publicly).
- `WarnDedupe` takes an injectable sink for testability.

### ✅ VP-3 — public components + `src/index.ts` exports (commit 2ae3a52)

`src/components/{body,body_tuning,shape_pose,geometry,material,force,target,events}.ts`
+ `src/index.ts`. All public component classes with zero-arg validity, plus
`Box.width/height` accessors. 38 tests in `tests/components/`
(`defaults.test.ts` verifies the defaults table component-by-component;
`box_accessors.test.ts` covers the half-extent accessors).

- Defaults verified against `box2d/src/types.c` `b2Default{Body,Shape}Def` /
  `b2DefaultFilter` / `b2DefaultSurfaceMaterial`. Authoritative shapes taken from
  `docs/components.md` (the public contract), which is stricter than the PLAN
  table on two points now settled below.
- **`BodyType` is a string enum** (`"static"|"kinematic"|"dynamic"`), per
  `docs/components.md` — the PLAN defaults table only named `BodyType.Static`.
- **Collision filter fields are 32-bit `number`, not `bigint`** (diverges from
  box2d's `uint64_t`): `categoryBits` (`1`), `maskBits` (`0xffffffff`),
  `groupIndex` (`0`). `Material.userMaterialId` is also a `number` (`0`). 32
  categories is ample and filtering uses native JS bitwise ops; the package has
  no `bigint` in its public surface. See PLAN → Settled Decisions.
- `Material` bundles `density` (from `b2ShapeDef`) with the `b2SurfaceMaterial`
  fields; not a separate density component.
- Event payload types (`ContactEvent`/`SensorEvent`/`HitEvent`) import `Entity`
  from `@vworlds/vecs`. Event arrays are per-instance (field initialisers), not
  prototype-shared — covered by a test.
- No Vecs registration here: `world.component(...)` calls and exclusivity land in
  VP-4.

### ✅ VP-4 — `installPhysics` skeleton (commit a68051d)

`src/install.ts` + `src/engine/state.ts`; `installPhysics`/`PhysicsOptions`
exported from `src/index.ts`. Registers all 29 public components in the PLAN
order, `setExclusiveComponents(Box, Circle, Capsule, Segment, Polygon, Chain)`,
ensures the three phases (`physics-pre`/`-step`/`-post`, or caller-supplied
`IPhase`/name), allocates a skeletal `PhysicsState` and attaches it via the
`PhysicsRoot` singleton. 9 tests in `tests/lifecycle/install.test.ts`. Wiring
only — no systems, engine is a no-op.

- **`PhysicsState` is skeletal:** resolved config (flattened from
  `PhysicsOptions`), the `bodyByEntity`/`shapeByEntity` maps, and `stepIndex`.
  The solver storage subsystems (`BodyStorage`/`ShapeStorage`/… in the PLAN
  sketch) and event-scratch arrays are deferred to the tickets that populate
  them — their element types don't exist yet.
- **`PhysicsSystemTag` deferred to VP-6.** PLAN registration step 9 lists it
  alongside `PhysicsRoot`, but it only matters once systems exist (it marks
  physics system entities for `ignoreSource`). Registering it now would add a
  dead class. Re-add it in VP-6 immediately after `PhysicsRoot` to preserve the
  documented registration order. Only `PhysicsRoot` is registered for now.
- **Double-install / after-start guards.** `hasPhysics(world)` (side-effect
  free: checks `world._classRegistry` before any registration) guards
  double-install; `isWorldStarted` reads the world's internal `_started` flag
  (no public accessor exists) to give a clear pre-`start()` error instead of the
  generic "registration disabled" throw.
- **Phase lookup uses `world._pipeline.get(name)` then `addPhase`** — `addPhase`
  always creates a new phase and would clobber an existing same-named one, so we
  look up first. Passing an `IPhase` directly is honoured as-is.

### ✅ VP-5 — `engine/body.ts` + `engine/solver_set.ts` (commit e0eb4c1)

`InternalBody`/`BodySim`/`BodyState` + `BodyStorage` (`body.ts`); `SolverSet`,
the set-type constants, and `createBody`/`destroyBody`/`transferBody`
(`solver_set.ts`). `PhysicsState` grows to hold `bodies: BodyStorage` and
`solverSets: SolverSet[]`. 14 tests in `tests/engine/`
(`solver_set.test.ts` covers transfers across awake/static/disabled preserving
every set's `localIndex`, plus body-state create/drop crossing the awake
boundary, same-set no-op, round-trip, and destroy; `body.test.ts` covers the
sim/state factories and `BodyStorage.get`).

- **Sims relocate by moving the object reference, not `memcpy`.** Box2D copies a
  `b2BodySim` struct into the target set then removes the source slot; we push
  the same `BodySim` object into the target array and swap-pop it out of the
  source. Indices are still fixed exactly as Box2D does (swap-pop moves the last
  element into the hole, and that element's `localIndex` is repaired via the
  `bodyId` back-pointer). A porting-fidelity instance — see PLAN → Settled.
- **`InternalBody` is intentionally thin** (`setIndex`, `localIndex`). The owning
  `Entity`, `type`, mass, flags, and topology (shape/contact/island links) are
  added by the tickets that populate them — body storage + transfer touch none
  of them. No `generation` field: the `IdPool` owns generations (settled VP-2).
- **Sleeping-set allocation deferred.** Only the three fixed sets
  (`STATIC`/`DISABLED`/`AWAKE`, indices 0/1/2) are created;
  `FIRST_SLEEPING_SET` is exported but sleeping islands take ids when sleep lands
  (M5). `b2TransferBody`'s transient-sim-flag clear (`isFast`/`isSpeedCapped`/
  `hadTimeOfImpact`) is a documented no-op until the solver/CCD introduce those
  flags. `SolverSet` holds only `bodySims`/`bodyStates`; contact/joint/island
  arrays land with their tickets.
- **`bodyStates` is awake-set only** and kept parallel to `bodySims`: a body
  gains an identity state when entering the awake set and drops it (swap-pop at
  the same `localIndex`) when leaving, mirroring `b2CreateBody`/`b2TransferBody`.
- Engine module boundary held: `body.ts`/`solver_set.ts` import only `math/` +
  `util/`, never `components/` (so the internal numeric body-type vs the public
  string `BodyType` translation is a VP-6 system-layer concern).

### ⬜ NEXT: VP-6 — `systems/lifecycle.ts` (`PhysicsBodyLifecycle`) + `pose_sync_in.ts` + `pose_sync_out.ts`

Body create/destroy, teleport, and feedback suppression. Re-add
`PhysicsSystemTag` (registered immediately after `PhysicsRoot`, deferred from
VP-4) and wire `PhysicsPoseSyncIn.ignoreSource([PhysicsSystemTag])`. **Verify
`ignoreSource` against the merged `@vworlds/vecs` source first** — a dev merge
relocated it from `System` to `Query.ignoreSource` (see _Cross-library_ below).
This ticket reads `Body.type` and translates it to the engine's solver-set
placement, and stores the owning `Entity` on `InternalBody` (grows the struct).
See `PLAN.md` → VP-6 and _System And Phase Pipeline_.

## Environment / conventions learned

- Run all checks from `lib/vecs-physics/`: `npm run typecheck | test | lint`.
  (`npm run test` from the worktree root runs every workspace; scope with
  `npm --prefix lib/vecs-physics run test` or `cd` in.)
- **Vitest now resolves `@vworlds/vecs` via an explicit alias** in
  `lib/vecs-physics/vitest.config.ts` → this checkout's `../vecs/src/index.ts`,
  mirroring `tsconfig.base.json` `paths`. Added in VP-4 because vitest (unlike
  tsc) had no alias and fell back to node resolution up to the repo-root
  `node_modules/@vworlds/vecs` symlink, which points at the **main checkout's
  working tree**. When that checkout is mid-refactor (it was: `query.ts` being
  split into `query/`), every `@vworlds/vecs` import failed to load. The alias
  makes the worktree hermetic; keep tsc and vitest pointed at the same source.
- Private class members **must** be `_`-prefixed (`local/internal-underscore`
  lint rule). Free-function modules (the math layer) are unaffected.
- ESM imports use explicit `.js` extensions.
- Commit style: `<type>: <subject>` + body, no scope (see `.agent/rules/commits.md`).
- Prettier is **not** enforced on `docs/*.md` (they aren't prettier-clean at
  HEAD). Don't `prettier --write` docs — make minimal literal edits and keep the
  existing hand-aligned table formatting, or you'll spray unrelated churn.
- **Port the model, not the C representation** (PLAN → _Box2D Porting Strategy_).
  Don't be slavishly literal about Box2D's C choices: 64-bit fields → `number`
  (not `bigint`) unless >2^53 range is truly needed; opaque user data → a field
  holding an arbitrary JS value, not a faked pointer/number. The collision-filter
  32-bit decision (above) is the first instance.

## Cross-library / open items

- Feedback suppression (pose-sync, VP-6) **has landed** but **moved**: a later
  dev merge (`cade99b`, pulling in the `silent` branch) relocated the machinery
  from `System` to **`Query`** — it's now `Query.ignoreSource` (commits
  `b745b34`/`dad09aa`), not `System.ignoreSource` as earlier notes/PLAN said.
  The plan originally called it `silenceFrom`. Re-verify its source-attribution
  semantics with a focused test at VP-6, and confirm the exact signature against
  the merged `@vworlds/vecs` source before relying on it.
- Open design questions still to settle before **M3 (solver)**: TGS vs PGS, and
  CCD scope. See `PLAN.md` → _Open Questions_.
- `Query.groupBy` (optional, mass-recompute convenience) **has landed** via the
  `cade99b` dev merge (`cascade` branch: commits `cc2a5a1`/`22ea51b`,
  `GroupedQuery` in `group.ts`). No longer uncommitted; still not on the critical
  path.
