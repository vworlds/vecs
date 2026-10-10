# vecs-physics Engineering Architecture

Status: **active, shipped.** Public API frozen at v1 (published `@vworlds/vecs-physics@1.0.x`). The simulation backend is **box2d3-wasm** (Emscripten build of Box2D v3, pinned to `box2d3-wasm@5.2.0`, upstream commit `3a4f0da8374af61293a03021c9a0b3ebcfe67948`).

This document is the stable contract: what vecs-physics looks like from the outside (public exports, components, defaults, systems, phases, lifecycle semantics) and how the adapter is wired internally. It is what tests assert against and what eng architects read before touching the package.

For where the suite is going next, see the central
[`ROADMAP.md`](../../../architecture/ROADMAP.md).

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

These are deferred. Ray casts, shape casts, and spatial queries have shipped; the
remaining items live in the central [`ROADMAP.md`](../../../architecture/ROADMAP.md).

- Character movers, debug rendering. (Shape casts have shipped — see `docs/queries.md`; every Box2D joint type has shipped — see `docs/joints.md`; breakable-joint events remain deferred.)
- Multithreading, SIMD. box2d3-wasm has a threaded "deluxe" build path but vecs-physics ships single-threaded (`compat` build).
- Pre-solve / custom-filter callbacks.
- A broad imperative `Physics` global handle. The package exposes only the narrow
  `physics(world)` read-only query surface where components are not ergonomic.
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
  Detectable,

  // Forces & impulses
  Force,
  Torque,
  Impulse,
  AngularImpulse,

  // Kinematic targets
  KinematicTargetPosition,
  KinematicTargetRotation,

  // Joints
  Joint, // abstract umbrella; the seven concrete types implement it
  JointBodyA,
  JointBodyB,
  JointFrame,
  RevoluteJoint,
  DistanceJoint,
  PrismaticJoint,
  WheelJoint,
  WeldJoint,
  FilterJoint,
  MotorJoint,
  JointMotor,
  JointLimit,
  JointLinearSpring,
  JointAngularSpring,
  JointSettings,

  // Events
  ContactEvents,
  type ContactEvent,
  SensorEvents,
  type SensorEvent,
  HitEvents,
  type HitEvent,

  // Queries (read-only, see docs/queries.md)
  physics,
  BodyMotion, // filled by physics(world).bodyMotion
  type PhysicsQueries,
  type PhysicsSettings,
  type PhysicsStats,
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

1. Register `PhysicsCoreModule` with the user's options. Core throws if `preloadPhysics` has not resolved (`getBox2D()` throws), creates or looks up the three physics phases, creates the Box2D world (`b2CreateWorld` + `b2World_SetContactTuning`), allocates `PhysicsEngine`, and binds it as the `PhysicsEngine` singleton.
2. Register feature modules in the canonical system order listed under **System and phase pipeline**. Each feature module owns its components and systems, and every system is tagged with `PhysicsSystemTag`.
3. Keep startup simple for users: `await preloadPhysics(); world.module(PhysicsModule, opts)` installs everything needed for physics.
4. Let feature modules obtain `PhysicsEngine` from the singleton (`getPhysicsEngine(world)`) instead of receiving it through umbrella-module parameters.
5. Throw if called twice on the same world with configuration, via normal Vecs module semantics.

### Authoritative component defaults

Part of the contract. Match Box2D's `b2DefaultBodyDef()`, `b2DefaultShapeDef()`, `b2DefaultFilter()`, `b2DefaultSurfaceMaterial()`.

| Component                                                               | Field                                                | Default                 |
| ----------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------- |
| `Body`                                                                  | `type`                                               | `BodyType.Static`       |
|                                                                         | `bullet`                                             | `false`                 |
|                                                                         | `enabled`                                            | `true`                  |
|                                                                         | `allowFastRotation`                                  | `false`                 |
| `Position`                                                              | `x, y`                                               | `0, 0`                  |
| `Rotation`                                                              | `angle`                                              | `0`                     |
| `LinearVelocity`                                                        | `x, y`                                               | `0, 0`                  |
| `AngularVelocity`                                                       | `value`                                              | `0`                     |
| `Damping`                                                               | `linear, angular`                                    | `0, 0`                  |
| `GravityScale`                                                          | `value`                                              | `1`                     |
| `MotionLocks`                                                           | `x, y, rotation`                                     | `false, false, false`   |
| `Sleep`                                                                 | `enabled, awake, threshold`                          | `true, true, 0.05`      |
| `ShapePosition`                                                         | `x, y`                                               | `0, 0`                  |
| `ShapeRotation`                                                         | `angle`                                              | `0`                     |
| `Box`                                                                   | `hx, hy`                                             | `0.5, 0.5`              |
| `Circle`                                                                | `radius`                                             | `0.5`                   |
| `Capsule`                                                               | `x1, y1, x2, y2, radius`                             | `-0.5, 0, 0.5, 0, 0.25` |
| `Segment`                                                               | `x1, y1, x2, y2`                                     | `-0.5, 0, 0.5, 0`       |
| `Polygon`                                                               | `vertices, radius`                                   | `[], 0`                 |
| `Chain`                                                                 | `points, loop`                                       | `[], false`             |
| `Material`                                                              | `density`                                            | `1`                     |
|                                                                         | `friction`                                           | `0.6`                   |
|                                                                         | `restitution`                                        | `0`                     |
|                                                                         | `rollingResistance, tangentSpeed`                    | `0, 0`                  |
|                                                                         | `userMaterialId`                                     | `0`                     |
| `CollisionFilter`                                                       | `categoryBits`                                       | `1`                     |
|                                                                         | `maskBits`                                           | `0xffffffff`            |
|                                                                         | `groupIndex`                                         | `0`                     |
| `Force` / `Impulse`                                                     | `x, y, wake`                                         | `0, 0, true`            |
| `Torque` / `AngularImpulse`                                             | `value, wake`                                        | `0, true`               |
| `KinematicTargetPosition`                                               | `x, y, tolerance, wake`                              | `0, 0, 0.001, true`     |
| `KinematicTargetRotation`                                               | `angle, tolerance, wake`                             | `0, 0.001, true`        |
| `ContactEvents`/`SensorEvents`                                          | `begin, end`                                         | `[], []`                |
| `HitEvents`                                                             | `hits`                                               | `[]`                    |
| `JointBodyA`/`JointBodyB`                                               | exclusive relationship slot                          | target required         |
| `JointFrame`                                                            | `localAnchorA, localAnchorB`                         | `{0,0}, {0,0}`          |
|                                                                         | `referenceAngle`                                     | `0`                     |
| `DistanceJoint`                                                         | `length`                                             | `1`                     |
| `RevoluteJoint`/`PrismaticJoint`/`WheelJoint`/`WeldJoint`/`FilterJoint` | (marker)                                             | —                       |
| `MotorJoint`                                                            | `linearVelocity, maxVelocityForce`                   | `{0,0}, 0`              |
|                                                                         | `angularVelocity, maxVelocityTorque`                 | `0, 0`                  |
|                                                                         | `linearHertz, linearDampingRatio, maxSpringForce`    | `0, 0, 0`               |
|                                                                         | `angularHertz, angularDampingRatio, maxSpringTorque` | `0, 0, 0`               |
| `JointMotor`                                                            | `targetSpeed, maxForce`                              | `0, 0`                  |
| `JointLimit`                                                            | `lower, upper`                                       | `0, 0`                  |
| `JointLinearSpring`/`JointAngularSpring`                                | `hertz, dampingRatio`                                | `0, 0`                  |
| `JointSettings`                                                         | `collideConnected`                                   | `false`                 |

All field initialisers belong on the class body so `new Component()` returns a valid, default-shaped instance — every component must work zero-arg.

`box2d3-wasm@5.2.0` exposes `Body.allowFastRotation` only on the body create definition. Changing `Body.allowFastRotation` after creation is a no-op in vecs-physics until the upstream binding exposes `b2Body_SetAllowFastRotation`.

`box2d3-wasm@5.2.0` does not expose runtime setters for `Material.rollingResistance`, `Material.tangentSpeed`, or `userMaterialId`. Changes to those fields recreate the shape so the new material values can be applied through the shape definition.

## Component model

### `Box` accessors

`Box` ships with `width`/`height` accessors that read/write `hx`/`hy`. Setting via accessor still requires `entity.modified(Box)` (or going through `entity.set(Box, { hx: … })`), because Vecs cannot detect raw property writes.

### `Vec2` in `Polygon` / `Chain`

`type Vec2 = { x: number; y: number }`. Polygons accept up to 8 vertices (Box2D's `B2_MAX_POLYGON_VERTICES`). Validate `length <= 8` and convexity **on shape creation**, not on every update.

### Geometry tiers and forward handles

`Shape` is the public umbrella marker for all six geometry components. `SingleShape` is an internal, non-exported marker for geometries backed by one Box2D `b2ShapeId`: `Box`, `Circle`, `Capsule`, `Segment`, and `Polygon`. `Chain` implements `Shape` directly because Box2D represents it with a `b2ChainId` and generated segment shapes.

The Box2D forward handles live directly on component instances as `@internal` fields:

- `Body._bodyId: b2BodyId | undefined`
- `SingleShape._shapeId: b2ShapeId | undefined`
- `Chain._chainId: b2ChainId | undefined`
- `Chain._segmentIndices: number[]`
- `Joint._jointId: b2JointId | undefined` (on the abstract `Joint` base; every concrete joint type maps to one `b2JointId`)

`Chain._segmentIndices` records the `index1` slot of each generated chain segment shape so `PhysicsEvents` can resolve sensor events back to the chain entity and teardown can clear the reverse map before Box2D reuses indices. These fields are populated by lifecycle systems and read by systems that need to talk to Box2D. They are never part of the serialized/public shape of the component.

### Internal / private components

Two internal, non-exported components exist on the world for engine wiring:

- **`PhysicsEngine`** — a `Singleton` component that owns the Box2D world and per-step caches. Reached via `world.get(PhysicsEngine)`, O(1). Never exported from the package public API.
- **`PhysicsSystemTag`** — marks every physics **system entity** so `PhysicsPoseSyncIn` can `ignoreSource([PhysicsSystemTag])` and drop the engine's own write-back. Lives on system entities only, never on user entities.

There are **no private components on user entities.** Per-entity engine handles live on the public `Body`/`Shape` components as `@internal` fields; the remaining per-step caches live in `PhysicsEngine` keyed by entity id or Box2D index.

## Package layout

```text
lib/vecs-physics/
├── package.json                 (deps: @vworlds/vecs, box2d3-wasm)
├── tsconfig.json
├── vitest.config.ts
├── docs/                        (user-facing)
├── architecture/
│   └── ARCHITECTURE.md          (this document)
├── bench/                       (stacking / falling_balls / many_movers)
├── src/
│   ├── index.ts                 Public exports.
│   ├── module.ts                Public PhysicsModule umbrella.
│   │
│   ├── core/                    PhysicsCoreModule, phases, step/reaper modules.
│   ├── body/                    Body components + lifecycle, pose sync, mass modules.
│   ├── shapes/                  Shape components + lifecycle, chain, pose modules.
│   ├── materials/               Material/filter/sensor components + sync module.
│   ├── forces/                  Force/impulse components + gather/zero modules.
│   ├── kinematic/               Kinematic target components + target module.
│   ├── events/                  Event components + opt-in/publish modules.
│   ├── joints/                  Joint components + lifecycle/feature modules.
│   ├── debug/                   Debug validation module.
│   │
│   ├── adapter/                 box2d3-wasm runtime, engine, disposal.
│   │   ├── runtime.ts           preloadPhysics, getBox2D.
│   │   ├── engine.ts            PhysicsEngine + PhysicsSystemTag
│   │   │                        + registerInternalComponents + attachPhysicsEngine.
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

- Each feature folder owns its ECS data classes, systems, and Vecs module wrappers. Components stay plain data; systems and modules perform behavior.
- Feature module dependencies use `world.module(DependencyModule)` without config; re-registering is a no-op.
- Modules that need the engine read it from the `PhysicsEngine` singleton via `getPhysicsEngine(world)` after `PhysicsCoreModule` has installed it.
- `src/adapter/` is the only place that imports `box2d3-wasm`. It exposes `PhysicsEngine`, `getBox2D()`, and the `withAllocated` disposal helper; systems reach the module through `engine.box2d`, never by importing `box2d3-wasm` directly.

## Vecs integration

### Feature module ownership

Feature modules register the components they own and the systems that implement their behavior:

1. `PhysicsCoreModule`: `PhysicsEngine`, `PhysicsSystemTag`, phases, Box2D world.
2. `BodyModule`: `Position`, `Rotation`, `LinearVelocity`, `AngularVelocity`, `Body`, `Damping`, `GravityScale`, `MotionLocks`, `Sleep`, plus body lifecycle systems.
3. `ShapesModule`: `ShapePosition`, `ShapeRotation`, `Shape`, `SingleShape`, `Box`, `Circle`, `Capsule`, `Segment`, `Polygon`, `Chain`, shape `Implements` metadata, plus shape and chain lifecycle systems.
4. `MaterialsModule`: `Material`, `CollisionFilter`, `Sensor`, `Detectable`, plus material/filter/sensor sync systems.
5. `ForcesModule`: `Force`, `Torque`, `Impulse`, `AngularImpulse`, impulse hooks, force gather, and impulse drain.
6. `KinematicModule`: `KinematicTargetPosition`, `KinematicTargetRotation`, plus kinematic target driving.
7. `EventsModule`: `ContactEvents`, `SensorEvents`, `HitEvents`.
8. `JointsModule`: `JointBodyA`, `JointBodyB`, `Joint`, `RevoluteJoint`, `DistanceJoint`, `PrismaticJoint`, `WheelJoint`, `WeldJoint`, `FilterJoint`, `MotorJoint`, `JointFrame`, `JointMotor`, `JointLimit`, `JointLinearSpring`, `JointAngularSpring`, `JointSettings`, exclusive relationship metadata and the `CleanupPolicy.Delete` policy for both body slots, joint `Implements` metadata, plus joint lifecycle and feature sync systems.

`ChildOf` is built into Vecs — referenced, never registered.

`Shape` metadata: `SingleShape` implements `Shape`; `Box`, `Circle`, `Capsule`, `Segment`, and `Polygon` implement `SingleShape`; `Chain` implements `Shape` directly. Joint metadata: `RevoluteJoint`, `DistanceJoint`, `PrismaticJoint`, `WheelJoint`, `WeldJoint`, `FilterJoint`, and `MotorJoint` implement `Joint`. `JointsModule` configures `JointBodyA` and `JointBodyB` as `Exclusive` relationship slots, so adding either relationship with a different body replaces that slot's target. This relationship cardinality is separate from the mutual exclusivity of joint-type components. Both relationships set `onDeleteTarget = CleanupPolicy.Delete` (destroying a body destroys the joint entity along with it — see Settled decisions).

### Internal Engine Attachment

`PhysicsEngine` lives on a world-scoped `Singleton` component:

- The engine instance is attached to the `PhysicsEngine` component entity. Retrieval is `world.get(PhysicsEngine)` — O(1).
- A second `PhysicsModule` registration throws after physics exists; duplicate and cross-world wiring bugs are caught for free.
- It GCs with the world; `PhysicsEngine` is never exported from the package public API.
- A non-exported `getPhysicsEngine(world)` is the only legal way to reach the engine.

### Entity-reference safety

`Entity` objects persist as JS objects after `entity.destroy()` — Vecs marks `_destroyed = true`. Reads are safe (`entity.get(C)` → `undefined`), writes no-op.

For event delivery:

- Events are recorded internally by Box2D **shape index** (`b2ShapeId.index1`), not Entity reference.
- At publish time we resolve `index1 → Entity` via `engine.entityByShapeIndex`; if the entity has been destroyed, drop silently.

A body destroyed during the same step still gets its `endEvents` correctly emitted to the **other** shape's `ContactEvents`, provided the other shape's entity is still alive.

### Default phase pipeline

```text
world.progress(now, delta):
  beginFrame(delta)
    physics-pre:
      PhysicsBodyLifecycle          (Body enter/update)
      PhysicsShapeLifecycle         (single-shape enter/update + ChildOf reparent)
      PhysicsChainLifecycle         (chain enter/update + ChildOf reparent)
      PhysicsJointLifecycle         (joint enter/recreate once both bodies exist)
      PhysicsJoint{Motor,Limit,LinearSpring,AngularSpring}Sync (feature presence → Box2D setters)
      PhysicsMaterialFilterSync     (Material / CollisionFilter / Sensor)
      PhysicsEventOptInSync         (ContactEvents / HitEvents / SensorEvents opt-in)
      PhysicsShapePoseSync          (ShapePosition / ShapeRotation)
      PhysicsPoseSyncIn             (user Position / Rotation / velocity → engine)
      PhysicsKinematicTargets       (drive kinematic bodies to targets)
      PhysicsForceGather            (Force / Torque accumulate)
      PhysicsImpulseAccumulate      (drain Impulse / AngularImpulse)
      PhysicsDebugValidation        (debug: true only)
    physics-cleanup (internal):
      PhysicsReaper                 (queued joints, shapes, chains, then bodies)
      PhysicsMassRecompute          (recompute mass after removal)
    physics-step:
      PhysicsStep                   (b2World_Step)
    physics-post:
      PhysicsPoseSyncOut            (write engine pose back to components)
      PhysicsEvents                 (publish contact / hit / sensor events)
      PhysicsImpulseZero            (silently zero consumed impulses)
  endFrame()
```

User input/gameplay phases land before `physics-pre`; user render phases after `physics-post`. Explicit phases supplied via `PhysicsOptions` keep the same ordering, with internal cleanup between pre and step. Immediate lifecycle query exits enqueue teardown at the structural-change flush, so a destroy from any pre-step system reaches the reaper before stepping. A post-step destroy leaves a move event that pose-out skips with a non-throwing entity lookup; cleanup removes the body before the following step.

### Hooks vs systems

v1 uses **systems** for almost everything — they batch reactivity into a phase-bound run, give a single debuggable choke point, and queue safe deferred mutations.

The one exception: `Impulse` and `AngularImpulse` accumulation uses `world.component(Impulse).on("set", ...)` **hooks**, not `.update()` callbacks. Reason: a Vecs `entity.set` reuses the stored component instance (`Object.assign` in place), and a system inbox stores a **reference** to it; by drain time every queued update for that component reads the **last** value — three sets `x:1,2,3` would sum to `9` instead of the documented `6`. `onSet` fires synchronously inside `_notifyComponentSet` after each `Object.assign`, so it observes each set-time value and accumulates correctly. The hook only mutates `PhysicsEngine` (no structural ECS work), which is safe.

## System and phase pipeline

Each system below: phase, responsibility, and the box2d3-wasm primitives it calls.

### `PhysicsBodyLifecycle` (`physics-pre`)

Query: `Body`.

- `.enter` — read `Body`, `Position`, `Rotation`, `LinearVelocity`, `AngularVelocity`, optional tunables. Fill a `b2DefaultBodyDef()`. Call `b2CreateBody(worldId, def)`. Store the `b2BodyId` on `Body._bodyId` and register `engine.entityByBodyIndex.set(bodyId.index1, entity.eid)`.
- `PhysicsBodyTeardown` query `.exit` — immediately queue the injected body's handle and clear `Body._bodyId`. The reaper destroys it after shapes and chains and clears its reverse-index slot before Box2D can reuse it.
- `.update(Body, …)` — `type` change → `b2Body_SetType`; `enabled` → `b2Body_Enable` / `Disable`; `bullet` → `b2Body_SetBullet`. `allowFastRotation` is create-time only under `box2d3-wasm@5.2.0`.

### `PhysicsShapeLifecycle` (`physics-pre`)

Query: `{ all: [SingleShape, { parent: Body }] }`. `Box`, `Circle`, `Capsule`, `Segment`, and `Polygon` implement the internal `SingleShape` tier, so b2Shape-only work never matches chains.

- `.enter` — resolve parent body from the injected parent `Body._bodyId`. Build a `b2ShapeDef` from `Material` / `CollisionFilter` / `Sensor` / event opt-in flags / `ShapePosition` / `ShapeRotation`. Dispatch by geometry type (table below). Store the `b2ShapeId` on `SingleShape._shapeId` and register `engine.entityByShapeIndex.set(shapeId.index1, entity.eid)`.
- `PhysicsShapeTeardown` query `.exit` — immediately injects `[SingleShape, { target: [ChildOf, Entity] }]`, queues the shape handle, and marks parent mass dirty. The reaper clears the reverse-index slot and destroys the shape in cleanup.
- `.update(SingleShape, …)` — destroy + recreate the shape, except `Capsule`/`Segment` updates with degenerate (near-zero-length) endpoints are ignored, preserving the existing valid shape (Box2D parity).
- `.update(ChildOf, …)` — reparenting between bodies = destroy under old parent, recreate under new.

| Geometry      | Call                                                                                  |
| ------------- | ------------------------------------------------------------------------------------- |
| `Box(hx, hy)` | `b2MakeOffsetBox(hx, hy, center, rot)` → `b2CreatePolygonShape(bodyId, def, poly)`    |
| `Circle`      | `b2CreateCircleShape(bodyId, def, circle)`                                            |
| `Capsule`     | `b2CreateCapsuleShape(bodyId, def, capsule)`                                          |
| `Segment`     | `b2CreateSegmentShape(bodyId, def, segment)`                                          |
| `Polygon`     | `b2ComputeHull(points)` → `b2MakePolygon(hull, radius)` → `b2CreatePolygonShape(...)` |

### `PhysicsChainLifecycle` (`physics-pre`)

Query: `{ all: [Chain, { parent: Body }] }`. Chain lifecycle is split from single-shape lifecycle because chains are backed by `b2ChainId`, not `b2ShapeId`, and Box2D exposes generated segment shapes for events.

- `.enter` — resolve parent body, build a `b2ChainDef` from filter/material/sensor-event opt-in, transform each `Chain.points` entry by `ShapePosition` and `ShapeRotation`, call `b2CreateChain`, store `Chain._chainId`, then call `b2Chain_GetSegments` and register each returned segment `index1` in `engine.entityByShapeIndex` pointing to the chain entity.
- `PhysicsChainTeardown` query `.exit` — immediately injects `[Chain, { target: [ChildOf, Entity] }]`, clears every registered segment index, queues the chain for cleanup, and clears `_chainId` on the live component if present.
- `.update(Chain, …)` and `.update(ChildOf, …)` — destroy + recreate the chain.

Chains participate in sensor events only. `b2ChainDef` exposes `enableSensorEvents` but not contact or hit event flags, so `ContactEvents`/`HitEvents` runtime toggles intentionally ignore chains. Sensor opt-in changes recreate the chain because Box2D has no per-chain runtime sensor-event setter.

### `PhysicsMaterialFilterSync` (`physics-pre`)

- Single-shape `.update(Material, …)` → `b2Shape_SetDensity(id, d, true)`, `b2Shape_SetFriction`, `b2Shape_SetRestitution`. Changes to `rollingResistance`, `tangentSpeed`, or `userMaterialId` recreate the shape because `box2d3-wasm@5.2.0` does not expose setters for those fields.
- Single-shape `.update(CollisionFilter, …)` → build a `b2Filter` (32-bit fields widen to Box2D's 64-bit by zero-padding upper bits) and call `b2Shape_SetFilter`.
- Single-shape `.update(Sensor, …)` — destroy + recreate the shape with `def.isSensor = true/false`. (Runtime solid↔sensor toggle has no in-place Box2D setter; recreate is the v1 path.)
- Chain `Material`, `CollisionFilter`, and `Sensor` updates recreate the chain because Box2D does not expose in-place setters for chain material/filter/sensor state.

### `PhysicsEventOptInSync` (`physics-pre`)

Hook-driven for single shapes: when `ContactEvents` / `HitEvents` / `SensorEvents` is added or removed from a shape entity, call `b2Shape_EnableContactEvents` / `EnableHitEvents` / `EnableSensorEvents` on the corresponding `b2ShapeId`.

Chains are excluded from those b2Shape setters. When `SensorEvents` or `Detectable` changes on a chain, `PhysicsEventOptInSync:ChainSensor` recreates the chain so the creation-time `b2ChainDef.enableSensorEvents` flag matches ECS state. Box2D v3 only delivers a sensor overlap when **both** the sensor shape and the visited shape have `enableSensorEvents == true` (`box2d/src/sensor.c`), so `Detectable` makes a solid shape or chain visible to sensors without giving it its own event arrays.

### `PhysicsShapePoseSync` (`physics-pre`)

`.update(ShapePosition / ShapeRotation, …)` — destroy + recreate the single shape or chain under the body with the new local pose. Chains transform every point by the local pose before `b2CreateChain`. box2d3-wasm shapes do not expose a runtime local-pose setter; recreate is the cheap path.

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

Non-reactive — re-scans force sources every step (the contract: "Force applies every physics step while it is present"). Query: `{ any: [Force, Torque] }`, with `{ target: [ChildOf, [Body]] }` injecting the parent's `Body` for the immediate-parent fallback. For each:

- `Force` → `b2Body_ApplyForceToCenter(bodyId, {x, y}, wake)`
- `Torque` → `b2Body_ApplyTorque(bodyId, value, wake)`

A zero `Force` (`x === 0 && y === 0`) or `Torque` (`value === 0`) is skipped before the call. It applies nothing, but Box2D wakes a sleeping body for any call made with `wake = true`, so a body holding an idle thrust component would be woken again on every step and could never stay asleep. A zero load never wakes a body; `wake` applies to non-zero loads.

box2d3-wasm zeroes applied forces inside `b2World_Step` (matches Box2D), so no per-step force reset is needed on our side.

### `PhysicsImpulseAccumulate` (`physics-pre`)

Hook-driven (see **Hooks vs systems**). `world.component(Impulse).on("set", ...)` and `world.component(AngularImpulse).on("set", ...)` fire synchronously on each `set`, accumulating into `engine.pendingLinearImpulse` / `pendingAngularImpulse` keyed by `b2BodyId`. The phase system flushes accumulators via `b2Body_ApplyLinearImpulseToCenter` / `b2Body_ApplyAngularImpulse` for each body that received any. A zero impulse is ignored when it is set, before the body is resolved: it is not accumulated and its `wake` does not count. The flush skips a sum that is exactly zero (no call, no wake), so impulses that cancel out do not wake the body either.

### `PhysicsMassRecompute` (`physics-cleanup`, after the reaper)

box2d3-wasm auto-recomputes mass when `b2Shape_SetDensity` is called with `updateBodyMass = true`. For bodies in `engine.dirtyMassBodies` (e.g. after shape add/remove), call `b2Body_ApplyMassFromShapes(bodyId)`. Most steady-state frames are no-ops.

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

`b2World_Step(engine.worldId, engine.fixedTimeStep, engine.subSteps)`. In `debug` mode it first warns once on `delta-mismatch` if the supplied delta diverges from `fixedTimeStep`.

### `PhysicsPoseSyncOut` (`physics-post`)

After `b2World_Step`, read `b2World_GetBodyEvents(worldId).moveCount` and walk `GetMoveEvent(i)` (Box2D emits these for awake bodies that moved). For each event resolve the entity via `entityByBodyIndex`, then:

- `entity.set(Position, { x, y })`
- If the entity has `Rotation`: `entity.set(Rotation, { angle })`
- If the entity has `LinearVelocity` / `AngularVelocity`: write those too.

Each `set` is conditional. Box2D reports every awake body on every step and returns bit-identical values for a body that did not move or turn, while a `set` always marks the component modified (`onSet`, `update` routing, and a replicated snapshot for a networked component). So `writePose` reads the current component with `entity.get`, which inside a system is the committed state, compares it field by field with exact `!==` (no epsilon), and calls `set` only when a field differs. The compare reads the new values into locals and allocates nothing; `Position` is created by the first write, and the optional components are written only when the body already carries them. A body flying straight therefore never rewrites `Rotation` or `AngularVelocity`, and an awake body at rest writes nothing.

Embind handle ownership matters on this hot path. `GetMoveEvent(i)` and `b2Body_GetLinearVelocity` return owned heap copies, so each is `delete()`d exactly once. `move.transform`, `transform.p` and `transform.q` are views into the move event's memory (the same address on every read), not copies: read each once and never `delete()` them, because that would run a C++ destructor on an interior pointer. `move.bodyId` is a plain value object. The angle comes from `q.GetAngle()` rather than `Math.atan2(q.s, q.c)`, because Box2D's `b2Atan2` is not bit-identical to `Math.atan2` and `Rotation` output must not change.

These set commands carry the `PhysicsSystemTag` source, so `PhysicsPoseSyncIn` filters them out next frame. Static body poses are user-owned and never written back.

### `PhysicsEvents` (`physics-post`)

Poll once per step: `b2World_GetContactEvents`, `b2World_GetSensorEvents`, `b2World_GetBodyEvents`. Walk begin/end via `beginCount`/`GetBeginEvent(i)` and `endCount`/`GetEndEvent(i)`; sensor events with the same shape; hit events via `hitCount`/`GetHitEvent(i)`. Resolve `b2ShapeId.index1 → Entity` via `engine.entityByShapeIndex`; push into the receiving entity's `ContactEvents.begin/end`, `SensorEvents.begin/end`, or `HitEvents.hits`. Mark the component modified once per receiving entity per step.

Embind ownership here: `b2World_Get*Events` results, contact `GetBeginEvent(i)` and `GetHitEvent(i)` are class handles and are `delete()`d in `finally`. Contact `GetEndEvent(i)` and sensor begin/end events are plain value objects with no `delete`, so nothing is released for them (`tests/events/event_handles.test.ts` fails if a binding change turns one into a handle).

Silent-clear semantics for shapes that received events last step but not this step: set `length = 0` without calling `modified`. Three independent "previously touched" sets (`prevTouchedContact`, `prevTouchedSensor`, `prevTouchedHit`) are tracked per event component in `PhysicsEngine`.

### `PhysicsImpulseZero` (`physics-post`, after `PhysicsEvents`)

For every entity in `engine.impulseEntitiesThisStep`, directly zero `Impulse.x/y` and `AngularImpulse.value` (no `modified`), then clear the set. This bypasses Vecs's modified-routing — the dirty bit stays clean and no query update events fire. `ignoreSource` cannot replace this: silent-zero must be invisible to **user** watchers too, not just to physics systems.

## Body lifecycle (semantics)

### Add `Body`

1. User: `entity.set(Body, {...})`.
2. Vecs routes the Set command; `PhysicsBodyLifecycle.enter` queues.
3. `TargetTerm` fan-out re-evaluates `ChildOf`-children with geometry — `PhysicsShapeLifecycle.enter` queues for single shapes and `PhysicsChainLifecycle.enter` queues for chains.
4. Physics-pre runs: body system creates the `b2BodyId`; shape/chain systems create each child geometry attached to it.

**Creation order does not matter** because `{ parent: Body }` is a `TargetTerm` with fan-out reactivity. Body-first and shape-first both work within the same frame. (Requirement: `PhysicsModule` must be installed _before_ physics components are added to entities — the module is what registers those component classes, and physics wires entities through reactive systems that only observe components added on or after install. Entities created before installation are not backfilled, by design; this is documented in `docs/installation.md`. Resolved UP-2 — v2 ships this as a documentation contract, not a backfill mechanism.)

### Remove `Body`

`entity.remove(Body)` or `entity.destroy()` → `PhysicsBodyLifecycle.exit` → `b2DestroyBody(bodyId)`. Box2D cascades shape destruction; each child's shape-lifecycle `.exit` fires and clears the maps.

### Toggle `enabled` / Change `type`

`Body.enabled = false/true` → `b2Body_Disable`/`Enable`. `type` change → `b2Body_SetType` (Box2D handles contact teardown and solver-set move internally; documented as expensive — prefer creating with the right type).

## Shape lifecycle (semantics)

- **Add geometry under a `Body`-parent**: `world.entity().add(ChildOf, body).set(Box, {…})` → `.enter` → `b2CreateXxxShape`. If the parent lacks `Body`, the query does not match and nothing is created; debug reports `shape-without-parent-body`.
- **Change geometry component**: same component with props changed → in-place setter where box2d3-wasm exposes one (filter, density, friction, restitution), otherwise destroy + recreate (dimensions, local pose). Geometry type swap (Box → Circle) → exclusivity removes the old (`.exit` destroys), adds the new (`.enter` creates).
- **Remove / reparent**: `.exit` destroys; `.update(ChildOf, …)` reparents by destroy + recreate under the new body.
- **Chains**: `Chain` produces a `b2ChainId` representing N internal segments. The chain handle lives on `Chain._chainId`, and each segment `index1` is stored in `Chain._segmentIndices` and registered in `engine.entityByShapeIndex` for sensor-event resolution.

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

| Capability                      | Vecs API                                                                        | Used by                                                       |
| ------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Relationships (`ChildOf`)       | `add(ChildOf, target)`, `{ parent: … }`, `{ target: [ChildOf, …] }`             | Shape↔body wiring, reparenting, force-target resolution.      |
| Relationships (joints)          | `JointBodyA`/`JointBodyB` (`{ target: [Rel, [Body]] }`), `CleanupPolicy.Delete` | Two-body joint refs; destroying a body destroys the joint.    |
| World singleton                 | `world.component(C).add(Singleton)`; `world.get(C)`                             | `PhysicsEngine` holder.                                       |
| Relationship fan-out reactivity | `TargetTerm` re-evaluates sources on target membership                          | Order-independent body/shape/joint creation.                  |
| System update silencing         | `System.ignoreSource(QueryDSL \| Query)`                                        | Pose-sync feedback suppression via `PhysicsSystemTag` marker. |
| Interface/exclusivity           | `Implements` with a shared marker (`Shape`, `Joint`)                            | Polymorphic geometry/joint query + mutual exclusivity.        |
| Component hooks                 | `world.component(C).on("add" \| "set" \| "remove", ...)`                        | Impulse accumulation; event opt-in toggles.                   |

## Settled decisions

- **Internal engine:** world-scoped `Singleton` component (`PhysicsEngine`).
- **Forward handles on components:** `Body._bodyId`, `SingleShape._shapeId`, `Chain._chainId`, `Chain._segmentIndices`, and `Joint._jointId` (`@internal`). Reverse lookups via `index1`-keyed `ArrayMap`s on `PhysicsEngine`.
- **Joints:** a joint is its own entity with two exclusive body relationship slots (`JointBodyA`/`JointBodyB`, configured by `JointsModule` with `CleanupPolicy.Delete`), one exclusive joint-type component (`Joint` umbrella via `Implements`), an optional shared `JointFrame`, and optional feature components (`JointMotor`/`JointLimit`/`JointLinearSpring`/`JointAngularSpring`) whose **presence is the enable flag**. Adding a different body to either relationship replaces that slot's target; this relationship cardinality is independent of joint-type component exclusivity. The handle lives on the `Joint` base. `PhysicsJointLifecycle` builds the def with the box2d3-wasm local-frame API (anchors via `def.base.localFrameA.p.Set(...)`, reference angle via `localFrameA.q.SetAngle(...)`; no allocation beyond the def handle); feature sync systems apply in-place setters and call `b2Joint_WakeBodies`. `PhysicsReaper` drains `pendingJointDestroys` (before bodies) guarded by `b2Joint_IsValid`.
- **Joint cascade-delete:** destroying a connected body destroys the joint entity. `JointsModule` sets `onDeleteTarget = CleanupPolicy.Delete` on `JointBodyA` and `JointBodyB`, matching Box2D (which destroys a body's joints with the body), so a game never has to cascade joint cleanup by hand. The Box2D side needs no extra guard: the joint's lifecycle exit queues its handle on `pendingJointDestroys`, which `PhysicsReaper` drains before `pendingBodyDestroys`, so `b2DestroyJoint` runs while the joint is still valid and `b2DestroyBody` then finds none left to cascade; the `b2Joint_IsValid` guard stays as a safety net. Removing `Body` from a connected body (without destroying its entity) is not a cascade: the joint stops matching `jointWithBothBodies`, its constraint is torn down, and the joint entity stays and rebuilds when `Body` returns. This replaces the earlier "detach, not cascade-delete" decision, which left a bodiless joint entity behind (#229).
- **Component registration order** as above; wire type ids deterministic.
- **System reactivity:** systems for everything except `Impulse` / `AngularImpulse`, which use synchronous `onSet` hooks.
- **Parent/child:** Vecs `ChildOf` relationship.
- **Pose-sync feedback suppression:** `PhysicsPoseSyncIn.ignoreSource([PhysicsSystemTag])`.
- **`PhysicsPoseSyncOut` writes only moved (awake dynamic) bodies, and only the components whose value changed.** Static poses are user-owned. Equality is exact: no epsilon.
- **Silent impulse zero:** direct property writes, bypass `modified`.
- **Event array semantics:** clear-in-place, modified only on new events.
- **Geometry updates:** same-type in place where setters exist; type-swap is delete + create via exclusivity.
- **`BodyType` is a string enum** (`"static"|"kinematic"|"dynamic"`).
- **Collision filter width:** 32-bit `number` for `categoryBits` / `maskBits` (widens to Box2D's 64-bit on call). `userMaterialId` is a `number` in the public API (cast to `bigint` at the Box2D boundary). **No `bigint` in the public surface.**
- **Massless dynamic body stays massless.** Box2D keeps `mass = 0, invMass = 0` for dynamic bodies with no positive-density shapes; the body does not fall. `dynamic-body-without-density` debug check flags it.
- **Sensor mass:** sensors contribute to mass/CoM/inertia like solid shapes unless `density === 0`.

## Risks

1. **WASM init lifecycle.** `preloadPhysics` is process-global and cached. Callers must `await preloadPhysics` exactly once before any `PhysicsModule`. Tests share a single `beforeAll(async () => { await preloadPhysics(); })` per file.
2. **Emscripten manual cleanup.** Every `new b2Xxx()` and factory call leaks if not `.delete()`'d. The discipline is enforced through `withAllocated` in `src/adapter/disposal.ts`; allocations outside that helper are a review red flag. (Note: the long-lived global scratch pools (`scr_b2Vec2`/`scr_b2QueryFilter`/`scr_b2AABB` in `src/adapter/runtime.ts`) and the world itself are intentionally not freed — **no world-teardown helper exists yet**; the world GCs with the process.)
3. **box2d3-wasm version pinning.** Upstream changes can shift parity baselines. Pinned via `package.json` (`5.2.0`); document the version on every parity golden.
4. **Node `navigator.hardwareConcurrency`.** box2d3-wasm reads it on init; `preloadPhysics` polyfills it from `os.cpus().length` when missing, guarded with `??=`.
5. **Single-thread `compat` build vs threaded `deluxe` build.** vecs-physics targets the `compat` path (no `crossOriginIsolated` required). The deluxe path is opt-in by environment, not by API.
