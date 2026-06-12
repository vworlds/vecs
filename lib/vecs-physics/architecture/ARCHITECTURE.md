# vecs-physics Engineering Architecture

Status: **active, shipped.** Public API frozen at v1 (published `@vworlds/vecs-physics@1.0.x`). The simulation backend is **box2d3-wasm** (Emscripten build of Box2D v3, pinned to `box2d3-wasm@5.2.0`, upstream commit `3a4f0da8374af61293a03021c9a0b3ebcfe67948`).

This document is the stable contract: what vecs-physics looks like from the outside (public exports, components, defaults, systems, phases, lifecycle semantics) and how the adapter is wired internally. It is what tests assert against and what eng architects read before touching the package.

For where the package is going next, see:

- [`ROADMAP.md`](./ROADMAP.md) — the v2 milestone and what is deferred beyond it.
- [`PLAN-v2.md`](./PLAN-v2.md) — the detailed v2 execution plan.

> **History note.** This file was previously `PLAN.md` and carried a second half describing Milestone 7, the migration from an in-house TypeScript Box2D port to box2d3-wasm. That migration is **complete** (the `src/engine/` TS port is deleted; the package is a thin adapter over box2d3-wasm). The migration mechanics have been removed; what remains is current reality.

---

## What vecs-physics is

A 2D rigid-body physics package for Vecs. The simulation model is Box2D v3. The public model is Vecs entities and components: a body is an entity with `Body`, a shape is a child entity with `Box`/`Circle`/`Capsule`/…, forces and events are components. Users never see a `b2WorldId`, a `b2BodyId`, a contact-listener callback, or a handle.

Internally, vecs-physics is a **thin adapter** that wires Vecs lifecycle and ECS reactivity to a Box2D world running in box2d3-wasm. The adapter implements no physics math itself.

vecs-physics design is ECS-first, meaning composition of component combinations
is what drives behavior via systems, rather than a collection of methods that
perform actions. vecs-physics exposes method/function APIs only when there is no other clean,
ergonomic option via components+systems, such as one-off actions like a raycast.

## Goals and non-goals

### Goals

- **Box2D-compatible simulation behaviour.** Defaults, units, and semantics match Box2D v3. A falling box under gravity 10 m/s² lands where Box2D says it should.
- **Vecs-first API.** Components and `world.module(PhysicsModule)` are the only public surface. `world.progress(now, delta)` drives everything.
- **Zero archetype churn for hot one-shot effects.** `Impulse` and `AngularImpulse` consume silently. Event arrays clear in place. No private components flap on/off during steady-state.
- **Predictable, shallow lookups.** Force-target / shape-parent resolution checks only the immediate `ChildOf` parent. No recursive ancestor walks.
- **Deterministic step under fixed input.** Identical creation order + inputs + WASM build → identical outputs on the same host.

### Non-goals (v1)

These are deferred. The v2 milestone (see [`ROADMAP.md`](./ROADMAP.md)) takes on ray casts and spatial queries; the rest remain deferred.

- Joints, shape casts, character movers, debug rendering.
- Ray casts and AABB/overlap queries — **scheduled for v2.**
- Multithreading, SIMD. box2d3-wasm has a threaded "deluxe" build path but vecs-physics ships single-threaded (`compat` build).
- Pre-solve / custom-filter callbacks.
- A `Physics` global handle or imperative `physics.*` API. v1 is pure-component. (v2 introduces a narrow imperative **query** surface for ray casts and overlaps — see `PLAN-v2.md`.)
- Cross-platform bit-identical floats. Target is x64 Linux Node; we guarantee deterministic _order_ and run-to-run reproducibility there.

## Public API contract

The full contract lives in `docs/`. This section enumerates the surface engineering must keep stable.

### Top-level exports

```ts
import {
  // Bootstrap
  preloadPhysics, // async; loads the box2d3-wasm module once per process
  PhysicsModule, // world module that wires the engine into a world

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
  Shape, // abstract marker; the six concrete types implement it
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

### Bootstrap and module registration

```ts
export function preloadPhysics(): Promise<void>;

export type PhysicsOptions = {
  gravity?: { x: number; y: number }; // default { x: 0, y: -10 }
  fixedTimeStep?: number; // seconds, default 1/60
  subSteps?: number; // default 4
  debug?: boolean; // default false
  debugSink?: (message: string) => void; // default console.warn

  // Optional phase placement. Entity or a name (created if missing).
  preStepPhase?: Entity | string;
  stepPhase?: Entity | string;
  postStepPhase?: Entity | string;

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

export class PhysicsModule extends Module<PhysicsOptions | undefined> {
  init(options?: PhysicsOptions): void;
}
```

Canonical bootstrap:

```ts
await preloadPhysics(); // once per process; cached
world.module(PhysicsModule);
world.module(PhysicsModule, opts); // with non-default options
```

`PhysicsModule.init()` must:

1. Throw if `preloadPhysics` has not resolved (`getBox2D()` throws).
2. Register every public component via `world.component(...)` in the stable order in **Component registration order** below.
3. Declare each geometry component an implementer of the abstract `Shape` marker via `world.component(C).set(Implements, { interfaces: [Shape] })`. This makes geometry components mutually exclusive (setting one evicts any previous geometry) and lets queries/systems match `Shape` polymorphically.
4. Create or look up the three physics phases and order them after `ON_UPDATE`.
5. Create the Box2D world (`b2CreateWorld` + `b2World_SetContactTuning`).
6. Register the physics systems (listed under **System and phase pipeline**), each tagged with `PhysicsSystemTag`.
7. Allocate `PhysicsState` and bind it to the world via the `PhysicsRoot` singleton.
8. Throw if called twice on the same world.

### Authoritative component defaults

Part of the contract. Match Box2D's `b2DefaultBodyDef()`, `b2DefaultShapeDef()`, `b2DefaultFilter()`, `b2DefaultSurfaceMaterial()`.

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

All field initialisers belong on the class body so `new Component()` returns a valid, default-shaped instance — every component must work zero-arg.

`box2d3-wasm@5.2.0` exposes `Body.allowFastRotation` only on the body create definition. Changing `Body.allowFastRotation` after creation is a no-op in vecs-physics until the upstream binding exposes `b2Body_SetAllowFastRotation`.

`box2d3-wasm@5.2.0` does not expose runtime setters for `Material.rollingResistance`, `Material.tangentSpeed`, or `userMaterialId`. Changes to those fields recreate the shape so the new material values can be applied through the shape definition.

## Component model

### `Box` accessors

`Box` ships with `width`/`height` accessors that read/write `hx`/`hy`. Setting via accessor still requires `entity.modified(Box)` (or going through `entity.set(Box, { hx: … })`), because Vecs cannot detect raw property writes.

### `Vec2` in `Polygon` / `Chain`

`type Vec2 = { x: number; y: number }`. Polygons accept up to 8 vertices (Box2D's `B2_MAX_POLYGON_VERTICES`). Validate `length <= 8` and convexity **on shape creation**, not on every update.

### Forward handles on components

The Box2D forward handles live directly on the public component instances as `@internal` fields:

- `Body._bodyId: b2BodyId | undefined`
- `Shape._shapeId: b2ShapeId | b2ChainId | undefined`

They are populated by the lifecycle systems and read by every system that needs to talk to Box2D. They are never part of the serialized/public shape of the component.

### Internal / private components

Two internal, non-exported components exist on the world for engine wiring:

- **`PhysicsRoot`** — a `Singleton` component that holds `PhysicsState`. Reached via `world.get(PhysicsRoot)`, O(1). Never exported.
- **`PhysicsSystemTag`** — marks every physics **system entity** so `PhysicsPoseSyncIn` can `ignoreSource([PhysicsSystemTag])` and drop the engine's own write-back. Lives on system entities only, never on user entities.

There are **no private components on user entities.** Per-entity engine handles live on the public `Body`/`Shape` components as `@internal` fields; the remaining per-step caches live in `PhysicsState` keyed by entity id or Box2D index.

## Package layout

```text
lib/vecs-physics/
├── package.json                 (deps: @vworlds/vecs, box2d3-wasm)
├── tsconfig.json
├── vitest.config.ts
├── docs/                        (user-facing)
├── architecture/
│   ├── ARCHITECTURE.md          (this document)
│   ├── ROADMAP.md               (v2 roadmap)
│   └── PLAN-v2.md               (v2 execution plan)
├── bench/                       (stacking / falling_balls / many_movers)
├── src/
│   ├── index.ts                 Public exports.
│   ├── module.ts                PhysicsModule + options parsing + phase setup.
│   │
│   ├── components/              ECS data classes — no Box2D imports.
│   │   ├── body.ts, body_tuning.ts, shape_pose.ts, geometry.ts,
│   │   ├── material.ts, force.ts, target.ts, events.ts
│   │
│   ├── systems/                 Vecs↔Box2D adapter systems.
│   │   ├── lifecycle.ts, shape_lifecycle.ts, shape_predicates.ts,
│   │   ├── pose_sync_in.ts, pose_sync_out.ts,
│   │   ├── kinematic.ts, forces.ts, impulse_accumulate.ts, impulse_zero.ts,
│   │   ├── material_filter_sync.ts, shape_pose_sync.ts,
│   │   ├── event_opt_in_sync.ts, events.ts,
│   │   ├── mass_recompute.ts, step.ts, debug.ts, index.ts
│   │
│   ├── adapter/                 box2d3-wasm runtime, state, disposal.
│   │   ├── runtime.ts           preloadPhysics, getBox2D.
│   │   ├── state.ts             PhysicsState + PhysicsRoot/PhysicsSystemTag
│   │   │                        + registerInternalComponents + attachPhysics.
│   │   └── disposal.ts          withAllocated — .delete() discipline.
│   │
│   └── util/
│       ├── warn.ts              WarnDedupe for debug validation.
│       └── resolve_body.ts      immediate-parent Body resolution helper.
│
└── tests/                       External-API tests only.
    ├── api/, components/, lifecycle/, events/, forces/, kinematic/,
    ├── sleep/, ccd/, debug/, parity/, fuzz/
    └── fixtures + helpers.
```

Module boundaries:

- `src/components/` is pure data, no imports from `systems/` or `adapter/`.
- `src/systems/` imports `components/` and `adapter/`. Never imports another system.
- `src/adapter/` is the only place that imports `box2d3-wasm`. It exposes `PhysicsState`, `getBox2D()`, and the `withAllocated` disposal helper; systems reach the module through `state.box2d`, never by importing `box2d3-wasm` directly.

## Vecs integration

### Component registration order

Components register in this order so type ids are deterministic across module registrations:

1. `Position`, `Rotation`, `LinearVelocity`, `AngularVelocity`, `Body`.
2. `Damping`, `GravityScale`, `MotionLocks`, `Sleep`.
3. `ShapePosition`, `ShapeRotation`.
4. `Shape`, `Box`, `Circle`, `Capsule`, `Segment`, `Polygon`, `Chain`.
5. `Material`, `CollisionFilter`, `Sensor`.
6. `Force`, `Torque`, `Impulse`, `AngularImpulse`.
7. `KinematicTargetPosition`, `KinematicTargetRotation`.
8. `ContactEvents`, `SensorEvents`, `HitEvents`.
9. Internal: `PhysicsRoot` (singleton), `PhysicsSystemTag`.
10. `world.component(C).set(Implements, { interfaces: [Shape] })` for each of `Box`, `Circle`, `Capsule`, `Segment`, `Polygon`, `Chain`.
11. Phase creation/lookup, ordered after `ON_UPDATE`.
12. System creation; tag each physics system entity with `PhysicsSystemTag`.
13. `PhysicsState` allocation and attach to `PhysicsRoot`.

`ChildOf` is built into Vecs — referenced, never registered.

### Internal-state attachment

`PhysicsState` lives on a world-scoped `Singleton` component (`PhysicsRoot`):

- Marking the component singleton auto-attaches the instance to the component's own meta entity. Retrieval is `world.get(PhysicsRoot)` — O(1).
- A second `PhysicsModule` registration throws after physics exists; duplicate and cross-world wiring bugs are caught for free.
- It GCs with the world; `PhysicsRoot` is never exported.
- A non-exported `getPhysics(world)` is the only legal way to reach state.

### Entity-reference safety

`Entity` objects persist as JS objects after `entity.destroy()` — Vecs marks `_destroyed = true`. Reads are safe (`entity.get(C)` → `undefined`), writes no-op.

For event delivery:

- Events are recorded internally by Box2D **shape index** (`b2ShapeId.index1`), not Entity reference.
- At publish time we resolve `index1 → Entity` via `state.entityByShapeIndex`; if the entity has been destroyed, drop silently.

A body destroyed during the same step still gets its `endEvents` correctly emitted to the **other** shape's `ContactEvents`, provided the other shape's entity is still alive.

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

User input/gameplay phases land before `physics-pre`; user render phases after `physics-post`. Explicit phases supplied via `PhysicsOptions` still split across the same three slots in the same order.

### Hooks vs systems

v1 uses **systems** for almost everything — they batch reactivity into a phase-bound run, give a single debuggable choke point, and queue safe deferred mutations.

The one exception: `Impulse` and `AngularImpulse` accumulation uses `world.component(Impulse).onSet(...)` **hooks**, not `.update()` callbacks. Reason: a Vecs `entity.set` reuses the stored component instance (`Object.assign` in place), and a system inbox stores a **reference** to it; by drain time every queued update for that component reads the **last** value — three sets `x:1,2,3` would sum to `9` instead of the documented `6`. `onSet` fires synchronously inside `_notifyComponentSet` after each `Object.assign`, so it observes each set-time value and accumulates correctly. The hook only mutates `PhysicsState` (no structural ECS work), which is safe.

## System and phase pipeline

Each system below: phase, responsibility, and the box2d3-wasm primitives it calls.

### `PhysicsBodyLifecycle` (`physics-pre`)

Query: `Body`.

- `.enter` — read `Body`, `Position`, `Rotation`, `LinearVelocity`, `AngularVelocity`, optional tunables. Fill a `b2DefaultBodyDef()`. Call `b2CreateBody(worldId, def)`. Store the `b2BodyId` on `Body._bodyId` and register `state.entityByBodyIndex.set(bodyId.index1, entity.eid)`.
- `.exit` — read the body ID from the injected `Body` snapshot, call `b2DestroyBody(id)`, and clear the `entityByBodyIndex` slot. Box2D cascades shape destruction internally.
- `.update(Body, …)` — `type` change → `b2Body_SetType`; `enabled` → `b2Body_Enable` / `Disable`; `bullet` → `b2Body_SetBullet`. `allowFastRotation` is create-time only under `box2d3-wasm@5.2.0`.

### `PhysicsShapeLifecycle` (`physics-pre`)

Query: `{ all: [Shape, { parent: Body }] }`. All six geometry types declare `Implements: [Shape]`, so this one predicate covers every geometry type. Membership tracks geometry-with-Body-parent — covers attachment, detachment, and reparenting via one query.

- `.enter` — resolve parent body from the injected parent `Body._bodyId`. Build a `b2ShapeDef` from `Material` / `CollisionFilter` / `Sensor` / event opt-in flags / `ShapePosition` / `ShapeRotation`. Dispatch by geometry type (table below). Store the `b2ShapeId` (or `b2ChainId` for `Chain`) on `Shape._shapeId` and, for non-chain shapes, register `state.entityByShapeIndex.set(shapeId.index1, entity.eid)`.
- `.exit` — injects `[ChildOf, Shape]` so the parent link and `_shapeId` are still readable from the exit snapshot. `b2DestroyShape` (or `b2DestroyChain` for chains, branching on `instanceof Chain`); clear the `entityByShapeIndex` slot for non-chain shapes.
- `.update(Shape, …)` — single collapsed system for all six geometry types: destroy + recreate the shape, except `Capsule`/`Segment` updates with degenerate (near-zero-length) endpoints are ignored, preserving the existing valid shape (Box2D parity).
- `.update(ChildOf, …)` — reparenting between bodies = destroy under old parent, recreate under new.

| Geometry      | Call                                                                                  |
| ------------- | ------------------------------------------------------------------------------------- |
| `Box(hx, hy)` | `b2MakeOffsetBox(hx, hy, center, rot)` → `b2CreatePolygonShape(bodyId, def, poly)`    |
| `Circle`      | `b2CreateCircleShape(bodyId, def, circle)`                                            |
| `Capsule`     | `b2CreateCapsuleShape(bodyId, def, capsule)`                                          |
| `Segment`     | `b2CreateSegmentShape(bodyId, def, segment)`                                          |
| `Polygon`     | `b2ComputeHull(points)` → `b2MakePolygon(hull, radius)` → `b2CreatePolygonShape(...)` |
| `Chain`       | `b2DefaultChainDef()` + filter/material → `b2CreateChain(bodyId, chainDef)`           |

### `PhysicsMaterialFilterSync` (`physics-pre`)

- `.update(Material, …)` → `b2Shape_SetDensity(id, d, true)`, `b2Shape_SetFriction`, `b2Shape_SetRestitution`. Changes to `rollingResistance`, `tangentSpeed`, or `userMaterialId` recreate the shape because `box2d3-wasm@5.2.0` does not expose setters for those fields.
- `.update(CollisionFilter, …)` → build a `b2Filter` (32-bit fields widen to Box2D's 64-bit by zero-padding upper bits) and call `b2Shape_SetFilter`.
- `.update(Sensor, …)` — destroy + recreate the shape with `def.isSensor = true/false`. (Runtime solid↔sensor toggle has no in-place Box2D setter; recreate is the v1 path.)

### `PhysicsEventOptInSync` (`physics-pre`)

Hook-driven: when `ContactEvents` / `HitEvents` / `SensorEvents` is added or removed from a shape entity, call `b2Shape_EnableContactEvents` / `EnableHitEvents` / `EnableSensorEvents` on the corresponding `b2ShapeId`.

> **Sensor-detection note (v1 limitation, addressed in v2).** Box2D v3 only delivers a sensor overlap when **both** the sensor shape and the _other_ (visited) shape have `enableSensorEvents == true` (`box2d/src/sensor.c`). vecs-physics derives `enableSensorEvents` from the presence of a `SensorEvents` component, so a plain solid shape is invisible to sensors. See `ROADMAP.md` / `PLAN-v2.md` (UP-1) for the v2 fix.

### `PhysicsShapePoseSync` (`physics-pre`)

`.update(ShapePosition / ShapeRotation, …)` — destroy + recreate the shape under the body with the new local pose. (box2d3-wasm shapes do not expose a runtime local-pose setter; recreate is the cheap path.)

### `PhysicsPoseSyncIn` (`physics-pre`)

Treats user pose/velocity writes as teleports. Engine write-backs (from `PhysicsPoseSyncOut`, a tagged physics system) are filtered out by `ignoreSource([PhysicsSystemTag])`.

- `.update(Position, …)` → `b2Body_SetTransform(bodyId, pos, currentRotation)`
- `.update(Rotation, …)` → `b2Body_SetTransform(bodyId, currentPos, b2MakeRot(angle))`
- `.update(LinearVelocity, …)` → `b2Body_SetLinearVelocity(bodyId, vec)`
- `.update(AngularVelocity, …)` → `b2Body_SetAngularVelocity(bodyId, value)`

Entry-time initialization is **not** silenced, so a body still initializes through a tagged source. Confirmed in `tests/lifecycle/ignore_source.test.ts`.

### `PhysicsKinematicTargets` (`physics-pre`)

For each kinematic body with `KinematicTargetPosition` / `KinematicTargetRotation`: compute `v = (target - current) / dt` (clamp to `maximumLinearSpeed`), call `b2Body_SetLinearVelocity` / `SetAngularVelocity`. Rotation uses shortest-arc. If within tolerance, leave the target attached and zero the velocity. Wake the body if `wake = true`.

### `PhysicsForceGather` (`physics-pre`)

Non-reactive — re-scans force sources every step (the contract: "Force applies every physics step while it is present"). Query: `{ any: [Force, Torque] }`, with `{ up: [ChildOf, [Body]] }` injecting the parent's `Body` for the immediate-parent fallback. For each:

- `Force` → `b2Body_ApplyForceToCenter(bodyId, {x, y}, wake)`
- `Torque` → `b2Body_ApplyTorque(bodyId, value, wake)`

box2d3-wasm zeroes applied forces inside `b2World_Step` (matches Box2D), so no per-step force reset is needed on our side.

### `PhysicsImpulseAccumulate` (`physics-pre`)

Hook-driven (see **Hooks vs systems**). `world.component(Impulse).onSet(...)` and `world.component(AngularImpulse).onSet(...)` fire synchronously on each `set`, accumulating into `state.pendingLinearImpulse` / `pendingAngularImpulse` keyed by `b2BodyId`. The phase system flushes accumulators via `b2Body_ApplyLinearImpulseToCenter` / `b2Body_ApplyAngularImpulse` for each body that received any.

### `PhysicsMassRecompute` (`physics-pre`)

box2d3-wasm auto-recomputes mass when `b2Shape_SetDensity` is called with `updateBodyMass = true`. For bodies in `state.dirtyMassBodies` (e.g. after shape add/remove), call `b2Body_ApplyMassFromShapes(bodyId)`. Most steady-state frames are no-ops.

### `PhysicsDebugValidation` (`physics-pre`, debug:true only)

Structural warnings with deduplication. Issue codes (stable strings, part of the contract because users may grep logs):

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

Dedupe key: `(entity.eid, code)`. Structural changes (e.g. shape gets a parent body) drop matching entries so a re-broken structure re-warns.

### `PhysicsStep` (`physics-step`)

`b2World_Step(state.worldId, state.fixedTimeStep, state.subSteps)`. In `debug` mode it first warns once on `delta-mismatch` if the supplied delta diverges from `fixedTimeStep`.

### `PhysicsPoseSyncOut` (`physics-post`)

After `b2World_Step`, read `b2World_GetBodyEvents(worldId).moveCount` and walk `GetMoveEvent(i)` (Box2D emits these for awake bodies that moved). For each event resolve the entity via `entityByBodyIndex`, then:

- `entity.set(Position, { x, y })`
- If the entity has `Rotation`: `entity.set(Rotation, { angle })`
- If the entity has `LinearVelocity` / `AngularVelocity`: write those too.

These set commands carry the `PhysicsSystemTag` source, so `PhysicsPoseSyncIn` filters them out next frame. Static body poses are user-owned and never written back.

### `PhysicsEvents` (`physics-post`)

Poll once per step: `b2World_GetContactEvents`, `b2World_GetSensorEvents`, `b2World_GetBodyEvents`. Walk begin/end via `beginCount`/`GetBeginEvent(i)` and `endCount`/`GetEndEvent(i)`; sensor events with the same shape; hit events via `hitCount`/`GetHitEvent(i)`. Resolve `b2ShapeId.index1 → Entity` via `state.entityByShapeIndex`; push into the receiving entity's `ContactEvents.begin/end`, `SensorEvents.begin/end`, or `HitEvents.hits`. Mark the component modified once per receiving entity per step.

Silent-clear semantics for shapes that received events last step but not this step: set `length = 0` without calling `modified`. Three independent "previously touched" sets (`prevTouchedContact`, `prevTouchedSensor`, `prevTouchedHit`) are tracked per event component in `PhysicsState`.

### `PhysicsImpulseZero` (`physics-post`, after `PhysicsEvents`)

For every entity in `state.impulseEntitiesThisStep`, directly zero `Impulse.x/y` and `AngularImpulse.value` (no `modified`), then clear the set. This bypasses Vecs's modified-routing — the dirty bit stays clean and no query update events fire. `ignoreSource` cannot replace this: silent-zero must be invisible to **user** watchers too, not just to physics systems.

## Body lifecycle (semantics)

### Add `Body`

1. User: `entity.set(Body, {...})`.
2. Vecs routes the Set command; `PhysicsBodyLifecycle.enter` queues.
3. `TargetTerm` fan-out re-evaluates `ChildOf`-children with geometry — `PhysicsShapeLifecycle.enter` queues for them.
4. Physics-pre runs: body system creates the `b2BodyId`; shape system creates each child shape attached to it.

**Creation order does not matter** because `{ parent: Body }` is a `TargetTerm` with fan-out reactivity. Body-first and shape-first both work within the same frame. (Caveat: installing the module _after_ entities already exist does not currently backfill them — see UP-2 in `ROADMAP.md`.)

### Remove `Body`

`entity.remove(Body)` or `entity.destroy()` → `PhysicsBodyLifecycle.exit` → `b2DestroyBody(bodyId)`. Box2D cascades shape destruction; each child's shape-lifecycle `.exit` fires and clears the maps.

### Toggle `enabled` / Change `type`

`Body.enabled = false/true` → `b2Body_Disable`/`Enable`. `type` change → `b2Body_SetType` (Box2D handles contact teardown and solver-set move internally; documented as expensive — prefer creating with the right type).

## Shape lifecycle (semantics)

- **Add geometry under a `Body`-parent**: `world.entity().set(ChildOf, { target: body }).set(Box, {…})` → `.enter` → `b2CreateXxxShape`. If the parent lacks `Body`, the query does not match and nothing is created; debug reports `shape-without-parent-body`.
- **Change geometry component**: same component with props changed → in-place setter where box2d3-wasm exposes one (filter, density, friction, restitution), otherwise destroy + recreate (dimensions, local pose). Geometry type swap (Box → Circle) → exclusivity removes the old (`.exit` destroys), adds the new (`.enter` creates).
- **Remove / reparent**: `.exit` destroys; `.update(ChildOf, …)` reparents by destroy + recreate under the new body.
- **Chains**: `Chain` produces a `b2ChainId` representing N internal segments. Stored in the same `Shape._shapeId: b2ShapeId | b2ChainId | undefined` field; destroy/recreate branches on `instanceof Chain`.

## Force, torque, impulse handling

| Component        | Persistence              | Apply timing                                                         | Cleanup                                          |
| ---------------- | ------------------------ | -------------------------------------------------------------------- | ------------------------------------------------ |
| `Force`          | Persistent while present | Pre-step scan, `b2Body_ApplyForceToCenter`                           | Box2D zeros applied forces inside `b2World_Step` |
| `Torque`         | Same                     | `b2Body_ApplyTorque`                                                 | Same                                             |
| `Impulse`        | Reactive on Set          | Hook accumulates; pre-step flush `b2Body_ApplyLinearImpulseToCenter` | Post-step silent zero                            |
| `AngularImpulse` | Same                     | `b2Body_ApplyAngularImpulse`                                         | Same                                             |

`Force` and `Impulse` on a shape entity resolve their target body via the immediate `ChildOf` parent — no grandparent walk.

## Events pipeline contract

- **Per-step clear in place.** Arrays are owned by the user's component instance; mutate `length = 0` so any reference user code holds stays valid.
- **Modified only on new events.** Track `prevTouched*`; only `modified` for shapes receiving events this step. Silently clear arrays for shapes that had events last step but not this step.
- **Payload carries the other shape entity** (`ContactEvent.other`, etc.). Resolved from `b2ShapeId` at publish time; if the other shape's entity has been destroyed, drop silently.

## Determinism

Single-threaded. Determinism depends on:

1. **WASM build determinism** on the same host. Same box2d3-wasm binary + same inputs → same outputs on x64 Linux Node.
2. **Entity creation order.** Vecs assigns eids monotonically.
3. **Body/shape id assignment order.** box2d3-wasm assigns ids deterministically given identical create/destroy sequences.
4. **System ordering.** Phase registration, system registration, and inbox arrival order all deterministic.
5. **Map iteration.** ES Map iteration follows insertion order; index-keyed `ArrayMap`s are slot-stable.

The parity baseline (`tests/parity/cross_platform.test.ts`) is WASM-build-determined. Re-baseline if the pinned box2d3-wasm version changes.

## Vecs dependencies

| Capability                      | Vecs API                                                | Used by                                                       |
| ------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------- |
| Relationships (`ChildOf`)       | `set(ChildOf, …)`, `{ parent }`, `{ up: [ChildOf, …] }` | Shape↔body wiring, reparenting, force-target resolution.      |
| World singleton                 | `world.component(C).add(Singleton)`; `world.get(C)`     | `PhysicsRoot` state holder.                                   |
| Relationship fan-out reactivity | `TargetTerm` re-evaluates sources on target membership  | Order-independent body/shape creation.                        |
| System update silencing         | `System.ignoreSource(QueryDSL \| Query)`                | Pose-sync feedback suppression via `PhysicsSystemTag` marker. |
| Interface/exclusivity           | `Implements` with a shared marker (`Shape`)             | Polymorphic geometry query + geometry mutual exclusivity.     |
| Component hooks                 | `world.component(C).onSet/onAdd/onRemove`               | Impulse accumulation; event opt-in toggles.                   |

## Settled decisions

- **Internal state:** world-scoped `Singleton` component (`PhysicsRoot`).
- **Forward handles on components:** `Body._bodyId`, `Shape._shapeId` (`@internal`). Reverse lookups via `index1`-keyed `ArrayMap`s on `PhysicsState`.
- **Component registration order** as above; type ids deterministic.
- **System reactivity:** systems for everything except `Impulse` / `AngularImpulse`, which use synchronous `onSet` hooks.
- **Parent/child:** Vecs `ChildOf` relationship.
- **Pose-sync feedback suppression:** `PhysicsPoseSyncIn.ignoreSource([PhysicsSystemTag])`.
- **`PhysicsPoseSyncOut` writes only moved (awake dynamic) bodies.** Static poses are user-owned.
- **Silent impulse zero:** direct property writes, bypass `modified`.
- **Event array semantics:** clear-in-place, modified only on new events.
- **Geometry updates:** same-type in place where setters exist; type-swap is delete + create via exclusivity.
- **`BodyType` is a string enum** (`"static"|"kinematic"|"dynamic"`).
- **Collision filter width:** 32-bit `number` for `categoryBits` / `maskBits` (widens to Box2D's 64-bit on call). `userMaterialId` is a `number` in the public API (cast to `bigint` at the Box2D boundary). **No `bigint` in the public surface.**
- **Massless dynamic body stays massless.** Box2D keeps `mass = 0, invMass = 0` for dynamic bodies with no positive-density shapes; the body does not fall. `dynamic-body-without-density` debug check flags it.
- **Sensor mass:** sensors contribute to mass/CoM/inertia like solid shapes unless `density === 0`.

## Risks

1. **WASM init lifecycle.** `preloadPhysics` is process-global and cached. Callers must `await preloadPhysics` exactly once before any `PhysicsModule`. Tests share a single `beforeAll(async () => { await preloadPhysics(); })` per file.
2. **Emscripten manual cleanup.** Every `new b2Xxx()` and factory call leaks if not `.delete()`'d. The discipline is enforced through `withAllocated` in `src/adapter/disposal.ts`; allocations outside that helper are a review red flag. (Note: a long-lived `state.scratchVec2` and the world itself are intentionally not freed — **no world-teardown helper exists yet**; the world GCs with the process.)
3. **box2d3-wasm version pinning.** Upstream changes can shift parity baselines. Pinned via `package.json` (`5.2.0`); document the version on every parity golden.
4. **Node `navigator.hardwareConcurrency`.** box2d3-wasm reads it on init; `preloadPhysics` polyfills it from `os.cpus().length` when missing, guarded with `??=`.
5. **Single-thread `compat` build vs threaded `deluxe` build.** vecs-physics targets the `compat` path (no `crossOriginIsolated` required). The deluxe path is opt-in by environment, not by API.
