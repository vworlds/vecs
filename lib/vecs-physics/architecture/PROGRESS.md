# vecs-physics — Progress

Mutable execution status for the plan in `PLAN.md`. **This file is the handoff
note**: a fresh context should read it first, then the relevant `PLAN.md`
section and the named box2d sources for the next ticket.

- `PLAN.md` = stable design (what/why). Only edited when the design or a
  cross-cutting decision changes.
- `PROGRESS.md` (this file) = mutable status (what's done, what's next, caveats).
- The **code** is ground truth; implementation caveats live as comments there,
  and the cross-cutting ones are mirrored into `PLAN.md` → _Settled Decisions_.

## Working rules (read before changing anything — applies to every agent)

The load-bearing rules are repeated
here:

- **Box2D parity is the north star.** Port the model faithfully. Verify against
  the vendored source in `lib/vecs-physics/box2d/` — do **not** assert "Box2D does
  X" from memory; open the file and quote it.
- **Every intentional deviation from Box2D must be recorded as a deviation.** Put
  it in `PLAN.md` → _Settled Decisions_ and note it here, quoting the Box2D
  behaviour you are diverging from. Never describe a divergence in prose as if it
  mirrors Box2D — that is how silent parity bugs get reviewed-in (it has happened:
  e.g. "skip sensors/zero-density" implied Box2D skips sensors; it does not).
- **Deferring work to a later milestone is fine, but track it.** Add a
  `Carried into MX` line with the contract, and leave an in-code comment at the
  site. Re-filing an already-tracked deferral as a "bug" is noise.
- **Gate before every commit:** `npm run typecheck && npm run test && npm run lint`
  - `npx prettier --check` on changed files, run from `lib/vecs-physics/`. The
    repo-wide pre-commit hook currently fails on unrelated workspaces; `--no-verify`
    is acceptable **only** when the `lib/vecs-physics/` gate above is fully green.
- **Commits:** `<type>: <subject>` + body, no scope (see `.agent/rules/commits.md`).

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

- `src/index.ts`. All public component classes with zero-arg validity, plus
  `Box.width/height` accessors. 38 tests in `tests/components/`
  (`defaults.test.ts` verifies the defaults table component-by-component;
  `box_accessors.test.ts` covers the half-extent accessors).

* Defaults verified against `box2d/src/types.c` `b2Default{Body,Shape}Def` /
  `b2DefaultFilter` / `b2DefaultSurfaceMaterial`. Authoritative shapes taken from
  `docs/components.md` (the public contract), which is stricter than the PLAN
  table on two points now settled below.
* **`BodyType` is a string enum** (`"static"|"kinematic"|"dynamic"`), per
  `docs/components.md` — the PLAN defaults table only named `BodyType.Static`.
* **Collision filter fields are 32-bit `number`, not `bigint`** (diverges from
  box2d's `uint64_t`): `categoryBits` (`1`), `maskBits` (`0xffffffff`),
  `groupIndex` (`0`). `Material.userMaterialId` is also a `number` (`0`). 32
  categories is ample and filtering uses native JS bitwise ops; the package has
  no `bigint` in its public surface. See PLAN → Settled Decisions.
* `Material` bundles `density` (from `b2ShapeDef`) with the `b2SurfaceMaterial`
  fields; not a separate density component.
* Event payload types (`ContactEvent`/`SensorEvent`/`HitEvent`) import `Entity`
  from `@vworlds/vecs`. Event arrays are per-instance (field initialisers), not
  prototype-shared — covered by a test.
* No Vecs registration here: `world.component(...)` calls and exclusivity land in
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
registers internal components (step 9) and installs+tags the three systems (step 12) before attach (step 13). `engine/body.ts` grew `InternalBody` (`entity` +
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
  `sim.invMass = 1` to stand in. ~~Box2D defaults a massless dynamic body to mass
  1; the mass ticket will too.~~ **Corrected at VP-12:** this was wrong — box2d's
  `b2UpdateBodyMassData` leaves a massless dynamic body at `invMass = 0` (infinite
  mass), and vecs-physics now matches it. The free-fall tests are unaffected (they
  seed `invMass` and their bodies have no shape, so mass is never recomputed).
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

## MILESTONE 2 — Shape lifecycle + broad/narrow phase (✅ COMPLETE)

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

- ✅ **VP-8** — `engine/shape.ts` + `engine/geometry.ts` (commit 6ec4a63). `ShapeType`
  enum, `GeometryUnion` (circle/capsule/segment/polygon/chainSegment), thin
  `InternalShape` + `ShapeStorage`, per-kind constructors, `makeChainSegments`,
  geometry helpers (`makeBox`/`makePolygon`/`computeHull`/`validateHull`/centroid),
  `computeAABB`, point-in-shape. `PhysicsState.shapes` added. 44 tests (parity:
  ShapeAABBTest, PointInShapeTest, AABBTest). **Mass deferred to VP-12.**
- ✅ **VP-9** — `engine/dynamic_tree.ts` (commit c2c5e08). Full BVH: node pool,
  create/destroy/move/enlarge, query, raycast, rebuild (SAH), validate. Public
  surface: `class DynamicTree`, `RayCastInput`, `TreeStats`, query/raycast
  callbacks `(proxyId, userData:number)=>…`. 22 tests porting all 8
  `test_dynamic_tree.c` cases. Leaf — no `state.ts`/`install.ts` coupling.
- ✅ **VP-10** — `engine/broad_phase.ts` (commit 83a713f). `BroadPhase` over three
  `DynamicTree`s (by numeric body type); proxy key `(id<<2)|type` (= box2d
  `B2_PROXY_KEY`); move buffer (`moveArray` + a `Set` dedup); `pairSet`
  (`Set<number>`, pair key `min*2^22+max`); `createProxy/destroyProxy/moveProxy/
enlargeProxy/updatePairs(cb)/removePair/rebuildTrees`. Static proxies never
  buffer; moving proxies query the static tree (→ dynamic-static pairs, no
  static-static); canonical lower-key ordering avoids double-emitting
  dynamic-dynamic pairs. **Contact creation is M3** — `updatePairs` only emits
  candidate `(shapeA, shapeB)` pairs. `PhysicsState.broadPhase` added. 31 tests.
  - Deferred: `forcePairCreation` for static `invokeContactCreation` → VP-11/M3.
- ✅ **VP-11** — `systems/{shape_lifecycle,material_filter_sync,shape_pose_sync}.ts`
  (e216999, cd62e63, 4a67d03). `PhysicsShapeLifecycle` (query
  `{all:[{any:geoms},{parent:Body}]}`): enter builds the `InternalShape` from the
  geometry component (components→engine boundary), sets local pose from
  `ShapePosition`/`ShapeRotation`, computes the **world** AABB via
  `computeAABB(geom, mul(bodyXf, localXf))` (the cross-ticket contract) + fat AABB
  (`b2ComputeShapeMargin`/`b2UpdateShapeAABBs`), links into the body shape list
  (`b2CreateShape` headShape manipulation), inserts a broad-phase proxy, marks
  `massDirty`. Chains expand 1:N via `chainShapeByEntity`. exit is idempotent;
  update(geom) rebuilds + refits; update(ChildOf) reparents between bodies.
  `PhysicsMaterialFilterSync` + `PhysicsShapePoseSync` handle the update-driven
  syncs. Wired into `installPhysics` after `PhysicsBodyLifecycle`. `InternalShape`
  grew the VP-10/VP-11 deferred fields; `InternalBody` gained
  `shapeHead`/`shapeCount`/`massDirty`. 48 new tests (327 total).
  - **Deferred to M3:** contact teardown on shape removal/type-change; contact
    refilter on `CollisionFilter` change; dynamic `Sensor` toggle (needs contact
    teardown) — all documented in-code, mirroring `PhysicsBodyLifecycle.exit`.
  - **Review follow-ups (non-blocking):** (1) `InternalShape.entity` is the **eid
    (`number`)** while `InternalBody.entity` is an **`Entity`** — reconcile at M4
    (the events system resolves handles→entities to write event components).
    (2) `update(ChildOf)` reads `childOf.target.eid` via an `as unknown` cast;
    prefer the typed `e.parent(ChildOf)` path (as `enter` uses). Tested + working.
- ✅ **VP-12** — `engine/mass.ts` + `systems/mass_recompute.ts` (engine d348412,
  system e2c1173, parity fix 937dbe8). Mass integrals (`b2ComputeCircleMass`/
  `CapsuleMass`/`PolygonMass`) + `b2UpdateBodyMassData` (walk the body shape list,
  skip only zero-density shapes, mass-weighted CoM, parallel-axis inertia about the
  CoM, min/max extent). `PhysicsMassRecompute` runs last in `physics-pre`,
  recomputing every `massDirty` body. Mass fields written on `BodySim`. 19 tests
  (parity: ShapeMassTest, DeferredMassFlagSyncTest).
  - **Local-pose contract honoured:** geometry-local centroid transformed by the
    shape local pose; per-shape inertia is about the centroid (box2d convention)
    and 2D centroidal inertia is rotation-invariant, so only the parallel-axis
    shift to the body CoM is applied.
  - **Parity fix (937dbe8):** massless dynamic body keeps `invMass=0` (box2d),
    overturning the false VP-7 "default mass 1" note (see Settled Decisions).
  - **Deferred:** CoM-shift velocity adjustment (box2d body.c:629–633) omitted —
    no `BodyState` threaded through; wire if sleep/CoM-drift needs it (M3/M5).
- ✅ **VP-13** — `engine/manifold/*` + `engine/distance.ts` (13a 0f459c7, 13b
  5f75617, 13c 82253ee, 13d 300c7d1, 13e 24e2065). All twelve `b2Collide*`
  functions, `b2ClipPolygons`/`findMaxSeparation`, `b2SegmentDistance` + GJK
  `b2ShapeDistance`/`makeProxy`/`SimplexCache`. Shared `Manifold`/`ManifoldPoint`
  (`anchorA/B` relative to each body origin in world space; `separation`<0 =
  penetrating; stable 16-bit `id` = `B2_MAKE_ID`; fixed length-2 `points` +
  `pointCount`). Solver-only fields (impulses) deferred to M3. 47 tests (parity:
  SegmentDistanceTest, ShapeDistanceTest + 40 manifold geometric tests).
  - **Chain ghost-vertex caveat confirmed:** the chain-segment functions consume
    ghosts exactly as `ChainSegmentGeometry` stores them. VP-8's open-chain
    endpoint reflection matches box2d only when the chain continues straight; at
    a sharp-turn endpoint it diverges from box2d's actual/neighbour ghosts. Loops
    match exactly. Resolve at VP-11 (chain creation) — M4 `ChainSegmentShapeTest`.
- ✅ **VP-14** — `engine/narrow_phase.ts` dispatch table (commit 23900e9). Ports
  `contact.c`'s `s_registers[type][type]` table (`b2AddType`) + the dispatch core
  of `b2UpdateContact`: a 5×5 registry of `{ collideFn, primary }`, with the
  reverse pair reusing the same fn and flipping the result. `computeManifold(
shapeA, xfA, shapeB, xfB, cache)` returns a `Manifold` with normal A→B
  regardless of call order; unregistered pairs (segment–segment etc.) →
  `pointCount=0`. **Transform convention (updated in M2 bug-fix pass, commit
  69541ca):** callers now pass each shape's **body** world transform;
  `computeManifold` composes the shape world transform from the shape's stored
  local pose and returns anchors relative to each shape's **body origin** (matches
  box2d's solver contract). No contact record/persistence (VP-15/M3).
  - **Caveat (box2d-faithful):** symmetric pairs are SAT order-dependent, so M3
    must store **canonical** shape ordering in the contact record and always call
    `computeManifold` in that order (mirrors `b2CreateContact`).

### ✅ MILESTONE 2 COMPLETE

All seven tickets (VP-8…VP-14) done, reviewed, and **gate-green: 365 tests**,
`typecheck`/`test`/`lint`/`prettier` all clean (run from `lib/vecs-physics/`).
Engine collision plumbing — shapes/geometry, BVH, broad phase, manifolds +
distance, mass, narrow-phase dispatch — plus the shape-lifecycle/material/pose
systems, are in place. No solver yet (M3): contacts are _generated_, bodies still
pass through.

**M2 milestone DoD met:**

- Unit parity green: all 8 `test_dynamic_tree.c` tests (VP-9); `ShapeMassTest`
  (VP-12); `ShapeAABBTest`, `PointInShapeTest` (VP-8); `test_collision.c::AABBTest`
  (VP-8); `SegmentDistanceTest`, `ShapeDistanceTest` (VP-13).
- Contact generation (no solving): VP-13 manifolds + VP-14 dispatch.
- AABB queries internally consistent (VP-9 tree tests).
- Reparenting (VP-11), mass updates (`DeferredMassFlagSyncTest`, VP-12).
- Module boundaries clean (engine/ imports no components/systems; no
  cross-system imports); no stray TODO/console/.only/.skip markers.

**Carried into M3 (deferred work + contracts, collected for the solver team):**

- **Wire the collision step loop:** broad-phase pairs (VP-10 `updatePairs`) →
  `InternalContact` (VP-15) → `computeManifold` (VP-14) → island (VP-16) →
  solver (VP-17). The step orchestrator currently runs gravity-only (VP-7).
- **Contact-dependent deferrals from M2:** contact teardown on shape
  removal/type-change (VP-11 `exit`); contact refilter on `CollisionFilter`
  change (VP-11b); dynamic `Sensor` toggle (VP-11b); `forcePairCreation` for a
  static shape's `invokeContactCreation` (VP-10).
- **Canonical contact ordering (VP-14 caveat):** M3 must store shapes in
  canonical (type-ordered) order in `InternalContact` and always call
  `computeManifold` in that order; persist the `SimplexCache` per contact.
- **`transferBody` flags seeding** (M1 review) — wire `MotionLocks`/bullet bits
  when those land; the awake-state lock/`allowFastRotation` bits belong there.
- **Pre-M3 eng review still required:** TGS vs PGS, CCD scope (PLAN → _Open
  Questions_) — settle before VP-17 (solver).

**Carried into M4:** reconcile `InternalShape.entity` (eid) vs
`InternalBody.entity` (`Entity`) in the events system; kinematic accept-input /
drop-output asymmetry (M1 review); open-chain ghost-vertex fidelity vs box2d
(`ChainSegmentShapeTest`).

**Carried into M5:** CoM-shift velocity adjustment in `b2UpdateBodyMassData`
(VP-12) if sleep/CoM-drift needs it.

## M2 post-milestone bug-fix pass (architecture review)

A review of M0–M2 filed issues under `architecture/issues/`. Triaged and resolved;
the issues folder is now empty. **Six** review bugs were fixed (gate green, 394
tests); **three** re-filed reports were dismissed as already-tracked M4 deferrals.

**Fixed (commit per issue):**

- `fc47d76` — **static fat-AABB margin was 0**, box2d uses `speculativeDistance`
  ("cannot be zero due to TOI tolerance"). Margin helpers (`computeShapeMargin`/
  `updateShapeAABBs`/`fatAabbContainsTight`) consolidated into `engine/shape.ts`.
- `34fbe0f` — **degenerate capsule/segment/chain-segment shapes** now rejected at
  the components→engine boundary (creation skips the shape; geometry update keeps
  the old valid shape; chain expansion drops duplicate adjacent points), matching
  box2d `shape.c`. Manifolds are no longer relied on to tolerate zero-length input.
- `681443c` — **shape local-pose changes now mark the owning body `massDirty`**
  so CoM/inertia/extents recompute.
- `a3e6726` — **body teleports refit child shape proxies.** `PhysicsPoseSyncIn`
  walks the shape list, recomputes world AABBs, and `moveProxy`s with the box2d
  fat-AABB containment check. (Solver-movement refit still lands with M3.)
- `ab966ef` — **broad-phase proxies synced on body enable/disable/type change**
  (skip proxy for shapes on disabled bodies; create/destroy/migrate proxies across
  type trees). **Contact** teardown/creation on these transitions stays M3.
- `0213720` — **Material update dirties mass only when `density` actually
  changed** (old density captured before `_applyMaterial`; friction/restitution/
  etc. no longer trigger a needless full mass recompute). A companion meta-report
  correctly noted the naive comparison-after-write fix would have been inverted.
- `1685430` — **sensor shapes now contribute to body mass** (skip only
  `density === 0`), matching box2d `b2UpdateBodyMassData`. Overturns the false
  "skip sensors" note. _Settled: sensors are massless only when density is 0._
- `69541ca` — **manifold anchor convention fixed** (see VP-14 entry above):
  `computeManifold` takes body transforms and returns body-origin-relative
  anchors, so compound bodies with offset (`ShapePosition`/`ShapeRotation`) shapes
  get correct lever arms before the M3 solver consumes them.

**Dismissed (already tracked for M4 — re-filed reports, no M2 action):**

- _Open-chain ghost-vertex fidelity_ — already a `Carried into M4` item and an
  M4 `ChainSegmentShapeTest` gate; the suggested "use neighbour ghosts" fix is
  also questionable for open chains (no neighbours exist past the endpoints).
- _`InternalShape.entity` (eid) vs `InternalBody.entity` (`Entity`)_ — already a
  `Carried into M4` reconciliation owned by the events system; no runtime bug at
  M2, and the representation choice interacts with the handle-based event-delivery
  design (PLAN → _Entity-reference safety_).
- _Kinematic pose-sync accept-input/drop-output asymmetry_ — already a documented
  M1 follow-up; the **contract** (write kinematic poses back vs. reject kinematic
  velocity input) is deliberately left for M4 `PhysicsKinematicTargets`, so the
  re-filed "default to write-back" pre-empts an open decision.

### Cross-ticket contracts surfaced reviewing VP-8 (VP-10/11/12 must honour)

- **Local pose vs world transform.** VP-8's `makeXShape(…, xf)` constructors
  seed _both_ the local-pose fields (`localX/Y/cos/sin`) and the cached world
  AABB from a single `xf`. The `InternalShape.localX…` are the shape's pose
  **relative to the body origin** (from `ShapePosition`/`ShapeRotation`); the AABB
  must be the **world** AABB. So **VP-11** must: set local pose from the shape's
  pose components, then compute the world AABB as
  `computeAABB(geom, mul(bodyWorldTransform, localPose))` and overwrite the
  seeded cache. `computeAABB(geom, xf)` (geometry.ts) is general — it takes any
  transform — so the broad-phase refit (VP-10) and lifecycle (VP-11) use it
  directly with the composed world transform.
- **`localCentroid` is geometry-local, not body-local.** VP-8 stores the bare
  geometry centroid (local pose **not** applied). **VP-12** mass/parallel-axis
  must transform it by the local pose to get the body-local centroid.
- **`pointInPolygon`** uses a half-plane test (not GJK); exact for convex shapes
  and passes the golden test. May be swapped for `b2ShapeDistance` at VP-13e.
- **Chain ghost vertices for open chains** use reflection (`2a−b`) at the two
  endpoints. Plausible but **unverified against box2d's real chain construction**
  (`b2CreateChain`, which uses provided/neighbour ghost points). VP-11 (chain
  creation) and VP-13e (chain-segment manifolds) must verify fidelity; chain
  parity is an M4 gate (`ChainSegmentShapeTest`).

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
  kinematic body with user-set velocity _does_ move inside the engine and lands
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

## MILESTONE 3 — Contacts + sequential-impulse solver (🚧 IN PROGRESS)

**Tickets: VP-15 (split a/b), VP-16, VP-17, VP-18.** Architect: this pass.
Wires the collision step loop the engine has been missing — broad-phase pairs →
contacts (persistence + edges + touch events) → islands → TGS solver →
finalize-with-refit — and proves it with the `HelloWorld` parity gate.

Reference: box2d **v3.2.0** vendored under `box2d/` (gitignored; re-clone
`erincatto/box2d` if absent). M1/M2 ports match it; the overflow `_Overflow`
solver names, `b2MakeSoft`, `b2CreateContact`/`b2UpdateContact`, and the island
link/merge flow are all verified present at this version.

### Architect scoping decisions (refining the PLAN ticket list)

- **VP-15 split into 15a (data model + storage + lifecycle) and 15b (narrow-phase
  `updateContact`).** 15a is the shared-data-model foundation: it lands every
  record/field the rest of M3 reads (Manifold solver fields, `ContactSim`,
  `InternalContact` + edges + `ContactStorage`, `SolverSet.contactSims`, the
  graph-overflow touching-contact array + island storage on `PhysicsState`,
  `InternalBody` contact-list/island fields, `BodyState` dynamic flag). Landing
  the model up front lets 15b / VP-16 / VP-17 add **logic in their own files**
  with minimal shared-file contention, so they can run in parallel.
- **VP-17 (solver) is implemented as ONE cohesive ticket by ONE agent**, not
  fanned across parallel agents. The PLAN says "subdivide along the eight stages",
  and the file _is_ organised stage-by-stage internally, but the stages share one
  `ContactConstraint`/`ContactConstraintPoint` scratch struct and one body-state
  contract; splitting that across parallel agents trades a small file for large
  integration risk. The integrate-velocities / integrate-positions stages already
  exist (VP-7, in `engine/step.ts`); VP-17 relocates them into `engine/solver.ts`
  as solver stages 2 & 5 alongside the new ones.
- **Constraint-graph coloring collapses to a single overflow color** (v1 has no
  coloring, exactly as box2d's `B2_FORCE_OVERFLOW` path). So `b2AddContactToGraph`
  / `b2RemoveContactFromGraph` reduce to push / swap-remove on one
  `state.graphContactSims` array; `b2GetContactSim` resolves "touching → graph
  array, non-touching → solver-set `contactSims`". A contact's location is tracked
  by `colorIndex` = `OVERFLOW_COLOR (0)` (touching) vs `NULL_INDEX` (non-touching),
  mirroring box2d so a future coloring pass is additive.
- **Islands are built in M3 (VP-16) but NOT consumed by the solver.** box2d's
  overflow solver iterates the contact array directly (reading body states by
  index), so islands are not needed for `HelloWorld` correctness; they exist in M3
  to keep the contact touch-begin/end flow faithful (it calls `b2LinkContact` /
  `b2UnlinkContact`) and to seat the structure sleep needs. **Island split is M5**
  (`b2UnlinkContact` only increments `constraintRemoveCount`).
- **Per-step body-index refresh, not cached.** box2d's `b2CollideTask` re-sets each
  contact's `bodySimIndexA/B` + `invMass*/invI*` every step during the narrow phase
  (so they never go stale across body swap-pops). We do the same in the collide
  loop (VP-18) rather than caching at graph-add time — same result, no staleness.
- **Contact recycling (`b2_simRelativeTransformValid` path) is disabled** for v1
  (`recycleDistance = 0`), matching a clean port; the cached-transform fields are
  omitted from `ContactSim`. Pre-solve / custom-filter / sensor-contact paths are
  out of scope (sensors are M4).
- **ECS contact-event _publishing_ is M4 (VP-21).** M3 tracks began/stopped-touching
  state (drives island link/unlink) but does not yet write `ContactEvents`
  components. No begin/end event arrays are allocated in M3.
- **`world.contactSpeed` default 3.0** (verified `types.c b2DefaultWorldDef`) must
  be added to `ResolvedPhysicsOptions`/`PhysicsOptions` (used by the solve bias
  clamp). The other solver tunables (`contactHertz` 30, `contactDampingRatio` 10,
  `restitutionThreshold` 1.0, `maximumLinearSpeed` 400) already exist.
- **Broad-phase `pairSet` semantics move to the contact layer (VP-18).** box2d adds
  the pair key in `b2CreateContact` (only when a contact is actually created) and
  the broad-phase callback does the `b2ShouldShapesCollide` / same-body / sensor
  filtering. The current `BroadPhase.updatePairs` instead adds to `_pairSet` on
  emit and does no filtering. VP-18 makes `updatePairs` emit raw overlap candidates
  (in-batch dedup via a local set, no `_pairSet` add) and moves the filter +
  `_pairSet` add into the contact-create path — so `pairSet` membership means "a
  contact exists", filtered pairs are re-evaluated cheaply, and filter changes are
  picked up. (`removePair` on contact destroy already exists.)

### Dependency graph & execution waves

```
VP-15a (data model + storage + edges + create/destroy + filter helper)
   ├─> VP-15b  updateContact (narrow-phase refresh, warm-start carry, touch flags)
   ├─> VP-16   island.ts (create/destroy/merge/link/unlink) + body island hooks
   └─> VP-17   solver.ts (8 stages + b2MakeSoft + finalize-with-refit)
                              ↓ (all three)
                         VP-18  engineStep wiring (collide + solve) + broad-phase
                                pairSet fix + HelloWorld gate + scenarios
```

- **Wave 1:** VP-15a (foundation; everything depends on it).
- **Wave 2 (parallel, separate worktrees):** VP-15b, VP-16, VP-17 — disjoint files
  (`contact.ts` update fn / `island.ts`+`solver_set.ts` hooks / `solver.ts`).
- **Wave 3:** VP-18 — integration + the milestone gate.

### Status by ticket

_(updated as tickets land)_

#### ✅ VP-16 — `engine/island.ts` + body-island hooks

`src/engine/island.ts` (NEW): `InternalIsland` / `ContactLink` / `IslandStorage`
plus `createIsland` / `destroyIsland` / `mergeIslands` / `addContactToIsland` /
`linkContact` / `unlinkContact` / `createIslandForBody` / `removeBodyFromIsland`.
`state.ts` gains `islands: IslandStorage` (replacing the VP-15a TODO).
`solver_set.ts` `createBody`/`destroyBody` now take `state` and wire the island
hooks. `contact.ts` `destroyContact` now calls `unlinkContact` when touching.
12 new island tests; 423 total. Gate green (typecheck/test/lint/prettier).

box2d lines mirrored:

- `createIsland` ← `b2CreateIsland` (island.c:15); `destroyIsland` ←
  `b2DestroyIsland` (island.c:48, **skipping the `splitIslandId` reset** — no
  split in M3); `mergeIslands` ← `b2MergeIslands` (island.c:82, keep-bigger,
  body + contact-link migration; **joints dropped**); `addContactToIsland` ←
  `b2AddContactToIsland` (island.c:174); `linkContact` ← `b2LinkContact`
  (island.c:194, **wake-sleeping-set logic 207-217 skipped** — no sleep);
  `unlinkContact` ← `b2UnlinkContact` (island.c:235, **no split**, only
  `constraintRemoveCount += 1`).
- `createIslandForBody` ← `b2CreateIslandForBody` (body.c:106);
  `removeBodyFromIsland` ← `b2RemoveBodyFromIsland` (body.c:119, empty-island →
  destroy, asserts no contacts). The `createBody` island gate mirrors
  `b2CreateBody` body.c:317-320 (`setId >= b2_awakeSet`), narrowed in M3 to
  "awake set AND non-static" (only the awake set is non-disabled/non-static).
- `destroyContact`'s `b2UnlinkContact` call mirrors `b2DestroyContact`
  (contact.c:473-476): after the edge unlink, before the graph removal.

Decisions / deferrals:

- **Islands are BUILT but NOT consumed by the solver in M3** (overflow solver
  iterates the contact array directly). **Island SPLIT deferred to M5**:
  `b2SplitIsland`/`b2SplitIslandTask` are NOT ported; `unlinkContact` only bumps
  `constraintRemoveCount`. **No joints in v1** (`b2Island.joints`/`b2JointLink`
  and the joint migration dropped). **No sleep** — `linkContact`'s wake logic
  skipped.
- **`createBody`/`destroyBody` signature changed**: first param is now
  `state: PhysicsState` (was `storage: BodyStorage`); needed because the island
  hooks read `state.islands`/`state.solverSets`, matching box2d's
  `b2CreateBody(world, …)`. `transferBody` is unchanged (still takes
  `BodyStorage`). Callers updated: `systems/lifecycle.ts` (enter/exit) and the
  test files `tests/engine/{solver_set,contact,step}.test.ts` (converted to build
  a `PhysicsState`).
- **`destroyBody` assumes a singleton island** (callers must have torn down the
  body's contacts first). Full contact teardown on body destroy is VP-18; the
  body-lifecycle `exit` path destroys bodies with no contacts, so the
  singleton-island case is what M3 exercises. `removeBodyFromIsland` throws if an
  emptied island still has contacts (mirrors box2d's empty-island assert).
- Island id allocation reuses a plain `IdPool<Handle>` in `IslandStorage` (no new
  branded handle), matching how `ContactStorage` uses a generic pool. The body
  id pushed into an island is recovered from `BodySim.bodyId` (the sim
  back-pointer) since `InternalBody` does not store its own handle index.

#### ✅ VP-17 — `engine/solver.ts` — the TGS soft-step constraint solver

Ports box2d v3.2.0's eight-stage solver restricted to the **single overflow
color**: the stages iterate `state.graphContactSims` directly and the awake
set's `bodyStates` (no island consumption). Exports `makeSoft`,
`makeStepContext`, `solve`, `StepContext`, `Softness`, the constraint types,
and the individual stages. 12 new tests (`tests/engine/solver.test.ts`); 423
total; gate green (typecheck/test/lint/prettier from `lib/vecs-physics/`).

- **`b2MakeSoft` ported VERBATIM** (solver.h:239), including the `hertz === 0`
  early return; a test pins `massScale + impulseScale ≈ 1` for non-zero hertz.
- **Each `_Overflow` stage ported verbatim** over the overflow color:
  `b2PrepareContacts` (contact_solver.c:24), `b2WarmStartContacts` (162),
  `b2SolveContacts` (239, with the `useBias` speculative/soft bias and the
  `-contactSpeed` clamp), `b2ApplyRestitution` (410), `b2StoreImpulses` (516).
  The integrate-velocities (solver.c:65) / integrate-positions (solver.c:113)
  stages are reproduced as solver stages 2 & 5 — same math as `step.ts` (VP-7).
- **Stage order** (solver.c:1038-1045/1521, physics_world.c b2Solve):
  prepare (once) → per sub-step {integrateVelocities, warmStart, solve(bias),
  integratePositions, relax=solve(no-bias)} → restitution (once) →
  storeImpulses (once).
- **Identity-static-state + `DYNAMIC_FLAG` write-back gate:** a module-level
  `b2_identityBodyState` stands in for static/null bodies (base-1 index 0 →
  base-0 `NULL_INDEX`); a stage writes velocity back to a state only when
  `state.flags & DYNAMIC_FLAG` (box2d's `b2_dynamicFlag`), so the shared dummy
  is never mutated and static bodies are untouched.
- **Finalize stays in the orchestrator.** `solve()` leaves the resolved
  velocities + accumulated delta-pose on the awake `bodyStates`; folding
  delta-pose / writing transforms / move events / AABB refit is step.ts /
  VP-18. `solve()` early-returns on an empty awake set and does NOT edit
  `engine/step.ts`.
- No divergence from box2d. Tangent uses `rightPerp(normal)` and `b2CrossSV` /
  `b2Cross` are inlined as scalar math matching the vec2 helpers; verified
  sign-for-sign. Constraint scratch is allocated per `solve()` call and reused
  across all sub-steps (one `ContactConstraint` per `graphContactSims[i]`).

#### ✅ VP-18 — `engine/collide.ts` + `engineStep` wiring + HelloWorld gate

Wires the full collision step loop: `engineStep` (step.ts) now runs
`makeStepContext` → `broadPhase.updatePairs(pairCreateCallback)` → `collide` →
`solve` → `finalizeBodies(with refit)`, mirroring box2d's `b2World_Step` →
`b2Collide` → `b2Solve` → `b2FinalizeBodiesTask`. 5 new tests (HelloWorld gate +
4 scenarios across `hello_world.test.ts` / `contacts.test.ts`); **450 total**;
gate green (typecheck/test/lint/prettier from `lib/vecs-physics/`).

**HelloWorld parity gate (M3 DoD) PASSES** — measured final
`x = -0.00908` (|x| < 0.01), `y = 0.99991` (|y − 1| = 9e-5 < 0.01),
`angle = 0` (< 0.01). Tolerance NOT loosened.

box2d lines mirrored:

- `collide` ← `b2Collide` (physics_world.c:610-815): gather all contact sims
  (overflow graph color + awake-set non-touching) → per-contact update →
  serial state-change loop. Single-threaded — the parallel-for and per-worker
  `contactStateBitSet` collapse to a serial pass + a `Set<number>` of contact
  ids (stable across array moves; iterated in gather order = deterministic).
- per-contact update ← `b2CollideTask` (physics_world.c:445-578): fat-AABB
  overlap → `SIM_DISJOINT`; else refresh `bodySimIndexA/B` + `invMass*/invI*`
  every step, build body transforms + `centerOffset = rotate(q, localCenter)`,
  `updateContact`, started/stopped flags, `mp.baseSeparation = mp.separation`.
  **Recycling block (483-538) skipped** (recycleDistance = 0, v1); **bullet/
  isFast nudge (565-576) skipped** (M5 CCD).
- state-change loop ← `b2Collide`:697-808: `SIM_DISJOINT → destroyContact`;
  `SIM_STARTED_TOUCHING →` set `CONTACT_TOUCHING_FLAG`, `linkContact`, re-fetch
  sim by `localIndex`, `addContactToGraph`, then `_removeNonTouchingContact`
  (link-first / add-before-remove order kept); `SIM_STOPPED_TOUCHING →`
  `unlinkContact`, `_addNonTouchingContact`, then `removeContactFromGraph`.
- `_addNonTouchingContact` ← `b2AddNonTouchingContact` (physics_world.c:583);
  `_removeNonTouchingContact` ← `b2RemoveNonTouchingContact` (594), awake set.
- `makePairCreateCallback` ← `b2PairQueryCallback` shape filtering
  (broad_phase.c:243-270): same-body skip, sensor skip (M4), `shouldShapesCollide`,
  then `createContact` (which does `canCollide` + canonical order + `addPair`).
- `finalizeBodies` AABB refit ← `b2FinalizeBodiesTask` shape loop
  (solver.c:686-732): walk `shapeHead`/`nextShape`, `updateShapeAABBs`, and
  `enlargeProxy` when the new tight AABB escapes the old fat AABB. Sleep timer
  (638-684) and isFast/CCD (688-728) skipped (M5).

Decisions / deviations:

- **Broad-phase `pairSet` semantics moved to the contact layer.**
  `BroadPhase.updatePairs` no longer adds to `_pairSet` on emit and no longer
  filters by shape; it emits raw OVERLAP candidates (keeping self-skip,
  both-moving dedup, and the `_pairSet.has` "contact exists" skip) and de-dups
  two moved proxies hitting the same target within one call via a LOCAL
  `Set<number>`. `_pairSet` membership now means "a contact exists", maintained
  by `createContact`/`destroyContact` (`addPair`/`removePair`). Two VP-10
  broad-phase tests updated to call `bp.addPair(...)` to simulate the contact
  layer. (PLAN → Settled already records this decision.)
- **Refit rule lives in one place.** Extracted `refitBodyShapeProxies` into
  `engine/shape.ts` with a `"move" | "enlarge"` mode; `pose_sync_in.ts`
  (teleport → MOVE proxy, `b2Body_SetTransform`) and `finalizeBodies`
  (per-step → ENLARGE proxy, `b2FinalizeBodiesTask`) both call it. The
  move-vs-enlarge distinction is box2d-faithful.
- **`integrateVelocities`/`integratePositions` removed from `step.ts`** — the
  solver (VP-17) owns them as stages 2 & 5. `finalizeBodies` kept + extended
  with the AABB refit; `engineStep` early-returns on `dt <= 0`. Empty-awake /
  no-contact cases handled by `solve`'s and `collide`'s own early returns.
- Scenarios (`contacts.test.ts`): a dropped box rests in a 0.9–1.1 band and
  stays within 0.02 over 240 extra steps; a restitution-1 body rebounds with
  ~88% of its impact speed (impact −4.5 → rebound +3.96); a 2-box stack settles
  with centre-separation ≈ 2 (top does not sink through) and near-zero spin.

**MILESTONE 3 COMPLETE** — contacts + TGS solver wired; HelloWorld parity gate
green; 450 tests. M4 deferrals unchanged (begin/end contact events VP-21,
sensors). M5: contact recycling, CCD/isFast, sleep, island split.
