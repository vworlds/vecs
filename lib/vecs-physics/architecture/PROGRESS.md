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
    (`number`)** while `InternalBody.entity` is an **`Entity`** — reconcile at M4.
    **✅ RESOLVED VP-21b**: `state.shapeEntityByEid` Map bridges the gap; no structural
    change to `InternalShape` or engine layer needed.
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
`InternalBody.entity` (`Entity`) in the events system (**✅ RESOLVED VP-21b** — via
`state.shapeEntityByEid` Map and eid capture in raw event types; no structural change
to `InternalShape` needed); kinematic accept-input / drop-output asymmetry (M1 review)
(**✅ RESOLVED VP-20**); open-chain ghost-vertex fidelity vs box2d
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

- **Kinematic accept-input / drop-output asymmetry.** ✅ RESOLVED in VP-20.
  Architect decision: write kinematic poses back (box2d-faithful).
  `PhysicsPoseSyncOut` now writes back all awake non-static bodies (both dynamic
  and kinematic). The VP-6 "kinematic poses are user-owned" rule is superseded.
  `KinematicTargetPosition`/`KinematicTargetRotation` drive velocity each step;
  the solver integrates the kinematic body; `PhysicsPoseSyncOut` writes the
  resulting pose back to `Position`/`Rotation` components.
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

## MILESTONE 3 — Contacts + sequential-impulse solver (✅ COMPLETE)

**Tickets: VP-15 (split a/b), VP-16, VP-17, VP-18.** Architect: this pass.
Wires the collision step loop the engine has been missing — broad-phase pairs →
contacts (persistence + edges + touch events) → islands → TGS solver →
finalize-with-refit — and proves it with the `HelloWorld` parity gate.

Reference: box2d **v3.2.0** vendored under `box2d/` (gitignored; re-clone
`erincatto/box2d` exact commit 6e96697064e1ec09265c64fe953e5e056098c215 if absent).
M1/M2 ports match it; the overflow `_Overflow`
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

_(See M3 entries above for VP-15a/b, VP-16, VP-17, VP-18.)_

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

### MILESTONE 3 — architecture review (this pass)

All five tickets (VP-15a/b, VP-16, VP-17, VP-18) reviewed against the vendored
box2d v3.2.0 source. The contact split, narrow-phase update (CoM-relative anchors

- warm-start id matching), island link/merge/unlink, the eight TGS stages
  (verbatim, incl. `b2MakeSoft`), and the collide state-change ordering
  (link-first / add-before-remove, fresh `localIndex` re-resolution each iteration)
  are all faithful. Gate independently re-run green: typecheck/test/lint/prettier,
  **450 tests**. HelloWorld rests at `y = 0.99991` (target `|y − 1| < 0.01`).

**Carried into M5 (review finding — fat-AABB hysteresis):** `updateShapeAABBs`
(`engine/shape.ts`) **recomputes the fat AABB every step** (fat = tight + margin,
recentred), whereas box2d **holds** `shape->fatAABB` until the tight AABB escapes
it and only then resets it (`b2FinalizeBodiesTask`). Consequence: the cached
`shape.fatAabb*` (used by `collide`'s disjoint check) recentres each step while
the broad-phase **tree** proxy keeps the older, larger fat until `enlargeProxy`
fires. This is benign for v1 — the tree proxy lags **larger**, never smaller, so
no broad-phase pair is ever missed; a contact is only destroyed once the cached
fats genuinely separate (gap ≈ 2·margin, i.e. not touching), and any meaningful
re-approach moves the tight AABB out of the lagged fat, which re-buffers the proxy
and re-creates the contact. So it self-heals and the geometric outcome matches
(HelloWorld + the rest/stack/bounce scenarios all pass). It is a real divergence
from box2d's hysteresis, recorded here; the proper fix (hold the fat AABB across
steps, reset only on escape) is also a perf win and belongs in the M5 performance
pass. This is a pre-existing `updateShapeAABBs` property (VP-8/VP-11), not
introduced by M3; VP-18 only reuses it via the shared `refitBodyShapeProxies`.

### MILESTONE 3 — post-review bug-fix pass (architecture issues)

Four architecture-review issues filed under `architecture/issues/` and fixed in
order. All four committed on the `physics` branch; **485 tests**; gate green
(typecheck/test/lint/prettier from `lib/vecs-physics/`).

#### ✅ M3-contact-teardown-missing (commit 372e58e)

`engine/contact.ts` gained two exported helpers:

- `destroyBodyContacts(state, bodyId, wakeBodies)` — walks the `headContactKey`
  linked list and destroys every contact for a body (mirrors
  `b2DestroyBodyContacts`, body.c). Snapshot `nextKey` before calling
  `destroyContact` (which swap-removes sims and mutates edge pointers).
- `destroyBodyContactsForShape(state, bodyId, shapeIndex, wakeBodies)` — same
  walk, destroys only contacts involving a specific shape index.

`systems/shape_lifecycle.ts` updated:

- `destroyShape` now calls `destroyBodyContactsForShape` before freeing (mirrors
  `b2DestroyShapeInternal` → `b2DestroyBodyContacts` for the specific shape).
- `update(ChildOf)` reparent paths (chain and single-shape) destroy contacts
  before relinking the shape to a different body.
- `rebuildSingleShape` destroys contacts before mutating geometry (mirrors
  `b2ResetProxy`).

7 tests in `tests/lifecycle/contact_teardown.test.ts`.

- **Caveat:** `destroyContact` swap-removes `contactSims` and mutates
  `edges[].prevKey/nextKey`; the walk MUST snapshot `nextKey` before each call.

#### ✅ M3-body-type-enable-bookkeeping (commit 0c461b7)

`systems/lifecycle.ts` `update(Body)` fully ported against `b2Body_SetType` /
`b2Body_Enable` / `b2Body_Disable` / `b2SyncBodyFlags`:

- **Stage 1:** destroy all contacts (`destroyBodyContacts`) on type/enable change
  (unless body was already disabled — contacts don't exist for disabled bodies).
- **Stage 2–4:** disabled-body early paths, proxy teardown, island teardown
  (`removeBodyFromIsland`).
- **Stage 5–6:** update `record.type` and DYNAMIC_FLAG on `BodySim.flags`.
- **Stage 7:** `transferBody` to the target solver set.
- **Stage 8:** `massDirty` on type change.
- **Stage 9–10:** proxy management (create proxies on enable, destroy/migrate on
  disable/type change) and `createIslandForBody` for newly active non-static bodies.
- **Stage 11:** sync existing `bodyState.flags` for same-set type changes
  (dynamic↔kinematic both stay in `AWAKE_SET`; `transferBody` doesn't create a
  new `BodyState` in that case).

`systems/lifecycle.ts` `exit` now calls `destroyBodyContacts` before `destroyBody`
(mirrors `b2DestroyBody` contact teardown; satisfies the island singleton assert).

13 tests in `tests/lifecycle/body_type_enable_bookkeeping.test.ts`.

#### ✅ M3-live-contact-invalidation-missing (commit ba03ea4)

`systems/material_filter_sync.ts` `update(CollisionFilter)` now calls
`destroyBodyContactsForShape` **before** updating the filter bits, for both single
shapes and chain segments. Mirrors `b2Shape_SetFilter → b2ResetProxy`
(shape.c:1325-1347): all contacts for the shape are destroyed so stale pair keys
leave `pairSet` and the pair re-evaluates under the new filter next step.

`systems/shape_lifecycle.ts` `rebuildSingleShape` already destroys contacts
(covered by M3-contact-teardown-missing above), providing the geometry-update path.

4 tests in `tests/lifecycle/live_contact_invalidation.test.ts`.

#### ✅ M3-motion-locks-not-wired (commit 713b206)

`systems/lifecycle.ts` `enter(Body)` now reads `MotionLocks` and
`Body.allowFastRotation` to seed `LOCK_LINEAR_X | LOCK_LINEAR_Y | LOCK_ANGULAR_Z |
ALLOW_FAST_ROTATION` into `BodySim.flags` (and `BodyState.flags` when in
`AWAKE_SET`).

New `update(MotionLocks)` handler syncs lock-bit changes whenever `MotionLocks` is
modified (second `set`); clears old bits, applies new.

`update(Body)` includes an `allowFastRotation` fast-path: when only that flag
changes, the ALLOW_FAST_ROTATION bit is updated on sim + state and the handler
returns early (no contact teardown or set transfer needed).

**Vecs `update` semantics caveat:** `update()` fires on query entry OR modification.
A watched component _added_ to a body already in the query is NOT seen until the
next write. Tests reflect this: `MotionLocks` must be present at entity creation
for `enter` to read it; a subsequent `set` exercises the update handler.

11 tests in `tests/lifecycle/motion_locks.test.ts`.

#### ✅ M3-contact-state-change-order

`engine/collide.ts` processed touch-state changes in `Set` insertion (gather)
order — graph-array order then awake-set order. Box2D's `b2Collide`
(`physics_world.c:697-704`) instead peels the lowest set bit of a per-contact
bitset, i.e. processes in **ascending contact-id order**. Once sims have
swap-moved between the awake set and the graph the two orders diverge, and since
the state-change loop mutates `graphContactSims` (and the solver iterates it in
array order) the resulting constraint-solve order drifted from Box2D. Fixed by
sorting the changed-contact ids ascending before the apply loop
(`[...stateChanged].sort((a, b) => a - b)`). Single-run behaviour was already
deterministic; this aligns the order with Box2D. Regression test
(`tests/engine/collide_order.test.ts`) scrambles awake-set order via id reuse and
asserts the graph lands ascending (fails `[0,2,1]` before, passes `[0,1,2]` after).

#### ✅ M0-hitEventThreshold-default

`installPhysics` resolved `hitEventThreshold` to `10.0`; Box2D's
`b2DefaultWorldDef` (`types.c:16`) uses `1.0 * lengthUnits`. Every other world-def
default already matched Box2D — this was a lone 10× outlier (and the PLAN sketch
carried it too). Corrected to `1.0` in `install.ts` and the `PLAN.md`
`PhysicsOptions` sketch; extended `tests/lifecycle/install.test.ts` to pin the
resolved world-def defaults (the existing defaults test only covered component
classes, which is how this slipped through). Consumed by M4 hit events (VP-22).

#### ✅ M3-static-proxy-force-pair-creation

`BroadPhase.createProxy` never buffered static proxies (`forcePairCreation` was
the unimplemented VP-10 deferral), diverging from Box2D: `b2DefaultShapeDef` sets
`invokeContactCreation = true` (`types.c`), `b2CreateShape` passes
`invokeContactCreation || isSensor` into `b2CreateShapeProxy` (`shape.c:176`), and
`b2BroadPhase_CreateProxy` (`broad_phase.c:104-112`) buffers when `proxyType !=
b2_staticBody || forcePairCreation`. Added a `forcePairCreation` parameter to
`BroadPhase.createProxy` (default `false`; buffer when `bodyType !== STATIC_BODY
|| forcePairCreation`); shape creation (single + chain segments) and the
enable/type-change proxy recreation now pass `true`, matching `b2Body_Enable` /
`b2Body_SetType` (`shape.c:1307`). Resolves the VP-10 `forcePairCreation`
deferral (no longer carried forward).

**Scope note (corrected the issue's premise):** the issue claimed a static shape
added under a settled body produces _no contact_ until something moves. In the
current lifecycle that observable miss does **not** reproduce — a freshly created
static body is pose-synced on entry, and `PhysicsPoseSyncIn`'s teleport refit
calls `BroadPhase.moveProxy`, which buffers the proxy unconditionally (no static
gate), incidentally covering the gap. So the bug here is a **Box2D parity /
robustness** divergence in `createProxy`, not a live missed-contact crash:
relying on the teleport masking is fragile (it breaks the moment a static proxy is
created without a following move). Regression test lives at the broad-phase unit
level (`tests/engine/broad_phase.test.ts` → `createProxy forcePairCreation`),
where `createProxy`'s buffering is the deciding factor: with a drained dynamic
proxy, a forced static proxy emits the overlap pair (fails without the fix, passes
with it); the unforced default stays unbuffered.

M3 carried-forward items from this pass now resolved:

- contact teardown on shape removal/type-change ✅
- contact refilter on `CollisionFilter` change ✅
- `MotionLocks`/`allowFastRotation` flag seeding ✅
- `DYNAMIC_FLAG`, `massDirty`, island hooks on body type/enable changes ✅

**Carried forward unchanged (M4/M5):**

- Dynamic `Sensor` toggle (needs contact teardown + contact graph refilter; destroy
  - recreate shape is the safe path until M4 sensors land).
- Contact-event publishing (begin/end arrays) — M4 VP-21.
- Fat-AABB hysteresis fix — M5 performance pass.

## MILESTONE 4 — Forces, impulses, kinematic, events, sensors (✅ COMPLETE)

**Tickets: VP-19, VP-20, VP-21 (split a/b), VP-22.** Architect: this pass.
Wires the user-facing intent layer on top of the M3 solver: persistent forces,
accumulating impulses, kinematic-target drive, and the full event surface
(contact begin/end, hit, sensor) — plus the engine-side sensor overlap pass
(box2d's separate `b2OverlapSensors`, NOT contacts). M3 already left the hook
points marked (`collide.ts:266/289`, `CONTACT_ENABLE_CONTACT_EVENTS`,
`SIM_ENABLE_HIT_EVENT`); M4 fills them in and fans the raw arrays out to ECS
event components.

Reference: box2d **v3.2.0** vendored under `box2d/`.

### Architect scoping decisions (refining the PLAN ticket list)

- **Impulses are applied directly to body velocity at step start — no
  `pendingLinearImpulse`/`pendingAngularImpulse` Float32Arrays.** Box2D's
  `b2Body_ApplyLinearImpulse` adds `invMass * impulse` to `state->linearVelocity`
  immediately and wakes the body; there is no buffering in box2d. The PLAN sketch
  buffered into pre-sized Float32Arrays to defer application — but `PhysicsImpulseAccumulate`
  runs in `physics-pre` (before `PhysicsMassRecompute`, which is last in pre), so to
  use _fresh_ invMass the drained impulse must be applied at the top of `engineStep`
  (physics-step), after mass recompute. So: `PhysicsImpulseAccumulate` sums into a
  small per-body pending accumulator (`Map<bodyIndex, {x,y,angular,wake}>`, cleared each
  step) on `PhysicsState`; `engineStep` applies it to the awake `BodyState` velocity
  before `collide`/`solve`. Pre-sizing the accumulator is an M5 perf concern. The
  accumulation guarantee (3 `set(Impulse)` → summed) falls out of one inbox event per
  `set`. `impulseEntitiesThisStep: Set<eid>` is kept for `PhysicsImpulseZero`.
- **Forces re-gather every step (non-reactive).** `PhysicsForceGather` walks
  `world.filter({any:[Force,Torque]})` once per step, resolving the target body by the
  immediate-parent rule (`{up:[ChildOf,[Body]]}` injection), and adds into
  `BodySim.forceX/forceY/torque`. `finalizeBodies` already zeroes force each step (VP-7),
  so next step re-accumulates fresh — matches box2d.
- **VP-21 split into VP-21a (engine) and VP-21b (publish system)** per the granularity
  note. **VP-21a**: contact begin/end event recording in `collide.ts` (+ `contact.ts`
  `destroyContact` end-event), the raw event arrays on `PhysicsState`, and the engine-side
  sensor overlap module `engine/sensor.ts` (`b2OverlapSensors` — double-buffered visitor
  lists, broad-phase query + `b2ShapeDistance` narrow check, begin/end via sorted
  two-finger merge) wired into `engineStep` + sensor registration in `shape_lifecycle`.
  **VP-21b**: `systems/events.ts` (`PhysicsEvents`) fans the raw arrays out to
  `ContactEvents`/`SensorEvents`/`HitEvents` components (clear-in-place, `modified` only
  on new events, three independent previously-touched sets).
- **Sensors are a separate overlap pass, not contacts** (box2d v3): `collide.ts:77`
  already skips sensor pairs in contact creation. `engine/sensor.ts` runs after the
  solver/finalize and queries the broad-phase trees directly.
- **VP-22 (hit events) reads the solver's existing manifold fields.** `ManifoldPoint`
  already carries `normalVelocity` + `totalNormalImpulse` (populated by VP-17). The
  hit-event scan (`b2ContactHitEvent`: approach speed > `hitEventThreshold`,
  `totalNormalImpulse > 0`) reads them post-solve and pushes to `contactHitEvents`.
- **Execution is sequential in the `physics` worktree.** M4's footprint is concentrated
  in shared files (`engine/state.ts`, `engine/step.ts`, `engine/collide.ts`,
  `systems/index.ts`), so parallel worktrees would collide on every ticket; the win is
  small. Each ticket lands as its own commit(s) with its PROGRESS status line.
- **`ChainSegmentShapeTest` is scoped to one-sided collision behaviour.** Box2D's test
  exercises C-API shape-type mutation (`b2Shape_SetChainSegment`, orphan chain segments,
  `b2Shape_GetParentChain`) that vecs-physics does not expose. The portable M4 gate is the
  physical property: a body rests on the **front** side of a `Chain` and is not stopped
  from the back (one-sided) — validating the M2 VP-13e ghost-vertex manifolds through the
  full pipeline. Verified at milestone close.

### Dependency graph & execution order

```
VP-19 forces+impulses ─┐
VP-20 kinematic targets ┤ (independent of each other)
                        ├─> VP-21a engine contact-events + sensor overlap
                        │        └─> VP-22 hit-event scan
                        │                  └─> VP-21b PhysicsEvents publish
                        └─> (closeout) M4 parity: chain one-sided, friction ramp,
                                       DeferredMassFlagSync, sensor_begin_end
```

- **VP-21b is last** — it consumes the contact/sensor/hit raw arrays all of
  21a + 22 populate. **VP-22 needs 21a's** `PhysicsState` event-array foundation.

### Status by ticket

_(updated as tickets land)_

#### ✅ VP-19 — `PhysicsForceGather` + `PhysicsImpulseAccumulate` + `PhysicsImpulseZero`

**Files:**

- `src/engine/state.ts` — added `pendingImpulses: Map<bodyIndex, {x,y,angular,wake}>` and
  `impulseEntitiesThisStep: Set<eid>` with doc comments referencing M4 scoping decision.
- `src/engine/step.ts` — added `applyPendingImpulses` helper called at the TOP of
  `engineStep` (after `PhysicsMassRecompute` has run, before `collide`). Also merged the
  `DYNAMIC_BODY` import from `body.js` with the existing `IS_SPEED_CAPPED`.
- `src/systems/forces.ts` (NEW) — `PhysicsForceGather`: non-reactive Filter walk of
  `{ any: [Force, Torque] }` every step; immediate-parent rule via `e.parent(ChildOf)`;
  accumulates into `BodySim.forceX/forceY/torque` (awake set only).
- `src/systems/impulse_accumulate.ts` (NEW) — `PhysicsImpulseAccumulate`: `onSet` hooks
  for `Impulse`/`AngularImpulse`; accumulates to `pendingImpulses` synchronously at each
  `set()` call; records eid in `impulseEntitiesThisStep`. System entity used for tagging.
- `src/systems/impulse_zero.ts` (NEW) — `PhysicsImpulseZero`: physics-post `.run()` walks
  `impulseEntitiesThisStep`, zeroes `imp.x/y` and `ai.value` via direct property write
  (no `entity.modified`), then clears the set.
- `src/systems/index.ts` — wired `installForceGather` and `installImpulseAccumulate` in
  physics-pre after `installPoseSyncIn`, before `installMassRecompute`; `installImpulseZero`
  in physics-post after `installPoseSyncOut`.
- `tests/forces/forces.test.ts` (NEW) — 10 tests.

**Box2D lines mirrored:**

- `PhysicsForceGather` ← `b2Body_ApplyForceToCenter` (body.c:964):
  `bodySim->force = b2Add(bodySim->force, force)` and `b2Body_ApplyTorque` (body.c:986):
  `bodySim->torque += torque`.
- `applyPendingImpulses` ← `b2Body_ApplyLinearImpulseToCenter` (body.c:1048):
  `state->linearVelocity = b2MulAdd(state->linearVelocity, invMass, impulse)` and
  `b2Body_ApplyAngularImpulse` (body.c:1077): `state->angularVelocity += invInertia * impulse`.

**Decisions / deviations:**

- **`onSet` hooks instead of `.update()` for impulse accumulation (PLAN divergence).**
  PLAN stated "each `set(Impulse,...)` fires one inbox event; summing across multiple sets
  in a frame is the accumulation guarantee" via `.update()` callbacks. This is incorrect:
  Vecs inbox events store a MUTABLE REFERENCE to the component; by drain time all events
  for the same component show the LAST `Object.assign`'d value. Three `set`s with x=1,2,3
  would all fire the callback with x=3 → sum = 9, not 6. `world.component(Impulse).onSet`
  fires SYNCHRONOUSLY inside `_notifyComponentSet`, called after each `Object.assign`,
  seeing the correct value at set-time. This is safe: the hook only mutates PhysicsState
  accumulators (no structural ECS mutations). PLAN.md → _PhysicsImpulseAccumulate_ carries
  the wrong assumption; NEXT ticket author should be aware.
- **`ImpulseZero` watcher test uses `.query({ any: [Impulse] })`** (not `.requires(Body)`).
  Vecs does NOT fire `.update()` when a component is ADDED to an entity already in a query
  (isUpdate=false in `_notifyComponentSet` skips `_notifyModified`). The watcher must
  match entities via the watched component so the entity enters at component-add time,
  triggering entry-time initialization.
- **Wake flag is a structural no-op until M5 (sleep).** Force gather and impulse accumulate
  carry `wake` structurally but `applyPendingImpulses` does not act on it (no sleeping set
  exists). Mirrors `b2Body_ApplyForceToCenter` body.c:933-936 wake guard. Carried into M5.
- **`applyPendingImpulses` skips non-AWAKE and non-DYNAMIC bodies.** Mirrors box2d's
  `body->type != b2_dynamicBody || body->setIndex == b2_disabledSet` early return.

**Tests:** 10 new tests in `tests/forces/forces.test.ts`. **498 tests total** (was 488).
Gate green: typecheck/test/lint/prettier all clean from `lib/vecs-physics/`.

#### ✅ VP-20 — `PhysicsKinematicTargets` + kinematic write-back in `PhysicsPoseSyncOut`

**Files:**

- `src/systems/kinematic.ts` (NEW) — `PhysicsKinematicTargets`: non-reactive filter scan of
  `{ any: [KinematicTargetPosition, KinematicTargetRotation] }` every step; skips non-kinematic
  and non-awake bodies; sets `bState.vx/vy` and `bState.omega` to drive toward the target.
- `src/systems/pose_sync_out.ts` — updated to write back both dynamic AND kinematic bodies
  (was dynamic-only; changed `record.type !== DYNAMIC_BODY` guard to `=== STATIC_BODY`).
  Updated header comment explains the VP-20 architect decision.
- `src/systems/index.ts` — wired `installKinematicTargets` in physics-pre AFTER
  `installPoseSyncIn` and BEFORE `installForceGather`; updated phase-order comment.
- `tests/kinematic/kinematic_targets.test.ts` (NEW) — 15 tests.
- `tests/lifecycle/pose_sync.test.ts` — updated "does not write back a kinematic body"
  test to assert kinematic bodies ARE written back (renamed and inverted assertion).

**Box2D lines mirrored:**

- `PhysicsKinematicTargets` ← `b2Body_SetTargetTransform` (body.c:831-887):
  - `dx = target.x − sim.transformX` (origin form; equivalent to box2d's CoM form — see below)
  - `v = dx * invDt` ← `linearVelocity = b2MulSV(invTimeStep, b2Sub(center2, center1))` [body.c:857]
  - `dAngle = relativeAngle(currentRot, targetRot)` ← `b2RelativeAngle(q1, q2)` [body.c:863]
  - `omega = dAngle * invDt` ← `angularVelocity = invTimeStep * deltaAngle` [body.c:864/886]

**Kinematic-asymmetry resolution (M1 review follow-up):** The VP-6 M1 asymmetry
("kinematic accept-input / drop-output") is resolved in VP-20. Architect decision:
**write kinematic poses back** (box2d-faithful). `PhysicsPoseSyncOut` now writes
back any awake non-static body. The VP-6 "kinematic poses are user-owned" rule is
superseded. The VP-6 pose_sync test asserting kinematic is NOT written back was
updated to assert the opposite (renamed, assertion inverted).

**Decisions / deviations:**

- **Linear velocity is computed from the body ORIGIN — equivalent to box2d's CoM
  form, NOT a deviation (architect review correction).** `b2Body_SetTargetTransform`
  (body.c:854-857) computes `center2 = b2TransformPoint(target, sim->localCenter)` and
  drives the CoM there. But `b2UpdateBodyMassData` zeroes `localCenter` for every
  non-dynamic body (body.c:528-533; our `mass.ts:424-433`), so a **kinematic body's CoM
  always coincides with its origin** (`localCenter ≡ 0`). The only bodies this system
  drives are kinematic, so `center2 = target origin` and `center1 = sim origin`, making
  `v = (target − origin)/dt` byte-for-byte box2d's calculation. The origin form just
  skips a needless mass-data round-trip. (The earlier VP-20 note labelled this a deviation;
  it is not — corrected here and in the `kinematic.ts` header.)
- **Angular cap applies:** the solver's `MAX_ROTATION = π/4` cap (per full step) limits
  how far a kinematic body can rotate per step; large angular targets take multiple steps
  to converge. This is not a deviation — it is the same cap that applies to dynamic
  bodies in `b2IntegratePositionsTask`. Tests reflect this (step(3) for π/2 target).
- **Wake flag is a structural no-op until M5 (sleep).** Both `KinematicTargetPosition.wake`
  and `KinematicTargetRotation.wake` are carried structurally but the system does not act
  on them (no sleeping set exists). Mirrors the forces.ts pattern.

**Tests:** 15 new tests in `tests/kinematic/kinematic_targets.test.ts`. **513 tests total** (was 498).
Gate green: typecheck/test/lint/prettier all clean from `lib/vecs-physics/`.

#### ✅ VP-21a — raw contact begin/end event recording (engine half)

**Files:**

- `src/engine/state.ts` — added `ContactTouchEvent` interface (engine-internal, uses base
  `Handle` not branded `ShapeHandle` — branding is an API-boundary guard, not useful inside
  the engine) and two `readonly` arrays: `contactBeginEvents: ContactTouchEvent[]` and
  `contactEndEvents: ContactTouchEvent[]` with doc comments referencing box2d's
  `world->contactBeginEvents`/`contactEndEvents` and the VP-21b consumer.
- `src/engine/step.ts` — clears `contactBeginEvents.length = 0` and `contactEndEvents.length = 0`
  at the TOP of `engineStep` (alongside `bodyMoveEvents.length = 0`), mirroring box2d's
  `b2World_Step` which clears event arrays before running `b2Collide`.
- `src/engine/collide.ts` — filled the two M4 hook points:
  - `SIM_STARTED_TOUCHING` branch: when `CONTACT_ENABLE_CONTACT_EVENTS` is set, push to
    `state.contactBeginEvents`. Added `_makeContactTouchEvent` helper (builds handles from
    `contact.shapeIdA/shapeIdB` + `state.shapes.idPool.generationOf`).
  - `SIM_STOPPED_TOUCHING` branch: when `CONTACT_ENABLE_CONTACT_EVENTS` is set, push to
    `state.contactEndEvents` BEFORE `unlinkContact`. Note: the SIM_DISJOINT branch calls
    `destroyContact` which emits the end event itself — the collide `SIM_DISJOINT` branch
    does NOT also emit (no double-emit).
- `src/engine/contact.ts` — filled the M4 hook in `destroyContact`: when the contact has
  `CONTACT_TOUCHING_FLAG` AND `CONTACT_ENABLE_CONTACT_EVENTS`, push to `state.contactEndEvents`.
  Mirrors `b2DestroyContact` (contact.c:400-422). This covers disjoint-destroy, shape removal,
  body destroy, and filter-change teardown paths.
- `tests/events/contact_begin_end.test.ts` (NEW) — 10 tests (7 world-level + 3 engine-level).

**Box2D lines mirrored:**

- Begin event: `b2Collide` (physics_world.c:749-753):
  `if ( flags & b2_contactEnableContactEvents ) b2Array_Push( world->contactBeginEvents, event )`
- End event (stopped-touching): `b2Collide` (physics_world.c:786-790):
  `if ( contact->flags & b2_contactEnableContactEvents ) b2Array_Push( world->contactEndEvents[...], event )`
- End event (teardown): `b2DestroyContact` (contact.c:400-422):
  `bool touching = ( flags & b2_contactTouchingFlag ) != 0; if ( touching && ( flags & b2_contactEnableContactEvents ) != 0 ) b2Array_Push( world->contactEndEvents[...], event )`

**Opt-in wiring finding:** `InternalShape.enableContactEvents` is **already wired** — no new
code needed. `shape_lifecycle.ts:342` sets `enableContactEvents: e.get(ContactEvents) !== undefined`
when building the `InternalShape` options, and `contact.ts:320-322` sets `CONTACT_ENABLE_CONTACT_EVENTS`
on the contact when either shape has `enableContactEvents = true`. The chain is complete:
`ContactEvents` component → `InternalShape.enableContactEvents` → `CONTACT_ENABLE_CONTACT_EVENTS`
flag on `InternalContact` → event emission in collide.ts/contact.ts.

**Decisions / deferrals:**

- **`ContactTouchEvent` uses `Handle` (not `ShapeHandle`).** The `ShapeHandle` brand is a
  TypeScript API-boundary guard; engine-internal events don't benefit from it and it requires
  `as unknown as ShapeHandle` casts. Using the base `Handle` type is cleaner and honest.
- **Double-buffer for body-teardown end events deferred to VP-21b.** Box2D uses two
  `contactEndEvents` arrays (double-buffer, physics_world.c:239-243/949-951) so that
  `b2Body_Destroy` end events (pushed between steps) survive until the user reads them.
  In vecs-physics, the body lifecycle exit runs in `physics-pre`, pushes the end event,
  then `engineStep` (physics-step) clears it before VP-21b (physics-post) can read it.
  The `destroyContact` push IS correct — verified by an engine-level test that calls
  `destroyContact` directly (bypassing the Vecs inbox-buffering timing). The double-buffer
  fix belongs in VP-21b when the full publish pipeline is designed.
  - **ARCHITECT RESOLUTION (binding on VP-21b) — ✅ IMPLEMENTED IN VP-21b:** do NOT add
    box2d's two-array double buffer. Instead **relocate the clearing**: remove the
    contact-event clear from `engineStep` and clear all ECS-bound event scratch arrays at
    the **end of `PhysicsEvents`** (physics-post), AFTER it publishes. Then the per-frame
    order is `physics-pre teardown → physics-step collide → physics-post publish → clear`,
    so events generated in physics-pre (lifecycle/filter-change teardown) and between frames
    (user `entity.destroy()` flushed at the next progress) accumulate and survive to the
    publish — achieving box2d's double-buffer _intent_ with a single array and one clear
    point. `bodyMoveEvents` stays cleared in `engineStep` (step-only; consumed by
    `PhysicsPoseSyncOut` earlier in physics-post). **IMPLEMENTED**: VP-21b removes the five
    event-array clears from `engineStep` and adds them at the end of `PhysicsEvents.run`.
    The teardown test (`physics_events.test.ts` — "destroy a touching body → end event
    next publish") exercises this path and would FAIL if the clear were still in engineStep.
- **No sensor events here.** `collide.ts:77` already skips sensor pairs at contact creation;
  sensor begin/end is VP-21c (`engine/sensor.ts`).

**Tests:** 10 new tests in `tests/events/contact_begin_end.test.ts`. **523 tests total** (was 513).
Gate green: typecheck/test/lint/prettier all clean from `lib/vecs-physics/`.

#### ✅ VP-21c — engine-side sensor overlap pass (`engine/sensor.ts`)

**Files:**

- `src/engine/sensor.ts` (NEW) — `VisitorRecord`, `SensorRecord`, `SensorStorage`
  (create/destroy with swap-remove + sensorIndex fixup), `makeShapeDistanceProxy`,
  `sensorQueryCallback`, `processSensorTask`, `overlapSensors`, `destroySensor`.
- `src/engine/state.ts` — added `SensorTouchEvent` interface (sensorShape + visitorShape
  handles, engine-internal); `sensors: SensorStorage`; `sensorBeginEvents` and
  `sensorEndEvents` raw arrays with doc-comments.
- `src/engine/broad_phase.ts` — added `BroadPhase.queryAll(aabb, maskBits, cb)`:
  queries all three trees (static, kinematic, dynamic) in order. Mirrors box2d
  sensor.c:191-193 (`b2DynamicTree_Query(trees + 0/1/2, ...)`).
- `src/engine/step.ts` — clears `sensorBeginEvents.length = 0` /
  `sensorEndEvents.length = 0` at the TOP of `engineStep`; calls `overlapSensors(state)`
  AFTER `finalizeBodies` (mirrors `b2OverlapSensors` position in `b2World_Step`).
- `src/systems/shape_lifecycle.ts` — sensor shapes registered in `SensorStorage`
  (`shape.sensorIndex = state.sensors.create(handle.index)`) on enter (single + chain);
  `destroySensor` called before proxy destroy on exit (emits end events for current
  overlaps). Added `import { destroySensor } from "../engine/sensor.js"`.
- `tests/events/sensor_begin_end.test.ts` (NEW) — 11 tests.

**box2d lines mirrored:**

- `VisitorRecord` ← `b2Visitor` (sensor.h); `SensorRecord` ← `b2Sensor` (sensor.h).
- `processSensorTask` ← `b2SensorTask` (sensor.c:135-237): swap overlaps1↔overlaps2,
  append hits (CCD, no-op), disabled/!enableSensorEvents early-exit, AABB tree query,
  sort + dedup overlaps2.
- `sensorQueryCallback` ← `b2SensorQueryCallback` (sensor.c:44-120): rejection rules
  in box2d order (self, enableSensorEvents, same-body, collision filter; custom filter
  skipped — not in v1).
- `overlapSensors` ← `b2OverlapSensors` (sensor.c:239-370): serial pass (no bitset),
  two-finger sorted merge of overlaps1 vs overlaps2 for begin/end events.
- `destroySensor` ← `b2DestroySensor` (sensor.c:372-409): emit end events for
  overlaps2, swap-remove, patch moved shape's sensorIndex.
- `makeShapeDistanceProxy` ← `b2MakeShapeDistanceProxy` (shape.c:1024-1045):
  circle→1pt, capsule→2pt, segment→2pt r=0, polygon→all verts, chainSegment→2pt r=0.
- Overlap check: `output.distance < 10.0 * FLT_EPSILON` (sensor.c:107).
- Sensor registration ← `b2CreateShape` sensor block (shape.c:~215-220).

**Opt-in / rejection rules confirmed in box2d (sensor.c:44-120):**

1. Skip self (`shapeId == sensorShapeId`).
2. Skip if `otherShape->enableSensorEvents == false` — requires opt-in on BOTH shapes.
3. Skip same-body (`otherShape->bodyId == sensorShape->bodyId`).
4. Skip collision-filter mismatch (`!b2ShouldShapesCollide`).
5. Custom filter: skipped (not in v1).
6. **No isSensor gate** — two sensors on different bodies detect each other as visitors.
   Confirmed by test: 2 begin events when two overlapping sensor circles overlap.

**`BroadPhase.queryAll` addition:** queries `_trees[0..2]` in order with the given
AABB + maskBits. Placed in a new "All-tree query" section before "Pair tracking".
Minimal — 6 lines of body.

**Deferrals:**

- `hits` (TOI queue for CCD) — always empty stub; CCD is M5.
  box2d sensor.c:157-164 merge path is present as a no-op loop.
- Multi-threading / worker bitsets — collapsed to a serial pass.
- Custom filter callback — not in v1.
- **`destroySensor` end-event timing — ✅ IMPLEMENTED IN VP-21b:** the ECS exit path
  (physics-pre) calls `destroySensor` which pushes to `sensorEndEvents`. This was the
  same double-buffer timing issue documented for VP-21a. VP-21b's clearing relocation
  (ARCHITECT RESOLUTION) fixes it: the five event arrays are now cleared at end-of-publish
  in `PhysicsEvents.run`, so teardown end-events generated in physics-pre survive to
  physics-post. Engine-level test still validates the `destroySensor` emit path directly.

**TestSensor parity:** PASSES. Box2d `ENSURE(beginCount == 1) / ENSURE(endCount == 1)`
— a bullet sensor (circle r=0.1, dynamic, vx=-20, no gravity) crossing a static wall
(box 0.5×10, enableSensorEvents on both sides) produces exactly one begin frame and
one end frame. Tolerance not loosened.

**Tests:** 11 new tests in `tests/events/sensor_begin_end.test.ts`. **534 tests total** (was 523).
Gate green: typecheck/test/lint/prettier all clean from `lib/vecs-physics/`.

#### ✅ VP-22 — engine-side hit event scan (`gatherHitEvents`)

**Files:**

- `src/engine/state.ts` — added `ContactHitEvent` interface (engine-internal; doc-comments reference
  box2d `b2ContactHitEvent` types.h / solver.c:1749-1789 and VP-21b consumer). Added
  `contactHitEvents: ContactHitEvent[]` readonly array with clearing comment referencing the
  VP-21a ARCHITECT RESOLUTION.
- `src/engine/solver.ts` — added `gatherHitEvents(state: PhysicsState)` export (placed after
  `solve` per the Stepdown Rule — high-level first, helpers below). Added `SIM_ENABLE_HIT_EVENT`
  and `ContactHitEvent` imports.
- `src/engine/step.ts` — clears `contactHitEvents.length = 0` at the TOP of `engineStep`
  (alongside the other event-array clears); imports and calls `gatherHitEvents(state)` after
  `solve(state, ctx)`, before `finalizeBodies`. Added `gatherHitEvents` to solver.ts import.
- `tests/events/hit_events.test.ts` (NEW) — 10 tests.

**box2d lines mirrored (solver.c:1725-1794):**

- `gatherHitEvents` ← `b2Solve` hit-events block (solver.c:1725-1794):
  - `approachSpeed = threshold` init (solver.c:1750) ← `let approachSpeed = threshold`
  - `approachSpeed = -mp->normalVelocity` (solver.c:1757) ← `const speed = -mp.normalVelocity`
  - `if ( approachSpeed > event.approachSpeed && mp->totalNormalImpulse > 0.0f )` (solver.c:1760)
    ← `if (speed > approachSpeed && mp.totalNormalImpulse > 0)`
  - `event.point = mp->clipPoint` (solver.c:1764) ← `pointX = mp.clipPoint.x; pointY = mp.clipPoint.y`
  - `event.normal = contactSim->manifold.normal` (solver.c:1773) ← `normalX = manifold.normal.x/y`
  - `b2Array_Push( world->contactHitEvents, event )` (solver.c:1788) ← `state.contactHitEvents.push(event)`
- `storeImpulses` (contact_solver.c:537-538) ← already present in VP-17 (writes
  `mp.normalVelocity = cp.relativeVelocity` and `mp.totalNormalImpulse`).

**`enableHitEvents` opt-in wiring finding (VERIFIED, no new code needed):**
`shape_lifecycle.ts:360` already sets `enableHitEvents: e.get(HitEvents) !== undefined` in
`readMaterialOpts`, applied to both single-shape (line 505) and chain-segment (line 401)
creation. `contact.ts:630` sets `SIM_ENABLE_HIT_EVENT` when
`shapeA.enableHitEvents || shapeB.enableHitEvents`. The full chain is:
`HitEvents` component → `InternalShape.enableHitEvents` → `SIM_ENABLE_HIT_EVENT` on `ContactSim`
→ `gatherHitEvents` scans only flagged contacts. No wiring change needed.

**Where the scan runs and why:**
`gatherHitEvents` runs in `engineStep` AFTER `solve(state, ctx)` and BEFORE `finalizeBodies`.
This mirrors box2d exactly: `b2Solve` emits hit events after `b2StoreImpulses_Overflow`
(solver.c:1705 → 1725) but before the refit-BVH block (solver.c:1801). In vecs-physics these
steps are separated across files (`solve` in solver.ts, refit in `finalizeBodies` in step.ts),
so the call is placed at the same logical position in the pipeline. The manifolds are stable
(storeImpulses has run) and body transforms are not yet advanced — the same window box2d uses.

**Decisions / deviations:**

- **`gatherHitEvents` iterates `state.graphContactSims` directly** (no bitset scan). box2d uses
  a per-contact bitset (`hitEventBitSet`, solver.c:1732-1793) set during the parallel constraint
  solve. vecs-physics is single-threaded and the overflow color owns all contacts in
  `graphContactSims`, so a simple loop with a `SIM_ENABLE_HIT_EVENT` flag check is equivalent.
  Not a semantic divergence — same contacts, same flag, same filter.
- **clipPoint note preserved from box2d** (solver.c:1763: "Using the clip point here is
  somewhat questionable"). Mirrored faithfully with a doc-comment. In v1 (no contact recycling)
  clipPoint is refreshed every step, so reliability is acceptable. Will degrade if recycling
  is re-enabled in M5.
- **`contactId` field omitted** from `ContactHitEvent`. box2d includes it as a `b2ContactId`
  in `b2ContactHitEvent` (types.h). vecs-physics does not expose contact ids in the public
  API; VP-21b (HitEvents component) does not need it, and omitting it keeps the type minimal.
  Deviation recorded here.
- **Clearing strategy — ✅ IMPLEMENTED IN VP-21b:** `contactHitEvents` clearing relocated
  from `engineStep` to end of `PhysicsEvents.run` per the ARCHITECT RESOLUTION. VP-21b
  consolidates all five event-array clears at end-of-publish.

**Tests:** 10 new tests in `tests/events/hit_events.test.ts`. **544 tests total** (was 534).
Gate green: typecheck/test/lint/prettier all clean from `lib/vecs-physics/`.

#### ✅ VP-21b — `systems/events.ts` — `PhysicsEvents` publish system

**Files changed:**

- `src/systems/events.ts` (NEW) — `installEvents`: `.run()` physics-post system.
  Three closure-local `prevTouched` Sets (contact/sensor/hit). For each raw event array:
  resolves shape entity eids via `state.shapeEntityByEid` (see below), publishes to
  `ContactEvents`/`SensorEvents`/`HitEvents` components with clear-in-place + modified
  only on new events + silent clear for previously-touched shapes with no events this step.
  Clears all five ECS-bound raw event arrays at end-of-run (clearing relocation). Lazy GC
  of `shapeEntityByEid` at end-of-run for freed shape entries.
- `src/engine/state.ts` — added `shapeEntityByEid: Map<number, Entity>` (the M4 reconcile
  item; see below). Added `entityEidA`/`entityEidB` to `ContactTouchEvent` and
  `ContactHitEvent`; `sensorEntityEid`/`visitorEntityEid` to `SensorTouchEvent`. Added
  `Entity` import from `@vworlds/vecs` (first engine-layer vecs type import; acceptable
  since state.ts already imported from `@vworlds/vecs` for `Singleton`/`World`).
- `src/engine/step.ts` — REMOVED the five event-array clears (`contactBeginEvents`,
  `contactEndEvents`, `sensorBeginEvents`, `sensorEndEvents`, `contactHitEvents`).
  `bodyMoveEvents.length = 0` stays (step-only, consumed by PoseSyncOut). Comment updated
  to reference the ARCHITECT RESOLUTION in PROGRESS.md.
- `src/engine/contact.ts` — `destroyContact` end-event emit updated to include
  `entityEidA`/`entityEidB` fields (captured from shape records BEFORE they are freed).
- `src/engine/collide.ts` — `_makeContactTouchEvent` updated to include
  `entityEidA`/`entityEidB` fields.
- `src/engine/sensor.ts` — all `sensorBeginEvents`/`sensorEndEvents` push sites updated
  via new `_makeSensorEvent` helper (captures `sensorEntityEid`/`visitorEntityEid` at
  emit time).
- `src/engine/solver.ts` — `gatherHitEvents` hit event updated to include
  `entityEidA`/`entityEidB` fields.
- `src/systems/shape_lifecycle.ts` — enter paths (single + chain) set
  `state.shapeEntityByEid.set(e.eid, e)` to register the Entity object; exit paths do NOT
  delete (lazy GC in PhysicsEvents). Chain enter also registers eid.
- `src/systems/index.ts` — wired `installEvents` in physics-post BETWEEN `installPoseSyncOut`
  and `installImpulseZero`. Updated phase-order comment.
- `tests/events/physics_events.test.ts` (NEW) — 11 new tests (6 functional areas).
- `tests/events/contact_begin_end.test.ts` — world-level tests migrated from raw-array
  assertions to ECS `ContactEvents` component assertions (clearing relocation makes raw
  arrays empty after `world.progress`). Engine-level destroyContact tests unchanged.
- `tests/events/sensor_begin_end.test.ts` — same migration: world-level tests now check
  `SensorEvents` components. Engine-level `destroySensor` tests unchanged.
- `tests/events/hit_events.test.ts` — fully rewritten to check `HitEvents` components
  instead of raw `state.contactHitEvents`.

**InternalShape.entity reconcile (M4 carried-into item — RESOLVED):**
`InternalShape.entity` is a plain `number` (eid); `InternalBody.entity` is an `Entity`.
The reconcile was deferred to M4. VP-21b resolves it WITHOUT changing `InternalShape.entity`
to `Entity` (engine module boundary: engine/ cannot import `Entity`). Instead:

- `state.shapeEntityByEid: Map<eid, Entity>` is added to `PhysicsState`. Populated in
  `PhysicsShapeLifecycle.enter`; lazily GC'd in `PhysicsEvents.run` (NOT in exit callback).
- Lazy GC is required because: the lifecycle exit fires in physics-pre (before PhysicsEvents
  in physics-post), so deleting from the map in exit would remove the Entity reference before
  PhysicsEvents can use it for teardown end-events. Lazy GC runs AFTER publishing, removing
  entries where `shapeByEntity.has(eid)` is false.
- Eids are ALSO captured in the raw event types (`entityEidA/B`, `sensorEntityEid/visitorEntityEid`)
  at emit time, because: (a) shape records are freed in physics-pre (same pass as the emit),
  so by physics-post `shapes.records[index]` is `undefined`; (b) `idPool.isValid` also returns
  false because the generation is bumped when the slot is freed. Using the captured eid
  bypasses both guards. The `isValid` check is still used as a stale-slot guard (if the
  eid is -1 or the slot was reused since emit, no entity will be in the map anyway).
- This is a clean resolution — no reconcile pass needed. Note for architect: this is the
  "carried-into-M4: reconcile InternalShape.entity vs InternalBody.entity" item from VP-11.

**ARCHITECT RESOLUTION — clearing relocation — ✅ IMPLEMENTED:**
Per the VP-21a ARCHITECT RESOLUTION: the five ECS-bound raw event arrays are cleared at the
END of `PhysicsEvents.run` (not in `engineStep`). `src/engine/step.ts` removes those five
clears; `src/systems/events.ts` adds them after publishing. The teardown end-event test
exercises this path. `bodyMoveEvents.length = 0` stays in `engineStep` (unchanged).

**Delivery semantics (per docs/events.md):**

- Contact: BOTH shapes receive if they have `ContactEvents`; `other` = the other shape entity.
- Sensor: ONLY the SENSOR shape receives `SensorEvents`; `other` = the visitor entity.
- Hit: BOTH shapes receive `HitEvents` if they have the component; A→B normal used for BOTH
  sides without flipping (box2d `b2ContactHitEvent` uses a single normal; documented in code).

**PLAN pseudocode divergences and confirmations:**

- PLAN pseudocode used `state.shapes[index].entity` as an Entity object directly. Actual
  code uses the eid from the captured-at-emit-time field + `state.shapeEntityByEid.get(eid)`.
  Functionally equivalent; uses the established map mechanism instead of storing Entity in
  InternalShape.
- PLAN's `state.eventsTouchedThisStep` was mentioned as a PhysicsState field. VP-21b uses
  closure-local `prevTouched` Sets per the ticket spec ("do not bloat PhysicsState").
- PLAN's `world.entity(eid)?.modified(ContactEvents)` → VP-21b uses `world.getEntity(eid)?.modified(...)`.
  Functionally the same — `world.getEntity(eid)` for a live entity returns the entity.

**Tests:** 11 new tests in `tests/events/physics_events.test.ts`. **556 tests total** (was 544).
Gate green: typecheck/test/lint/prettier all clean from `lib/vecs-physics/`.

#### ✅ M4 closeout parity — chain one-sided collision + friction ramp

**Files:**

- `tests/lifecycle/chain_collision.test.ts` (NEW) — 3 tests.
- `tests/lifecycle/friction_ramp.test.ts` (NEW) — 4 tests.

**Chain one-sided collision (`chain_collision.test.ts`):**
Ports the physical one-sided-collision property from `box2d/test/test_world.c::ChainSegmentShapeTest`
(lines 474-489). Box2D's C-API shape-type mutation is not ported (not exposed); the test covers
the portable physical property: a dynamic circle dropped onto a `Chain` ground rests on the front
(top) side and does not tunnel through; a circle starting below and moving up passes through the
back (behind the collision normal) unimpeded.

- **Loop chain used.** Points ordered right-to-left on the top edge so `rightPerp(edge) = (0,+1)`
  (upward-facing collision normal). Loop: `{5,0},{-5,0},{-5,-2},{5,-2}`. Loop chains use real
  neighbour ghost vertices — match box2d exactly.
- **One-sidedness confirmed:** a circle at y=−0.5 moving upward at 5 m/s (no gravity) passes
  THROUGH the back side of the chain and ends above y=0. The `offset < 0` check in
  `collideChainSegmentAndCircle` correctly returns an empty manifold. One-sided semantics HOLD.
- **Resting position:** after 120 steps at 1/60 the circle settles in the band 0.3 < y < 0.7
  (matching box2d's `circlePos.y > 0` assertion plus a tighter window). Stable over 240 further
  steps (< 0.05 m vertical drift).
- **Open-chain ghost-vertex divergence** (the `Carried into M4` item): the loop chain avoids
  the endpoint-reflection issue entirely. The open-chain endpoint ghost vertices (reflection:
  `2a−b`) are accurate for straight chains but may diverge from box2d's `b2CreateChain`
  behaviour at sharp endpoint turns. This remains **carried into M5** — the loop test confirms
  the chain-segment manifold pipeline works correctly end-to-end; open-chain endpoint behaviour
  at sharp turns is still unverified vs box2d. In-code comment at `makeChainSegments` is the
  authoritative tracking.

**Friction ramp (`friction_ramp.test.ts`):**
A static body at −20° (`Rotation.angle = −RAMP_ANGLE`) with a flat `Box` shape forms an inclined
surface. A dynamic box is placed just above the ramp surface.

- **High friction (0.6 on dynamic body):** μ_mix = sqrt(0.6 × 0.6) = 0.6; atan(0.6) ≈ 31° > 20°
  → static friction holds. After 120 steps the box stays within 1.5 m of its start-x and has
  near-zero speed (< 0.5 m/s). Stable over 180 further steps (< 0.2 m x-drift). ✅
- **Zero friction on dynamic body:** μ_mix = sqrt(0 × 0.6) = 0 → no friction. After 120 steps
  the box has slid > 2 m down the slope. ✅
- **Qualitative difference confirmed:** zero-friction box slides > 2 m; high-friction box moves
  < (zero-friction displacement − 1 m). Friction mixing is observable.

**`DeferredMassFlagSyncTest` confirmation:** `tests/lifecycle/mass_flag_sync.test.ts` fully covers
this test (VP-12, commit e2c1173 + parity fix 937dbe8). The file includes the golden test port
(`DeferredMassFlagSyncTest` describe block) plus 5 additional mass-recompute lifecycle tests.
No gap found — no new mass test needed.

**Tests:** 7 new tests. **563 tests total** (was 556).
Gate green: typecheck/test/lint/prettier all clean from `lib/vecs-physics/`.

### ✅ MILESTONE 4 COMPLETE

All M4 tickets done, reviewed against vendored box2d v3.2.0, and **gate-green: 563
tests** (50 files), `typecheck`/`test`/`lint`/`prettier` all clean from
`lib/vecs-physics/`. The user-facing intent + event layer now sits on the M3 solver:
persistent forces, accumulating impulses (`onSet` hooks), kinematic-target drive with
pose write-back, the full event surface (contact begin/end, hit, sensor), and box2d's
separate sensor-overlap pass.

**Ticket map (sequential, this worktree):** VP-19 (`df9e00c`) forces+impulses ·
VP-20 (`c27594f`) kinematic+kinematic write-back · VP-21a (`47ec5f1`) contact
begin/end recording · VP-21c (`2f449f9`) sensor overlap engine · VP-22 (`87814ae`)
hit-event scan · VP-21b (`7bb0f77`) PhysicsEvents publish + event-clearing relocation ·
M4 closeout (`f856227`) chain one-sided + friction ramp. Plus architect doc/nit
commits (`eb54a3e`, `df4b3a7`, `edda709`, `476fba2`, `88ed235`).

**M4 milestone DoD met:**

- **Parity gates green:** `sensor_begin_end` (`TestSensor`, VP-21c) — exactly one
  begin frame + one end frame; `chain_segment` one-sided collision (loop chain: front
  rests, back passes through) and `friction ramp` (μ=0.6 holds at 20°, μ=0 slides) at
  the milestone close; `DeferredMassFlagSyncTest` (`tests/lifecycle/mass_flag_sync.test.ts`,
  from VP-12).
- **Functional matrix (PLAN ~1404):** force persistence, multi-source force sum,
  immediate-parent rule, impulse accumulation, silent impulse zero, kinematic
  convergence + re-engage + tolerance, contact-event opt-in, empty-step-is-silent,
  sensor opt-in, hit-event threshold — all covered across `tests/{forces,kinematic,events}`.
- **Module boundaries clean:** `engine/` imports neither `components/` nor `systems/`;
  no cross-system imports; no stray `.only`/`.skip`/TODO markers.

**Architect review notes (deviations recorded, none open):**

- **Impulse accumulation uses `onSet` hooks, not `.update()`** — the one v1 exception to
  "systems, not hooks". Verified necessary: Vecs' system inbox stores a component
  **reference**, so multiple `set()`s in a frame all replay the final value (3 sets →
  9, not 6); `onSet` fires synchronously per set. Recorded in PLAN → _Settled Decisions_
  (supersedes the `.update()`-based prose in `PhysicsImpulseAccumulate`).
- **Event-array clearing relocated** (not box2d's two-array double buffer): all five
  ECS-bound raw arrays are cleared at the END of `PhysicsEvents` (physics-post) after
  publish, so physics-pre teardown end-events and between-frame `entity.destroy()` events
  survive to the publish. Single array, one clear point, box2d's double-buffer _intent_.
- **Kinematic linear velocity** is computed from the body origin — proven byte-for-byte
  equal to box2d's CoM form for the only bodies it drives (kinematic bodies always have
  `localCenter = 0`). NOT a deviation.
- **Sensors are a separate overlap pass** (box2d v3): `engine/sensor.ts` ports
  `b2OverlapSensors` (double-buffered visitor lists, broad-phase query + `b2ShapeDistance`,
  sorted two-finger merge). No `isSensor` gate in the query (sensors detect sensors,
  box2d-faithful). The `hits`/TOI queue is an empty stub (CCD is M5).

**Carried-into-M4 items now RESOLVED:**

- Kinematic accept-input / drop-output asymmetry → **write kinematic poses back** (VP-20).
- `InternalShape.entity` (eid) vs `InternalBody.entity` (`Entity`) → events resolve
  eid→`Entity` via the `state.shapeEntityByEid` bridge (populated at shape `enter`, GC'd
  after publish so destroyed-shape `Entity` references survive to delivery). No structural
  reconcile needed (VP-21b).

**Carried forward (unchanged):**

- **Open-chain ghost-vertex fidelity at sharp endpoints** (M2 caveat) — the loop-chain
  parity test confirms the chain-segment manifold pipeline end-to-end, but open-chain
  endpoint reflection (`2a−b`) vs box2d's `b2CreateChain` neighbour ghosts is still
  unverified at sharp turns. **M5.**
- **`wake` flag is a structural no-op** on Force/Torque/Impulse/Kinematic targets until
  **sleep (M5)** wires sleeping sets.
- **Fat-AABB hysteresis** (M3 review) — **M5 performance pass.**
- **Contact recycling, CCD/`isFast`, sleep, island split** — **M5.**
- **Dynamic `Sensor` MARKER toggle** (solid ↔ sensor at runtime) — **M5.** Needs
  contact teardown + `SensorStorage` create/destroy + mass/proxy invariants. Shape
  recreation (remove + re-add geometry) is the supported workaround until then.
  (Re-surfaced and re-tracked in the M4 architecture-review pass — the event-opt-in
  half of that same gap, runtime `ContactEvents`/`HitEvents`/`SensorEvents` add/remove,
  IS now handled by `PhysicsEventOptInSync`; only the marker toggle remains deferred.)

## MILESTONE 5 — Sleep + continuous CCD + debug validation + perf (✅ COMPLETE)

**Tickets: VP-23, VP-24, VP-25, VP-26.** Architect: this pass.
Closes the simulation loop: idle islands fall asleep (and wake on disturbance),
fast/bullet dynamic bodies stop tunnelling (CCD), invalid ECS structures warn once
in debug mode, and a profiling pass removes hot-path allocations (incl. the M3
fat-AABB hysteresis divergence). After M5 the only v1-excluded surface is the
explicitly-roadmapped one (ray/shape casts, AABB queries, joints, character movers).

Reference: box2d **v3.2.0** vendored under `box2d/` (gitignored; re-clone
`erincatto/box2d` at commit 6e96697064e1ec09265c64fe953e5e056098c215 if absent).
Baseline at M5 start: **569 tests / 51 files**, gate green
(typecheck/test/lint/prettier from `lib/vecs-physics/`).

### Box2D source map for M5 (verified this pass)

The PLAN _Package layout_ put CCD in `engine/ccd.ts` and sleep in `solver.ts`, but
the actual box2d functions are spread across files — recorded here so ticket authors
open the right source:

- **Sleep transition:** `b2TrySleepIsland` / `b2WakeSolverSet` / `b2MergeSolverSets`
  (`solver_set.c:155 / 35 / 417`); the per-step sleep loop that calls
  `b2TrySleepIsland` is in `b2Solve` (`solver.c:~2006`, `if (world->enableSleep)`).
- **Sleep accumulation:** `b2FinalizeBodiesTask` sleep block (`solver.c:556-684`) —
  `sleepVelocity`, `sleepTime += timeStep`, `awakeIslandBitSet`, and the
  `splitIslandId`/`splitSleepTime` selection (chosen here, executed later).
- **Island split:** `b2SplitIsland` / `b2SplitIslandTask` (`island.c:389 / 659`) —
  union-find DFS over the island's contact graph; runs after finalize when a sleepy
  island has `constraintRemoveCount > 0`.
- **CCD:** `b2ContinuousQueryCallback` / `b2SolveContinuous` / `b2BulletBodyTask`
  (`physics_world.c:181 / 379 / 1249`); the fast/bullet detection + dispatch is the
  `enableContinuous` branch of `b2FinalizeBodiesTask` (`solver.c:635-657`); the
  bullet stage runs after the main solve (`physics_world.c:1896-1968`).
- **Wake on touch:** `b2WakeBody` (`body.c:328`) is called from `b2Collide`'s contact
  begin path (`contact.c:508-509`) and from the force/impulse/teleport setters
  (`body.c:795/819/871/935/958/980/1011/1039/1068`).

`step.ts` already carries M5 hook-point comments at the exact insertion sites
(lines 49/112/133/153/160 in `finalizeBodies`) left by the VP-7/VP-18 authors.

### Architect scoping decisions (refining the PLAN ticket list)

- **VP-23 (Sleep + island split) is ONE cohesive ticket by ONE agent.** Sleep,
  island split, and the wake paths are a single tightly-coupled subsystem: the
  sleep block in finalize selects the split island, the split runs post-finalize,
  `b2TrySleepIsland` consumes the split result, and every wake path
  (`b2WakeBody`/`b2WakeSolverSet`) must round-trip the same sleeping-set bookkeeping.
  Splitting across agents trades a small file for large integration risk (same
  reasoning as VP-17). It touches `island.ts` (split), `solver_set.ts`
  (sleep/wake/merge + sleeping-set allocation past `FIRST_SLEEPING_SET`),
  `step.ts`/`solver.ts` (finalize sleep accumulation + post-solve sleep loop),
  `body.ts` (sleep fields + `b2WakeBody` + `enableSleep`/`isAwake` flags),
  `contact.ts` (wake-on-touch), and the `Sleep` component + `wake`-flag wiring in
  systems. **This is the milestone's critical path** — VP-24 and VP-26 build on it.
- **VP-23 also activates every `wake` flag** carried as a structural no-op since M4
  (`Force`/`Torque`/`Impulse`/`AngularImpulse`/`KinematicTarget*`). Until VP-23
  there was no sleeping set to wake into; now `applyPendingImpulses`, force gather,
  and kinematic drive must call `b2WakeBody` when `wake === true` and the body is
  asleep. Mirrors box2d's wake guards (`body.c:933-936` etc.).
- **VP-24 (CCD) ports the single-threaded bullet+fast path.** `engine/ccd.ts`
  (NEW) gets `solveContinuous` + the continuous query callback; `engine/distance.ts`
  grows `b2TimeOfImpact` (conservative advancement, `distance.c`) — the one genuinely
  new geometry primitive in M5. Fast (non-bullet) bodies TOI-resolve inline during
  finalize against the **static** tree; bullets are collected and resolved in a
  post-solve stage against static+kinematic+dynamic trees. `enableContinuous`
  defaults `true` (PLAN), but the **Unresolved Decisions** rule stands: the default
  may only stay `true` if CCD actually works — so VP-24 owns the
  `SetBulletDriftTest`/no-tunnel gate. Depends on VP-23 (shares the finalize loop;
  cleaner to layer CCD onto the settled sleep block than to merge two finalize
  rewrites).
- **VP-25 (PhysicsDebugValidation) is fully independent — runs in parallel from the
  start, in its own worktree.** New `systems/debug.ts` + a one-line debug-gated
  install hook + tests; reuses the existing `util/warn.ts` `WarnDedupe`. Validates
  the six codes in `docs/debug-validation.md` (`shape-without-parent-body`,
  `dynamic-body-without-density`, `chain-too-few-points`, `polygon-invalid`,
  `shape-position-on-body`, `position-on-shape-entity`). Only `install.ts` is shared
  with VP-23 (a localized conditional insert) — trivial rebase. Registered only when
  `debug: true`.
- **VP-26 (perf pass) is LAST and owns the M5 closeout** — it profiles the full
  post-VP-23/24 pipeline, so it must run after both. Scope: (1) the **fat-AABB
  hysteresis fix** (M3 review — hold `shape.fatAabb*` across steps, reset only on
  escape; a parity fix _and_ a perf win); (2) hot-allocation removal on a 200-body
  scene (pre-size the impulse accumulator, scratch reuse in solver/collide/sensor);
  (3) a repeatable benchmark harness under `tests/` (or `bench/`). It does **not**
  chase micro-opts that risk parity — measurable wins only, gate stays green.
- **Carried-deferral triage (avoid bloat — not all M5-bucketed items are milestone
  DoD):**
  - _CoM-shift velocity adjustment_ (VP-12 carry) — VP-23 evaluates whether sleep
    needs it; v1 has no runtime CoM drift beyond mass recompute, so likely stays
    deferred. VP-23 author decides and records.
  - _Open-chain ghost-vertex fidelity at sharp endpoints_ — verification task, not in
    the milestone DoD. Assessed at closeout: fix if cheap, else formally defer to v2
    with the in-code `makeChainSegments` comment as the tracker (open chains with
    sharp turns are an edge case; loop chains already match box2d exactly).
  - _Dynamic `Sensor` marker toggle_ — a feature gap with a documented workaround
    (shape recreate), **not** in the milestone DoD ("Sleep + CCD + debug + perf").
    Kept deferred unless it falls out cheaply; the architect will not let it expand
    M5 scope.

### Dependency graph & execution waves

```
VP-25 debug validation ── independent, own worktree ──┐ (parallel from t0)
                                                       │
VP-23 sleep + island split ──> VP-24 CCD (bullets) ───┤
        (critical path, main worktree)    (main)      │
                                                       └─> VP-26 perf pass + fat-AABB
                                                                + M5 closeout/triage
```

- **Wave 1 (parallel):** VP-23 (main worktree) ‖ VP-25 (separate worktree).
- **Wave 2:** VP-24 (after VP-23; shares `finalizeBodies`).
- **Wave 3:** VP-26 (after VP-23+VP-24; profiles the whole pipeline) + closeout.

### Status by ticket

_(updated as tickets land)_

- ✅ **VP-23** — Sleep + island split (engine `55768ed`, systems `71d0b88`, tests
  `c70c91f`, docs `0309b73`). See entry below.
- ✅ **VP-24** — Continuous collision (CCD) for bullets + fast bodies (flags
  `49887c6`, TOI `e71569d`, shape fields `1677cc7`, engine `3c781d3`, wiring
  `b57f9d5`, tests `31b95f0`). See entry below.
- ✅ **VP-25** — `PhysicsDebugValidation` system (`5d4ed8e`, `dbca1f9`, `3d91299`,
  `be6ee6a`). See entry below.
- ✅ **VP-26** — Performance pass + fat-AABB hysteresis fix + benchmark + closeout
  (`ed56bfa` hysteresis, `12fcd4d` shapeIndex, `807c723` scratch, `ad67360` bench,
  docs commit below). See entry below.

#### ✅ VP-25 — `PhysicsDebugValidation` system

**Files:**

- `src/systems/debug.ts` (NEW) — `installDebugValidation`: a `.run()` physics-pre
  system that walks three `world.filter()` scans every step and validates all six
  structural codes from `docs/debug-validation.md`. Owns a `WarnDedupe` instance
  (survives across steps). Re-arms (eid, code) pairs when the structure becomes
  valid so a future relapse can warn again.
- `src/systems/index.ts` — added `PhysicsSystemsOptions` interface; conditionally
  calls `installDebugValidation` as the last physics-pre system when `debug: true`.
- `src/install.ts` — added `debugSink?: (message: string) => void` to
  `PhysicsOptions`; passes `{ debug, debugSink }` to `installPhysicsSystems`.
- `tests/debug/debug_validation.test.ts` (NEW) — 42 tests, one describe block per
  code, each covering: fires once (a), silent when debug: false (b), 600-step
  deduplication (c), message contains code+eid (d), re-arm after fix+re-break (e).

**Six validation codes (all from `docs/debug-validation.md`):**

1. `shape-without-parent-body` — geometry entity with no direct Body parent.
2. `dynamic-body-without-density` — dynamic body with no non-sensor shape of
   density > 0, OR no shape children at all.
3. `chain-too-few-points` — `Chain.points.length < 4`.
4. `polygon-invalid` — `Polygon.vertices` fail `validateHull` / `computeHull`.
5. `shape-position-on-body` — `Body` entity carries `ShapePosition` or `ShapeRotation`.
6. `position-on-shape-entity` — geometry entity carries `Position`.

**Decisions:**

- **Filter scan approach** (not reactive queries). The validator is a read-only
  pass that runs every step regardless, mirroring `PhysicsForceGather`. Three
  `world.filter()` scans: geometry entities, body entities, and body-with-shape-pose
  entities. No dependency on `PhysicsState` internals — pure ECS walk.
- **`dynamic-body-without-density` child scan**: builds a `Map<body-eid, child[]>`
  by walking the geometry filter and checking each entity's `ChildOf` parent. This
  avoids threading `PhysicsState` through the validator. Correct because the
  geometry filter already includes every geometry entity in the world.
- **Re-arm on valid** (codes 1, 3, 4, 6): when the (eid, code) pair is valid on
  the current step, call `dedupe.rearm()` so a future return to invalid warns again.
  For code 5 (shape-position-on-body), re-arm is not needed — if the entity leaves
  the filter (components removed) it simply isn't visited; re-entry is covered by
  the new filter membership.
- **`debugSink` on `PhysicsOptions`**: avoids exposing `installDebugValidation`
  in the public API while still allowing test interception without console.warn
  spying.
- **Gate is last in physics-pre**: after `PhysicsMassRecompute`, so the validator
  sees the world after all lifecycle/sync has run. Transient mid-frame states during
  entity construction are not the validator's concern.

**Test count:** 569 → 611 (42 new). Gate green:
`typecheck/test/lint/prettier` all clean from `lib/vecs-physics/`.

#### ✅ VP-23 — sleep transition + island split + wake activation

**Files** (3 commits on `vp23-sleep`):

- `src/engine/sleep.ts` (NEW) — `wakeSolverSet`, `trySleepIsland`,
  `mergeSolverSets`, `wakeBody`, `installSleepHooks`, plus the sleeping-set id
  pool (`allocSleepingSet`/`freeSleepingSet`). Mirrors `box2d/src/solver_set.c`
  `b2WakeSolverSet`/`b2TrySleepIsland`/`b2MergeSolverSets` (lines 35/155/417).
- `src/engine/island.ts` — `splitIsland` (union-find DFS over contacts;
  `island.c:389`); `linkContact` now wakes/merges sleeping sets via state
  callback hooks (mirrors `island.c:207-217`).
- `src/engine/body.ts` — `InternalBody` grows `sleepTime`, `sleepThreshold`,
  `flags`, `bodyMoveIndex` (mirrors `b2Body.sleepThreshold/sleepTime/flags/
bodyMoveIndex`, body.h:106-112); adds `ENABLE_SLEEP = 0x0800` (`body.h:53`).
- `src/engine/state.ts` — `solverSets` array grows past `FIRST_SLEEPING_SET`;
  adds `sleepingSetPool`, `splitIslandId`, `splitSleepTime`,
  `fellAsleepThisStep`, and the `_wakeSolverSet`/`_mergeSolverSets` hooks (used
  by `island.ts`/`contact.ts` without importing `sleep.ts`).
- `src/engine/contact.ts` — `destroyContact(wakeBodies)` wakes both bodies on a
  touching teardown (`contact.c:506-510`).
- `src/engine/step.ts` — `finalizeBodies` runs the sleep accumulation block
  (`solver.c:556-684`): compute `sleepVelocity`, bump `body.sleepTime`,
  mark `awakeIslandBitSet`, pick the sleepiest split-candidate. After finalize:
  `splitIsland` on the candidate, then the reverse-iteration sleep loop
  (`solver.c:2039-2053`). `applyPendingImpulses` honours `acc.wake`.
- `src/systems/lifecycle.ts` — `enter(Body)` reads `Sleep`, sets `ENABLE_SLEEP`
  / threshold, and seeds `sleepTime > B2_TIME_TO_SLEEP` when
  `Sleep.awake === false` (body sleeps on first step). `update(Sleep)` syncs
  flags + wakes on `enabled=false` / `awake=true`.
- `src/systems/forces.ts` / `kinematic.ts` / `pose_sync_in.ts` — activate the
  `wake` flag (Force/Torque/KinematicTarget/teleport/velocity setters call
  `wakeBody` per the matching box2d setters: body.c:946-988 / 831-887 / 704 /
  783-820).
- `src/systems/pose_sync_out.ts` — skip bodies in `fellAsleepThisStep`
  (their sim has moved to a sleeping set; mirrors
  `b2BodyMoveEvent.fellAsleep`).
- `src/install.ts` — calls `installSleepHooks(state)` before
  `installPhysicsSystems` so wake calls from physics-pre work on step 1.

**Tests** (`tests/sleep/sleep.test.ts`): **26 tests / 14 describe blocks**;
covers all 10 scenarios from the architect brief plus `EnableSleepFlagSyncTest`,
`mergeSolverSets`, angular impulse wake, and `Sleep.awake=false` start-asleep.
**595 → 595** (the file was already discovered by vitest before commit; net
delta +26 vs baseline 569).

**Box2D lines mirrored** (sample):

- Sleep transition: `solver_set.c:35` (`b2WakeSolverSet`), `:155`
  (`b2TrySleepIsland`), `:417` (`b2MergeSolverSets`).
- Sleep accumulation: `solver.c:556-684` (`b2FinalizeBodiesTask` sleep block).
- Post-solve sleep loop: `solver.c:2003-2059` (`b2Solve` sleep block).
- Island split: `island.c:389-650` (`b2SplitIsland`; joints dropped).
- Wake-on-touch: `island.c:207-217` (`b2LinkContact`); `contact.c:506-510`
  (`b2DestroyContact`).
- `b2WakeBody`: `body.c:328-338`. Setter wake calls: `body.c:704/795/819/871/
935/958/980/1011/1039/1068`.

**Decisions / deviations**:

- **Circular-dependency hook** — `island.ts` and `contact.ts` need to call
  `wakeSolverSet`/`mergeSolverSets` (sleep.ts), but `sleep.ts` imports from
  `contact.ts` (`addContactToGraph`, `CONTACT_TOUCHING_FLAG`) and from
  `island.ts` is structurally awkward. Resolved by storing
  `_wakeSolverSet`/`_mergeSolverSets` as fields on `PhysicsState`, populated by
  `installSleepHooks` (called from `installPhysics`). Default to no-ops, safe
  before sleep is wired. Recorded as a structural decision, not a divergence
  from Box2D.
- **`Set<number>` instead of bitset** for `awakeIslandBitSet` — single-threaded,
  so the in-place-union step (`solver.c:2032-2036`) is irrelevant; a Set is
  simpler and equivalent.
- **`fellAsleepThisStep`** — Box2D marks `b2BodyMoveEvent.fellAsleep = true` on
  the move-event struct. vecs-physics' `bodyMoveEvents` is a `number[]` of
  body ids (not full events), so the fell-asleep state lives on a sibling
  `Set<number>` consumed by `PhysicsPoseSyncOut`. Semantically equivalent.
- **Sleeping-set id recycling** — Box2D uses `b2AllocId`/`b2FreeId` over
  `world->solverSetIdPool`. We use a plain number-stack free-list
  (`sleepingSetPool`); slots reuse the same `SolverSet` JS object (arrays
  cleared on free). Mirrors the model, drops the generation tracking (we don't
  hand out sleeping-set handles to user code).
- **Joints dropped everywhere** — `splitIsland`, `mergeSolverSets`,
  `wakeSolverSet`, and `trySleepIsland` all skip the joint loops (v1 has no
  joints; PLAN → Settled Decisions).
- **`Sleep.awake = false` at creation** — Box2D's `b2CreateBody` does not
  publicly call `b2TrySleepIsland`; we cannot put a body to sleep at creation
  because its island may not be fully wired (no contacts yet, no
  `constraintRemoveCount`). The chosen path: set `record.sleepTime = 1.0`
  (above `B2_TIME_TO_SLEEP = 0.5`), so finalize elects the island for sleep on
  step 1. Functionally equivalent — body is asleep by the end of the first
  step. Recorded here; alternative would be a direct sleep-on-create path.

**Carried forward / deferrals**:

- **CoM-shift velocity adjustment** (VP-12 carry, body.c:629-633) — sleep does
  not exercise CoM drift in v1 (no runtime CoM change happens to a sleeping
  body; mass recompute on a sleeping body is rare and the v=ω=0 sleep state
  makes the shift identically zero anyway). **Kept deferred**; will be revisited
  in v2 or earlier if a regression points at it.
- **VP-24 (CCD)** — fast/bullet TOI path stays a no-op in `finalizeBodies` (the
  sleep block sits alongside the future CCD branch).
- **VP-26 (perf)** — pre-allocation of the per-step `awakeIslandBitSet` Set is
  fair game in the perf pass.

**Wake-flag note**: every `wake` field on `Force`/`Torque`/`Impulse`/
`AngularImpulse`/`KinematicTargetPosition`/`KinematicTargetRotation` is now
functional. Comments calling it "a no-op until sleep lands (M5)" were removed.

**Gate green**: typecheck/test/lint/prettier all clean from `lib/vecs-physics/`.
**595 tests** total in this branch (was 569 at M5 start; +26 sleep tests).
After merging VP-25 into the integrated branch: **637 tests** total.

#### ✅ VP-24 — CCD for bullets + fast bodies

**Files** (6 commits on `vp24-ccd`):

- `src/engine/body.ts` — added `IS_FAST = 0x0008`, `IS_BULLET = 0x0010`,
  `HAD_TIME_OF_IMPACT = 0x0040`, `ENLARGE_BOUNDS = 0x0100`,
  `BODY_TRANSIENT_FLAGS = IS_FAST | IS_SPEED_CAPPED | HAD_TIME_OF_IMPACT`.
  Mirrors body.h:26-65.
- `src/engine/distance.ts` — grew with the CCD geometry primitives: `Sweep`,
  `TOIInput`, `TOIOutput`, `TOIState` types (collision.h:441-487); `getSweepTransform`
  (distance.c:14-30); `makeSweep` (body.h:235-244); `_makeSeparationFunction` /
  `_findMinSeparation` / `_evaluateSeparation` (distance.c:935-1136); `timeOfImpact`
  (distance.c:1140-1426, verbatim port with box2d line-number comments).
- `src/engine/shape.ts` + `src/systems/shape_lifecycle.ts` — `InternalShape` gained
  `aabbMargin` (pre-computed fat-AABB margin, cached once) and `enlargedAABB` (transient
  per-step proxy-enlarge flag). Mirrors `b2Shape.aabbMargin / enlargedAABB` (shape.h).
- `src/engine/ccd.ts` (NEW) — `_continuousQueryCallback` (solver.c:181-376):
  rejection rules (same-shape/body, sensor, filter, other-bullet), chain-segment
  parallel-movement early-out (solver.c:256-279), `b2TimeOfImpact` call + zero-fraction
  circle fallback. `solveContinuous` (solver.c:379-541): per-shape sweep against BVH
  trees, TOI-interpolated body advance, fat-AABB refit, `enlargedAABB` marking.
  `enlargeBulletProxies` (physics_world.c:1917-1958): post-bullet broad-phase enlarge.
- `src/engine/broad_phase.ts` — added `BroadPhase.queryTree(bodyType, aabb, maskBits,
cb)`: query a single body-type tree. Mirrors `b2DynamicTree_Query(trees + N, ...)`
  in `b2SolveContinuous` (solver.c:434-440).
- `src/engine/state.ts` — added `bulletBodies: number[]` (awake-set sim indices of
  bullet bodies collected by finalizeBodies; cleared each step).
- `src/engine/step.ts` — `finalizeBodies`: clears `BODY_TRANSIENT_FLAGS` on sim+state
  (solver.c:622-626); CCD fast/bullet detection block (solver.c:633-657) in the
  "not sleepy" branch; fast bodies skip normal `refitBodyShapeProxies`. `engineStep`:
  clears `state.bulletBodies` at top; bullet stage after sleep loop (walks
  `bulletBodies`, calls `solveContinuous` + `enlargeBulletProxies`).
- `src/systems/lifecycle.ts` — `enter(Body)` seeds `IS_BULLET` from `Body.bullet`.
  `update(Body)` early-path and stage 12 sync `IS_BULLET` on type/enabled-unchanged
  changes.

**Tests** (`tests/ccd/ccd.test.ts`): 10 tests. **637 → 647** total.
Gate green: typecheck/test/lint/prettier all clean from `lib/vecs-physics/`.

**Box2D lines mirrored:**

- `_continuousQueryCallback` ← solver.c:181-376.
- `solveContinuous` ← solver.c:379-541.
- `enlargeBulletProxies` ← physics_world.c:1917-1958 (serial loop).
- Fast/bullet detection ← `b2FinalizeBodiesTask` solver.c:633-657.
- Bullet stage call site ← physics_world.c:1896-1968 (collapsed to serial).
- `timeOfImpact` ← distance.c:1140-1426; separation helpers ← distance.c:935-1136.
- `getSweepTransform` ← distance.c:14-30; `makeSweep` ← body.h:235-244.

**Decisions / deviations:**

- **Sensor TOI hits queue** (solver.c:531-537 / b2TaskContext.sensorHits): deferred.
  Vecs-physics sensors use an AABB-based overlap pass (engine/sensor.ts, VP-21c)
  that already runs after finalize; adding TOI precision for sensors is M6+ scope.
  Documented as a deferral in the `engine/ccd.ts` module header.
- **Custom pre-solve / custom filter callbacks** (solver.c:240-254, 360-365): absent
  in vecs-physics v1. Consistent with collide.ts:88.
- **b2ShouldBodiesCollide** (solver.c:232-238): no joints in v1; equivalent to
  always returning true. Consistent with collide.ts:88. Skipped.
- **Non-bullet fast-body proxy enlargement**: in box2d a separate
  `enlargedSimBitSet` + refit-BVH task runs after finalize for non-bullet fast bodies.
  In vecs-physics (single-threaded, no task graph), `enlargeBulletProxies` is called
  inline after `solveContinuous` for non-bullet fast bodies and in the bullet stage
  for bullets. Semantically equivalent; no separate refit-BVH pass needed.
- **`_getShapeIndex` is O(n)** — scans `shapes.records` to find a shape's slot index
  for the same-shape skip in the query callback. This is acceptable for v1 (the scan
  is bounded by the body's live shape count, not the entire shape pool). A cached
  `shapeIndex: number` field on `InternalShape` would eliminate it; deferred to VP-26
  perf pass.

**Parity tests passed:**

- `SetBulletDriftTest` (flag persistence, box2d test_world.c:611-654).
- Physical no-tunnel gate: bullet (r=0.2, vx=-20) stops at wall with CCD on.
- `enableContinuous=false` tunnel: very-fast tiny bullet crosses hairline wall.
- Fast non-bullet body: vx=-15 box avoids tunnelling through thin static wall.
- `TimeOfImpactTest` (test_distance.c:80-102): fraction ≈ 0.5 ± 0.005.
- Bullet-vs-bullet skip: two bullets pass through each other (solver.c:227-230).
- HelloWorld no-regression: slow box rests at y≈1 with CCD enabled.

**Carried forward / deferrals:**

- **Sensor TOI hits queue** — deferred (see above). ✅ Closed out in VP-26 M5 closeout.
- **\_getShapeIndex O(n)** — ✅ **RESOLVED VP-26**: the O(n) scan never existed in the
  VP-24 implementation; the loop variable was used directly. VP-26 added `shapeIndex`
  to `InternalShape` and removed the redundant `fastShapeIndex` from `ContinuousContext`.
- **Fat-AABB hysteresis** — ✅ **RESOLVED VP-26**: see VP-26 entry below.
- **Open-chain ghost-vertex fidelity** — deferred to v2.

#### ✅ VP-26 — Perf pass + fat-AABB hysteresis fix + benchmark harness + M5 closeout

**Files** (4 commits on `vp26-perf`):

**`ed56bfa` — `fix: VP-26 fat-AABB hysteresis — hold fat AABB until tight escapes`**

- `src/engine/shape.ts` — restructured `refitBodyShapeProxies` to implement
  box2d's fat-AABB hysteresis (solver.c:712-728) for the "enlarge" (per-step)
  mode. Old code: `updateShapeAABBs` unconditionally reset the fat AABB every
  step. New code: compute new tight AABB, check containment in existing fat AABB;
  only reset fat and call `enlargeProxy` when tight escapes (solver.c:714:
  `b2AABB_Contains`). The "move" (teleport) path still resets both tight and fat
  unconditionally (box2d-faithful). `updateShapeAABBs` now uses `shape.aabbMargin`
  (cached, VP-24) instead of recomputing it each call.
- `tests/engine/fat_aabb_hysteresis.test.ts` (NEW) — 5 tests:
  1. `enlargeProxy` NOT called for stationary body after step 1 (tight stays in fat).
  2. Fat AABB values stable across 5+ steps for stationary body.
  3. `enlargeProxy` IS called when body escapes fat margin (enableContinuous=false
     to isolate from CCD path).
  4. Fat AABB recentred correctly on tight when escape occurs (fat = tight ± margin).
  5. Teleport ("move" mode) always resets fat AABB to new location.

**`12fcd4d` — `refactor: VP-26 cache InternalShape.shapeIndex, use in CCD same-shape skip`**

- `src/engine/shape.ts` — added `shapeIndex: number` to `InternalShape` interface.
  Set by `createShape()` to `handle.index`; initialized to `NULL_INDEX` sentinel in
  `makeShape()`. ShapeStorage uses sparse handle-indexed records (no swap-remove),
  so the index is stable for the shape's lifetime.
- `src/engine/ccd.ts` — removed `fastShapeIndex` field from `ContinuousContext`;
  `_continuousQueryCallback` now reads `ctx.fastShape.shapeIndex` directly for the
  same-shape skip (solver.c:193-196). No O(n) scan existed in VP-24 — the
  `_getShapeIndex` carry was already implemented via the loop variable; VP-26 makes
  it self-contained on the shape record.
- `src/systems/shape_lifecycle.ts` — inline `newShape()` factory updated to include
  `shapeIndex: NULL_INDEX` sentinel.
- `tests/engine/mass.test.ts` — `makeInternalShape` test helper updated to include
  `shapeIndex: NULL_INDEX`.

**`807c723` — `perf: VP-26 hoist hot per-step scratch onto PhysicsState`**

- `src/engine/state.ts` — added three persistent scratch fields:
  `_awakeIslandBitSet: Set<number>` (was `new Set<number>()` per step in
  `finalizeBodies`; VP-23 carry); `_collideContactSims: ContactSim[]` (was `[]` per
  step in `collide()`); `_collideStateChanged: Set<number>` (was `new Set<number>()`
  per step in `collide()`).
- `src/engine/step.ts` — `finalizeBodies` now clears `state._awakeIslandBitSet`
  instead of allocating a fresh `Set`.
- `src/engine/collide.ts` — `collide()` now clears `state._collideContactSims` and
  `state._collideStateChanged` instead of allocating fresh per call.

**`ad67360` — `feat: VP-26 benchmark harness (bench/) + npm run bench`**

- `bench/index.ts` (NEW) — runs all scenarios, prints a results table.
- `bench/scenarios/stacking.bench.ts` (NEW) — 200-body scene (20 cols × 10 rows),
  500 steps. Reference baseline: ~109 ms total / ~0.22 ms per step.
- `bench/scenarios/falling_balls.bench.ts` (NEW) — 100 circles, 300 steps.
  Reference baseline: ~100 ms total / ~0.33 ms per step.
- `package.json` — added `"bench": "tsx bench/index.ts"` script (no new deps;
  `tsx` is a transitive dep of vitest). Not part of `vitest run`.

**Box2D lines mirrored (hysteresis fix):**

- `b2FinalizeBodiesTask` shape-AABB refit: `solver.c:703-728`.
- Containment check: `solver.c:714: b2AABB_Contains(shape->fatAABB, aabb)`.
- Fat-AABB reset: `solver.c:716-727: fatAABB = {aabb ± margin}; shape->fatAABB = fatAABB`.

**Hysteresis fix verification:**

- `fat_aabb_hysteresis.test.ts` test 1 (`enlargeProxy NOT called`): a stationary
  body's `enlargeProxy` is never called after step 1 because tight AABB is
  identical every step and fits inside the fat (solver.c:714 containment → skip).
- `fat_aabb_hysteresis.test.ts` test 3 (`enlargeProxy IS called on escape`): with
  `enableContinuous=false` (to isolate from CCD path), a body moving faster than
  the fat margin per step triggers `enlargeProxy` (solver.c:716-727 resets fat).
- Tests 2, 4, 5 verify: fat stability across steps; fat = tight ± margin on reset;
  teleport unconditionally resets fat.

**Perf-pass decisions (non-obvious skips):**

- **`pendingImpulses` object pooling** — each per-body entry is a plain object
  `{x,y,angular,wake,generation}`. Replacing with a TypedArray layout would
  require restructuring `applyPendingImpulses` and `PhysicsImpulseAccumulate` for
  minimal gain (impulse accumulation is low frequency). Skipped.
- **`solver.ts` `ContactConstraint` per-contact scratch** — correctness-critical;
  allocates once per `solve()` call and reuses across sub-steps. Pooling would
  require a free-list coupled to contact lifecycle. Skipped.
- **`ContinuousContext` centroid scratch** — two `{x,y}` objects per fast/bullet
  body per shape per step. Could be shared mutable pair on ctx. Skipped; CCD path
  is not hot for typical scenes (bullets are rare) and the current code is clearer.

**Test count:** 647 → 652 (5 new). Gate green: typecheck/test/lint/prettier all
clean from `lib/vecs-physics/`.

**Benchmark baseline (`npm run bench` on dev machine):**

```
scenario         | steps | total (ms) |  ms/step
stacking         |   500 |      109.7 |    0.219
falling_balls    |   300 |       99.7 |    0.332
```

### ✅ MILESTONE 5 COMPLETE

All four tickets (VP-23 / VP-24 / VP-25 / VP-26) done. **Gate-green: 652 tests**,
`typecheck`/`test`/`lint`/`prettier` all clean from `lib/vecs-physics/`.

**Ticket map:**

- ✅ **VP-23** — Sleep + island split (`55768ed` engine, `71d0b88` systems,
  `c70c91f` tests, `0309b73` docs). Sleep transitions, island split, wake
  activation on all force/impulse/kinematic/teleport paths.
- ✅ **VP-24** — CCD for bullets + fast bodies (`49887c6` flags, `e71569d` TOI,
  `1677cc7` shape fields, `3c781d3` engine, `b57f9d5` wiring, `31b95f0` tests).
  No-tunnel gate: SetBulletDriftTest, physical bullet stop, TimeOfImpactTest.
- ✅ **VP-25** — `PhysicsDebugValidation` system (`5d4ed8e`, `dbca1f9`, `3d91299`,
  `be6ee6a`). Warns once per (eid, code) for all six structural codes; re-arms.
- ✅ **VP-26** — Perf pass + fat-AABB hysteresis fix + benchmark harness + M5
  closeout (`ed56bfa`, `12fcd4d`, `807c723`, `ad67360`, docs commit).

**DoD met:**

- Sleep transitions: idle islands sleep; disturbance wakes. `EnableSleepFlagSyncTest`,
  `mergeSolverSets` round-trip, angular-impulse wake, `Sleep.awake=false`
  start-asleep — all covered. (`tests/sleep/sleep.test.ts`, 26 tests.)
- Bullets / fast bodies don't tunnel: `SetBulletDriftTest`, physical no-tunnel
  gate, `enableContinuous=false` regression, fast non-bullet, `TimeOfImpactTest`,
  bullet-vs-bullet skip, HelloWorld no-regression. (`tests/ccd/ccd.test.ts`, 10 tests.)
- Debug validation warns once for all six codes. (`tests/debug/debug_validation.test.ts`,
  42 tests.)
- Perf pass: fat-AABB hysteresis implemented (parity with box2d solver.c:712-728);
  three per-step scratch allocations hoisted to `PhysicsState`; `shapeIndex`
  cached on `InternalShape`. Benchmark harness in `bench/`; baseline numbers above.

**Tests:** 652 total (55 test files). Gate green.

**Carried forward (deferred to v2 or a future milestone — NOT M5 DoD):**

- **Open-chain ghost-vertex fidelity at sharp endpoints** (M2 carry) — loop chains
  use real neighbour ghosts and match box2d exactly. Open-chain endpoints use
  reflection (`2a−b`), which is correct for straight chains but unverified at sharp
  turns against `b2CreateChain`'s actual neighbour ghost logic. In-code comment at
  `makeChainSegments` is the authoritative tracker. Deferred to v2.
- **Dynamic `Sensor` MARKER toggle** (solid ↔ sensor at runtime, M4 carry) —
  needs contact teardown + `SensorStorage` create/destroy + mass/proxy invariants.
  Shape recreate (remove + re-add geometry component) is the supported workaround
  until v2. Deferred to v2.
- **CoM-shift velocity adjustment** (VP-12 carry, body.c:629-633) — VP-23 assessed:
  sleep does not exercise CoM drift in v1 (no runtime CoM change happens to a
  sleeping body; mass recompute on a sleeping body is rare, and the v=ω=0 sleep
  state makes the shift identically zero anyway). Kept deferred; revisit in v2 if
  a regression points at it.
- **Sensor TOI hits queue** (VP-24 carry, solver.c:531-537) — the AABB-based sensor
  overlap pass (VP-21c, `engine/sensor.ts`) covers v1 sensor use cases without TOI
  precision. TOI-precise sensor detection is M6+ scope.

## MILESTONE 6 — Hardening, docs, release v1.0.0 (🚧 IN PROGRESS)

**Tickets: VP-27 … VP-34** (8 total). Architect: planning pass before kickoff.
No new engine behaviour — only doc audit, box2d test-suite parity sweep,
`SOLVER.md`, fuzz pass, public-API freeze, README + examples, monorepo
server-demo integration, and release mechanics (MIT, CHANGELOG, v1.0.0 tag).

**Execution contract: `architecture/CLOSING_PLAN.md`.** Read it first — it
carries the full ticket breakdown (scope / files / DoD), the dependency graph,
the settled decisions from the planning round, and notes on what is
intentionally not in M6 scope.

**Baseline at M6 start:** 668 tests / 55 files, gate green (typecheck / test /
lint / prettier from `lib/vecs-physics/`). Post-M5 review fix pass landed
on top of VP-26 (7 commits ending at `4c4af8d`); `architecture/issues/` empty.

**Wave 1 COMPLETE.** VP-27, VP-28, VP-29, VP-30, VP-31 all merged; plus a
sibling `fix:` against M5 (CCD/sleep stale-index bug, surfaced by VP-30 fuzz
— see VP-30 entry below). **NEXT: Wave 2** — VP-32 (README + examples) and
VP-33 (monorepo server-demo integration). Both depend on VP-31's frozen
export surface; VP-32 also consumes VP-27's refreshed `docs/roadmap.md`.
VP-34 (release: bench/BASELINE, CHANGELOG, version bump, MIT LICENSE, v1.0.0
tag) is strictly last and depends on VP-33.
See `CLOSING_PLAN.md` § VP-NN per ticket. Suggested sequence:
VP-27 → VP-31 → VP-28 → VP-29 → VP-30 → VP-32 → VP-33 → VP-34.

### Status by ticket

#### ✅ VP-27 — Doc audit + docs↔code defaults pin + roadmap v2-carries (commit 2e00b1e)

**Files:**

- `lib/vecs-physics/docs/components.md` — added a `## Defaults` table covering every
  public component / field with its `new C()`-produced default value (the table is now
  parsed by the regression test below). The hand-aligned table style is preserved
  per the prettier rule on docs.
- `lib/vecs-physics/tests/components/defaults.test.ts` — extended with a
  docs↔code defaults parser test (`describe("docs/components.md defaults table")`):
  reads the new Defaults table out of `docs/components.md` with a small regex, builds
  the expected pairs from fresh public component instances, and asserts equality
  per `(Component, field)` key. Numeric formatting handles `0xffffffff`, JSON
  encoding for objects/strings, `[]` for empty arrays. Sensor uses a synthetic
  `marker` row → `{}`.
- M5 doc-coverage refresh across the pages CLOSING_PLAN.md §1.4 flagged:
  `docs/events.md` (hit threshold default, sleeping-body event behaviour, CCD/sensor
  TOI deferral, dropped the stale optional `otherBody` payload), `docs/getting-started.md`
  (added `enableSleep`/`enableContinuous` rows), `docs/internals.md`, `docs/kinematic-motion.md`,
  `docs/shapes.md` (dynamic `Sensor` toggle deferral, CCD/bullet shape notes, sensor-mass
  wording), `docs/systems-and-phases.md` (added a full world-options defaults table:
  `gravity`, `fixedTimeStep`, `subSteps`, `debug`, `restitutionThreshold`,
  `hitEventThreshold` 1.0, `contactHertz` 30, `contactDampingRatio` 10,
  `contactSpeed` 3.0, `maximumLinearSpeed` 400, `enableSleep`, `enableContinuous`).
- `lib/vecs-physics/docs/roadmap.md` — added a `## V2 Carries From V1 Closeout`
  subsection listing the four v2 carries (open-chain ghost-vertex fidelity at sharp
  endpoints, dynamic `Sensor` marker toggle, CoM-shift velocity adjustment, sensor
  TOI hits queue) with one-line reasons; the v1 scope table grew Sleeping / Continuous
  CCD / Debug validation rows.

**Decisions / deviations:**

- **No engine behaviour changed** (M6 iron rule respected). The docs↔code defaults
  test was always going to pass on first try because the doc table is mechanically
  derived from the same code the test instantiates; the value is that any future
  doc drift now fails CI, so reviewers can stop manually spot-checking defaults.
- **Stale `otherBody` payload prose removed** from `docs/events.md` — the
  `ContactEvent`/`SensorEvent`/`HitEvent` types in `src/components/events.ts` only
  carry `other: Entity`, never `otherBody`. The previous prose described an optional
  field that does not exist; consumers were already directed to
  `event.other.parent(ChildOf)` for the body entity.
- Defaults parser is intentionally regex-based + brittle to malformed tables —
  the test throws if the `## Defaults` heading or table structure is missing, so
  doc edits that break it surface immediately.

**Tests:** 669 tests / 55 files (was 668 / 55). Gate green: typecheck/test/lint/prettier
from `lib/vecs-physics/`. Closes #74.

#### ✅ VP-28 — Box2D test-suite parity sweep (commit 0ed1a78)

**Files:**

- `lib/vecs-physics/tests/parity/cross_platform.test.ts` (NEW) — v1-equivalent of
  `test_world.c::CrossPlatformTest`. Box2D's Falling Hinges scene relies on revolute
  joints (v1 excludes); the port instead builds a 20×10 dynamic-box stack on a static
  ground, steps 360 frames at 1/60, snapshots every body's `(bodyId, x, y, rotation,
vx, vy, omega, sleeping)` via `getPhysics(world)`, and asserts byte-equal snapshots
  across two independent runs in one process. Snapshot is `JSON.stringify` (string
  equality, not deep equality), so any deterministic float drift surfaces.
- `lib/vecs-physics/tests/lifecycle/empty_world.test.ts` (NEW) — port of
  `test_world.c::EmptyWorld`. `installPhysics` + `world.start()` + 32 `world.progress`
  calls with no entities; asserts `bodies/shapes/contacts/islands.records` empty,
  `graphContactSims` empty, exactly 3 solver sets (STATIC/DISABLED/AWAKE), every
  set's `bodySims/bodyStates/contactSims/islandSims` empty.
- `lib/vecs-physics/tests/lifecycle/destroy_all_bodies.test.ts` (NEW) — port of
  `test_world.c::DestroyAllBodiesWorld`. Builds a static ground + 8 dynamic boxes,
  lets contacts form (5 steps), destroys every shape+body in one frame, steps once,
  asserts no live `bodyByEntity`/`shapeByEntity` entries, no records, no
  `graphContactSims`, no non-touching contacts, no islands, no broad-phase proxies
  (via `state.broadPhase.queryAll`).
- `lib/vecs-physics/tests/lifecycle/enable_contact_recycling.test.ts` (NEW) — port
  of `test_world.c::EnableContactRecyclingTest`. Single dynamic box on a ground;
  after contacts form, toggle `Body.enabled = false` and assert the body moved to
  `DISABLED_SET`, shape `proxyKey === -1`, zero live contacts; toggle back to
  `enabled = true` and assert proxy recreated (`proxyKey >= 0`) and contacts
  regenerated. v1 disables contact recycling (`recycleDistance = 0`) but the
  enable/disable contact-teardown invariant still applies (M3 review fix
  `M3-body-type-enable-bookkeeping`).
- `lib/vecs-physics/tests/math/aabb_raycast.test.ts` (NEW) — port of
  `test_collision.c::AABBRayCastTest`. All 14 sub-cases (side / edge / corner / miss /
  inside / degenerate / exact-boundary, offset AABB) exercised in a single `it()` block.
- `lib/vecs-physics/tests/parity/README.md` (NEW) — catalogues intentionally-not-
  ported box2d tests with the PLAN _Non-Goals_ reason for each: `RayCastShapeTest`,
  `ShapeCastTest`, threading tests, container/hash-set tests, `TestIsValid`,
  `TestWorldRecycle`, `TestWorldCoverage`, `TestSetWorkerCount`. Also notes
  `ChainSegmentShapeTest`'s partial-port status (physical one-sided ✅; C-API
  shape-type mutation ❌ — M4 closeout).
- `lib/vecs-physics/src/math/aabb.ts` (+100/-1) — added `rayCastAABB(a, p1, p2)`
  with the exported `AABBCastOutput` (`hit/fraction/normal/point`). **Verbatim port
  of `b2AABB_RayCast`** (`box2d/src/aabb.c:19`) — same `tmin = -MAX / tmax = MAX`
  init, same `absD < FLT_EPSILON` parallel-axis test, same swap logic with sign-of-
  normal `s`, same `tmin < 0 || 1 < tmin` early returns. Used only by the new
  `aabb_raycast.test.ts` (CCD does not consume it in v1).

**Decisions / deviations:**

- **No engine behaviour changed.** No parity divergence was uncovered by the five
  ports; no sibling `fix:` PR needed (M6 iron rule respected).
- **`rayCastAABB` is a new internal math primitive, not an engine behaviour change.**
  It's a pure function on the math layer (no state, no solver call sites) added so
  the `AABBRayCastTest` port has a function to exercise. Could become a public ray-
  cast primitive in v2 alongside `physics.rayCastClosest`; for now it's exported
  from `math/aabb.ts` only.
- **`cross_platform.test.ts` is broader than `tests/engine/collide_order.test.ts`.**
  collide_order only pins 3-contact id ordering; cross_platform exercises a 200-body
  stack across 360 steps and pins every body's full pose+velocity+sleep state. If
  any future change re-introduces a determinism regression, this test catches it.
  Snapshot uses `JSON.stringify` for byte-equality (no `toBeCloseTo`).
- **`enable_contact_recycling` reaches into `state.shapes.get(shapeIndex).proxyKey`**
  for the disable assertion — proxyKey = -1 is the explicit "no broad-phase proxy"
  sentinel set by the M3 enable/type-change bookkeeping fix.

**Tests:** 674 tests / 60 files (was 669 / 55, +5 tests / +5 files). Gate green:
typecheck/test/lint/prettier from `lib/vecs-physics/`. Closes #75.

#### ✅ VP-29 — `architecture/SOLVER.md` solver/CCD/sleep implementation map (commit 80d7114)

**Files:**

- `lib/vecs-physics/architecture/SOLVER.md` (NEW, 356 lines). Maintainer-facing map of
  the solver subsystem; complements (does not duplicate) `PLAN.md` (design) and
  `PROGRESS.md` (per-ticket history). Sections:
  - Step orchestration (`engine/step.ts`): per-step flow (clear event arrays, install
    sleep hooks, apply pending impulses, `makeStepContext`, broad-phase pair-create
    callback, `collide`, `solve`, `gatherHitEvents`, `finalizeBodies`, island split,
    sleep loop, bullet stage, sensor overlap).
  - TGS solver core (`engine/solver.ts`): `makeStepContext`, `makeSoft` (verbatim
    `b2MakeSoft` port), the eight overflow-only stages with box2d source ranges.
  - Collide and contact state (`engine/collide.ts`): pair create callback, narrow-phase
    refresh, ascending contact-id state-change order (M3 review fix).
  - Contact model (`engine/contact.ts`): `InternalContact`/`ContactSim` split, create/
    destroy/update, single-overflow-color graph movement.
  - Islands and sleep (`engine/island.ts`, `engine/sleep.ts`): bookkeeping, link/unlink/
    merge, `splitIsland`, sleeping-set allocation, `wakeSolverSet`/`trySleepIsland`.
  - Continuous collision (`engine/ccd.ts`, `engine/distance.ts`): fast/bullet detection
    in finalize, `_continuousQueryCallback`, `solveContinuous`, `enlargeBulletProxies`,
    `timeOfImpact` + sweep/separation helpers.
  - Broad phase, dynamic tree, fat AABBs (`engine/broad_phase.ts`, `engine/dynamic_tree.ts`,
    `engine/shape.ts`): three trees, pair key encoding, `pairSet` semantics, M5 fat-AABB
    hysteresis fix in `refitBodyShapeProxies` "enlarge" mode.
  - Mass and extents (`engine/mass.ts`): `updateBodyMassData`, sensor-mass parity,
    CoM-shift deferral.
  - **Box2D source map** — 30-row table mapping `(vecs-physics code, box2d source:line,
notes)`. Every line range was verified against the vendored source at commit
    `6e96697064e1ec09265c64fe953e5e056098c215`; references that could not be verified
    were omitted (per the issue brief).
  - **Intentional deviations** — 11-row table covering single overflow color, contact-
    layer `pairSet`, ref-based solver-set transfers, IdPool-owned generations, fat-AABB
    hysteresis, sensors-are-not-contacts, `linkContact` no-merge, impulse-accumulate
    `onSet` hooks, CCD transient flag propagation, joints omitted, sensor TOI hits queue.
  - V1 non-goals (constraint coloring, joints, multi-threading, contact recycling,
    pre-solve/custom filter, casts/queries, sensor TOI hits, deep TGS theory).
  - Cross-links to `PROGRESS.md` and `PLAN.md` → _Settled Decisions_ at the end of every
    major section.

**Decisions / deviations:**

- **Doc-only**, no engine behaviour change (M6 iron rule respected).
- **Lightweight map per CLOSING_PLAN.md § VP-29.** Not a deep dive; deep theory and
  derivations are intentionally left in box2d sources. Length sits at the ~300-line
  target zone.
- **`architecture/*.md` is intentionally not prettier-clean** (same rule as `docs/*.md`);
  no `prettier --check` run on the new file. Hand-aligned tables preserved.
- Spot-verified line references against vendored box2d: `solver.h:239` (b2MakeSoft),
  `contact_solver.c:{24,162,239,410,516}` (the five overflow stages), `solver.c:{65,113}`
  (integrate-velocities/positions), `body.c:515` (b2UpdateBodyMassData), `contact.c:{224,
382,529}` (createContact/destroyContact/updateContact), `solver.c:1249` (b2BulletBodyTask).
  All match.

**Tests:** 674 tests / 60 files (unchanged — doc-only). Gate green: typecheck/test/lint
from `lib/vecs-physics/`. Closes #76.

#### ✅ VP-30 — Fuzz harness (commit 8fe1117)

**Files:**

- `lib/vecs-physics/tests/fuzz/rng.ts` (NEW, 35 lines) — `Rng` class implementing
  mulberry32 (deterministic seeded PRNG). Exposes `float`, `int(min,max)`,
  `range(min,max)`, `signed(maxMag)`, `bool(p)`, `choice([])`. Internal `_state`
  is a uint32 mask of the seed; `>>> 0` keeps it 32-bit across `+ 0x6d2b79f5`.
- `lib/vecs-physics/tests/fuzz/scene.ts` (NEW, 325 lines) — `buildFuzzScene(seed)`:
  installs physics (`debug: true`, `subSteps: 2`, gravity `(0, -10)`, **`enableSleep: false`**
  — see deviation below), adds static boundaries + coverage bodies, then 8–12 random
  bodies with random geometry (`Box`/`Circle`/`Capsule`/`Polygon`/`Segment`/`Chain`),
  random `Material` (density/friction/restitution), random `CollisionFilter`
  (categoryBits/maskBits drawn from a fixed 8-category set), some `Sensor` shapes,
  some `KinematicTargetPosition` drivers, persistent `Force`/`Torque`, per-step
  `Impulse`/`AngularImpulse`. Respects M2 validators (no zero-length capsules/
  segments/chains, no duplicate adjacent chain points).
- `lib/vecs-physics/tests/fuzz/fuzz.test.ts` (NEW, 61 lines) — committed seed list
  `[1, 2, 3, 5, 8, 13, 42, 1337, 65537, 3735928559]`, 300 steps at 1/60, asserts per
  step: `Position`/`Rotation`/`LinearVelocity`/`AngularVelocity` all finite;
  `world.progress` wall time < 5 s (hard infinite-loop guard, not a perf gate). Whole
  suite runs in ~1 s on a dev machine.
- `lib/vecs-physics/vitest.config.ts` — narrowed `include` from `tests/**/*.ts` to
  `tests/**/*.test.ts` so the helper files (`rng.ts`, `scene.ts`) are not reported as
  empty test suites.

**Decisions / deviations:**

- **No engine behaviour changed** in this PR (M6 iron rule respected).
- **`enableSleep: false` is a temporary workaround for a real M5 CCD/sleep bug.**
  Setting `enableSleep: true` reproduces a `TypeError: Cannot read properties of
undefined (reading 'center0X')` at `engine/distance.ts:668` (`makeSweep`), reached
  through `engine/ccd.ts:279` (`solveContinuous`), on seeds 2, 3, 13, 3735928559.
  Root cause: `state.bulletBodies` (`engine/state.ts:398`) holds **awake-set local
  indices** pushed during `finalizeBodies`; the sleep loop runs between finalize and
  the bullet stage and may swap-pop those slots out of the awake set, leaving the
  index either stale (pointing at a different body's sim) or out of range. The fix
  is to either store stable `bodyId`s (and resolve set/index at call time) or skip
  bullet bodies that moved out of `AWAKE_SET` before the bullet stage. **Tracked as
  a separate `fix:` against M5 VP-24**; once that lands, `enableSleep` flips back to
  `true` in `tests/fuzz/scene.ts`. This is exactly the iron-rule-mandated pattern:
  M6 ports/tests surface a real M5 bug → file it separately, don't bundle.
- **`vitest.config.ts` `include` narrowing is safe.** All existing test files use the
  `*.test.ts` suffix; verified before commit. Helper files in any future `tests/<area>/`
  are now silently allowed.
- **Wall-time bound of 5 s/step** is generous on purpose — it catches infinite loops
  and pathological perf regressions only, not normal slowdown. Whole 10-seed suite
  finished in ~1 s on the dev machine.

**Tests:** 684 tests / 61 files (was 674 / 60, +10 tests / +1 file). Gate green:
typecheck/test/lint/prettier from `lib/vecs-physics/`. Closes #77.

**Carried into a separate M5 fix:** `state.bulletBodies` stale-index bug when
sleep is enabled (described above). **✅ FIXED** in commit `54257a6` (`fix: M5
CCD ordering — run bullet stage before sleep loop`); the fuzz harness was flipped
back to `enableSleep: true` in commit `1ac46e9`. Root cause: vecs-physics ran
sleep → bullet, but box2d runs bullet → sleep (solver.c:1896 then :2003); the
sleep loop's `trySleepIsland` swap-pops awake-set `bodySims`, which invalidated
the awake-set local indices stored in `state.bulletBodies` during finalize. The
previous comment claiming bullets had to run AFTER sleep was based on a wrong
premise (finalize already marks a bullet body's island awake via the sleepTime
=0 path, so running bullets first does NOT let a bullet body sleep). All 684
tests stay green with the swap, plus all 10 fuzz seeds now pass with sleep
enabled.

#### ✅ VP-31 — Public API freeze (export snapshot) (commit c394962)

**Files:**

- `lib/vecs-physics/tests/api/exports.approved.json` (NEW, 69 lines) — the approved
  API snapshot stored as JSON-as-data (not vitest `.toMatchSnapshot`). Five fields:
  - `runtimeExports` (30): every named export of `@vworlds/vecs-physics`, sorted.
  - `classExports` (29): every component class.
  - `functionExports` (1): `installPhysics`.
  - `valueExports` (1): `BodyType` (the `"static"|"kinematic"|"dynamic"` string enum).
  - `typeExports` (5): `ContactEvent`, `HitEvent`, `PhysicsOptions`, `SensorEvent`,
    `Vec2` — type-only, not runtime-discoverable, pinned via `tsc` on the test file.
- `lib/vecs-physics/tests/api/exports.test.ts` (NEW, 112 lines) — three tests in one
  `describe("public API exports")` block:
  1. "matches the approved public API snapshot" — `expect(buildApiSnapshot()).toEqual(APPROVED_API)`.
  2. "exports component classes, installPhysics, and BodyType with expected runtime
     kinds" — runtime kind check per category: every `classExports` entry is a class
     (`Function.prototype.toString` starts with `"class "`); `installPhysics` is a
     function-but-not-class; `BodyType` equals `{Static:"static",Kinematic:"kinematic",Dynamic:"dynamic"}`.
  3. "keeps docs/components.md component rows in sync with exported component classes" —
     parses the docs Defaults table (regex on `## Defaults\n\n…\n\n…(?=\n## )`), extracts
     unique component names from the first column, asserts equal to sorted `classExports`.
     Plus a `PublicTypeExports` tuple alias that imports all 5 types as `type`s so `tsc`
     fails if any are removed; `void (undefined as unknown as PublicTypeExports)` keeps the
     alias live without runtime cost.
- `lib/vecs-physics/scripts/api-snapshot.ts` (NEW, 78 lines) — small CLI helper. Default
  invocation re-checks the approved snapshot against the current `* as api` exports;
  `--write` re-renders the JSON via Prettier and overwrites the approved file.
  Intended workflow for intentional API changes: edit `src/index.ts`, run
  `npm run api:snapshot -- --write`, commit the JSON diff alongside the code change.
- `lib/vecs-physics/package.json` (+1) — added `"api:snapshot": "tsx scripts/api-snapshot.ts"`.

**Decisions / deviations:**

- **No engine behaviour changed** (M6 iron rule respected). `src/index.ts` already
  matched PLAN.md → _Top-level Exports_; the audit confirmed it (no rename / delete /
  add needed).
- **JSON-as-data snapshot file + helper script** instead of the inline-string-array
  in the issue brief. The agent chose this path for cleaner PR diffs and `--write`
  ergonomics on intentional changes. Accepted at review — the durable contract is
  the same (any drift in the public surface fails the test), and the JSON file is
  Prettier-formatted via the script.
- **Type exports pinned via `tsc`, not runtime introspection.** TypeScript erases
  type-only exports at runtime, so `Object.keys(api)` cannot see `PhysicsOptions`/
  `Vec2`/`ContactEvent`/`SensorEvent`/`HitEvent`. The test imports them as `type`s in
  a tuple alias; removing or renaming any breaks the typecheck step of the gate.
- **Docs cross-check uses the same regex as VP-27's defaults parser**, with a `Set`
  dedup over the first column. Because every public component class appears at least
  once in the Defaults table, the deduped first-column list equals the class export
  list.

**Tests:** 687 tests / 62 files (was 684 / 61, +3 tests / +1 file). Gate green:
typecheck/test/lint/prettier from `lib/vecs-physics/`. Closes #78.

### ✅ MILESTONE 6 — WAVE 1 COMPLETE

VP-27 / VP-28 / VP-29 / VP-30 / VP-31 all merged + sibling M5 CCD/sleep fix. **Gate
green: 687 tests / 62 files**, typecheck / test / lint / prettier all clean from
`lib/vecs-physics/`. PRs #79, #80, #81, #82, #83 all squash-rebase-merged with branch
deletion; agent worktrees survive locally (`VP27`/`VP28`/`VP29`/`VP30`/`VPxxx` under
`.worktrees/`) but the remote branches are gone.

**Wave 1 → Wave 2 carry:** none. All five tickets landed clean.

#### ✅ VP-32 — README + examples (commit 7540587 + cherry-pick 4d528aa)

**Files:**

- `lib/vecs-physics/README.md` (NEW) — package-root entry point. One-paragraph
  what-it-is (Box2D v3 → Vecs port, idiomatic ECS through `installPhysics`),
  install snippet, **HelloWorld quickstart** (M3 parity scene: dynamic box at
  `y=4`, static ground at `y=-1`, 60 steps at `1/60`), v1 features table (10
  rows: sleep, CCD, contact/sensor/hit events, kinematic, forces, materials,
  filters, debug), v1 limitations list (now 10 bullets, including the two
  v2-carries cherry-picked from #86: dynamic `Sensor` marker toggle requires
  shape recreation; open-chain ghost vertices at sharp endpoints), how to run
  the examples, learn-more links into `docs/*`, architecture links into
  `architecture/{PLAN,SOLVER}.md`.
- `lib/vecs-physics/examples/hello_world.ts` (NEW, 62 lines) — dropping box;
  prints `y` every 10 frames; rests at `(0.000, 0.500)` within 60 frames.
- `lib/vecs-physics/examples/sensor_trigger.ts` (NEW, 66 lines) — a moving
  circle enters and exits a static `Sensor` box; recolours a `Tint` component
  on begin/end via `SensorEvents`. Prints `entered: tint=green` / `exited:
tint=blue`.
- `lib/vecs-physics/examples/kinematic_platform.ts` (NEW, 52 lines) —
  `KinematicTargetPosition` drives a horizontal platform along
  `sin(frame*0.03)*2`; a dynamic rider sits on it; prints rider vs platform x
  every 20 frames.
- `lib/vecs-physics/examples/contact_events.ts` (NEW, 59 lines) — stack of two
  dynamic boxes on a static ground, all three with `ContactEvents`; prints
  begin events as the stack settles.
- `lib/vecs-physics/tsconfig.json` — `include` now adds `examples` so examples
  compile under the package `typecheck`.
- `lib/vecs-physics/package.json` — `examples` script (`tsx examples/X.ts &&
...`) cherry-picked from #86 so all four examples can be smoke-run with
  `npm run examples`.

**Decisions / deviations:**

- **No engine behaviour changed** (M6 iron rule respected).
- **Two competing PRs (best-of-both merge).** Agents A (#86) and B (#87) both
  picked up VP-32. #87 was merged as the primary because its examples are
  more thorough (sensor_trigger demos a `Tint` component to make the event
  use case concrete; kinematic_platform compares rider/platform x; contact_events
  uses a stack on ground rather than two free-floating boxes). The two wins
  from #86 — the extended limitations list (dynamic `Sensor` toggle, open-chain
  ghost endpoints) and the `examples` npm script — were cherry-picked in
  4d528aa. #86 was closed with a comment explaining the choice.
- **Examples use the public API exclusively** — every imported name appears in
  `tests/api/exports.approved.json` (the VP-31 snapshot).
- **README is prettier-clean** (lives outside `docs/`, so the formatter rule
  does apply).

**Tests:** 687 tests / 62 files (unchanged — docs+examples only, no
runtime code added to the engine). Gate green: typecheck/test/lint/prettier
from `lib/vecs-physics/`. All four examples run cleanly via
`npm run examples`. Closes #84 (issue), supersedes #86 (closed), merges #87.

#### ✅ VP-33 — Monorepo server-demo: bouncing balls via vecs-physics (commit 52f3173)

**Files:**

- `apps/server/package.json` (+1) — adds `"@vworlds/vecs-physics": "*"` to
  `dependencies`. `package-lock.json` regenerated.
- `apps/server/src/main.ts` (+83 / -29) — replaces the hand-rolled ball motion
  (per-frame `position += velocity`, manual wall bounce) with `installPhysics`-
  driven simulation:
  - `installPhysics(world, { gravity: { x: 0, y: -10 }, fixedTimeStep: DT,
subSteps: 4 })` is called after the demo's `update` phase is registered, so
    the default `physics-*` phases land after gameplay writes and before
    `collect`/`send`.
  - Walls: a single static body holds 4 child `Segment` shapes outlining the
    play area (`WIDTH × PLAY_HEIGHT`), with `Material { density: 0, friction:
0.6, restitution: 0 }`.
  - Balls: each ball entity gains `Body { type: Dynamic }` + `PhysicsPosition` - `PhysicsVelocity` (vecs-physics' `Position`/`LinearVelocity`, imported
    with `as` aliases to avoid colliding with the demo's wire-typed
    `Position`); a child shape entity owns the `Circle` + `Material { friction:
0.6, restitution: 0.7 }`.
  - New `SyncPhysicsBalls` system in `physics-post`: reads `PhysicsPosition`,
    writes the demo `Position` (with a y-flip — physics y-up vs screen y-down
    — and a u16-safe `clamp + round`), and calls `entity.modified(Position)`
    to trigger network sync. This was the "option 2: adapt" path from the
    issue brief; "option 1: replace + decorate the external class" was not
    attempted because decorating an external class with `@wireType` is not
    supported by the wire layer.
  - `AssignCells` and `UpdatePlayerViews` were moved to `physics-post` so they
    observe post-physics positions.
  - The old `Velocity` class and `MoveSystem` are deleted; players still move
    via direct `Position` writes in `MovePlayers` (no velocity needed).

**Decisions / deviations:**

- **No engine behaviour changed.** Public-API integration; no `@vworlds/vecs-physics/src/*`
  imports; no engine internals reached. The integration uncovered no API gaps
  that required a sibling `fix:` — the export surface frozen by VP-31 covered
  every use case (`Body`, `BodyType`, `Circle`, `installPhysics`,
  `LinearVelocity`, `Material`, `Position`, `Segment`, plus `ChildOf` from
  `@vworlds/vecs`).
- **Coord-system flip.** Demo screen coords have y-down (GAME_TOP=60 at the
  top, HEIGHT=540 at the bottom); physics uses y-up. The sync helpers
  `toPhysicsPoint` and `toDemoBallPoint` flip via `HEIGHT - y` in both
  directions. Gravity stays `(0, -10)` in physics space so balls fall toward
  larger demo-y values (visually down).
- **Optional sensor zone deliberately skipped.** The brief marked it
  "optional, drop if it gets complex"; the agent skipped to stay within the
  ~200-line budget.
- **Visual verification limited.** PR notes "browser automation was unavailable
  in this environment", so the agent confirmed the server starts cleanly
  (`timeout 8s npm --prefix apps/server run dev`) and types/lints pass, but
  did not capture a client-side recording of the balls bouncing. Local
  smoke-test post-merge: server boots to `vecs demo server listening on
http://localhost:3000` with no errors in 6 seconds.

**Tests:** 687 tests / 62 files (unchanged — server-side integration only,
no `lib/vecs-physics/` code changed). Server gate green: `npm --prefix
apps/server run typecheck` + `lint`. Closes #85.

### ✅ MILESTONE 6 — WAVE 2 COMPLETE

VP-32 + VP-33 merged. Public-facing surface is now in place: README + four
runnable examples + a real-app dogfood. **Gate green: 687 tests / 62 files**
in `lib/vecs-physics/`, `apps/server/` typecheck + lint clean. **NEXT: VP-34**
(release mechanics — bench/BASELINE.md, CHANGELOG, version bump, MIT LICENSE,
final gate, v1.0.0 tag) — the last ticket.

#### ✅ VP-34 — Release mechanics: bench BASELINE + CHANGELOG + MIT LICENSE + v1.0.0 (commit 57f3ee8)

**Files:**

- `lib/vecs-physics/bench/BASELINE.md` (NEW, 21 lines) — committed
  `npm run bench` numbers from the dev machine: `stacking` 0.235 ms/step over
  500 steps × 200 bodies; `falling_balls` 0.349 ms/step over 300 steps × 100
  circles. Header records OS/arch (`Linux 6.17.0-23-generic x86_64`) and Node
  version (`v24.15.0`), date 2026-05-31. Body explicitly states the v1 perf
  posture: **informational baseline only**, no v1 regression gate; future
  regressions land as ordinary `perf:` commits and the file can be refreshed
  by re-running `npm run bench` on the target machine. Cross-links to
  `architecture/CLOSING_PLAN.md` § 5 decision 4.
- `lib/vecs-physics/CHANGELOG.md` (NEW, 71 lines) — Keep-a-Changelog format,
  single `## [1.0.0] - 2026-05-31` entry grouped by feature area (M1 Bodies,
  M2 Shapes, M3 Contacts + solver, M4 Forces + events + sensors, M5 Sleep +
  CCD + debug + perf, M6 Hardening, docs, release) followed by a Limitations
  list that mirrors `README.md` exactly. Concise — release-note tone, not a
  re-export of PROGRESS.md.
- `lib/vecs-physics/LICENSE` (NEW, 21 lines) — standard SPDX MIT licence text.
  Copyright header: `Copyright (c) 2026 vworlds` (the GitHub org).
- `lib/vecs-physics/package.json` — `version: "0.0.0"` → `"1.0.0"`,
  `license: "UNLICENSED"` → `"MIT"`. `private: true` left as-is (npm-publish
  call deferred to the user). `main` / `types` still `src/index.ts` (v1 ships
  ESM source directly).
- `package-lock.json` (root) — workspace metadata regenerated for the
  vecs-physics version/license bump.

**Decisions / deviations:**

- **No engine behaviour changed.** Pure release engineering (M6 iron rule
  respected).
- **`v1.0.0` tag created locally post-merge, push deferred to the user.** The
  PR deliberately did not include a tag in the diff (per the issue brief);
  the architect tags after merging. Tag created at commit `57f3ee8` after
  this PROGRESS update lands. `git push --tags` is the user's call.
- **`private: true` left intentionally.** The npm-publish decision is a
  separate ask — flipping `private` and `npm publish`-ing is out of scope for
  VP-34, recorded in CLOSING_PLAN.md § 5 decision 5.
- **PR's first CI run failed on `npm run format:check`** due to my prior
  PROGRESS.md M6 entries (committed via direct pushes to `physics` that
  never went through CI). Pre-fixed on `physics` directly in commit
  `12641ae` (`chore: prettier-clean PROGRESS.md M6 entries`) so the rebase
  landed clean. The agent's PR commit message noted they had bypassed the
  pre-commit hook for the same reason — my fix means future PRs no longer
  need to.

**Tests:** 687 tests / 62 files (unchanged — release artefacts only). Gate
green: typecheck/test/lint from `lib/vecs-physics/`; root
`npm run format:check` clean; `npm run examples` exits 0. Closes #89.

### ✅ MILESTONE 6 COMPLETE — vecs-physics 1.0.0

All 8 tickets (VP-27 / VP-28 / VP-29 / VP-30 / VP-31 / VP-32 / VP-33 / VP-34)
merged and reviewed against the vendored box2d v3.2.0. **Gate green: 687
tests / 62 files**, typecheck / test / lint / prettier all clean from
`lib/vecs-physics/`; root `npm run format:check` clean; `apps/server/`
typecheck + lint clean; four examples run cleanly via `npm run examples`;
fuzz harness covers 10 seeds × 300 steps with `enableSleep: true`. The
public API export snapshot (`tests/api/exports.approved.json`) freezes the
30 runtime + 5 type exports listed in `architecture/PLAN.md` →
_Public API Contract_. README + four examples + monorepo server-demo
integration dogfooded the v1 surface; no API gaps surfaced. `package.json`
bumped to `1.0.0`; MIT `LICENSE` in place. Tag `v1.0.0` created locally on
commit `57f3ee8`; `git push --tags` deferred to the user.

**M6 ticket map (in merge order on `physics`):**

- ✅ VP-27 (PR #79, `2e00b1e`) — doc audit + docs↔code defaults parser test
  - roadmap v2-carries refresh.
- ✅ VP-28 (PR #80, `0ed1a78`) — box2d test-suite parity sweep: 5 ports
  (CrossPlatformTest equivalent, EmptyWorld, DestroyAllBodiesWorld,
  EnableContactRecyclingTest, AABBRayCastTest) + `tests/parity/README.md`
  cataloguing the N/A cases + `rayCastAABB` math primitive.
- ✅ VP-29 (PR #81, `80d7114`) — `architecture/SOLVER.md` 356-line
  maintainer-facing solver/CCD/sleep implementation map with verified box2d
  source line refs.
- ✅ VP-30 (PR #82, `8fe1117`) — seeded fuzz harness (mulberry32 PRNG, 10
  seeds × 300 steps) + sibling M5 fixes: `fix:` `54257a6` (CCD bullet/sleep
  ordering — match box2d's `bullets → sleep`, not `sleep → bullets`),
  `test:` `1ac46e9` (re-enable `enableSleep: true` in the fuzz scene),
  `docs:` `46e1e9b` (record fix).
- ✅ VP-31 (PR #83, `c394962`) — public API export snapshot
  (`tests/api/exports.approved.json`) + three-test gate (snapshot equality,
  runtime-kind classification, docs cross-check) + `api:snapshot` helper
  script with `--write` for intentional API changes.
- ✅ VP-32 (PR #87, `7540587` + cherry-pick `4d528aa`) — best-of-both merge
  of the two duplicate VP-32 PRs (closed #86 in favour of #87, cherry-picked
  the extended limitations + `examples` npm script). README at package root
  - four runnable examples (`hello_world`, `sensor_trigger`,
    `kinematic_platform`, `contact_events`).
- ✅ VP-33 (PR #88, `52f3173`) — monorepo `apps/server/` integration: balls
  driven by `installPhysics` via the public API only; `SyncPhysicsBalls`
  system in `physics-post` mirrors `PhysicsPosition` → demo wire `Position`
  with the y-flip; no engine internals reached; server smoke-boots cleanly.
- ✅ VP-34 (PR #90, `57f3ee8`) — release artefacts: `bench/BASELINE.md`,
  `CHANGELOG.md`, MIT `LICENSE`, `package.json` 1.0.0 + MIT; final gate
  green; tag created.

**M6 sibling commits (carried-into-M6 cleanups that aren't tickets):**

- `12641ae` `chore: prettier-clean PROGRESS.md M6 entries` — fixed pre-existing
  PROGRESS.md formatting that broke VP-34's CI on the first run.
- All five M6 entry-recording PROGRESS commits I wrote inline (`cb9bebc`,
  `49c6fa3`, `453f1cb`, `1c18829`, `93a9519`, `33034be`) — direct pushes to
  `physics`, one per ticket.

**Carried into v1.1+ (none requires immediate work):**

- The four v2 carries listed in `docs/roadmap.md` (open-chain ghost-vertex
  fidelity at sharp endpoints, dynamic `Sensor` marker toggle, CoM-shift
  velocity adjustment, sensor TOI hits queue) — all explicitly v2 scope.
- `private: true` in `package.json` — the npm-publish call is a separate
  user decision; flip to `false` and `npm publish` when ready.
- Repo-level (vs package-level) `README.md` — out of M6 scope per
  CLOSING_PLAN.md § 5 decision 6.

vecs-physics 1.0.0 is **done**.
