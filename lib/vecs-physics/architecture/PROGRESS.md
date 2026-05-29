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

### ✅ VP-6 — `systems/lifecycle.ts` (`PhysicsBodyLifecycle`) + `pose_sync_in.ts` + `pose_sync_out.ts` (commit f576659)

`src/systems/{lifecycle,pose_sync_in,pose_sync_out,index}.ts`; `install.ts` now
registers internal components (step 9) and installs+tags the three systems (step
12) before attach (step 13). `engine/body.ts` grew `InternalBody` (`entity` +
numeric `type`), added body-type constants + `writeBodyTransform`;
`engine/solver_set.ts` `createBody` takes `(…, entity, type)`;
`engine/state.ts` exports `PhysicsSystemTag` + `registerInternalComponents`.
30 new tests (`tests/lifecycle/{ignore_source,body_lifecycle,pose_sync}.test.ts`),
122 total.

- **`ignoreSource` confirmed first, then wired.** A focused Vecs-level test
  (`ignore_source.test.ts`) pins the contract: it lives on **`Query`** (not
  `System`), drops updates whose source is in the silence query, never silences
  entry-time init, and honours outside (sourceless) writes. The pose-sync
  feedback suppression rides this with no value comparison. Mirrored to
  PLAN → _Settled Decisions_.
- **`PhysicsSystemTag` re-added** (deferred from VP-4): registered immediately
  after `PhysicsRoot` in `registerInternalComponents` (step 9); each of the
  three systems is tagged in `systems/index.ts` (step 12).
- **`update` fires on query entry _or_ on modification.** `Query._enter` replays
  every watchlisted component present at entry through `_notifyModified`; a modify
  of an already-present component also fires. A watched component _added_ to a
  body that already matches `requires(Body)` is **not** seen until next written
  (adding it doesn't re-enter the query). The canonical pose/velocity components
  are present at body creation, so they're caught on entry. See PLAN → Settled.
- **`update(Body)` is partial by necessity.** Type/enable changes do the
  fully-portable solver-set transfer now; contact teardown, mass re-init, and
  broad-phase re-creation (the rest of `b2Body_SetType`/`Enable`/`Disable`) wait
  for those subsystems. Same for `exit` — no shape/contact/island walk yet.
- **`PhysicsPoseSyncOut` writes back every dynamic awake body each frame** (no
  move-event list until the solver lands in VP-7); kinematic/static poses are
  not written back.
- VP-5 storage tests updated for the new `createBody` signature / grown record
  (now `toMatchObject` on the index-bookkeeping assertions, plus an entity/type
  check).

### ✅ VP-7 — `systems/step.ts` + `engine/step.ts` — minimal `engineStep` (gravity only) (commit db85b21)

`src/engine/step.ts` (the integrator) + `src/systems/step.ts` (`PhysicsStep` in
the `physics-step` phase). `PhysicsState` gained `bodyMoveEvents`;
`PhysicsPoseSyncOut` now consumes it; `engine/body.ts` gained the body flag bits
(`LOCK_*`, `IS_SPEED_CAPPED`, `ALLOW_FAST_ROTATION`). 13 new tests
(`tests/engine/step.test.ts`, `tests/lifecycle/gravity.test.ts`), 135 total.

- **Integrator ports the gravity/damping core** of the TGS soft-step solver:
  `b2IntegrateVelocitiesTask` (gravity gated on `invMass > 0`, Pade damping,
  force/torque), `b2IntegratePositionsTask` (motion-lock zeroing, linear/angular
  speed caps, delta-pose advance), and the body-write half of
  `b2FinalizeBodiesTask` (fold delta-pose into centre/rotation, derive origin
  `p = c − R·localCenter`, reset deltas/forces, advance sweep, emit move event).
  Constraint stages, sleep, and CCD are documented no-ops until their tickets.
- **Uniform sub-step `h = dt / subSteps`.** The PLAN's "first substep uses full
  `dt`" was wrong; corrected against `b2_physics_world.c` and noted in PLAN.
- **`PhysicsPoseSyncOut` now iterates `state.bodyMoveEvents`** (the awake bodies
  the step finalized) instead of scanning the awake set — the narrowing the
  VP-6 note called for.
- **Mass is not computed yet** (VP-12), so a fresh dynamic body has `invMass = 0`
  and will not fall. The free-fall DoD test and the engine tests seed
  `sim.invMass = 1` to stand in. Box2D defaults a massless dynamic body to mass
  1; the mass ticket will too. Settled in PLAN.
- **DoD met:** `tests/lifecycle/gravity.test.ts` drops a body through the full
  pipeline and matches `pos.y = 4 − ½·g·t²` (and `v = −g·t`) within tolerance;
  a static body does not move. `engine/step.test.ts` pins the semi-implicit
  Euler position/velocity exactly, plus damping, speed cap, force reset, and
  move-event behaviour.
- Two VP-6 pose-sync tests and the body-lifecycle velocity test were updated for
  the now-active solver: "engine moved the body" is simulated by setting the
  body **centre** (finalize derives the origin transform from it, so poking
  `transformX` alone no longer survives the step), and the velocity-read check
  uses a zero-damping body so the step leaves the read value intact.

## MILESTONE 2 — Shape lifecycle + broad/narrow phase (IN PROGRESS)

**Tickets: VP-8, VP-9, VP-10, VP-11, VP-12, VP-13, VP-14.** Architect: this pass.
Engine-layer collision plumbing (shape storage, BVH, broad/narrow phase,
manifolds, mass) plus the shape-lifecycle/material/pose systems. No solver yet
(M3): contacts are _generated_, bodies still pass through.

### Dependency graph & execution waves

```
VP-8  shape.ts/geometry.ts ─┬─> VP-10 broad_phase ─┬─> VP-11 shape systems
VP-9  dynamic_tree ─────────┘                      │
VP-8 ─> VP-12 mass.ts (engine) ───> VP-12 system ──┘ (system needs VP-11)
VP-8 ─> VP-13 manifolds/distance ──> VP-14 narrow_phase dispatch
```

- **Wave 1 (parallel):** VP-8 and VP-9 — independent leaves. VP-9 runs in its own
  worktree (touches only `dynamic_tree.ts` + tests; must NOT edit `state.ts`/
  `install.ts`/`PROGRESS.md`).
- **Wave 2 (after VP-8):** VP-10 (also needs VP-9), VP-12 (engine half), VP-13.
- **Wave 3:** VP-11 (needs VP-8+VP-10), VP-14 (needs VP-13), VP-12 (system half,
  needs VP-11).

### Architect scoping decisions (refining the PLAN ticket list)

- **`distance.c` is a manifold prerequisite, folded into VP-13 (not a new
  top-level ticket).** Checked the sources: `b2CollidePolygons` needs only
  `b2SegmentDistance` (closed-form) — _not_ GJK; full `b2ShapeDistance` (GJK) +
  `b2MakeProxy` + `b2SimplexCache` are needed only by
  `b2CollideChainSegmentAndPolygon`. So `engine/distance.ts` grows in two steps:
  `b2SegmentDistance` in VP-13b (polygons), GJK in VP-13e (chain segments). The
  PLAN's _Package layout_ lists `distance.ts` but the M2 ticket list omitted it —
  this records the gap and where it lands.
- **VP-13 sub-ticket relabel (a–e, not the PLAN's a–f).** Consolidated the three
  circle functions into one sub-ticket and made distance-primitive growth
  explicit: 13a circles, 13b distance+polygons, 13c capsules, 13d segments,
  13e chain segments+GJK. Same twelve `b2Collide*` functions, clearer ordering.
- **VP-8 owns shape record + geometry union + AABB + point-in-shape only; all
  mass integrals are VP-12** (resolving the PLAN's flagged VP-8/VP-12 overlap).
- **VP-11 splits `PhysicsMaterialFilterSync` into its own unit (VP-11b)** per the
  granularity note. Its contact-refilter teardown is **deferred to M3** (no
  contact graph exists yet) — same shape of deferral as VP-6's body teardown.
- **VP-14 is the dispatch unit + a narrow-phase entry only.** Full
  broad→narrow→contact step-loop wiring lands in M3 with contacts/islands/solver;
  M2 proves manifold generation, not a wired collision step.
- **Pre-M3 open questions (TGS vs PGS, CCD scope) still need eng review** before
  the solver proper — unchanged by M2.

### Status by ticket

- ⬜ **VP-8** — `engine/shape.ts` + `engine/geometry.ts`. NEXT (wave 1).
- ⬜ **VP-9** — `engine/dynamic_tree.ts`. NEXT (wave 1, parallel).
- ⬜ **VP-10** — `engine/broad_phase.ts`.
- ⬜ **VP-11** — `systems/shape_lifecycle.ts` + `shape_pose_sync.ts` + `material_filter_sync.ts`.
- ⬜ **VP-12** — `engine/mass.ts` + `systems/mass_recompute.ts`.
- ⬜ **VP-13** — `engine/manifold/*` + `engine/distance.ts`.
- ⬜ **VP-14** — `engine/narrow_phase.ts`.

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

- Feedback suppression (pose-sync) **confirmed and wired at VP-6**. The machinery
  lives on **`Query`** — `Query.ignoreSource(source: QueryDSL | Query)` (a dev
  merge `cade99b`/`b745b34`/`dad09aa` relocated it from `System`; the plan
  originally called it `silenceFrom`). Signature and source-attribution semantics
  were pinned by a focused test (`tests/lifecycle/ignore_source.test.ts`) before
  wiring: source = the system entity that made the mutation; entry-init is never
  silenced; sourceless (gameplay) writes always wake. The documented
  engine-origin-tag fallback was **not** needed.
- Open design questions still to settle before **M3 (solver)**: TGS vs PGS, and
  CCD scope. See `PLAN.md` → _Open Questions_.
- `Query.groupBy` (optional, mass-recompute convenience) **has landed** via the
  `cade99b` dev merge (`cascade` branch: commits `cc2a5a1`/`22ea51b`,
  `GroupedQuery` in `group.ts`). No longer uncommitted; still not on the critical
  path.

## M1 review follow-ups

Forward-looking items surfaced reviewing Milestone 1 (VP-5…VP-7) against box2d.
None block M1 — the integrator/transfer/storage ports are faithful and the gate
is green — but each needs attention in a later ticket.

- **Kinematic accept-input / drop-output asymmetry.** `PhysicsPoseSyncIn` accepts
  `LinearVelocity`/`AngularVelocity` on a kinematic body (`pose_sync_in.ts` only
  excludes `STATIC_BODY`), and the integrator advances any awake body — so a
  kinematic body with user-set velocity *does* move inside the engine and lands
  on `bodyMoveEvents`. But `PhysicsPoseSyncOut` writes back **dynamic only**
  (`pose_sync_out.ts`), so that motion is never visible in the ECS: a silent
  no-op. box2d moves and reports kinematic bodies. Resolve when kinematic drive
  lands (**M4 / `PhysicsKinematicTargets`**): either write kinematic poses back
  too, or reject kinematic velocity input. Decide the contract, don't leave it
  half-wired. Code comment left in `pose_sync_out.ts`.
- **`transferBody` seeds `BodyState.flags` from `sim.flags`, box2d uses
  `body.flags`** (`b2TransferBody`, solver_set.c:539). Equivalent today — both
  `0` until `MotionLocks`/`bullet` are wired, and the lock/`allowFastRotation`
  bits are identical in both. `InternalBody` has no `flags` field yet; whoever
  wires `MotionLocks` (the lock-flag ticket) must give the awake-state its lock +
  `allowFastRotation` bits. Code comment left at the seeding site in
  `solver_set.ts`.
- **No fixed-timestep accumulator.** `PhysicsStep` steps exactly once per frame
  with `fixedTimeStep` and ignores the frame delta (debug-warns on mismatch).
  This matches the PLAN (fixed step, no accumulator promised); flagged only so a
  future "variable frame rate" request is a known design change, not a bug.
