# vecs-physics Engineering Architecture Plan

Status: active. Public API frozen at v1; engine backend migrating from the
in-house TypeScript Box2D port to **box2d3-wasm** (Emscripten build of Box2D
v3 at commit `3a4f0da8374af61293a03021c9a0b3ebcfe67948`).

This document is what eng architects and agents will read. It has two halves:

1. **What vecs-physics looks like from the outside** — the stable contract:
   public exports, components, defaults, systems, phases, lifecycle
   semantics. This is what users see and what tests assert against.
2. **The way forward** — the box2d3-wasm migration plan (Milestone 7), with
   per-system mappings, memory model, bootstrap, and a dependency-aware
   ticket sequence.

The first half holds whether we're on the TS engine or the WASM backend; the
second half is how we get from one to the other.

---

# Part 1 — vecs-physics from the outside

## What vecs-physics is

A 2D rigid-body physics package for Vecs. The simulation model is Box2D v3.
The public model is Vecs entities and components: a body is an entity with
`Body`, a shape is a child entity with `Box`/`Circle`/`Capsule`/…, forces and
events are components. Users never see a `b2WorldId`, a `b2BodyId`, a
contact-listener callback, or a handle.

Internally, vecs-physics is a **thin adapter** that wires Vecs lifecycle and
ECS reactivity to a Box2D world. After M7 the world is **box2d3-wasm**; the
adapter does not implement any physics math itself.

## Goals and non-goals

### Goals

- **Box2D-compatible simulation behaviour.** Defaults, units, and semantics
  match Box2D v3. A falling box under gravity 10 m/s² lands where Box2D says
  it should.
- **Vecs-first API.** Components and `installPhysics(world, opts)` are the
  only public surface. `world.progress(now, delta)` drives everything.
- **Zero archetype churn for hot one-shot effects.** `Impulse` and
  `AngularImpulse` consume silently. Event arrays clear in place. No private
  components flap on/off during steady-state.
- **Predictable, shallow lookups.** Force-target / shape-parent resolution
  checks only the immediate `ChildOf` parent. No recursive ancestor walks.
- **Deterministic step under fixed input.** Identical creation order +
  inputs + WASM build → identical outputs on the same host.

### Non-goals (v1)

- Joints, ray casts, shape casts, AABB overlap, character movers, debug
  rendering. Roadmap'd to v2 even though box2d3-wasm exposes them.
- Multithreading, SIMD. box2d3-wasm has a threaded "deluxe" build path but
  v1 ships single-threaded.
- Pre-solve / custom-filter callbacks.
- A `Physics` global handle, `physics.*` imperative API, or any non-component
  way to inspect the simulation.
- Cross-platform bit-identical floats. Target is x64 Linux Node; we
  guarantee deterministic _order_ and run-to-run reproducibility there.

## Public API contract

The full contract lives in `docs/`. This section enumerates the surface
engineering must keep stable.

### Top-level exports

```ts
import {
  // Bootstrap
  preloadPhysics, // NEW: async, loads box2d3-wasm module once
  installPhysics, // sync, wires the engine into a world

  // Body
  Body,
  BodyType,
  Position,
  Rotation,
  LinearVelocity,
  AngularVelocity,
  Damping,
  GravityScale,
  MotionLocks,
  Sleep,

  // Shape pose
  ShapePosition,
  ShapeRotation,

  // Geometry
  Box,
  Circle,
  Capsule,
  Segment,
  Polygon,
  Chain,
  type Vec2,

  // Material / filter / sensor
  Material,
  CollisionFilter,
  Sensor,

  // Forces & impulses
  Force,
  Torque,
  Impulse,
  AngularImpulse,

  // Kinematic targets
  KinematicTargetPosition,
  KinematicTargetRotation,

  // Events
  ContactEvents,
  type ContactEvent,
  SensorEvents,
  type SensorEvent,
  HitEvents,
  type HitEvent,
} from "@vworlds/vecs-physics";
```

### Bootstrap and install signature

```ts
export function preloadPhysics(): Promise<void>;

export type PhysicsOptions = {
  gravity?: { x: number; y: number }; // default { x: 0, y: -10 }
  fixedTimeStep?: number; // seconds, default 1/60
  subSteps?: number; // default 4
  debug?: boolean; // default false
  debugSink?: (message: string) => void; // default console.warn

  // Optional phase placement. IPhase or a name (created if missing).
  preStepPhase?: import("@vworlds/vecs").IPhase | string;
  stepPhase?: import("@vworlds/vecs").IPhase | string;
  postStepPhase?: import("@vworlds/vecs").IPhase | string;

  // Optional thresholds and tunables, all Box2D-aligned defaults.
  restitutionThreshold?: number; // m/s, default 1.0
  hitEventThreshold?: number; // m/s, default 1.0
  contactHertz?: number; // default 30
  contactDampingRatio?: number; // default 10
  contactSpeed?: number; // m/s, default 3.0
  maximumLinearSpeed?: number; // m/s, default 400
  enableSleep?: boolean; // default true
  enableContinuous?: boolean; // default true
};

export function installPhysics(world: World, opts?: PhysicsOptions): void;
```

Canonical bootstrap:

```ts
await preloadPhysics(); // once per process; cached
installPhysics(world, opts); // before world.start()
world.start();
```

`installPhysics` must:

1. Throw if `preloadPhysics` has not resolved.
2. Register every public component via `world.component(...)` in the stable
   order in **Component registration order** below.
3. Call `world.setExclusiveComponents(Box, Circle, Capsule, Segment, Polygon, Chain)`.
4. Create or look up the three physics phases.
5. Install the physics systems (listed under **System and phase pipeline**).
6. Allocate `PhysicsState` (holds the `b2WorldId` and entity↔ID maps) and
   bind it to the world via the `PhysicsRoot` singleton.
7. Throw if called after `world.start()` or twice on the same world.

### Authoritative component defaults

Part of the contract. Match Box2D's `b2DefaultBodyDef()`, `b2DefaultShapeDef()`,
`b2DefaultFilter()`, `b2DefaultSurfaceMaterial()`.

| Component                      | Field                             | Default                 |
| ------------------------------ | --------------------------------- | ----------------------- |
| `Body`                         | `type`                            | `BodyType.Static`       |
|                                | `bullet`                          | `false`                 |
|                                | `enabled`                         | `true`                  |
|                                | `allowFastRotation`               | `false`                 |
| `Position`                     | `x, y`                            | `0, 0`                  |
| `Rotation`                     | `angle`                           | `0`                     |
| `LinearVelocity`               | `x, y`                            | `0, 0`                  |
| `AngularVelocity`              | `value`                           | `0`                     |
| `Damping`                      | `linear, angular`                 | `0, 0`                  |
| `GravityScale`                 | `value`                           | `1`                     |
| `MotionLocks`                  | `x, y, rotation`                  | `false, false, false`   |
| `Sleep`                        | `enabled, awake, threshold`       | `true, true, 0.05`      |
| `ShapePosition`                | `x, y`                            | `0, 0`                  |
| `ShapeRotation`                | `angle`                           | `0`                     |
| `Box`                          | `hx, hy`                          | `0.5, 0.5`              |
| `Circle`                       | `radius`                          | `0.5`                   |
| `Capsule`                      | `x1, y1, x2, y2, radius`          | `-0.5, 0, 0.5, 0, 0.25` |
| `Segment`                      | `x1, y1, x2, y2`                  | `-0.5, 0, 0.5, 0`       |
| `Polygon`                      | `vertices, radius`                | `[], 0`                 |
| `Chain`                        | `points, loop`                    | `[], false`             |
| `Material`                     | `density`                         | `1`                     |
|                                | `friction`                        | `0.6`                   |
|                                | `restitution`                     | `0`                     |
|                                | `rollingResistance, tangentSpeed` | `0, 0`                  |
|                                | `userMaterialId`                  | `0`                     |
| `CollisionFilter`              | `categoryBits`                    | `1`                     |
|                                | `maskBits`                        | `0xffffffff`            |
|                                | `groupIndex`                      | `0`                     |
| `Force` / `Impulse`            | `x, y, wake`                      | `0, 0, true`            |
| `Torque` / `AngularImpulse`    | `value, wake`                     | `0, true`               |
| `KinematicTargetPosition`      | `x, y, tolerance, wake`           | `0, 0, 0.001, true`     |
| `KinematicTargetRotation`      | `angle, tolerance, wake`          | `0, 0.001, true`        |
| `ContactEvents`/`SensorEvents` | `begin, end`                      | `[], []`                |
| `HitEvents`                    | `hits`                            | `[]`                    |

All field initialisers belong on the class body so `new Component()` returns
a valid, default-shaped instance — every component must work zero-arg.

## Component model

### `Box` accessors

`Box` ships with `width`/`height` accessors that read/write `hx`/`hy`.
Setting via accessor still requires `entity.modified(Box)` (or going through
`entity.set(Box, { hx: … })`), because Vecs cannot detect raw property
writes.

### `Vec2` in `Polygon` / `Chain`

`type Vec2 = { x: number; y: number }`. Polygons accept up to 8 vertices
(Box2D's `B2_MAX_POLYGON_VERTICES`). Validate `length <= 8` and convexity
**on shape creation**, not on every update.

### Internal / private components

Two internal, non-exported components exist on the world for engine wiring:

- **`PhysicsRoot`** — a `Singleton` component that holds `PhysicsState`.
  Reached via `world.get(PhysicsRoot)`, O(1). Never exported.
- **`PhysicsSystemTag`** — marks every physics system entity so
  `PhysicsPoseSyncIn` can `ignoreSource([PhysicsSystemTag])` and drop the
  engine's own write-back. Lives on system entities only, not user entities.

There are **no private components on user entities.** All per-entity state
lives in `PhysicsState` maps keyed by entity id.

## Package layout (post-M7)

```text
lib/vecs-physics/
├── package.json                 (deps: @vworlds/vecs, box2d3-wasm)
├── tsconfig.json
├── vitest.config.ts
├── docs/                        (user-facing)
├── architecture/
│   └── PLAN.md                  (this document)
├── src/
│   ├── index.ts                 Public exports.
│   ├── install.ts               installPhysics + options parsing + phase setup.
│   │
│   ├── components/              ECS data classes — no Box2D imports.
│   │   ├── body.ts, body_tuning.ts, shape_pose.ts, geometry.ts,
│   │   ├── material.ts, force.ts, target.ts, events.ts
│   │
│   ├── systems/                 Vecs↔Box2D adapter systems.
│   │   ├── lifecycle.ts, shape_lifecycle.ts,
│   │   ├── pose_sync_in.ts, pose_sync_out.ts,
│   │   ├── kinematic.ts, forces.ts, impulse_accumulate.ts,
│   │   ├── material_filter_sync.ts, shape_pose_sync.ts,
│   │   ├── event_opt_in_sync.ts, events.ts, impulse_zero.ts,
│   │   ├── mass_recompute.ts, step.ts, debug.ts
│   │
│   └── adapter/                 box2d3-wasm runtime, state, disposal.
│       ├── runtime.ts           preloadPhysics, getBox2D.
│       ├── state.ts             PhysicsState + PhysicsRoot/PhysicsSystemTag
│       │                        + registerInternalComponents + attachPhysics.
│       └── disposal.ts          .delete() discipline for Emscripten objects.
│
└── tests/                       External-API tests only (engine tests removed in M7).
    ├── api/, components/, lifecycle/, events/, forces/, kinematic/,
    ├── sleep/, ccd/, parity/
    └── fixtures/, helpers.ts
```

Module boundaries:

- `src/components/` is pure data, no imports from `systems/` or `adapter/`.
- `src/systems/` imports `components/` and `adapter/`. Never imports another
  system.
- `src/adapter/` is the only place that imports `box2d3-wasm`. It exposes
  `PhysicsState` and a small set of typed helpers; systems never call
  `getBox2D()` directly.

## Vecs integration

### Component registration order

Components register in this order so type ids are deterministic across
installs:

1. `Position`, `Rotation`, `LinearVelocity`, `AngularVelocity`, `Body`.
2. `Damping`, `GravityScale`, `MotionLocks`, `Sleep`.
3. `ShapePosition`, `ShapeRotation`.
4. `Box`, `Circle`, `Capsule`, `Segment`, `Polygon`, `Chain`.
5. `Material`, `CollisionFilter`, `Sensor`.
6. `Force`, `Torque`, `Impulse`, `AngularImpulse`.
7. `KinematicTargetPosition`, `KinematicTargetRotation`.
8. `ContactEvents`, `SensorEvents`, `HitEvents`.
9. Internal: `PhysicsRoot` (singleton), `PhysicsSystemTag`.
10. `world.setExclusiveComponents(Box, Circle, Capsule, Segment, Polygon, Chain)`.
11. Phase creation/lookup.
12. System creation; tag each physics system entity with `PhysicsSystemTag`.
13. `PhysicsState` allocation and attach to `PhysicsRoot`.

`ChildOf` is built into Vecs — referenced, never registered.

### Internal-state attachment

`PhysicsState` lives on a world-scoped `Singleton` component (`PhysicsRoot`):

- Marking the component singleton auto-attaches the instance to the
  component's own meta entity. Retrieval is `world.get(PhysicsRoot)` — O(1).
- A second instance throws; double-install and cross-world wiring bugs are
  caught for free.
- It GCs with the world; `PhysicsRoot` is never exported.
- A non-exported `getPhysics(world)` is the only legal way to reach state.

### Entity-reference safety

`Entity` objects persist as JS objects after `entity.destroy()` — Vecs marks
`_destroyed = true`. Reads are safe (`entity.get(C)` → `undefined`), writes
no-op.

For event delivery:

- Events are recorded internally by **`b2ShapeId`**, not Entity reference.
- At publish time we resolve `b2ShapeId → Entity` via
  `state.entityByShape`; if the entity has been destroyed, drop silently.

A body destroyed during the same step still gets its `endEvents` correctly
emitted to the **other** shape's `ContactEvents`, provided the other shape's
entity is still alive.

### Default phase pipeline

```text
world.progress(now, delta):
  beginFrame(delta)
    physics-pre:
      PhysicsBodyLifecycle          (Body enter/exit/update)
      PhysicsShapeLifecycle         (geometry enter/exit + ChildOf reparent)
      PhysicsMaterialFilterSync     (Material / CollisionFilter / Sensor)
      PhysicsEventOptInSync         (ContactEvents / HitEvents / SensorEvents opt-in)
      PhysicsShapePoseSync          (ShapePosition / ShapeRotation)
      PhysicsPoseSyncIn             (user Position / Rotation / velocity → engine)
      PhysicsKinematicTargets       (drive kinematic bodies to targets)
      PhysicsForceGather            (Force / Torque accumulate)
      PhysicsImpulseAccumulate      (drain Impulse / AngularImpulse)
      PhysicsMassRecompute          (recompute mass for dirty bodies)
      PhysicsDebugValidation        (debug: true only)
    physics-step:
      PhysicsStep                   (b2World_Step)
    physics-post:
      PhysicsPoseSyncOut            (write engine pose back to components)
      PhysicsEvents                 (publish contact / hit / sensor events)
      PhysicsImpulseZero            (silently zero consumed impulses)
  endFrame()
```

User input/gameplay phases land before `physics-pre`; user render phases
after `physics-post`. Explicit phases supplied via `PhysicsOptions` still
split across the same three slots in the same order.

### Hooks vs systems

v1 uses **systems** for almost everything — they batch reactivity into a
phase-bound run, give a single debuggable choke point, and queue safe
deferred mutations.

The one v1 exception: `Impulse` and `AngularImpulse` accumulation uses
`world.component(Impulse).onSet(...)` **hooks**, not `.update()` callbacks.
Reason: a Vecs `entity.set` reuses the stored component instance
(`Object.assign` in place), and the system inbox stores a **reference** to
it; by drain time every queued update for that component reads the **last**
value — three sets `x:1,2,3` would sum to `9` instead of the documented `6`.
`onSet` fires synchronously inside `_notifyComponentSet` after each
`Object.assign`, so it observes each set-time value and accumulates
correctly. The hook only mutates `PhysicsState` (no structural ECS work),
which is safe.

## System and phase pipeline

Each system below: phase, responsibility, and the box2d3-wasm primitives it
calls.

### `PhysicsBodyLifecycle` (`physics-pre`)

Query: `Body`.

- `.enter` — read `Body`, `Position`, `Rotation`, `LinearVelocity`,
  `AngularVelocity`, optional tunables. Fill a `b2DefaultBodyDef()`. Call
  `b2CreateBody(worldId, def)`. Store `b2BodyId` in
  `state.bodyByEntity` / `state.entityByBody`.
- `.exit` — look up `b2BodyId`; call `b2DestroyBody(id)`. Drop maps. Box2D
  cascades shape destruction internally.
- `.update(Body, …)` — `type` change → `b2Body_SetType`; `enabled` →
  `b2Body_Enable` / `Disable`; `bullet` → `b2Body_SetBullet`;
  `allowFastRotation` → corresponding setter.

### `PhysicsShapeLifecycle` (`physics-pre`)

Query: `{ all: [{ any: [Box, Circle, Capsule, Segment, Polygon, Chain] }, { parent: Body }] }`.

Membership tracks geometry-with-Body-parent — covers attachment, detachment,
and reparenting via one query.

- `.enter` — resolve parent body via `entity.parent(ChildOf)` →
  `state.bodyByEntity`. Build a `b2ShapeDef` from `Material` / `CollisionFilter`
  / `Sensor` / `ShapePosition` / `ShapeRotation`. Dispatch by geometry type
  (see table below). Store `b2ShapeId` in `state.shapeByEntity` /
  `state.entityByShape`.
- `.exit` — `b2DestroyShape(shapeId)` (or `b2DestroyChain` for chains). Drop
  maps.
- `.update(<geom>, …)` — same-type props change in place via
  `b2Shape_Set...` setters where available; otherwise destroy + recreate.
- `.update(ChildOf, …)` — reparenting between bodies = destroy under old
  parent, recreate under new.

| Geometry      | Call                                                                                  |
| ------------- | ------------------------------------------------------------------------------------- |
| `Box(hx, hy)` | `b2MakeOffsetBox(hx, hy, center, rot)` → `b2CreatePolygonShape(bodyId, def, poly)`    |
| `Circle`      | `b2CreateCircleShape(bodyId, def, circle)`                                            |
| `Capsule`     | `b2CreateCapsuleShape(bodyId, def, capsule)`                                          |
| `Segment`     | `b2CreateSegmentShape(bodyId, def, segment)`                                          |
| `Polygon`     | `b2ComputeHull(points)` → `b2MakePolygon(hull, radius)` → `b2CreatePolygonShape(...)` |
| `Chain`       | `b2DefaultChainDef()` + filter/material → `b2CreateChain(bodyId, chainDef)`           |

### `PhysicsMaterialFilterSync` (`physics-pre`)

- `.update(Material, …)` → `b2Shape_SetDensity(id, d, true)`,
  `b2Shape_SetFriction`, `b2Shape_SetRestitution`,
  `b2Shape_SetRollingResistance`, etc.
- `.update(CollisionFilter, …)` → build a `b2Filter` (32-bit fields widen to
  Box2D's 64-bit by zero-padding upper bits) and call `b2Shape_SetFilter`.
- `.update(Sensor, …)` — v1: destroy + recreate the shape with
  `def.isSensor = true/false`.

### `PhysicsEventOptInSync` (`physics-pre`)

Hook-driven: when `ContactEvents` / `HitEvents` / `SensorEvents` is added or
removed from a shape entity, call `b2Shape_EnableContactEvents` /
`EnableHitEvents` / `EnableSensorEvents` on the corresponding `b2ShapeId`.

### `PhysicsShapePoseSync` (`physics-pre`)

`.update(ShapePosition / ShapeRotation, …)` — destroy + recreate the shape
under the body with the new local pose. (box2d3-wasm shapes do not expose a
runtime local-pose setter; recreate is the cheap path.)

### `PhysicsPoseSyncIn` (`physics-pre`)

Treats user pose/velocity writes as teleports. Engine write-backs (from
`PhysicsPoseSyncOut`, a tagged physics system) are filtered out by
`ignoreSource([PhysicsSystemTag])`.

- `.update(Position, …)` → `b2Body_SetTransform(bodyId, pos, currentRotation)`
- `.update(Rotation, …)` → `b2Body_SetTransform(bodyId, currentPos, b2MakeRot(angle))`
- `.update(LinearVelocity, …)` → `b2Body_SetLinearVelocity(bodyId, vec)`
- `.update(AngularVelocity, …)` → `b2Body_SetAngularVelocity(bodyId, value)`

`ignoreSource` source-attribution: each mutation is credited to the system
entity that made it; a consumer drops updates whose source matches its
silence query. Entry-time initialization is **not** silenced, so a body
still initializes through a tagged source. Confirmed at VP-6 in
`tests/lifecycle/ignore_source.test.ts`.

### `PhysicsKinematicTargets` (`physics-pre`)

For each kinematic body with `KinematicTargetPosition` /
`KinematicTargetRotation`: compute `v = (target - current) / dt` (clamp to
`maximumLinearSpeed`), call `b2Body_SetLinearVelocity` /
`SetAngularVelocity`. If within tolerance, leave the target attached and
zero the velocity. Wake the body if `wake = true`.

### `PhysicsForceGather` (`physics-pre`)

Non-reactive — re-scans force sources every step (the contract: "Force
applies every physics step while it is present").

Query: `world.filter({ any: [Force, Torque] })`, with
`{ up: [ChildOf, [Body]] }` injecting the parent's `Body` for the
immediate-parent fallback. For each:

- `Force` → `b2Body_ApplyForceToCenter(bodyId, {x, y}, wake)`
- `Torque` → `b2Body_ApplyTorque(bodyId, value, wake)`

box2d3-wasm zeroes applied forces inside `b2World_Step` (matches Box2D), so
no per-step force reset is needed on our side.

### `PhysicsImpulseAccumulate` (`physics-pre`)

Hook-driven (see **Hooks vs systems**). `world.component(Impulse).onSet(...)`
and `world.component(AngularImpulse).onSet(...)` fire synchronously on each
`set`, accumulating into `PhysicsState.pendingLinearImpulse[bodyId]` and
`pendingAngularImpulse[bodyId]`. The phase system itself is a no-op `.run()`
that exists to carry `PhysicsSystemTag`.

The pre-step phase flushes accumulators via
`b2Body_ApplyLinearImpulseToCenter` / `b2Body_ApplyAngularImpulse` for each
body that received any.

### `PhysicsMassRecompute` (`physics-pre`)

box2d3-wasm auto-recomputes mass when `b2Shape_SetDensity` is called with
`updateBodyMass = true`. For bodies explicitly marked dirty (e.g. after a
manual flag flip), call `b2Body_ApplyMassFromShapes(bodyId)`. Most cases are
no-ops post-M7.

### `PhysicsDebugValidation` (`physics-pre`, debug:true only)

Structural warnings with deduplication. Issue codes (stable strings, part of
the contract because users may grep logs):

| Code                           | Trigger                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------- |
| `shape-without-parent-body`    | Shape entity with no immediate `Body` parent.                                         |
| `dynamic-body-without-density` | Dynamic body with zero total mass after recompute.                                    |
| `chain-too-few-points`         | `Chain.points.length < 4`.                                                            |
| `polygon-invalid`              | Polygon hull validation fails.                                                        |
| `shape-position-on-body`       | `ShapePosition`/`ShapeRotation` on a body entity.                                     |
| `position-on-shape-entity`     | `Position`/`Rotation` on a shape entity (likely mistake).                             |
| `body-component-on-shape`      | `LinearVelocity`/`Damping`/etc. on a shape entity.                                    |
| `force-without-target`         | `Force`/`Torque`/`Impulse`/`AngularImpulse` with no Body in self or immediate parent. |
| `delta-mismatch`               | Vecs delta diverges from `fixedTimeStep` by > 0.1 ms.                                 |

Dedupe key: `(entity.eid, code)`. Structural changes (e.g. shape gets a
parent body) drop matching entries so a re-broken structure re-warns.

### `PhysicsStep` (`physics-step`)

```ts
.run((_now, delta) => {
  const state = getPhysics(world);
  if (state.debug && Math.abs(delta / 1000 - state.fixedTimeStep) > 1e-4) {
    warn.warnOnce(0, "delta-mismatch", ...);
  }
  b2World_Step(state.worldId, state.fixedTimeStep, state.subSteps);
});
```

### `PhysicsPoseSyncOut` (`physics-post`)

After `b2World_Step`, read `b2World_GetBodyEvents(worldId).moveEvents` (Box2D
emits these for awake bodies that moved). For each event:

- `entity.set(Position, { x, y })`
- If the entity has `Rotation`: `entity.set(Rotation, { angle })`
- If the entity has `LinearVelocity` / `AngularVelocity`: write those too.

These set commands carry the `PhysicsSystemTag` source, so
`PhysicsPoseSyncIn` filters them out next frame. Kinematic and static body
poses are user-owned — never written back.

### `PhysicsEvents` (`physics-post`)

Poll once per step:

```ts
const ce = b2World_GetContactEvents(worldId);
const se = b2World_GetSensorEvents(worldId);
const be = b2World_GetBodyEvents(worldId); // moveEvents (consumed above) + hitEvents
```

Walk each array; resolve `b2ShapeId → Entity` via `state.entityByShape`; push
into the entity's `ContactEvents.begin/end`, `SensorEvents.begin/end`, or
`HitEvents.hits`. Mark the component modified once per receiving entity per
step (`world.entity(eid).modified(ContactEvents)`).

Silent-clear semantics for shapes that received events last step but not
this step: `events.begin.length = 0; events.end.length = 0;` without calling
`modified`. Three independent "previously touched" sets are tracked per
event component.

### `PhysicsImpulseZero` (`physics-post`, after `PhysicsEvents`)

For every entity in `state.impulseEntitiesThisStep`:

```ts
const imp = entity.get(Impulse);
if (imp) {
  imp.x = 0;
  imp.y = 0;
} // direct write, no modified
const ai = entity.get(AngularImpulse);
if (ai) {
  ai.value = 0;
}
state.impulseEntitiesThisStep.clear();
```

This bypasses Vecs's modified-routing. The dirty bit stays clean; no query
update events fire. `ignoreSource` cannot replace this — silent-zero needs
to be invisible to **user** watchers too, not just to physics systems.

## Body lifecycle (semantics)

### Add `Body`

1. User: `entity.set(Body, {...})`.
2. Vecs routes the Set command; component bitmask sets the `Body` bit;
   `PhysicsBodyLifecycle.enter` queues.
3. `TargetTerm` fan-out re-evaluates `ChildOf`-children with geometry —
   `PhysicsShapeLifecycle.enter` queues for them.
4. Physics-pre runs: body system creates the `b2BodyId`; shape system
   creates each child shape attached to it.

**Creation order does not matter** because `{ parent: Body }` is a
`TargetTerm` with fan-out reactivity. Body-first and shape-first both work
within the same frame.

### Remove `Body`

`entity.remove(Body)` or `entity.destroy()` → `PhysicsBodyLifecycle.exit` →
`b2DestroyBody(bodyId)`. Box2D cascades shape destruction; the shape
lifecycle system's `.exit` for each child fires and removes the maps.

### Toggle `enabled`

`Body.enabled = false` → `b2Body_Disable(bodyId)`. `true` → `b2Body_Enable`.

### Change `type`

`b2Body_SetType(bodyId, newType)`. Box2D handles the contact teardown and
solver-set move internally. Documented as expensive; recommend creating with
the right type.

## Shape lifecycle (semantics)

### Add geometry under a `Body`-parent

`world.entity().set(ChildOf, { target: body }).set(Box, { hx, hy })` →
`PhysicsShapeLifecycle.enter` → dispatch on geometry → `b2CreateXxxShape`.

If the parent lacks `Body`, the query does not match and nothing is created;
debug mode reports `shape-without-parent-body`.

### Change geometry component

- **Same component, props changed** — for fields box2d3-wasm exposes setters
  for (filter, density, friction, restitution), call the setter in place.
  For shape dimensions (where setters don't exist), destroy + recreate.
- **Geometry type swapped** (Box → Circle) — exclusivity removes Box first
  → `.exit` destroys, then Circle adds → `.enter` creates.

### Remove geometry / Reparent

`.exit` destroys the shape; `.update(ChildOf, …)` reparents by destroy +
recreate under the new body.

### Chains

`Chain` produces a `b2ChainId` representing N internal segments. The shape
table uses a separate `chainByEntity: Map<EntityId, b2ChainId>` and the
common path stays branch-free.

## Material and filter updates

Already covered in `PhysicsMaterialFilterSync`. Notes:

- `Sensor` toggle in v1 = destroy + recreate the shape.
- `CollisionFilter` update calls `b2Shape_SetFilter`. Box2D rebuilds the
  affected contacts internally on the next step.

## Pose and velocity synchronization

| Direction     | Trigger                         | Mechanism                                                                                   |
| ------------- | ------------------------------- | ------------------------------------------------------------------------------------------- |
| User → engine | `entity.set(Position, …)`       | `PhysicsPoseSyncIn.update(Position)` → `b2Body_SetTransform`                                |
| User → engine | `entity.set(LinearVelocity, …)` | `PhysicsPoseSyncIn.update(LinearVelocity)` → `b2Body_SetLinearVelocity`                     |
| Engine → user | Awake body moved                | `PhysicsPoseSyncOut` reads `b2World_GetBodyEvents().moveEvents` → `entity.set(Position, …)` |

`PhysicsPoseSyncIn.ignoreSource([PhysicsSystemTag])` drops every update
originating from a physics system, so what the input system sees is, by
construction, a user write.

## Force, torque, impulse, angular-impulse handling

| Component        | Persistence              | Apply timing                                                           | Cleanup                                          |
| ---------------- | ------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------ |
| `Force`          | Persistent while present | Pre-step scan, `b2Body_ApplyForceToCenter`                             | Box2D zeros applied forces inside `b2World_Step` |
| `Torque`         | Same                     | `b2Body_ApplyTorque`                                                   | Same                                             |
| `Impulse`        | Reactive on Set          | Hook accumulates; pre-step flushes `b2Body_ApplyLinearImpulseToCenter` | Post-step silent zero                            |
| `AngularImpulse` | Same                     | `b2Body_ApplyAngularImpulse`                                           | Same                                             |

`Force` and `Impulse` on a shape entity resolve their target body via the
immediate `ChildOf` parent — no grandparent walk.

## Kinematic target handling

`PhysicsKinematicTargets` system, pre-step:

```ts
const pos = entity.get(Position);
const tpos = entity.get(KinematicTargetPosition);
if (pos && tpos) {
  const dx = tpos.x - pos.x,
    dy = tpos.y - pos.y;
  if (Math.hypot(dx, dy) > tpos.tolerance) {
    b2Body_SetLinearVelocity(bodyId, { x: dx / dt, y: dy / dt });
    if (tpos.wake) b2Body_SetAwake(bodyId, true);
  }
}
// Rotation handled the same way with shortest-arc.
```

Target stays attached after reaching the goal; physics stops applying motion;
user updating the target component re-engages. Non-kinematic bodies with a
target component are ignored (debug warns).

## Events pipeline

See `PhysicsEvents` above. The contract observed:

- **Per-step clear in place.** Arrays are owned by the user's component
  instance. Mutate `length = 0` so any reference user code holds remains
  valid.
- **Modified only on new events.** Track `previouslyTouched` set; only call
  `modified` for shapes receiving events this step. Silently clear arrays
  for shapes that had events last step but not this step.
- **Payload carries the other shape entity** (`ContactEvent.other`, etc.).
  Resolved from `b2ShapeId` at publish time; if the other shape's entity
  has been destroyed, the event is dropped silently.

## Determinism

v1 is single-threaded. Determinism depends on:

1. **WASM build determinism** on the same host. box2d3-wasm runs the C
   Box2D 3 build; same WASM binary + same inputs → same outputs on x64
   Linux Node.
2. **Entity creation order.** Vecs assigns eids monotonically; deterministic
   given identical sequences.
3. **Body/shape id assignment order.** box2d3-wasm assigns ids
   deterministically given identical create/destroy sequences.
4. **System ordering.** Phase registration, system registration, and inbox
   arrival order all deterministic.
5. **Map iteration.** ES Map iteration follows insertion order;
   `bodyByEntity`/`shapeByEntity` rely on this.

The parity baseline (`tests/parity/cross_platform.test.ts`) is now
WASM-build-determined. Re-baseline if the upstream box2d3-wasm version
changes.

## Vecs dependencies

| Capability                      | Vecs API                                                                                          | Used by                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Relationships (`ChildOf`)       | `set(ChildOf, …)`, `entity.parent(ChildOf)`, DSL `{ parent }`, `{ up: [ChildOf, …] }`, `Iter.src` | Shape↔body wiring, reparenting, force-target resolution.      |
| World singleton                 | `world.component(C).add(Singleton)`; `world.get(C)`                                               | `PhysicsRoot` state holder.                                   |
| Relationship fan-out reactivity | `TargetTerm` re-evaluates sources when target membership changes                                  | Order-independent body/shape creation.                        |
| System update silencing         | `System.ignoreSource(QueryDSL \| Query)`                                                          | Pose-sync feedback suppression via `PhysicsSystemTag` marker. |

All landed on the `physics` branch.

## Settled decisions (carried into M7)

- **Internal state:** world-scoped `Singleton` component (`PhysicsRoot`).
- **Component registration order** as above; type ids deterministic.
- **System reactivity:** systems for everything except `Impulse` /
  `AngularImpulse`, which use synchronous `onSet` hooks (see **Hooks vs
  systems**).
- **Parent/child:** Vecs `ChildOf` relationship.
- **Pose-sync feedback suppression:**
  `PhysicsPoseSyncIn.ignoreSource([PhysicsSystemTag])`.
- **`PhysicsPoseSyncOut` writes only dynamic bodies.** Kinematic and static
  poses are user-owned.
- **Silent impulse zero:** direct property writes, bypass `modified`.
- **Event array semantics:** clear-in-place, modified only on new events.
- **Geometry updates:** same-type in place where setters exist; type-swap
  is delete + create via exclusivity.
- **`BodyType` is a string enum** (`"static"|"kinematic"|"dynamic"`).
- **Collision filter width:** 32-bit `number` for `categoryBits` /
  `maskBits` (widens to Box2D's 64-bit on call). `userMaterialId` is a
  `number`. **No `bigint` in the public surface.**
- **Massless dynamic body stays massless.** Box2D's `b2UpdateBodyMassData`
  keeps `mass = 0, invMass = 0` for dynamic bodies with no positive-density
  shapes; the body does not fall. `dynamic-body-without-density` debug check
  flags the misconfiguration.
- **Sensor mass:** sensors contribute to mass/CoM/inertia like solid shapes
  unless `density === 0`.
- **`Box.width`/`height` setter footgun:** direct setter doesn't trigger
  `modified`. Document it.

## Risks (post-M7)

1. **WASM init lifecycle.** `preloadPhysics` is process-global and cached.
   In multi-world / multi-test scenarios, callers must `await preloadPhysics`
   exactly once before any `installPhysics`. Tests share a single
   `beforeAll(async () => { await preloadPhysics(); })` per test file.
2. **Emscripten manual cleanup.** Every `new b2Xxx()` and factory call
   leaks if not `.delete()`'d. The discipline is enforced inside
   `src/adapter/disposal.ts` via a `withAllocated` helper. New code paths
   that allocate outside the helper are a review red flag.
3. **box2d3-wasm version pinning.** Upstream changes can shift parity
   baselines. Pin via `package.json`; document the version on every parity
   golden.
4. **Node `navigator.hardwareConcurrency`.** box2d3-wasm reads it on init;
   `preloadPhysics` polyfills it from `os.cpus().length` when missing. Test
   runners that mock `navigator` may break; the polyfill is guarded with
   `??=`.
5. **Single-thread `compat` build vs threaded `deluxe` build.** v1 targets
   the `compat` path (no `crossOriginIsolated` required). The factory
   auto-detects; document that the deluxe path is opt-in by environment, not
   API.

---

# Part 2 — Milestone 7: migrate engine to box2d3-wasm

## Context

vecs-physics currently ships a TypeScript port of Box2D v3 under
`src/engine/` (~33 files, ~13K LOC). The port works and ships v1.0.0, but is
too slow for real workloads (the demo's "balls escape" symptom in commit
`9268968`). [box2d3-wasm](https://github.com/Birch-san/box2d3-wasm) is an
Emscripten WASM build of the same C library at commit
`3a4f0da8374af61293a03021c9a0b3ebcfe67948`, dramatically faster.

This milestone replaces the TS engine with box2d3-wasm while keeping the
public vecs-physics API (Part 1) byte-for-byte identical from the outside.
vecs-physics becomes a vecs↔Box2D adapter and nothing more.

## Scope decisions (locked)

- **Async bootstrap via separate `preloadPhysics()`.** `installPhysics`
  stays synchronous. Existing call sites add one `await preloadPhysics()`
  line.
- **v1 surface only.** Joints, raycasts, AABB/shape queries, and contact
  callbacks stay deferred to v2 even though box2d3-wasm exposes them.
- **Re-record golden values.** Tight-tolerance external tests (e.g.
  `gravity.test.ts`, `friction_ramp.test.ts`) get their expected numbers
  re-snapshotted from box2d3-wasm output and locked in. Behavioural tests
  are untouched.
- **`box2d/` and `box2d3-wasm/` reference clones stay `.gitignored`.** They
  are scratch references for nuance lookup, not vendored code. The npm
  package `box2d3-wasm` becomes a regular dependency.

## Files to delete (entirely)

- `lib/vecs-physics/src/engine/` — all 33 files (body, shape, contact,
  island, broad_phase, dynamic_tree, narrow_phase, collide, solver,
  solver_set, distance, ccd, geometry, mass, sleep, sensor, step, state, all
  `manifold/*.ts`). The two pieces of `state.ts` that survive (`PhysicsState`
  shell, `PhysicsRoot` / `PhysicsSystemTag` markers,
  `registerInternalComponents`, `attachPhysics`, `hasPhysics`) move to
  `src/adapter/state.ts`.
- `src/math/{aabb, rot, transform, constants}.ts` — engine-only. `vec2.ts`
  survives only because `Vec2` is part of the public API.
- `src/util/{handle, id_pool, dense_array, bitset}.ts` — engine-only.
  `warn.ts` (`WarnDedupe`) stays; the debug validation system uses it.
- `tests/engine/` (23 files), `tests/math/` (6), `tests/util/` (4),
  `tests/engine/fuzz/` (1). ~34 internal test files removed.

## Files to rewrite (the adapter)

The 8 component files in `src/components/` are **untouched** — pure data
classes with Box2D-aligned defaults, public contract.

The 15 systems in `src/systems/` keep their names, phases, and ordering;
only their bodies change. Each currently reaches into `src/engine/*` to
mutate the TS engine; after the migration each reaches into a thin wrapper
around box2d3-wasm IDs.

`src/install.ts` keeps its signature, registration order, exclusivity rule,
phase setup, and `attachPhysics(world, state)` flow.

## New files

- **`src/adapter/runtime.ts`** — exports `preloadPhysics(): Promise<void>`
  and a module-level cached `getBox2D()` accessor that throws if preload
  hasn't resolved.
- **`src/adapter/state.ts`** — new `PhysicsState` holding `b2WorldId`, the
  `Box2D` module reference, `Map<EntityId, b2BodyId>`,
  `Map<b2BodyId, EntityId>`, same for shapes, resolved options, per-step
  caches. Hosts `PhysicsRoot` / `PhysicsSystemTag` markers and
  `registerInternalComponents`.
- **`src/adapter/disposal.ts`** — Emscripten manual-cleanup discipline.
  Every `new b2Xxx()` / factory call funnels through a `withAllocated`
  helper that runs `.delete()` in `finally`. ID resources go through
  `b2DestroyBody` / `b2DestroyShape`.
- **`.agent/rules/box2d-references.md`** — instructions for fresh worktrees:
  how to clone `box2d` (pinned to `3a4f0da8…`) and `box2d3-wasm` into
  `lib/vecs-physics/` so agents can look up Box2D source nuances. `.gitignore`
  keeps these out of git. Append a one-line pointer to this file from the
  `.agent/` list in `CLAUDE.md` / `AGENTS.md`.

## Per-system mapping

The mapping is given inline in Part 1's **System and phase pipeline** —
every system already lists the box2d3-wasm calls it makes. The tickets
below cite which systems each one rewrites.

## Memory management

box2d3-wasm is Emscripten. `new b2Vec2(...)`, `new b2DefaultBodyDef()`,
`b2MakeBox()`, `b2ComputeHull()`, etc. return objects that **must** be
`.delete()`'d. ID resources (world/body/shape) use `b2DestroyXxx(id)`.

Discipline:

1. Every `new` or factory call lives inside `src/adapter/`, matched by an
   explicit `.delete()` in the same function (use try/finally for multi-step
   shape creation).
2. Body/shape defs are short-lived: built, passed to `b2Create...`, deleted
   immediately after.
3. Long-lived per-body scratch objects (a reusable `b2Vec2` for
   `SetLinearVelocity`, etc.) are pooled at the state level and freed on
   world teardown.

A new internal `uninstallPhysics(world)` helper (not in v1 public API but
used by tests) calls `b2DestroyWorld(state.worldId)` and frees pools.

## `preloadPhysics` bootstrap

```ts
// src/adapter/runtime.ts
let modulePromise: Promise<Box2DModule> | null = null;
let module: Box2DModule | null = null;

export async function preloadPhysics(): Promise<void> {
  if (modulePromise) {
    await modulePromise;
    return;
  }
  // Node polyfill — box2d3-wasm reads this on init.
  if (typeof globalThis.navigator === "undefined") {
    globalThis.navigator = {} as Navigator;
  }
  globalThis.navigator.hardwareConcurrency ??= (await import("node:os")).cpus().length;

  modulePromise = Box2DFactory().then((m) => (module = m));
  await modulePromise;
}

export function getBox2D(): Box2DModule {
  if (!module) {
    throw new Error(
      "Box2D module not loaded. Call `await preloadPhysics()` before `installPhysics()`."
    );
  }
  return module;
}
```

`installPhysics` calls `getBox2D()` inside `new PhysicsState(...)` to grab
the module reference.

## Tests

**External API tests survive** — all ~34 files under
`tests/{lifecycle, events, forces, kinematic, components, sleep, ccd, parity, api}/`.

Per-test action:

- **Re-record golden values** for tight-tolerance assertions. After porting
  a system, run the affected test once with box2d3-wasm, snapshot the new
  numbers, lock them in. Add a comment pointing at the box2d3-wasm version
  the baseline was taken on.
- **Behavioural assertions** stay untouched.
- **`tests/parity/cross_platform.test.ts`** — re-baseline its expected hash;
  document that determinism is WASM-build-determined.
- **`tests/api/exports.test.ts`** — add `preloadPhysics` to the expected
  export list.

Each test file gets one shared `beforeAll(async () => { await
preloadPhysics(); })`. Add this once per test directory via a `setup.ts`
imported from `vitest.config.ts`.

**Engine tests deleted wholesale**: `tests/engine/`, `tests/math/`,
`tests/util/`, `tests/engine/fuzz/`. ~34 files.

## Docs and examples

- `docs/getting-started.md` — add the `await preloadPhysics()` step.
- `docs/installation.md` — document the `box2d3-wasm` dependency, the Node
  `navigator.hardwareConcurrency` polyfill, browser `crossOriginIsolated`
  notes for the deluxe build path.
- `docs/systems-and-phases.md` — drop references to internal engine systems
  (`engineStep`); system list and ordering are unchanged.
- `docs/roadmap.md` — note that the engine is now box2d3-wasm; v2 deferrals
  (joints, raycasts, queries) are now upstream-available but
  vecs-physics-side adapters are still pending.
- `examples/{hello_world, sensor_trigger, kinematic_platform, contact_events}.ts`
  — add the `await preloadPhysics()` line. No other changes.
- CHANGELOG — record the migration and the perf delta from `npm run bench`.

## Package.json

- Add `"box2d3-wasm": "^5.2.0"` to `dependencies`.
- Update `src/index.ts` to export `preloadPhysics`.

## Agent guidance for fresh worktrees

New `.agent/rules/box2d-references.md`:

> The `box2d/` (C reference) and `box2d3-wasm/` (WASM build source)
> directories under `lib/vecs-physics/` are git-ignored. If you are working
> in a fresh worktree and need to look up Box2D source nuances:
>
> ```
> cd lib/vecs-physics
> git clone https://github.com/erincatto/box2d
> (cd box2d && git checkout 3a4f0da8374af61293a03021c9a0b3ebcfe67948)
> git clone https://github.com/Birch-san/box2d3-wasm
> ```
>
> These are read-only references — never edit them, never check them in.

Append a one-line pointer from the existing `.agent/` list at the top of
`AGENTS.md` / `CLAUDE.md`.

## Implementation order

The tickets form a dependency graph, not a linear list. The middle band
(M7-5 through M7-9) is parallelizable — those systems touch disjoint files
and share only the already-cut-over `PhysicsState`.

### Critical path (sequential)

- **M7-1 — Foundation.** Add `box2d3-wasm` dep; build `preloadPhysics()` +
  Node polyfill; adapter `runtime.ts` / `state.ts` / `disposal.ts`
  skeletons. Engine still in place; no systems rewritten yet. Gates
  everything. _Tests gated:_ `tests/api/exports.test.ts` (with
  `preloadPhysics` added).
- **M7-2 — Body lifecycle.** Rewrite `lifecycle.ts`. Delete
  `engine/body.ts`, `engine/solver_set.ts`. Gates every system that looks up
  a body by entity. _Tests:_ `tests/lifecycle/{body_lifecycle, install,
empty_world}.test.ts`.
- **M7-3 — Shape lifecycle.** Rewrite `shape_lifecycle.ts`. Delete
  `engine/shape.ts`, `engine/geometry.ts`, `engine/dynamic_tree.ts`,
  `engine/broad_phase.ts`. _Tests:_ `tests/lifecycle/{shape_lifecycle,
shape_pose_sync, demo_arena_walls}.test.ts`.
- **M7-4 — Pose sync + step.** Rewrite `pose_sync_in.ts`, `pose_sync_out.ts`,
  `step.ts`. Delete `engine/step.ts`, `engine/solver.ts`, `engine/collide.ts`,
  `engine/island.ts`, all of `manifold/`, `narrow_phase.ts`, `distance.ts`,
  `ccd.ts`. _Tests:_ `tests/lifecycle/{hello_world, gravity, pose_sync,
ignore_source, friction_ramp, chain_collision, contacts, contact_teardown,
live_contact_invalidation}.test.ts`, `tests/ccd/ccd.test.ts`.

### Parallel band (after M7-4, any order)

- **M7-5 — Forces & impulses.** Rewrite `forces.ts`,
  `impulse_accumulate.ts`, `impulse_zero.ts`. Depends on M7-2.
  _Tests:_ `tests/forces/forces.test.ts`.
- **M7-6 — Kinematic targets.** Rewrite `kinematic.ts`. Depends on M7-2.
  _Tests:_ `tests/kinematic/kinematic_targets.test.ts`.
- **M7-7 — Material / filter / mass.** Rewrite `material_filter_sync.ts`,
  `mass_recompute.ts`. Delete `engine/mass.ts`. Depends on M7-3.
  _Tests:_ `tests/lifecycle/{material_filter_sync, mass_flag_sync}.test.ts`.
- **M7-8 — Events.** Rewrite `event_opt_in_sync.ts`, `events.ts`. Delete
  `engine/sensor.ts`. Depends on M7-3. _Tests:_ `tests/events/*.test.ts`.
- **M7-9 — Sleep.** Replace `installSleepHooks` + per-body sleep config.
  Delete `engine/sleep.ts`. Depends on M7-2. _Tests:_
  `tests/sleep/sleep.test.ts`,
  `tests/lifecycle/body_type_enable_bookkeeping.test.ts`.

### Closeout (sequential)

- **M7-10 — Engine purge.** Delete remaining `src/engine/`,
  `src/math/{aabb, rot, transform, constants}.ts`, engine `src/util/` files.
  Re-record `parity/cross_platform.test.ts` hash. _Verification:_ full
  suite green; `git ls-files src/engine | wc -l` → 0.
- **M7-11 — Docs & examples sweep.** Updates listed under **Docs and
  examples**. Can float earlier (in parallel with M7-5..M7-9) if done by a
  different person. _Verification:_ `npm run examples` clean.

```
       M7-1 (foundation)
          │
       M7-2 (body lifecycle)
          │
       M7-3 (shape lifecycle)
          │
       M7-4 (pose sync + step)
          │
   ┌──┬──┬┴─┬──┬──┐
  M7-5 M7-6 M7-7 M7-8 M7-9    ← parallel band
   └──┴──┴┬─┴──┴──┘
          │
       M7-10 (engine purge)
          │
       M7-11 (docs sweep)
```

**Shippability:** each ticket is a unit of review, but the branch is
**not runnable** between M7-1 and the end of M7-4 — the engine is being
torn out while the WASM backend is wired up. Treat M7-1..M7-4 as a single
shippable chunk; M7-5..M7-9 are independently testable once the critical
path lands.

## Verification

End-to-end checklist before declaring M7 done:

- `cd lib/vecs-physics && npm install && npm run typecheck && npm run lint &&
npm run test` all green.
- `npm run examples` runs all four examples to completion in Node under `tsx`.
- `npm run bench` runs without crashing and reports a speedup vs.
  pre-migration baseline; record in CHANGELOG.
- `tests/api/exports.test.ts` passes with the `preloadPhysics` export.
- `git ls-files src/engine | wc -l` → 0.
- `grep -r "from \"../engine/" src/systems/ src/components/` returns no hits.
- Spot-check the server demo that motivated the migration: the
  ball-escape symptoms from commit `9268968` are gone.
