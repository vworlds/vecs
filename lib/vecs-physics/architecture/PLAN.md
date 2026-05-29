# vecs-physics Engineering Architecture Plan

Status: draft for engineering review.
Author: architecture pass over the docs, Vecs internals, and Box2D source.
Target: v1 of `@vworlds/vecs-physics`.

## Executive Summary

`vecs-physics` is a native Vecs 2D rigid-body engine. The simulation model is Box2D's. The public model is Vecs entities and components. Users never see a `b2WorldId`, a `b2BodyId`, a callback, or a handle.

The plan ports Box2D's simulation pipeline (broad-phase BVH → narrow-phase manifolds → island building → constraint solver → sleep / writeback / events) into TypeScript, then wraps that engine in a small set of Vecs systems that read intent from components and write results back to components. The engine sits behind a private `PhysicsState` stored on a world-scoped Vecs **`Singleton` component**. Entities map to dense internal indices through (index, generation) handles. Hot solver storage is plain TypedArrays / dense object arrays; the ECS is the **interface**, not the solver representation.

The integration leans on four Vecs capabilities. The first three are load-bearing; the fourth is an optional convenience:

- **Relationships.** Parent/child is a first-class relationship component, `ChildOf extends Relationship`. A shape attaches to a body with `shape.set(ChildOf, { target: body })`. Because the parent link is a component, retargeting (reparenting) fires `onSet` and is observable through ordinary reactive queries. Queries can also inject a parent's components (`{ up: [ChildOf, [Body]] }`) and report which entity each came from (`Iter.src`).
- **World singletons.** The `Singleton` module enforces one-instance-per-world for a marked component. `PhysicsState` rides on such a component, reached in O(1) through the world.
- **System update silencing.** `System.ignoreSource(source: QueryDSL | Query)` lets a system ignore update events that originated from any system matched by the predicate. The pose write-back system and the teleport-input system are both physics systems, so the input system silences the physics group and never mistakes the engine's own write-back for a user teleport.
- **Query grouping (optional).** `Query.groupBy(...)`, including `groupBy(ChildOf)` to bucket entities by parent, is noted where it could simplify per-body work; the plan does not depend on it.

We are not wrapping a JavaScript Box2D. We are porting Box2D's architecture, math, and algorithms, choosing TypeScript idioms where they win and skipping pieces that exist only to serve multithreading or C-API ergonomics. v1 is single-threaded.

v1 covers: bodies, shapes (Box/Circle/Capsule/Segment/Polygon/Chain), materials, filters, sensors, forces, torques, impulses, kinematic targets, contact/hit/sensor events, sleep, optional debug validation, and a fixed-step pipeline. v1 explicitly **excludes** ray casts, shape casts, AABB queries, joints, character movers, multithreading, and pre-solve callbacks. The architecture must not block these but does not implement them.

Recommendation at the end of this document: engineering can begin immediately on Milestone 0 (math + components + scaffolding) without further design review. The pipeline architecture (Milestones 1–4) has two open questions worth flagging before solver work starts.

## Goals And Non-Goals

### Goals

- Box2D-compatible simulation behaviour. A falling box under gravity 10 m/s² should land at the same position in vecs-physics and Box2D within tight float tolerance.
- Vecs-first API. Bodies, shapes, materials, forces, events are components. `installPhysics(world, opts)` is the only entry point. `world.progress(now, delta)` drives everything.
- Zero archetype churn for hot one-shot effects. `Impulse` and `AngularImpulse` consume silently. Event arrays clear in place. No private components flap on/off during steady-state.
- Predictable, shallow lookups. Shape-of-parent and force-target resolution check only the immediate parent. No recursive ancestor walks.
- Deterministic single-thread step. Identical creation order and inputs → identical outputs.

### Non-Goals (v1)

- Joints, ray casts, shape casts, AABB overlap, character movers, debug rendering. Roadmap'd.
- Multithreading, SIMD, constraint-graph color partitioning. Pure single-threaded TGS-style solver.
- Pre-solve / custom-filter callbacks. The world solver does not invoke user code mid-step.
- A `Physics` global handle, `physics.*` imperative API, or any non-component way to inspect the simulation. Engineering must resist the urge.
- Cross-platform / cross-engine bit-identical floats. The target platform is **x64 Linux**; we guarantee deterministic _order_ and run-to-run reproducibility there, and parity with Box2D within float tolerance — not bit-equality with the C build or identical results on other architectures.

## Public API Contract

The full contract lives in `docs/`. This section enumerates the surface the engineering plan must keep stable.

### Top-level Exports

```ts
import {
  installPhysics, // function

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

### `installPhysics` Signature

```ts
export type PhysicsOptions = {
  gravity?: { x: number; y: number }; // default { x: 0, y: -10 }
  fixedTimeStep?: number; // seconds, default 1/60
  subSteps?: number; // default 4
  debug?: boolean; // default false

  // Optional phase placement. Either pass an IPhase or a name (created if missing).
  preStepPhase?: import("@vworlds/vecs").IPhase | string;
  stepPhase?: import("@vworlds/vecs").IPhase | string;
  postStepPhase?: import("@vworlds/vecs").IPhase | string;

  // Optional thresholds and tunables, all with Box2D-aligned defaults.
  restitutionThreshold?: number; // m/s, default 1.0
  hitEventThreshold?: number; // m/s, default 10.0
  contactHertz?: number; // default 30
  contactDampingRatio?: number; // default 10
  maximumLinearSpeed?: number; // m/s, default 400
  enableSleep?: boolean; // default true
  enableContinuous?: boolean; // default true (bullet path; can be off for perf)
};

export function installPhysics(world: World, opts?: PhysicsOptions): void;
```

`installPhysics` must:

1. Register every public component class via `world.component(...)`. (`ChildOf` is built into Vecs; do not register it.)
2. Call `world.setExclusiveComponents(Box, Circle, Capsule, Segment, Polygon, Chain)`.
3. Create or look up the three physics phases. Names default to `"physics-pre"`, `"physics-step"`, `"physics-post"`.
4. Install the physics systems into those phases (listed below).
5. Allocate a `PhysicsState` and bind it to the world via a `Singleton` component (see Internal-state attachment).
6. Throw if called after `world.start()` (Vecs registration is locked).
7. Throw if called twice on the same world (single install per world).

Order in `installPhysics` matters: registration before `setExclusiveComponents` before `system(...)`. The function itself runs before `world.start()`.

### Authoritative Component Defaults

These are part of the contract. They must match Box2D's `b2DefaultBodyDef()`, `b2DefaultShapeDef()`, `b2DefaultFilter()`, `b2DefaultSurfaceMaterial()`:

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

All field initialisers belong on the class body so `new Component()` returns a valid, default-shaped instance — this is the Vecs contract (every component must work zero-arg).

## Package Layout

Recommended location: **`lib/vecs-physics/`** (already exists; scaffolding has `src/index.ts` and `tests/placeholder_test.ts`).

```text
lib/vecs-physics/
├── package.json                  (already present)
├── tsconfig.json
├── vitest.config.ts
├── docs/                         (already present)
├── architecture/
│   └── PLAN.md                   (this document)
├── src/
│   ├── index.ts                  Public exports only.
│   ├── install.ts                installPhysics, options parsing, phase setup.
│   │
│   ├── components/
│   │   ├── body.ts               Body, BodyType, Position, Rotation, LinearVelocity, AngularVelocity
│   │   ├── body_tuning.ts        Damping, GravityScale, MotionLocks, Sleep
│   │   ├── shape_pose.ts         ShapePosition, ShapeRotation
│   │   ├── geometry.ts           Box, Circle, Capsule, Segment, Polygon, Chain, Vec2
│   │   ├── material.ts           Material, CollisionFilter, Sensor
│   │   ├── force.ts              Force, Torque, Impulse, AngularImpulse
│   │   ├── target.ts             KinematicTargetPosition, KinematicTargetRotation
│   │   └── events.ts             ContactEvents, SensorEvents, HitEvents + payload types
│   │
│   ├── systems/
│   │   ├── lifecycle.ts          Body / shape create-destroy-update + reparent (ChildOf) systems.
│   │   ├── pose_sync_in.ts       Teleports: Position/Rotation/velocity user-writes → engine.
│   │   ├── forces.ts             Force/Torque gather + Impulse/AngularImpulse accumulation.
│   │   ├── kinematic.ts          KinematicTargetPosition/Rotation drive.
│   │   ├── step.ts               PhysicsStep — invokes engine.step(dt, subSteps).
│   │   ├── pose_sync_out.ts      Writeback: engine → Position/Rotation/velocity components.
│   │   ├── events.ts             ContactEvents, HitEvents, SensorEvents publish.
│   │   └── debug.ts              Debug validation (only registered if debug:true).
│   │
│   ├── engine/
│   │   ├── state.ts              PhysicsState + Singleton (PhysicsRoot) accessor.
│   │   ├── body.ts               InternalBody, BodySim, BodyState; create/destroy/transfer.
│   │   ├── shape.ts              InternalShape, geometry helpers, mass per shape.
│   │   ├── broad_phase.ts        BroadPhase wrapping the DynamicTree per body type.
│   │   ├── dynamic_tree.ts       Self-balancing BVH (Box2D-equivalent).
│   │   ├── narrow_phase.ts       Pair → manifold dispatch table.
│   │   ├── manifold/             Per-pair manifold algos (circle-circle, polygon-polygon, etc.).
│   │   ├── contact.ts            Contact lifecycle, contact list per body, contact persistence.
│   │   ├── island.ts             Island build/merge/split; sleep candidates.
│   │   ├── solver.ts             TGS solver — prepare, integrateVel, warmStart, solve, integratePos, relax, restitution, store.
│   │   ├── sensor.ts             Sensor overlap detection + double-buffered visitor lists.
│   │   ├── mass.ts               b2ComputeShapeMass / b2UpdateBodyMassData equivalents.
│   │   ├── ccd.ts                Continuous collision (bullet path). Optional; gate behind enableContinuous.
│   │   └── step.ts               World.step orchestrator — calls broad → narrow → island → solver → sensors → events.
│   │
│   ├── math/
│   │   ├── vec2.ts               b2Vec2 ops (Add/Sub/MulSV/Dot/Cross/Length/Normalize/...).
│   │   ├── rot.ts                b2Rot ops (MakeRot, Mul, InvMul, GetAngle, NormalizeRot).
│   │   ├── transform.ts          b2Transform ops (TransformPoint, InvTransformPoint, ...).
│   │   ├── aabb.ts               AABB union/intersect/contains/perimeter.
│   │   └── constants.ts          LINEAR_SLOP, MAX_ROTATION, SPECULATIVE_DISTANCE, MAX_AABB_MARGIN, TIME_TO_SLEEP, PI...
│   │
│   └── util/
│       ├── handle.ts             BodyHandle, ShapeHandle (index+generation), null sentinels.
│       ├── id_pool.ts            Index allocator with generation counter.
│       ├── dense_array.ts        Swap-pop array helper used by solver sets.
│       ├── warn.ts               Debug-warning dedupe (Map<eid, Set<issueCode>>).
│       └── bitset.ts             Thin wrapper or re-export of `@vworlds/vecs`'s Bitset.
│
└── tests/
    ├── components/               Defaults, registration, exclusivity.
    ├── lifecycle/                Body/shape create-destroy-update.
    ├── forces/                   Force persistence, multi-source, impulse accumulation, silent zero.
    ├── kinematic/                Target convergence, tolerance behaviour.
    ├── events/                   Contact/hit/sensor opt-in, clearing semantics.
    ├── debug/                    Warning emission + dedupe.
    ├── parity/                   Box2D ports (one folder per Box2D test we mirror).
    ├── fixtures/                 Helpers — make a world, drive N fixed steps, snapshot tolerances.
    └── helpers.ts                Common setup utilities.
```

Module boundaries:

- `src/components/` defines exported classes and types. No imports from `src/engine` or `src/systems`. Pure data.
- `src/systems/` glue Vecs callbacks to the engine. Imports `components/` and `engine/`. Never imports another system.
- `src/engine/` is a self-contained physics engine. It must not import from `components/` or `systems/`. It takes plain numbers and returns plain numbers / event structs. Public API of the engine is a single `class World` plus helper free functions.
- `src/math/` and `src/util/` are leaf modules with no upward imports.

This boundary lets engineers unit-test the engine without spinning up a Vecs world. It also lets us swap the ECS wiring later without rewriting the solver.

## Component Model

All public components are listed in the public API contract. Two non-obvious design notes:

### Box accessors

`Box` ships with `width`/`height` accessors that read/write `hx`/`hy`. These are getter/setter pairs. Important Vecs detail: when user calls `box.width = 2`, the field changes but Vecs has no way to detect it. So we document: setting via accessor still requires `entity.modified(Box)` or going through `entity.set(Box, { hx: ... })`. The accessor exists for ergonomics on read paths and for cases where the user already wraps the mutation in `getMut(Box)` (which marks modified).

### Vec2 in Polygon / Chain

Use `type Vec2 = { x: number; y: number }`, a plain shape. Polygons accept up to `B2_MAX_POLYGON_VERTICES` (8). Engineering note: validate `vertices.length <= 8` and convexity on shape creation, **not** on every component update.

### Internal / private components

We need **no private components** for v1. All internal state lives in `PhysicsState`. Reasons:

- Private components increase archetype churn (every body would flip archetype when added).
- They're slower than direct storage because every read goes through ArrayMap lookup.
- The Vecs scaffolding for them already exists, but using it for engine state pollutes the user-visible component registry and `entity.components` iteration.

No private marker is needed to track a shape's parent body: the parent link _is_ a component (`ChildOf`), so reparenting is observed directly via a reactive `.update(ChildOf, ...)` callback in the lifecycle system. See **Shape Lifecycle → Reparent shape**.

One internal component does exist: a marker tagging every physics **system entity** (systems are entities in Vecs) so the pose-sync input system can `ignoreSource` the group. It is internal, registered by `installPhysics`, never exported, and lives on system entities only — not on user entities — so it adds zero per-entity archetype churn. See **Pose And Velocity Synchronization**.

## Internal Data Model

### State container

```ts
// engine/state.ts (sketch)
export class PhysicsState {
  // Configuration
  gravityX: number;
  gravityY: number;
  fixedTimeStep: number;
  subSteps: number;
  debug: boolean;
  // ...other tunables

  // Storage
  bodies: BodyStorage;
  shapes: ShapeStorage;
  contacts: ContactStorage;
  broadPhase: BroadPhase;
  islands: IslandStorage;
  sensors: SensorStorage;

  // Maps between Vecs and engine
  bodyByEntity: Map<number /* eid */, BodyHandle>;
  shapeByEntity: Map<number /* eid */, ShapeHandle>;

  // Event scratch — per-step, cleared at top of each step
  contactBeginEvents: ContactEventRaw[];
  contactEndEvents: ContactEventRaw[];
  contactHitEvents: ContactHitEventRaw[];
  sensorBeginEvents: SensorEventRaw[];
  sensorEndEvents: SensorEventRaw[];
  bodyMoveEvents: BodyMoveEventRaw[];

  // Pending impulse accumulators keyed by internal body index
  pendingLinearImpulse: Float32Array;
  pendingAngularImpulse: Float32Array;
  pendingImpulseWake: Uint8Array;

  // Debug warning dedupe
  warned: Map<number, Set<string>>;

  // Step counter (monotonic, for determinism + event tagging)
  stepIndex: number;
}

// The state rides on a world singleton component. `PhysicsRoot` is internal —
// registered and marked singleton by installPhysics, never exported.
class PhysicsRoot {
  state!: PhysicsState;
}

export function attachPhysics(world: World, state: PhysicsState): void {
  // Marking PhysicsRoot singleton auto-attaches it to its own component
  // entity (the Singleton module does `target.add(target)`), so the single
  // instance is reachable via `world.get(PhysicsRoot)` with no extra entity
  // and no query.
  world.component(PhysicsRoot).add(Singleton);
  world.set(PhysicsRoot, { state });
}
export function getPhysics(world: World): PhysicsState {
  const root = world.get(PhysicsRoot) as PhysicsRoot | undefined;
  if (!root) throw new Error("installPhysics(world, ...) must be called before world.start()");
  return root.state;
}
```

`world.get(PhysicsRoot)` is an O(1) read of the component stored on its own meta entity — no per-step query, no `WeakMap`. The `Singleton` marker (from `@vworlds/vecs`) guarantees a single instance per world and throws if the package is mis-wired. See **Internal-state attachment** for the rationale.

### Body storage

Box2D splits body data three ways:

- `b2Body` — sparse, indexed by stable bodyId, contains organisational fields (set/local index, contact list head, name, generation).
- `b2BodySim` — dense, per-set, owns transform, force/torque, mass/inertia, damping, gravity scale.
- `b2BodyState` — dense, per-active-set, owns velocity + delta-pose for the solver.

For v1 we **keep the split** because it pays off the moment we get sleep working (sleeping bodies don't need `BodyState`). But we use plain object arrays instead of TypedArrays for v1 simplicity; the layout still allows a TypedArray refactor later.

```ts
// engine/body.ts (sketch)
type SolverSetIndex = number;
const STATIC_SET = 0;
const DISABLED_SET = 1;
const AWAKE_SET = 2;
const FIRST_SLEEPING_SET = 3;

interface InternalBody {
  // Organizational (sparse, indexed by bodyHandle.index)
  setIndex: number; // Which solver set this body lives in.
  localIndex: number; // Index inside that set's bodySims array.
  generation: number; // Bumped on destroy/reuse.

  // Mapping
  entity: Entity; // For events and writeback.

  // Topology
  shapeHead: ShapeHandle | null;
  shapeCount: number;
  contactKeyHead: number; // Linked-list head for contact graph; B2 encoding (contactId<<1|edge).
  contactCount: number;
  islandId: number;

  // Logical flags (replicated to BodySim/State for hot path)
  type: BodyType;
  bullet: boolean;
  enabled: boolean;
  allowFastRotation: boolean;
  enableSleep: boolean;
  awake: boolean;

  // Mass cache (also lives on BodySim; used outside hot path)
  mass: number;
  inertia: number;
  sleepThreshold: number;
  sleepTime: number;

  // Mass dirty flag — set when shapes change; cleared by mass recompute step.
  massDirty: boolean;
}

interface BodySim {
  transformX: number;
  transformY: number;
  cos: number;
  sin: number;
  centerX: number;
  centerY: number; // world center of mass
  localCenterX: number;
  localCenterY: number;
  rotation0Cos: number;
  rotation0Sin: number;
  center0X: number;
  center0Y: number; // previous-step center for TOI
  forceX: number;
  forceY: number;
  torque: number;
  invMass: number;
  invInertia: number;
  minExtent: number;
  maxExtent: number;
  linearDamping: number;
  angularDamping: number;
  gravityScale: number;
  bodyId: number; // back-pointer to sparse InternalBody index.
  flags: number; // bullet, dirtyMass, lockX/Y/rot.
}

interface BodyState {
  vx: number;
  vy: number;
  omega: number;
  flags: number;
  // Solver-local delta pose; reset each step.
  deltaPosX: number;
  deltaPosY: number;
  deltaRotCos: number;
  deltaRotSin: number;
}
```

### Shape storage

```ts
interface InternalShape {
  generation: number;
  bodyHandle: BodyHandle;
  entity: Entity;
  prevShape: ShapeHandle | null;
  nextShape: ShapeHandle | null;

  type: ShapeType; // 0=circle, 1=capsule, 2=segment, 3=polygon, 4=chainSegment
  geometry: GeometryUnion; // Tagged union; see below.

  density: number;
  friction: number;
  restitution: number;
  rollingResistance: number;
  tangentSpeed: number;
  userMaterialId: number;

  categoryBits: number; // 32-bit
  maskBits: number; // 32-bit
  groupIndex: number;

  sensor: boolean;
  enableContactEvents: boolean; // Mirrors presence of ContactEvents on the entity.
  enableHitEvents: boolean;
  enableSensorEvents: boolean;

  localCentroidX: number;
  localCentroidY: number;
  aabbMinX: number;
  aabbMinY: number;
  aabbMaxX: number;
  aabbMaxY: number;
  fatAabbMinX: number;
  fatAabbMinY: number;
  fatAabbMaxX: number;
  fatAabbMaxY: number;
  proxyKey: number; // Broad-phase proxy id.
  sensorIndex: number; // Into PhysicsState.sensors, or -1.

  // Shape-local pose, from ShapePosition + ShapeRotation.
  localX: number;
  localY: number;
  localCos: number;
  localSin: number;
}

type GeometryUnion =
  | { kind: "circle"; cx: number; cy: number; radius: number }
  | { kind: "capsule"; ax: number; ay: number; bx: number; by: number; radius: number }
  | { kind: "segment"; ax: number; ay: number; bx: number; by: number }
  | {
      kind: "polygon";
      vertices: Float32Array;
      normals: Float32Array;
      count: number;
      radius: number;
      centroidX: number;
      centroidY: number;
    }
  | {
      kind: "chainSegment";
      ghost1X: number;
      ghost1Y: number;
      ax: number;
      ay: number;
      bx: number;
      by: number;
      ghost2X: number;
      ghost2Y: number;
      chainId: number;
    };
```

We **don't** preserve Box2D's `b2ChainShape` aggregate as a public concept beyond the user-facing `Chain` component. Internally a `Chain` component produces N `chainSegment` shapes, each its own InternalShape with `prevShape`/`nextShape` ghost vertices for one-sided collision. The owning Chain entity gets a single ShapeHandle that points to the first segment; we walk the linked list for cleanup.

### Contact storage

```ts
interface InternalContact {
  generation: number;
  shapeA: ShapeHandle;
  shapeB: ShapeHandle;
  bodyA: BodyHandle;
  bodyB: BodyHandle;
  edges: [ContactEdge, ContactEdge]; // body→contact linked-list nodes
  islandId: number;
  setIndex: number;
  localIndex: number;
  flags: number;
  manifold: Manifold;
  friction: number;
  restitution: number;
  rollingResistance: number;
  tangentSpeed: number;
  invMassA: number;
  invIA: number;
  invMassB: number;
  invIB: number;
  cache: SimplexCache;
}
```

### Broad-phase

One `DynamicTree` per `BodyType` (3 trees: static, kinematic, dynamic). When a body changes type, its proxies migrate. `moveSet` records proxies that need pair queries this step. `pairSet` records existing contacts (hash set of (shapeA, shapeB) tuples).

### Islands

Persistent `b2Island` records own the graph of awake bodies + their contacts. Same Box2D layout: doubly linked-list of bodies/contacts, with cached `(contactId, bodyA, bodyB)` triplets for split passes. v1 does **not** need joint links because joints are deferred.

### Solver sets

We keep the Box2D split:

- `STATIC_SET` — all static bodies.
- `DISABLED_SET` — disabled bodies.
- `AWAKE_SET` — all awake non-static bodies + their non-touching contacts.
- `FIRST_SLEEPING_SET..` — one set per sleeping island.

Without multithreading we don't strictly need contiguous arrays for SIMD, but the split makes sleep transitions O(island size) instead of O(world size), which matters for steady-state perf.

### Identifier strategy

Internal handles are `(index, generation)` tuples. **Never exposed to user code.**

```ts
type BodyHandle = { index: number; generation: number };
type ShapeHandle = { index: number; generation: number };
```

`IdPool` (mirror of `b2IdPool`):

- `acquire()` returns a free index, bumping that slot's generation.
- `release(index)` returns the slot to the free list (generation has been bumped when reused).
- `isValid(handle)` compares stored generation against `handle.generation`.

Handles are used by:

- Internal event queues (`contactBeginEvents` holds `ShapeHandle` for both sides).
- Contact lists (linked list keys hold body+edge index).
- Sensor overlap lists.
- Broad-phase proxy back-pointers.

At publish time, we resolve each handle back through `state.bodies[handle.index]`/`state.shapes[handle.index]` and, if the generation matches, emit the corresponding `Entity`. If the generation no longer matches, the body or shape was destroyed mid-step and the event is silently dropped.

This is the **only** v1 use of generations; users never see them. Without internal generations a destroyed-then-recreated shape would alias to its old contact events.

## Vecs Integration

This section is the most important non-obvious work. It defines exactly how the engine reads from and writes to Vecs.

### Component registration order in `installPhysics`

Components are registered with `world.component(Class)`. `ChildOf` is **built in** — Vecs registers it as part of its bootstrap — so the physics package only references it, never registers it.

1. `world.component(Position)`, `(Rotation)`, `(LinearVelocity)`, `(AngularVelocity)`, `(Body)`.
2. `(Damping)`, `(GravityScale)`, `(MotionLocks)`, `(Sleep)`.
3. `(ShapePosition)`, `(ShapeRotation)`.
4. `(Box)`, `(Circle)`, `(Capsule)`, `(Segment)`, `(Polygon)`, `(Chain)`.
5. `(Material)`, `(CollisionFilter)`, `(Sensor)`.
6. `(Force)`, `(Torque)`, `(Impulse)`, `(AngularImpulse)`.
7. `(KinematicTargetPosition)`, `(KinematicTargetRotation)`.
8. `(ContactEvents)`, `(SensorEvents)`, `(HitEvents)`.
9. Internal, non-exported: `(PhysicsRoot)` (singleton state holder) and `(PhysicsSystemTag)` (marks physics system entities for `ignoreSource`).
10. `world.setExclusiveComponents(Box, Circle, Capsule, Segment, Polygon, Chain)`.
11. Phase creation/lookup (defaults: `physics-pre`, `physics-step`, `physics-post`).
12. System creation (next subsection); tag each physics system entity with `PhysicsSystemTag`.
13. `PhysicsState` allocation and attach (mark `PhysicsRoot` singleton, store the state).

The exact ordering matters for deterministic component type ids: Vecs assigns ids in registration order, so registering in the same order on every world produces matching ids. Cross-instance determinism cares; tests should not.

### Internal-state attachment

**`PhysicsState` lives on a world-scoped `Singleton` component (`PhysicsRoot`).**

- Marking a component singleton (`world.component(PhysicsRoot).add(Singleton)`) auto-attaches the instance to the component's **own meta entity**. Retrieval is `world.get(PhysicsRoot)` — O(1), no query, no enter handler.
- The singleton invariant is enforced by Vecs: a second instance throws, which catches double-install and cross-world wiring bugs for free.
- It GCs with the world, and `PhysicsRoot` is never exported, so user code cannot reach `PhysicsState`.
- The state lives **inside** the world's own entity graph, so it participates in the world lifecycle (and any future world serialization/inspection) rather than in an out-of-band side table. Per-world isolation is automatic: each world has its own singleton instance, so multiple worlds in one process never collide.

A single non-exported helper, `getPhysics(world)`, is the only legal way to reach engine internals from inside the package. Engineers must avoid stuffing references to `PhysicsState` into user-visible types.

### Entity-reference safety

`Entity` objects in Vecs persist as JS objects even after `entity.destroy()` — Vecs sets `_destroyed = true` and removes the entity from the world map, but the object reference may still be held by user code or by our internal arrays. This is safe for **reads** (`entity.get(C)` returns undefined; `entity.eid` is stable; `entity.parent(ChildOf)` returns undefined once relationship cleanup has run). It is **unsafe for writes** (`entity.set` enqueues a command that `_set` will no-op via `_destroyed`).

For event delivery:

- We record events using **internal handles** (`ShapeHandle`, `BodyHandle`), not Entity references.
- At publish time, we resolve each handle and only emit an event if the handle is still valid.
- We then write to the **shape entity's** event component using `entity.get(ContactEvents) as ContactEvents | undefined`; if undefined (component was removed), drop the event silently.

This means: a body destroyed during the same step still gets its `endEvents` correctly emitted to the **other** shape's `ContactEvents` (we hold the other shape's handle; if it's still valid, we emit). If both shapes were destroyed, both events drop. That mirrors Box2D's `b2Shape_IsValid` guarding.

### Default phase pipeline

Default placement when `preStepPhase`/`stepPhase`/`postStepPhase` are not provided:

```text
world.progress(now, delta):
  beginFrame(delta)
    physics-pre:
      PhysicsLifecycle              (enter/exit/update for Body, geometry, and ChildOf reparenting)
      PhysicsMaterialFilterSync     (Material / CollisionFilter / Sensor updates)
      PhysicsShapePoseSync          (ShapePosition / ShapeRotation updates)
      PhysicsPoseSyncIn             (user Position / Rotation / velocity teleports)
      PhysicsKinematicTargets       (apply target velocities to kinematic bodies)
      PhysicsForceGather            (Force / Torque from body or immediate child)
      PhysicsImpulseAccumulate      (drain Impulse / AngularImpulse update inbox)
      PhysicsMassRecompute          (recompute mass for any body with massDirty)
    physics-step:
      PhysicsStep                   (engine.step(dt, subSteps))
    physics-post:
      PhysicsPoseSyncOut            (write engine pose back to dynamic-body components)
      PhysicsEvents                 (publish contact / hit / sensor events)
      PhysicsImpulseZero            (silently zero consumed impulse components)
  endFrame()
```

User-defined input/gameplay phases naturally land before `physics-pre`; user-defined render phases after `physics-post`. If the user passes explicit phases, the systems still split between three phases in the same order — they only differ in where they sit relative to user systems.

### System reactivity model — choosing hooks vs systems

Vecs offers two reactivity mechanisms:

1. **Hooks (`world.hook(C).onAdd / .onSet / .onRemove`)** — synchronous, fire while the command queue drains. Cheap. No inbox.
2. **System enter/update/exit callbacks** — buffered into the system's inbox, replayed at `_run`. Phase-bound.

For v1 we choose **systems for everything**. Reasons:

- Hooks fire mid-drain, sometimes between two user system bodies. Mutating engine state at that point makes it harder to reason about determinism (e.g. body creation racing against shape creation). Phase-bound system runs give us a clean batch: gather all changes, apply them once, in inbox arrival order.
- Hooks can't `entity.set(...)` safely without re-entering the queue. For zeroing impulses we need silent writes, which we do **outside** Vecs's command machinery entirely (direct property writes; see `PhysicsImpulseZero`).
- Systems give us a single, debuggable choke point per phase. This is worth more than the marginal latency of one frame's delay.

The one exception we use hooks for: nothing in v1. We may add `onRemove(Body)` later as a defensive teardown if the lifecycle system somehow misses an event, but the system path is sufficient.

## System And Phase Pipeline

Each system below lists: phase, query, callbacks, ordering. Every system runs single-threaded.

### `PhysicsLifecycle` (phase: `physics-pre`)

Owns body and shape creation/destruction. A Vecs `System` carries a single query, so this is **two cooperating systems** in `lifecycle.ts`, registered in this order so the body exists before any shape resolves its parent:

#### `PhysicsBodyLifecycle` — query `Body`

- `.enter(Iter, [Position, Rotation], (it, [pos, rot]) => { ... })` — create internal body at pos (or origin), with rotation (or 0). Read `Body.type`; read optional `Damping`/`GravityScale`/`MotionLocks`/`Sleep`/`LinearVelocity`/`AngularVelocity` from `it.entity` directly. Insert into the appropriate solver set. Add to `bodyByEntity`. **No child walk needed** — shapes attach themselves through the shape system's relationship query (below).
- `.exit((e) => { ... })` — look up `bodyByEntity[e.eid]`. Destroy the internal body: walk the internal shape linked list, destroy each shape (proxy + contacts); remove from solver set; release id. Remove from `bodyByEntity`. **Do not** touch the entity; it may already be destroyed. The shape _entities_ are handled independently by the shape system's `exit` (their `{ parent: Body }` membership drops when the parent loses `Body` or is destroyed).
- `.update(Body, (e, body) => { ... })` — `type`/`bullet`/`enabled`/`allowFastRotation` changes propagate to the internal body. Type changes go through `BodyTransfer` between solver sets. Enable/disable transfers between AWAKE_SET and DISABLED_SET.

#### `PhysicsShapeLifecycle` — query `{ all: [{ any: [Box, Circle, Capsule, Segment, Polygon, Chain] }, { parent: Body }] }`

The query matches a geometry entity **only while its immediate `ChildOf` parent has `Body`**. This single predicate covers shape attachment, detachment, and reparenting with no child-walk and no per-step scan:

- `.enter((e) => { ... })` — resolve the parent body with `e.parent(ChildOf)` → `bodyByEntity.get(parent.eid)` (guaranteed present: the body system ran first this phase, and the body must exist for the query to match). Read `ShapePosition`/`ShapeRotation`/`Material`/`CollisionFilter`/`Sensor` from `e`. Create the InternalShape, link it into the body's shape list, insert its proxy, mark `body.massDirty = true`. Add to `shapeByEntity`.
- `.exit((e) => { ... })` — destroy the internal shape (proxy, contact edges, broad-phase removal), mark the (former) parent body's mass dirty, remove from `shapeByEntity`. **Idempotent** — if the shape was already destroyed by the body system's cascade, skip. `exit` covers geometry removal, parent losing `Body`, parent destruction, and reparenting **to a non-Body**.
- `.update(Box, ...)` / `.update(Circle, ...)` / … — per-geometry: re-validate, copy to the internal shape, recompute AABB, mark mass dirty, mark the proxy enlarged so broad-phase refits.
- `.update(ChildOf, (e) => { ... })` — **reparenting between two bodies.** Membership does not change (both parents have `Body`), so neither enter nor exit fires; this callback relocates the shape: destroy the internal shape under the old body, recreate it under `e.parent(ChildOf)`, mark both bodies' mass dirty. (Reparenting to a non-Body or to nothing instead drops membership and is handled by `exit`; reparenting from a non-Body parent to a Body adds membership and is handled by `enter`.)

Because geometry components are exclusive, adding `Circle` to an entity that has `Box` fires Box exit → Circle enter; the system observes them in arrival order and destroys the old shape before creating the new one.

**Creation order does not matter.** `{ parent: Body }` is a `TargetTerm` with **fan-out reactivity**: when an entity gains `Body`, every entity pointing at it through `ChildOf` is re-evaluated. Both creation orders therefore work without any ordering assumption between body and shape:

- `body.set(Body)` then `child.set(ChildOf, { target: body }).set(Box)` → body enters; when `Box` is added and the parent already has `Body`, the child enters the shape query. Body system ran first → handle exists.
- `child.set(ChildOf, { target: body }).set(Box)` then `body.set(Body)` → child does not match yet (parent has no `Body`). When `body` gains `Body`, the fan-out re-evaluates the child, which now matches → shape `enter` fires the same frame, after the body `enter`. **No scan, no child-walk.**

### Reparenting — no dedicated system

Parenting is the `ChildOf` relationship component, so retargeting a shape is an ordinary reactive event handled inside `PhysicsShapeLifecycle` (`enter` / `exit` / `.update(ChildOf)` above): zero per-step cost, no map scan, exact event delivery. No separate reparent-tracking system exists.

### `PhysicsMaterialFilterSync` (phase: `physics-pre`)

- `.update(Material, ...)` — copy fields to internal shape. If `density` changed and body is dynamic, mark `body.massDirty = true`. Cheap.
- `.update(CollisionFilter, ...)` — copy bits, then mark all contacts on this shape as "filter dirty". The broad phase keeps the contact's AABB pair; on the next narrow-phase pass the engine re-applies filtering: any contact whose pair now fails `b2ShouldShapesCollide` is destroyed. Document the cost.
- `.update(Sensor, ...)` — Box2D forbids dynamic isSensor changes. We follow: if Sensor is added to a shape that doesn't have it, **destroy the existing shape proxy and recreate it as a sensor**. Same for removal. Conceptually identical to a geometry component change.

### `PhysicsShapePoseSync` (phase: `physics-pre`)

- `.update(ShapePosition, ...)` — copy to internal shape's local pose. Mark proxy enlarged.
- `.update(ShapeRotation, ...)` — same.

### `PhysicsPoseSyncIn` (phase: `physics-pre`)

- `.update(Position, ...)` — for the body keyed by `entity`, treat as teleport. Static/kinematic: push the new transform into the engine immediately. Dynamic: same — Box2D treats user-set transform as a teleport (with the documented "expensive" warning).
- `.update(Rotation, ...)` — same.
- `.update(LinearVelocity, ...)` — push velocity into BodyState. For static bodies: ignore (Box2D ignores velocity on static).
- `.update(AngularVelocity, ...)` — same.

**Distinguishing a user teleport from the engine's own write-back.** `PhysicsPoseSyncOut` writes simulated pose back with `entity.set(Position, { x, y })` so that user systems watching `Position` see the result. Those same Set commands would otherwise land in `PhysicsPoseSyncIn`'s own `.update(Position)` inbox next frame, where they would be misread as user teleports — a self-feedback loop. `System.ignoreSource` breaks it.

`System.ignoreSource(source: QueryDSL | Query)` makes a system ignore update events that _originated from_ any system the predicate matches. Every physics system entity is tagged with the internal `PhysicsSystemTag` marker at install (`poseSyncIn.entity.add(PhysicsSystemTag)`), and `PhysicsPoseSyncIn` declares:

```ts
poseSyncIn.ignoreSource([PhysicsSystemTag]);
```

`PhysicsPoseSyncIn` then sees `Position`/`Rotation`/`LinearVelocity`/`AngularVelocity` updates **only when they came from outside the physics group** — i.e. genuine user writes. The engine's own write-back (from `PhysicsPoseSyncOut`, a tagged physics system) is filtered at the source-attribution level, with no value comparison and no ordering dependency between the in/out systems.

Consequences:

- A user teleport in any non-physics system is honoured (it isn't in the group).
- A user teleport written from a _physics-post_ user system placed after `PhysicsPoseSyncOut` is also honoured, provided that system isn't tagged `PhysicsSystemTag` — which user systems never are.
- The order of `PhysicsPoseSyncIn` vs `PhysicsPoseSyncOut` does not affect echo suppression (it still matters for _freshness_ of the values user systems read).

`ignoreSource` is a load-bearing dependency here; its status is tracked in **Vecs Dependencies**.

### `PhysicsKinematicTargets` (phase: `physics-pre`)

- Query: `KinematicTargetPosition` or `KinematicTargetRotation` on bodies. (We `.requires(Body)` and `.update` for both target classes.)
- Per kinematic body with one or both target components present:
  - Compute required `LinearVelocity` to converge: `v = (target - current) / dt`.
  - Clamp to `maxLinearSpeed` if exceeded.
  - If `|target - current| <= tolerance`, **leave the target component in place**, do not apply target motion this step (set velocity to zero this step).
  - Wake the body if `wake = true`.
- Same for rotation: angular velocity is `(target - current) / dt`, with shortest-arc handling for angles.

Box2D's `b2Body_SetTargetTransform` does the velocity calc internally. We do it in our pre-step system because it's a few lines and lets us keep the engine signature simple.

### `PhysicsForceGather` (phase: `physics-pre`)

Persistent forces. This is **not** reactive — we re-scan force sources every step because the contract says "Force applies every physics step while it is present."

- Query: `world.filter({ any: [Force, Torque] })` — a non-reactive filter, walked once per step.
- We resolve the target body in a single pass using relationship injection, so there is no manual ancestor walk. Iterate with the `Iter` cursor and inject the body from either the entity itself or its immediate `ChildOf` parent:

  ```ts
  forceFilter.forEach(
    Iter,
    [Body, { up: [ChildOf, [Body]] }, Force, Torque],
    (it, [selfBody, parentBody, force, torque]) => {
      const body = selfBody ?? parentBody; // self wins; else immediate parent
      if (!body) return; // neither → skip (debug: force-without-target)
      const bodyEntity = selfBody ? it.entity : it.src[1]!; // src[1] = the ChildOf target
      const handle = bodyByEntity.get(bodyEntity.eid)!;
      // ...accumulate force/torque, wake as configured
    }
  );
  ```

  `{ up: [ChildOf, [Body]] }` injects the parent's `Body` (or `undefined`), and `it.src` reports which entity each slot came from — exactly the immediate-parent rule, enforced by the query engine rather than hand-written. Grandparents are never consulted because `up` resolves a single hop.
  - If `Force` is present: add to `body.forceX/forceY`. If `wake=true`, wake the body.
  - If `Torque` is present: add to `body.torque`. Same wake rule.

Forces are accumulated into `BodySim.force/torque` for the upcoming step. After the step, the engine zeroes `BodySim.force/torque` itself (Box2D does this in `update transforms`); next step we accumulate fresh values.

### `PhysicsImpulseAccumulate` (phase: `physics-pre`)

Reactive — drains `Impulse` and `AngularImpulse` update events.

- `.update(Impulse, (e, impulse) => { ... })` and `.update(AngularImpulse, (e, ai) => { ... })`.
- For each update event:
  - Resolve target body with the same immediate-parent rule as `PhysicsForceGather`: `e.get(Body)` ? `e` : `e.parent(ChildOf)?.get(Body)` ? the parent : skip. (The `up`-injection form can be used here too; for reactive `.update` callbacks the explicit `e.parent(ChildOf)` read is equally cheap.)
  - If no body → drop.
  - **Add** `impulse.x` to `pendingLinearImpulse[handle.index*2]`, `impulse.y` to `[handle.index*2+1]`. Mark wake.
  - For angular: add `ai.value` to `pendingAngularImpulse[handle.index]`.

Note the Vecs detail: each `entity.set(Impulse, {...})` emits a Set command. The lifecycle/inbox model fires `_notifyComponentSet` once per Set command, so the inbox accumulates one update event per `set` call. Multiple `set` calls between physics steps therefore become multiple inbox entries. Our update handler accumulates them into the pending impulse arrays — that's where the doc's "accumulate" guarantee is realised.

**Crucial detail on silent zero**: after the step, `PhysicsImpulseZero` (post-step) walks every entity in `shapeByEntity`/`bodyByEntity` that has an `Impulse` or `AngularImpulse` component and writes `x=y=0` (linear) or `value=0` (angular) directly:

```ts
const impulse = entity.get(Impulse) as Impulse | undefined; // bypass readonly
if (impulse) {
  impulse.x = 0;
  impulse.y = 0;
  // Do NOT call entity.modified — silent.
}
```

This bypasses Vecs's modified-routing entirely. The dirty bit stays clean; no query update events fire. Vecs holds the `Impulse` instance via internal `_components` map and we mutate the same object.

The dirty bit on the entity should also stay clean (post-step writes after the inbox has drained). To be defensive, after writing we clear `entity._dirtyComponentBitmask` for that component type — but we should **not** touch Vecs internals; instead, we just don't `modified`. The dirty bit is set by `set`/`getMut`/`modified` only. Direct property assignment doesn't set it.

This is the entire mechanism. It's important the docs are explicit (they are): direct write + no `modified` = invisible to update-watchers. We test it.

**Note on `ignoreSource` vs silent zero — they solve different problems.** `ignoreSource` lets a _consumer_ system opt out of updates from a group; it cannot stop **user** systems from waking. The silent-zero requirement is precisely that _no_ watcher — physics or user — observes the reset, so the direct-write approach stays. `ignoreSource` is not a substitute here.

### `PhysicsMassRecompute` (phase: `physics-pre`)

Last system in pre. Walks all bodies with `massDirty = true`, recomputes mass + inertia + local center from current shapes (`b2UpdateBodyMassData` equivalent):

- For each shape on the body: `b2ComputeShapeMass` returns `MassData{ mass, center, inertia }`. Combine over shapes using parallel-axis theorem.
- Dynamic body with zero total mass: zero out inertia/invInertia/invMass, set flags accordingly. Warn in debug.
- Update `body.mass`, `body.inertia`, `body.invMass`, `body.invInertia`, `body.localCenter`.
- Clear `massDirty`.

We iterate the body's **internal shape linked list** (canonical — the solver and broad-phase need it regardless), not the ECS. Only dirty bodies are visited, so cost is O(shapes on changed bodies), not O(all shapes).

**Optional, not adopted: `Query.groupBy(ChildOf)`.** Vecs can bucket shape entities by parent body (`world.filter({ any: geoms }).groupBy(ChildOf)` yields one `Group` per body, keyed by the parent `Entity`). That would let mass recompute pull a body's shapes straight from the ECS via `group(bodyEntity)`. We do **not** build on it because the internal shape list already exists and is faster (no per-entity component resolution, no key Map). `groupBy(ChildOf)` is recorded here as an available simplification if the internal list is ever dropped, and as a possible future basis for compound-body assembly diagnostics. See **Vecs Dependencies**.

### `PhysicsStep` (phase: `physics-step`)

```ts
.run((now, delta) => {
  const physics = getPhysics(world);
  const dt = physics.fixedTimeStep;
  // Document the consistency check:
  if (physics.debug && Math.abs(delta / 1000 - dt) > 1e-4) {
    warnOnce(physics, /* code */ "delta-mismatch",
      `Vecs delta=${delta}ms but fixedTimeStep=${dt*1000}ms. Physics expects fixed delta.`);
  }
  engineStep(physics, dt, physics.subSteps);
});
```

`engineStep` is the orchestrator inside `src/engine/step.ts`. It runs the Box2D pipeline:

1. Increment `stepIndex`.
2. Find pairs: `broad_phase.findNewPairs()`.
3. Create contacts: for each new pair, `contact.create()` if it passes filtering.
4. Update narrow phase: for each existing contact, compute manifold; emit begin/end touch flags.
5. Merge islands for new touches; queue split candidates for ended touches.
6. Solve constraints (TGS, `subSteps` iterations).
7. Integrate positions; update transforms; cap velocities.
8. Hit events: scan touching contacts for approach speed > threshold.
9. Refit BVH.
10. Bullet CCD pass for `b2_isBullet` bodies (skip if `enableContinuous: false`).
11. Try sleep: islands whose bodies are below sleep threshold for `> TIME_TO_SLEEP` → transition to sleeping set.
12. Sensors: query overlaps against sensor shapes; emit begin/end against double-buffered overlap arrays.

Each numbered step is the matching Box2D source file (e.g. `broad_phase.c`, `solver.c`, `sensor.c`). We port them as TypeScript modules under `src/engine/`. We do **not** port the multithreaded scheduler, parallel-for, or graph-color partitioning. The solver is one sweep over the (small set of) awake bodies and contacts.

### `PhysicsPoseSyncOut` (phase: `physics-post`)

- Iterate `state.bodyMoveEvents` — Box2D emits a per-body move event list during step 7 above for awake bodies that moved. We mirror that. For each move event:
  - Look up the entity.
  - `entity.set(Position, { x, y })` — Vecs routes a Set command, marks modified for downstream systems.
  - If the entity has `Rotation`, `entity.set(Rotation, { angle })`.
  - If the entity has `LinearVelocity`, `entity.set(LinearVelocity, { x, y })`.
  - If the entity has `AngularVelocity`, `entity.set(AngularVelocity, { value })`.

No echo bookkeeping is needed. These Set commands are attributed to this system (a `PhysicsSystemTag`-tagged physics system), so `PhysicsPoseSyncIn`'s `ignoreSource([PhysicsSystemTag])` discards them automatically next frame. They still reach user systems watching `Position`/`Rotation`/velocity, which is the contract.

For kinematic and static bodies we **do not** write back — their pose is user-owned.

### `PhysicsEvents` (phase: `physics-post`)

Publishes all event arrays. Algorithm for `ContactEvents`:

```ts
// Pseudocode
const touched: Set<number /* shape eid */> = new Set();

for (const ev of state.contactBeginEvents) {
  emitContact(ev.shapeA, ev.shapeB, "begin");
  emitContact(ev.shapeB, ev.shapeA, "begin");
}
for (const ev of state.contactEndEvents) {
  emitContact(ev.shapeA, ev.shapeB, "end");
  emitContact(ev.shapeB, ev.shapeA, "end");
}

function emitContact(self: ShapeHandle, other: ShapeHandle, kind: "begin" | "end") {
  if (!isValid(self) || !isValid(other)) return;
  const selfEntity = state.shapes[self.index].entity;
  const otherEntity = state.shapes[other.index].entity;
  const events = selfEntity.get(ContactEvents) as ContactEvents | undefined;
  if (!events) return; // shape not opted in
  touched.add(selfEntity.eid);

  // First touch this step: clear arrays in place.
  if (!state.eventsTouchedThisStep.has(selfEntity.eid)) {
    events.begin.length = 0;
    events.end.length = 0;
    state.eventsTouchedThisStep.add(selfEntity.eid);
  }
  (kind === "begin" ? events.begin : events.end).push({ other: otherEntity });
}

// After all begin/end pushed: notify modified for shapes that received events this step.
for (const eid of touched) {
  world.entity(eid)?.modified(ContactEvents);
}

// For shapes that had events LAST step but NOT this step, clear silently.
for (const eid of state.contactEventsPreviouslyTouched) {
  if (touched.has(eid)) continue;
  const e = world.entity(eid);
  if (!e) continue;
  const events = e.get(ContactEvents) as ContactEvents | undefined;
  if (!events) continue;
  if (events.begin.length === 0 && events.end.length === 0) continue;
  events.begin.length = 0;
  events.end.length = 0;
  // Silent clear — no modified.
}
state.contactEventsPreviouslyTouched = touched; // for next step
```

The same pattern for `HitEvents` and `SensorEvents`. Three independent "previously touched" sets are tracked.

This realises the docs contract: arrays are cleared and reused (user references stay valid); `modified` only fires when new events arrive; silent clears don't wake watchers.

### `PhysicsImpulseZero` (phase: `physics-post`, after `PhysicsEvents`)

```ts
.run(() => {
  const physics = getPhysics(world);
  // Walk every entity with Impulse/AngularImpulse and zero it silently.
  // We maintain side-tables in PhysicsImpulseAccumulate of "entities seen this step".
  for (const eid of physics.impulseEntitiesThisStep) {
    const e = world.entity(eid); if (!e) continue;
    const imp = e.get(Impulse) as Impulse | undefined;
    if (imp) { imp.x = 0; imp.y = 0; }
    const ai = e.get(AngularImpulse) as AngularImpulse | undefined;
    if (ai) { ai.value = 0; }
  }
  physics.impulseEntitiesThisStep.clear();
});
```

`physics.impulseEntitiesThisStep` is populated by `PhysicsImpulseAccumulate` as it sees update events. After the step we walk only those entities, not every entity in the world.

### `PhysicsDebugValidation` (phase: `physics-pre`, installed only if `debug: true`)

- Walks reactive queries that detect each issue code:
  - `shape-without-parent-body`: `{ all: [{ any: [Box, Circle, ...] }, { not: { parent: Body } }] }` — query on entry warns once per entity+code. (This is exactly the complement of `PhysicsShapeLifecycle`'s membership, so it fires for precisely the geometry entities that did _not_ attach.)
  - `dynamic-body-without-density`: after `PhysicsMassRecompute`, walk dynamic bodies whose total mass is 0.
  - `chain-too-few-points`: in geometry update handler when `Chain.points.length < 4`.
  - `polygon-invalid`: in polygon update handler when `b2ValidateHull` (ported) rejects vertices.
  - `shape-position-on-body`: query `{ all: [Body, ShapePosition] }`.
  - `position-on-shape-entity`: query `{ all: [{ any: [Box, ...] }, Position] }`. Note: shape entities **may** have Position from user code by accident; the docs flag this as a mistake.

- Each warning calls `warnOnce(physics, e.eid, code, message)`:

```ts
function warnOnce(state: PhysicsState, eid: number, code: string, msg: string) {
  let set = state.warned.get(eid);
  if (!set) {
    set = new Set();
    state.warned.set(eid, set);
  }
  if (set.has(code)) return;
  set.add(code);
  console.warn(`[vecs-physics] ${code}: ${msg}`);
}
```

When the underlying issue changes (e.g. shape gets a valid parent now), we drop the entity's code via `state.warned.get(eid)?.delete(code)`. This lets a re-broken structure re-warn.

### Interaction with Vecs deferred mode

All system bodies run inside `world.defer(...)` (Vecs does this for us in `System._run`). Mutations from inside our callbacks queue and flush between systems automatically. We rely on this:

- `PhysicsLifecycle` system can call `entity.set(...)` and `entity.destroy()` safely; flushes happen between systems in the same phase.
- `PhysicsPoseSyncOut.set(Position, ...)` queues commands that drain before the next system (`PhysicsEvents`) runs. So any query watching `Position` in `PhysicsEvents` sees the new positions.

We do **not** call `world.flush()` ourselves. The phase loop in `World.runPhase` handles it.

## Body Lifecycle

### Add `Body`

```text
user: entity.set(Body, {...})
  → Vecs queues Set command
  → routing fires:
    – entity.componentBitmask sets Body bit
    – PhysicsBodyLifecycle (query Body) re-evaluates → enter event queued
    – TargetTerm fan-out: any ChildOf-children with geometry re-evaluate →
      PhysicsShapeLifecycle enter events queued for them
  → physics-pre run() (this or next frame):
    – PhysicsBodyLifecycle.enter:
        read Position/Rotation/velocity/Damping/GravityScale/MotionLocks/Sleep
        idPool.acquire() → handle (index, generation)
        construct InternalBody, BodySim, BodyState
        place in solver set (AWAKE if dynamic, STATIC if static, etc.)
        bodyByEntity.set(eid, handle)
    – PhysicsShapeLifecycle.enter (runs after, same phase): each pre-existing
      child geometry attaches itself; body.massDirty = true
```

### Remove `Body`

```text
user: entity.remove(Body)  OR  entity.destroy()
  → Vecs queues Remove (or Destroy which iterates components)
  → PhysicsBodyLifecycle exit fires
  → PhysicsLifecycle._run:
    – handle = bodyByEntity.get(eid)
    – walk shape linked list: for each shape, destroy proxy + contacts; release shape id
    – remove body from solver set; tear down contact graph edges; clean island
    – idPool.release(handle.index); bump generation slot
    – bodyByEntity.delete(eid)
```

### Toggle `enabled` flag

`Body.enabled = false` ⇒ body moves to `DISABLED_SET`. All contacts on the body are destroyed (Box2D does this). Body is no longer broad-phased.

`enabled = true` ⇒ moves back to AWAKE_SET. Proxies recreated with `forcePairCreation = true` so contacts are discovered the next step.

This is in `PhysicsLifecycle.update(Body, ...)`.

### Change `type`

Type changes route through `b2Body_SetType` logic (in `body.c`). Internally:

- Destroy all contacts on the body.
- Move the body between solver sets (static ↔ awake ↔ disabled set transitions).
- Re-init mass (zero for static/kinematic; recompute for dynamic).
- Re-broadphase proxies in the new tree (each `BodyType` has its own DynamicTree).

We label this as "expensive" in docs and counsel users to create with the right type. We do not block it.

## Shape Lifecycle

### Add geometry component to a child entity

```text
user: world.entity().set(ChildOf, { target: body }).set(Box, {hx, hy})
  → Set(ChildOf) + Set(Box) commands queue
  → routing: child has geometry AND parent has Body →
    PhysicsShapeLifecycle query `{ all: [{ any: geoms }, { parent: Body }] }` enters
  → PhysicsShapeLifecycle.enter callback:
    – body = child.parent(ChildOf); handle = bodyByEntity.get(body.eid)
    – read ShapePosition / ShapeRotation / Material / CollisionFilter / Sensor from child
    – compute initial AABB in world space
    – idPool.acquire() → shapeHandle
    – construct InternalShape; insert into broad-phase tree of body.type
    – link into body.shapeHead linked list
    – shapeByEntity.set(eid, shapeHandle)
    – body.massDirty = true
```

If the geometry entity has no `ChildOf` parent, or its parent lacks `Body`, the query simply does not match and nothing is created — the debug system (if enabled) reports `shape-without-parent-body` instead of the lifecycle callback doing the check.

### Change geometry component

Two sub-cases:

1. **Same component, props changed** (e.g. `box.set(Box, {hx: 0.7})`): geometry update handler resizes in place; AABB recomputed; mass dirty; broad-phase proxy enlarged.
2. **Geometry type swapped** (Box → Circle): exclusivity removes Box first → `PhysicsShapeLifecycle` exit → destroy old shape. Then Circle adds → `PhysicsShapeLifecycle` enter → create new shape.

Both are correct under Vecs's natural ordering.

### Remove geometry

`PhysicsShapeLifecycle` exit fires → destroy proxy, edges, contacts touching this shape; release shape id; clear `shapeByEntity`; mark body mass dirty.

### Reparent shape

`shape.set(ChildOf, { target: newParent })`. Because `ChildOf` is a component, this is a reactive event, not a scan:

- New parent has `Body` (and old one did too) → membership unchanged → `PhysicsShapeLifecycle.update(ChildOf)` relocates the internal shape to the new body.
- New parent lacks `Body` (or is removed) → membership drops → `exit` destroys the shape.
- Old parent lacked `Body`, new one has it → membership gained → `enter` creates the shape.

No `PhysicsReparentScan`, no per-step cost.

### Chain shapes

`Chain` is a special case. One Chain component yields N internal shapes (chain segments). The shape table for a chain entity holds a list of internal handles, not just one. Cleanup walks the full list. `shapeByEntity` maps `eid → ShapeHandle[]` for chain entities only; we use a union: `ShapeHandle | ShapeHandle[]`, or a separate `chainShapeByEntity` map. Recommendation: separate map to keep the common path branch-free.

## Material And Filter Updates

`Material` change:

- Update `density`, `friction`, `restitution`, `rollingResistance`, `tangentSpeed`, `userMaterialId` on the InternalShape.
- If density changed and body is dynamic: mark `body.massDirty = true`.
- No contact rebuilding needed; friction/restitution will be mixed fresh in next narrow-phase pass.

`CollisionFilter` change:

- Update `categoryBits`, `maskBits`, `groupIndex` on the InternalShape.
- Walk contacts on the shape: any contact where `b2ShouldShapesCollide(filterA, filterB)` is now false → destroy that contact.
- Set the broad-phase proxy's `categoryBits` so subsequent pair queries respect it.
- This **does not** create new contacts. The next broad-phase pass picks up newly compatible pairs naturally.

This work happens in `PhysicsMaterialFilterSync`.

## Pose And Velocity Synchronization

Algorithm summary (already detailed in System pipeline):

| Direction     | Source                           | Mechanism                            | Notes                                                                     |
| ------------- | -------------------------------- | ------------------------------------ | ------------------------------------------------------------------------- |
| User → engine | `entity.set(Position, ...)`      | `PhysicsPoseSyncIn.update(Position)` | Always a teleport — physics' own writes are filtered by `ignoreSource`.   |
| User → engine | `entity.set(LinearVelocity,...)` | `PhysicsPoseSyncIn.update(LinearV)`  | Always applied; engine write-back filtered by the same `ignoreSource`.    |
| Engine → user | Body moved during step           | `PhysicsPoseSyncOut.run`             | `entity.set(Position, {x,y})`; reaches user watchers, ignored by pose-in. |
| Engine → user | Body velocity changed            | `PhysicsPoseSyncOut.run`             | Only writes to components present on the entity.                          |

`PhysicsPoseSyncIn.ignoreSource([PhysicsSystemTag])` drops every update that originated from a physics system, so anything the input system _does_ receive is, by construction, a user write and is treated as a teleport. No per-body pose array or value comparison is involved.

## Force, Torque, Impulse, And AngularImpulse Handling

Already detailed in System pipeline. Summary:

| Component        | Persistence              | Apply timing                           | Cleanup                                                         |
| ---------------- | ------------------------ | -------------------------------------- | --------------------------------------------------------------- |
| `Force`          | Persistent while present | Pre-step scan via filter (every step)  | Engine clears `BodySim.force` after step. User keeps component. |
| `Torque`         | Persistent while present | Same                                   | Same                                                            |
| `Impulse`        | Reactive on Set          | Pre-step from impulse-accumulate queue | Post-step silent zero, component stays.                         |
| `AngularImpulse` | Reactive on Set          | Same                                   | Same                                                            |

Multiple force sources on body + immediate children are summed naturally because the filter scan iterates all matching entities and adds to the same body's `forceX/forceY`.

Impulse accumulation across multiple `set` calls is realised because each `set` enqueues an Update command, and the system inbox accumulates one update event per Set. The accumulator adds each event's components to `pendingLinearImpulse` and zeros the entity's `impulseEntitiesThisStep` only after the step.

## Kinematic Target Handling

Pseudo-implementation already in `PhysicsKinematicTargets` system:

```ts
function applyKinematicTarget(state: PhysicsState, entity: Entity, dt: number) {
  const handle = state.bodyByEntity.get(entity.eid);
  if (!handle) return;
  const body = state.bodies[handle.index];
  if (body.type !== BodyType.Kinematic) return;

  const pos = entity.get(Position);
  const tpos = entity.get(KinematicTargetPosition);
  if (pos && tpos) {
    const dx = tpos.x - pos.x;
    const dy = tpos.y - pos.y;
    if (Math.hypot(dx, dy) > tpos.tolerance) {
      const state = getBodyState(state, handle);
      state.vx = dx / dt;
      state.vy = dy / dt;
      // Clamp to maxLinearSpeed.
      if (tpos.wake) body.awake = true;
    } else {
      // Within tolerance — leave component attached, stop moving.
      // Important: zero velocity only if previously driving this target.
    }
  }

  const rot = entity.get(Rotation);
  const trot = entity.get(KinematicTargetRotation);
  if (trot) {
    const currentAngle = rot?.angle ?? 0;
    const dAngle = shortestArc(trot.angle - currentAngle);
    if (Math.abs(dAngle) > trot.tolerance) {
      const state = getBodyState(state, handle);
      state.omega = dAngle / dt;
      if (trot.wake) body.awake = true;
    }
  }
}
```

Behaviour matches doc: target stays attached after reaching the goal; physics stops applying motion; user updating the target component re-engages.

Edge case: if the user adds `KinematicTargetPosition` to a static or dynamic body, we ignore it. Optional debug warn.

## Events Pipeline

Already detailed under `PhysicsEvents`. The contract observed:

- **Per-step clear in place.** Arrays are owned by the user's component instance. We mutate `length = 0` so any reference user code holds remains valid.
- **Modified only on new events.** Track `previouslyTouched` set; only call `modified(ContactEvents)` for shapes receiving events this step. Silently clear arrays for shapes that had events last step but not this step.
- **Payload contains other shape entity always.** We always carry shape handles, resolve to entities at publish time. The doc allows including the other body entity if it's cheap; in our pipeline we already know `shape.bodyHandle`, so we can include `otherBody` cheaply. Whether to expose it on the public type is a small follow-up; the type is permissive (`otherBody?: Entity`).
- **No global event aggregator.** Box2D's per-world event arrays don't exist publicly.

Inside the engine we still maintain raw per-step event arrays (`state.contactBeginEvents` etc.) keyed by `ShapeHandle`. They are the engine's working set; the publish system fans them out to shape entities.

## Debug Validation

Detailed under `PhysicsDebugValidation` system. Issue codes (stable strings — part of the contract because users may grep logs):

| Code                           | Trigger                                                                                       |
| ------------------------------ | --------------------------------------------------------------------------------------------- |
| `shape-without-parent-body`    | Shape entity exists without an immediate parent with `Body`.                                  |
| `dynamic-body-without-density` | Dynamic body whose total mass after recompute is zero (no positive-density non-sensor shape). |
| `chain-too-few-points`         | `Chain.points.length < 4` on shape create/update.                                             |
| `polygon-invalid`              | Polygon vertices fail convex-hull validation.                                                 |
| `shape-position-on-body`       | `ShapePosition` or `ShapeRotation` present on a body entity.                                  |
| `position-on-shape-entity`     | `Position` or `Rotation` present on a shape entity (likely mistake).                          |
| `body-component-on-shape`      | Any of `LinearVelocity`, `AngularVelocity`, `Body`, `Damping`, etc. on a shape entity.        |
| `force-without-target`         | `Force`/`Torque`/`Impulse`/`AngularImpulse` on entity whose immediate parent has no Body.     |
| `delta-mismatch`               | Vecs delta diverges from `fixedTimeStep` by > 0.1 ms.                                         |

Dedupe key: `(entity.eid, code)`. Wake-up policy:

- When the structure changes, drop matching entries. Specifically: in `PhysicsLifecycle` enter/exit callbacks, after the structural fix, we call `state.warned.get(eid)?.delete(code)` for any codes that were applicable.

Throttle behaviour: at most one warning per `(eid, code)` per session. A re-occurrence after a fix re-warns once. We do not time-throttle; the warning is structural, not noise.

## Box2D Porting Strategy

We port **algorithms and data shapes**, not the C API or the threading model. Each engine module corresponds to a Box2D source file. The mapping:

> **Port the model, not the C representation.** Don't be slavishly literal about Box2D's C-level choices. C makes decisions for reasons that don't apply in JavaScript — fixed-width integers, `void*` opaque pointers, struct packing, manual memory layout. Translate the _intent_ into the idiomatic JS form (see _TypeScript idiom decisions_ below). Two recurring cases: 64-bit fields and opaque user data.

| `lib/vecs-physics/src/engine/`   | Box2D source                                                 | Notes                                                                           |
| -------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `state.ts`                       | `physics_world.h`/`physics_world.c`                          | Strip threading, scheduler, debug bitsets we don't need.                        |
| `body.ts`                        | `body.h`/`body.c`                                            | Drop `b2BodyId` API surface; keep transfer-between-sets logic and contact list. |
| `shape.ts`                       | `shape.h`/`shape.c`                                          | Drop `b2ShapeId` API; keep geometry union and proxy management.                 |
| `broad_phase.ts`                 | `broad_phase.h`/`broad_phase.c`                              | Single tree per BodyType. Drop parallel pair processing.                        |
| `dynamic_tree.ts`                | `dynamic_tree.c`                                             | Direct port of AABB tree (rotation-balanced surface area heuristic).            |
| `manifold/circle_circle.ts` etc. | `manifold.c`                                                 | Per-pair functions: circle×circle, circle×capsule, ..., polygon×chainSegment.   |
| `narrow_phase.ts`                | `contact.c` (`b2UpdateContact`)                              | Dispatch table by shape type pair.                                              |
| `contact.ts`                     | `contact.h`/`contact.c`                                      | Persistence (`b2SimplexCache`), edge list, begin/end touch flags.               |
| `island.ts`                      | `island.h`/`island.c`                                        | Build, merge, split. No joint links in v1.                                      |
| `solver.ts`                      | `solver.c` + `contact_solver.c`                              | TGS sequential impulse, single-threaded. Same warm-start and substep stages.    |
| `solver_set.ts`                  | `solver_set.h`/`solver_set.c`                                | Sleep/wake transfers between sets.                                              |
| `sensor.ts`                      | `sensor.h`/`sensor.c`                                        | Double-buffered visitor arrays.                                                 |
| `mass.ts`                        | `shape.c` (mass helpers) + `body.c` (`b2UpdateBodyMassData`) | Per-shape inertia integrals; parallel-axis combination.                         |
| `geometry.ts`                    | `geometry.c`                                                 | Box, polygon, capsule centroid/area/perimeter; convex hull validation.          |
| `aabb.ts`                        | `aabb.c`                                                     | Union/intersect/contains/perimeter.                                             |
| `distance.ts`                    | `distance.c`                                                 | GJK + EPA used by some manifold paths and by future shape casts.                |
| `ccd.ts`                         | `solver.c` bullet path                                       | Optional; behind `enableContinuous`.                                            |
| `step.ts`                        | `solver.c::b2World_Step` orchestrator                        | Single function calling each pipeline stage.                                    |
| `math/`                          | `math_functions.c`                                           | Pure functions. No determinism trickery — we accept JS engine float behaviour.  |

**TypeScript idiom decisions:**

- **Don't mirror C's bit-widths.** Where Box2D uses a fixed-width integer (`uint64_t` filter bits, ids, hashes), use a plain JS `number` unless the value genuinely needs more than 2^53 of range. `number` is JavaScript's natural integer type; reaching for `bigint` just to match a 64-bit C field imports `bigint`'s ergonomic friction and per-op cost for no benefit. Forcing 64-bit precision is cargo-culting the C type. (Applied to collision filters at VP-3: `categoryBits`/`maskBits` are 32-bit `number`.)
- **Opaque user data becomes a real reference.** Box2D models user/opaque data as a `void*` (or a `uint64_t` id standing in for one) because C has no other way to hand back "your thing." In JS the idiom is simply a field that holds an arbitrary value — let users store an object, a string, whatever — rather than reducing it to a number to imitate the pointer. (Box2D's _internal_ generation-tagged handle ids still stay internal; this is about _user-facing_ fields. Often the right answer in an ECS is no field at all — the `Entity` already is the handle.)
- **No SIMD wide-constraint arrays.** Box2D's `b2ContactConstraintWide` (`b2ContactPrepareSpan`, `wideContactConstraints`) exist to feed AVX/Neon 4/8-wide solver kernels. JS has no portable SIMD; we keep one `ContactConstraint` per contact and solve sequentially.
- **No `b2HashSet` / `b2Table`.** Use `Map` and `Set`. We pay a slightly higher per-op cost but the V8 hidden-class layout keeps them fast. Profile, then optimise if needed.
- **No arena allocator.** Allocation pressure is V8's problem. We pre-size hot arrays (Float32Array buffers, contact constraint pool) at world create.
- **No `b2Array` macros.** `Array<T>` and `Float32Array` directly. The container.h helpers exist for C; TS doesn't need them.
- **Math functions in radians.** Box2D's `b2Rot { c, s }` form is preserved internally because rotating points is faster as a complex multiply than as a sin/cos lookup. User-visible `Rotation.angle` is converted on writeback.
- **Generation-tagged ids stay internal.** Public events expose `Entity`. We resolve handles → entities at publish time. This is the entire user-facing handle story.
- **Deterministic creation order.** We iterate entities in entity creation order where Box2D iterates by body id. Vecs's `World.entities` is a `Map<number, Entity>` keyed by eid; insertion order is iteration order; entity counters monotonically increase. Single-threaded → determinism via order.

**What we explicitly skip in v1:**

- `joint.c`, `distance_joint.c`, `motor_joint.c`, `prismatic_joint.c`, `revolute_joint.c`, `weld_joint.c`, `wheel_joint.c` — all joint code.
- `mover.c` — character mover helpers (deferred to v2).
- `constraint_graph.c` — color partitioning for multi-threaded solver. Without joints + single-thread, the graph is just one big bucket.
- `parallel_for.c`, `scheduler.c`, `atomic.h` — multithreading.
- `arena_allocator.c` — V8 owns allocation.
- `hull.c` — partial port: enough to validate convex polygons. Full hull computation can come with v2 dynamic geometry tools.
- `bitset.c`, `table.c` — replaced by built-ins.

Each engine file should be small, ported one Box2D function at a time, with the original source path in a comment so reviewers can diff against upstream.

### Solver pipeline — exact stage order to port

The TGS soft-step solver is the heart of the engine. Box2D's worker pipeline (`src/solver.c`, `b2Solve` → `b2SolverTask`) runs a fixed sequence of stages, enumerated in `src/solver.h` as `b2SolverStageType`. **Port these stages in this order**; the multithreaded scaffolding around them (color blocks, sync indices, `b2ExecuteStage`/`b2ExecuteMainStage`) collapses to a plain loop over the single overflow color since v1 has no constraint-graph coloring:

| Order | Box2D stage (`solver.h`)      | Box2D function to port (`contact_solver.c`, `_Overflow` variants)                   | Runs          |
| ----- | ----------------------------- | ----------------------------------------------------------------------------------- | ------------- |
| 1     | `b2_stagePrepareContacts`     | `b2PrepareContacts_Overflow`                                                        | once per step |
| 2     | `b2_stageIntegrateVelocities` | `b2IntegrateVelocitiesTask` (`solver.c`) — gravity, damping, `maxLinearSpeed` clamp | per substep   |
| 3     | `b2_stageWarmStart`           | `b2WarmStartContacts_Overflow`                                                      | per substep   |
| 4     | `b2_stageSolve`               | `b2SolveContacts_Overflow(useBias = true)`                                          | per substep   |
| 5     | `b2_stageIntegratePositions`  | `b2IntegratePositionsTask` (`solver.c`) — advances the delta-pose                   | per substep   |
| 6     | `b2_stageRelax`               | `b2SolveContacts_Overflow(useBias = false)`                                         | per substep   |
| 7     | `b2_stageRestitution`         | `b2ApplyRestitution_Overflow`                                                       | once per step |
| 8     | `b2_stageStoreImpulses`       | `b2StoreImpulses_Overflow`                                                          | once per step |

`b2_stagePrepareJoints` is skipped (no joints in v1). The per-substep block (stages 2–6) runs `subSteps` times; **every substep uses the same `h = dt / subSteps`** (`b2_physics_world.c`: `context.h = timeStep / context.subStepCount`, `context.inv_h = subStepCount * inv_dt`) — copy that exact `context->h`/`inv_h` setup along with `contactSoftness`/`staticSoftness` (`contactHertz`, `contactDampingRatio`) from `b2Solve`. (An earlier draft of this line claimed the first substep used the full `dt`; that is wrong — verified against the source in VP-7.) Soft-constraint coefficients (`biasRate`, `massScale`, `impulseScale`) are computed in `b2MakeSoft` (`core.c`); port it verbatim — the parity tests are sensitive to it.

After the substep loop, `b2FinalizeBodiesTask` (`solver.c`) writes transforms, updates sleep timers, and produces the body-move event list we mirror in `bodyMoveEvents`.

### Narrow-phase manifold functions — one port per shape pair

`src/manifold.c` exposes exactly twelve `b2Collide*` functions; each becomes one file under `engine/manifold/`. The dispatch table in `narrow_phase.ts` keys on the ordered shape-type pair. The full set:

`b2CollideCircles`, `b2CollideCapsuleAndCircle`, `b2CollidePolygonAndCircle`, `b2CollideCapsules`, `b2CollideSegmentAndCapsule`, `b2CollidePolygonAndCapsule`, `b2CollidePolygons`, `b2CollideSegmentAndCircle`, `b2CollideSegmentAndPolygon`, `b2CollideChainSegmentAndCircle`, `b2CollideChainSegmentAndCapsule`, `b2CollideChainSegmentAndPolygon`.

Notes for porters: capsules and segments are treated as 2-vertex polygons internally, so `b2CollidePolygons` is the workhorse — port and harden it first (`tests/parity` against `b2CollidePolygons` cases). The chain-segment variants carry ghost vertices (`ghost1`, `ghost2`) for one-sided collision; they are what make `Chain` shapes work and must preserve Box2D's "front side only" rejection. Manifold IDs (`b2MakeId`) feed warm-starting — they must be stable across frames or warm-start accumulates wrong impulses.

### Supporting collision primitives

- `distance.c` — `b2ShapeDistance` (GJK), `b2ShapeCast` (conservative advancement), `b2TimeOfImpact` (used by the bullet/CCD path), `b2SegmentDistance`, `b2MakeProxy`, `b2SimplexCache`. v1 needs GJK + the `SimplexCache` for manifold persistence immediately; `b2TimeOfImpact` is only required when the CCD bullet path is implemented (M5).
- `geometry.c` — `b2ComputeCircleMass`/`b2ComputeCapsuleMass`/`b2ComputePolygonMass` (mass integrals), `b2MakeBox`/`b2MakePolygon`, centroid/AABB helpers, and the convex-hull validation subset of `hull.c` (`b2ComputeHull`, `b2ValidateHull`).
- `core.c` — `b2MakeSoft` (soft-constraint coefficients) and the global tunables/constants (`B2_LINEAR_SLOP`, `B2_SPECULATIVE_DISTANCE`, `B2_MAX_ROTATION`, `b2_timeToSleep`). Mirror these exactly in `math/constants.ts`.
- `broad_phase.c` + `dynamic_tree.c` — the BVH and pair management. `b2DynamicTree_*` is a large but self-contained port; the `test_dynamic_tree.c` suite below validates it in isolation before the solver depends on it.

## Determinism And Ordering

v1 is single-threaded. Determinism is a function of:

1. **Entity creation order.** Vecs assigns eids monotonically. Tests should not assume specific eid values, but identical entity-creation sequences must yield identical eids.
2. **Internal id assignment order.** Our `IdPool` reuses freed slots before allocating new ones; the order is deterministic given an identical sequence of acquire/release calls.
3. **System ordering.** Phases run in registration order; systems within a phase run in registration order; inbox events fire in arrival order. All deterministic.
4. **Math.** Identical inputs through `Math.*` on the same engine produce identical results, so a fixed creation/step sequence is reproducible run-to-run. We do not need bit-identical results across JS engines — the **target platform is x64 Linux** (Node `vitest`), and that is the only platform our determinism and parity claims cover.
5. **Map iteration.** ES Map iteration follows insertion order. We rely on this for `bodyByEntity`, `shapeByEntity`.

Box2D-equivalence tests run on x64 Linux and assert **close agreement, not bit-equality**: a TypeScript port of Box2D's math is not expected to reproduce the C build's last ULP, but on the same hardware the trajectories track tightly. Use a tolerance of ~`1e-4`–`1e-5` for short simulations (≤ a few hundred steps) and loosen for longer ones; where a long run would accumulate drift, assert a geometric property instead (e.g. "rest position within Δx of expected") rather than a step-by-step match.

## Performance Strategy

Order of priority for v1:

1. **Don't pessimise the ECS.** The lifecycle systems must not iterate every entity every frame. They use reactive queries that index by component type, so they only see entities that changed.
2. **Reactive force gather is per-step, but cheap.** A `world.filter({ any: [Force, Torque] })` walks all entities each step. For 1000 entities that's a 1000-iteration loop with a single component lookup per iteration. The filter is built once at install. Acceptable for v1.
3. **Pre-size hot arrays.** At install, allocate `Float32Array(initialBodyCapacity*N)` for pending impulse buffers, etc. Grow with `2x` resize when capacity is exceeded.
4. **No allocation in hot loops.** The solver should reuse one ContactConstraint instance per active contact, mutated in place. Vec2 temporaries are passed as `(x, y)` pairs of numbers, not allocated structs. This is the single biggest TS-port performance lever.
5. **Map vs Object.** `Map<number, X>` outperforms `Record<number, X>` for the body/shape maps because eids grow and Maps don't degrade with sparse keys.

Measurable targets (informational, not contractual):

- 200 dynamic bodies + 4 substeps + 60 Hz on V8 ~ 16 ms target. Box2D in C does this in < 1 ms; a careful TS port should land in 3–6 ms.
- Steady-state allocation per step: 0 bytes (post-warmup).

Profile and iterate. We do not pre-optimise.

## Testing Strategy

**Test-Driven is the project standard. Tests come first.**

### Layers

1. **Math/util layer.** `vec2`, `rot`, `transform`, `aabb`, `dynamic_tree`, `id_pool` — pure-function tests with no world. Fast feedback loop.
2. **Engine layer.** Construct a `PhysicsState` directly (no Vecs world). Drive `engineStep(state, dt, subSteps)` and assert on body positions, contacts, events. These tests are the bit-by-bit Box2D parity tests.
3. **Vecs integration layer.** Construct a `World`, `installPhysics`, register entities/components, call `world.progress(now, delta)` N times. Assert on component values and event arrays.

### Box2D parity matrix — port from the actual Box2D test suite

Box2D ships a C unit-test suite under `box2d/test/` (run via `box2d/test/main.c`) and an interactive sample gallery under `box2d/samples/`. The tests are the authoritative golden source. For each relevant Box2D test we write `lib/vecs-physics/tests/parity/<name>.test.ts` that reproduces the same setup and asserts the same property. Where a Box2D test asserts an exact final value, copy it as the golden number and compare **within tolerance** (the port tracks Box2D closely on x64 Linux but is not bit-exact); where it asserts an inequality (e.g. `mdLower < md < mdUpper`), copy the inequality verbatim. Many of Box2D's own assertions are already tolerance-based (e.g. `HelloWorld` uses `< 0.01`), so those port directly.

**Unit-level parity (port directly — these need no full world):**

| vecs-physics module                 | Box2D test file → function                                                                                                                                                                                       | What to assert (golden values from the source)                                                                                                                  |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `math/*`                            | `test_math.c` → `MathTest`                                                                                                                                                                                       | vec/rot/transform identities.                                                                                                                                   |
| `math/aabb`, manifold AABB          | `test_collision.c` → `AABBTest`, `AABBRayCastTest`                                                                                                                                                               | union/overlap/contains; segment-vs-AABB.                                                                                                                        |
| `engine/mass`                       | `test_shape.c` → `ShapeMassTest`                                                                                                                                                                                 | circle: `mass == π`, `center == (1,0)`, `I == 0.5π` (density 1); capsule mass bracketed by bounding box and inscribed hull; polygon via `b2ComputePolygonMass`. |
| `engine/shape` (AABB/point/raycast) | `test_shape.c` → `ShapeAABBTest`, `PointInShapeTest`, `RayCastShapeTest`                                                                                                                                         | per-shape AABB, containment, ray hits.                                                                                                                          |
| `engine/distance`                   | `test_distance.c` → `SegmentDistanceTest`, `ShapeDistanceTest`, `ShapeCastTest`, `TimeOfImpactTest`                                                                                                              | GJK distance, cast, TOI. (`ShapeCast`/`TOI` only when CCD lands in M5.)                                                                                         |
| `engine/dynamic_tree`               | `test_dynamic_tree.c` → `TreeRayCastTest`, `TreeMultipleProxiesTest`, `TreeQueryTest`, `TreeMoveAndEnlargeTest`, `TreeRebuildAndValidateTest`, `TreeRowHeightTest`, `TreeGridHeightTest`, `TreeGridMovementTest` | insertion/move/enlarge/query/rebuild correctness and tree balance. **Port all eight** — the broad phase rests on this.                                          |

**World-level parity (full `installPhysics` world, driven by `world.progress`):**

| Scenario            | Box2D source                                                                                                   | Golden assertion                                                                                                                                                                                                                                          |
| ------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hello_world`       | `test_world.c` → `HelloWorld`                                                                                  | dynamic box on static ground; `timeStep = 1/60`, `subSteps = 4`, **90 steps**; final `\|x\| < 0.01`, `\|y − 1.00\| < 0.01`, `\|angle\| < 0.01`. This is the M3 gate.                                                                                      |
| `sensor_begin_end`  | `test_world.c` → `TestSensor`                                                                                  | bullet passing through a wall sensor produces begin then end sensor events.                                                                                                                                                                               |
| `chain_segment`     | `test_world.c` → `ChainSegmentShapeTest`                                                                       | one-sided chain collision; body rests on the correct side.                                                                                                                                                                                                |
| `mass_flag_sync`    | `test_world.c` → `DeferredMassFlagSyncTest`                                                                    | adding/removing shapes recomputes body mass exactly when expected.                                                                                                                                                                                        |
| `sleep_flag_sync`   | `test_world.c` → `EnableSleepFlagSyncTest`                                                                     | toggling sleep enable transfers bodies between solver sets correctly.                                                                                                                                                                                     |
| `contact_recycling` | `test_world.c` → `EnableContactRecyclingTest`                                                                  | contacts created/destroyed across enable toggles without leaks.                                                                                                                                                                                           |
| `bullet_drift`      | `test_world.c` → `SetBulletDriftTest`                                                                          | bullet body does not drift/tunnel (CCD; M5).                                                                                                                                                                                                              |
| `determinism`       | `test_determinism.c` → `CrossPlatformTest` (the "Falling Hinges" scene, also `samples/sample_determinism.cpp`) | run-to-run **reproducibility** on x64 Linux: the same creation/step sequence yields identical transforms every run (assert exact run-to-run equality of our own output — _not_ a match to Box2D's cross-platform hash). See **Determinism And Ordering**. |

**Integration scenarios (no golden file in `test/`; mirror the sample setups in `samples/` and assert qualitative/geometric properties):**

- Stacking & robustness — `samples/sample_stacking.cpp` (Large Pyramid), `samples/sample_robustness.cpp`: tall stacks stay stable, no jitter/explosion.
- Restitution — `samples/sample_continuous.cpp` ("Restitution Threshold"): bounce height tracks the `restitutionThreshold`.
- Friction ramp — boxes on an inclined static body come to rest (friction mixing).
- Continuous/bullet — `samples/sample_continuous.cpp` (Drop, Skinny Box, Ghost Bumps): fast bodies do not tunnel (M5).
- Compound bodies — `samples/sample_bodies.cpp`, `samples/sample_benchmark.cpp` (Compounds): multi-shape bodies have correct combined mass/inertia.
- Events — `samples/sample_events.cpp` (Contact, Body Move, Foot Sensor): begin/end/hit/sensor event timing.

Each parity test must assert at least one trajectory or state check; longer scenarios capture a JSON snapshot under `tests/parity/snapshots/` with a documented tolerance (see the determinism risk for window guidance).

### Required functional tests (from the brief)

| Area                         | Test                                                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Component defaults           | `new Body()` matches `b2DefaultBodyDef()` projected to our subset; same for every component.                                                                                   |
| Component registration       | `installPhysics` registers every public component; `world.component(Body)` resolves post-install; `ChildOf` is already registered by Vecs.                                     |
| Component exclusivity        | Adding `Circle` after `Box` removes `Box`. Adding `Polygon` removes `Circle`.                                                                                                  |
| Body creation                | `entity.set(Body, dynamic)` + Position + child Box → after `progress`, body falls.                                                                                             |
| Body destruction             | `body.destroy()` removes the internal body; child shape entity is also destroyed; subsequent steps don't read deleted slot.                                                    |
| Shape child creation         | Adding `Box` after `Body` and before `start()` succeeds; same after start; same in subsequent frame.                                                                           |
| Shape child destruction      | Removing geometry component destroys internal shape; body persists; mass recomputed.                                                                                           |
| Immediate-parent rule        | Geometry on a grandchild of Body is ignored. Force on grandchild is ignored.                                                                                                   |
| Missing optional defaults    | Body without Position starts at origin; without Rotation, angle 0; without Material, density 1; without CollisionFilter, mask all.                                             |
| Force persistence            | `Force(10, 0)` on dynamic body produces 10 N every step until removed.                                                                                                         |
| Multiple child forces        | Two child entities with Force, each with different vector — body sees the sum.                                                                                                 |
| Impulse accumulation         | `set(Impulse, {x:1}); set(Impulse, {x:2}); set(Impulse, {x:3})` → body receives 6 N·s impulse before next step.                                                                |
| Silent impulse zeroing       | After step, `entity.get(Impulse)` has `x=0, y=0` but `entity.events.has(Impulse update)` is false (no modified fired).                                                         |
| Dynamic pose sync            | After step, `entity.get(Position)` returns physics result. `entity.get(LinearVelocity)` updated if present.                                                                    |
| User teleport                | Mid-simulation `entity.set(Position, {...})` moves the body. Next step starts from teleported position.                                                                        |
| Write-back is not a teleport | `PhysicsPoseSyncOut`'s write does **not** trigger a teleport in `PhysicsPoseSyncIn` next step (`ignoreSource`); a user write to `Position` from a non-physics system **does**. |
| Kinematic target convergence | Kinematic body with `KinematicTargetPosition` moves toward target each step; stops within tolerance; component stays attached.                                                 |
| Kinematic target re-engage   | After body reaches target, updating the target moves it again.                                                                                                                 |
| Contact event opt-in         | Two shapes colliding; only the one with `ContactEvents` receives events.                                                                                                       |
| Empty event step is silent   | Frame N produces contact events → `modified` fires. Frame N+1 no events → no `modified` fires; array empty.                                                                    |
| Sensor opt-in                | Sensor without `SensorEvents` produces nothing. With it, begin/end fire on overlap.                                                                                            |
| Hit event threshold          | Slow contact does not produce HitEvent; fast contact does.                                                                                                                     |
| Debug warning dedupe         | Invalid structure persisting for 600 steps logs exactly once.                                                                                                                  |
| Debug warning re-arm         | Structure becomes valid, then becomes invalid again → second warning emitted.                                                                                                  |
| Reparenting                  | Shape moved to a new Body — next step it is a shape on the new body.                                                                                                           |
| Reparenting to non-Body      | Shape moved to an entity without Body — shape is destroyed.                                                                                                                    |
| Filter change                | Updating `CollisionFilter` to exclude an existing partner destroys their contact within one step.                                                                              |

### Test infrastructure

- `tests/fixtures/world.ts` — `makePhysicsWorld(opts)` helper.
- `tests/fixtures/step.ts` — `runSteps(world, n)` helper that calls `progress(t, 1000/60)` `n` times.
- `tests/fixtures/snapshot.ts` — `snapshotPositions(world, entities)` → JSON; comparable against `tests/parity/snapshots/*.json` with configurable tolerance.

Coverage gate: tests must hit every code path in `src/systems/` and the engine pipeline orchestrator. Engine internals (manifold/\* etc.) are exercised through parity tests + targeted unit tests.

## Implementation Milestones

### Milestone 0 — Scaffolding + math + components (1 week)

**Tickets: VP-1, VP-2, VP-3, VP-4.** ✅ complete.

- `src/math/*` and `src/util/*` ported.
- All public component classes registered, with defaults and accessor pairs.
- `installPhysics` implemented down to component registration + phase creation, but engine is a no-op.
- Test matrix for component defaults / registration / exclusivity green.

### Milestone 1 — Body lifecycle + pose sync (1.5 weeks)

**Tickets: VP-5, VP-6, VP-7.** ✅ complete.

- `engine/state.ts`, `engine/body.ts`, `IdPool`, solver sets (storage only).
- `PhysicsLifecycle` for Body (no shape yet); `PhysicsPoseSyncIn`/`Out` with echo detection.
- Tests: body creation/destruction, teleport, default pose, default Body type.
- Engine `step()` is a no-op integrator (gravity only on dynamic bodies, no contacts). Falling-body test passes (no ground collision yet).

### Milestone 2 — Shape lifecycle + broad/narrow phase (3 weeks)

**Tickets: VP-8, VP-9, VP-10, VP-11, VP-12, VP-13, VP-14.** (VP-13/VP-14 sit under
the _Narrow phase_ ticket group below but gate this milestone; contact
_persistence_ — VP-15 — is M3.)

- `engine/shape.ts`, `engine/broad_phase.ts`, `engine/dynamic_tree.ts`.
- `engine/manifold/` — the twelve `b2Collide*` functions (start with `b2CollidePolygons`; capsules/segments reduce to it).
- `PhysicsShapeLifecycle` for geometry (incl. reactive `ChildOf` reparenting); `PhysicsMaterialFilterSync`; `PhysicsShapePoseSync`.
- `engine/narrow_phase.ts` dispatch table.
- `engine/mass.ts`.
- **Unit parity green**: all of `test_dynamic_tree.c` (8 tree tests), `test_shape.c::ShapeMassTest` (circle `mass == π`, `I == 0.5π`), `ShapeAABBTest`, `PointInShapeTest`; `test_collision.c::AABBTest`.
- Tests: contact generation (no solving yet — bodies pass through), AABB queries internally consistent, reparenting, mass updates.

### Milestone 3 — Contacts + sequential-impulse solver (3 weeks)

**Tickets: VP-15, VP-16, VP-17, VP-18.** (VP-17, the solver, is the single largest
ticket — subdivide along the eight solver stages before starting; see note in the
ticket list.)

- `engine/contact.ts` (persistence, edges, manifolds).
- `engine/island.ts` (build, merge; split deferred to M5).
- `engine/solver.ts` (the eight stages in order: prepare-contacts, integrate-velocities, warm-start, solve, integrate-positions, relax, restitution, store — see **Solver pipeline**).
- **`hello_world` parity green** (`test_world.c::HelloWorld`: 90 steps, final `\|y−1.00\| < 0.01`). This is the milestone gate.
- Tests: stacking stability (`sample_stacking`), restitution, friction, compound body.

### Milestone 4 — Forces, impulses, kinematic, events (1.5 weeks)

**Tickets: VP-19, VP-20, VP-21, VP-22.**

- `PhysicsForceGather`, `PhysicsImpulseAccumulate`, `PhysicsImpulseZero`, `PhysicsKinematicTargets`, `PhysicsEvents`.
- `engine/sensor.ts` for sensor overlap.
- All v1 functional tests green.
- Parity: `sensor_begin_end` (`test_world.c::TestSensor`), `chain_segment` (`ChainSegmentShapeTest`), `mass_flag_sync` (`DeferredMassFlagSyncTest`), friction ramp. Bullet/`SetBulletDriftTest` deferred to M5.

### Milestone 5 — Sleep + continuous CCD + debug validation (1.5 weeks)

**Tickets: VP-23, VP-24, VP-25, VP-26.**

- Island split for sleep candidates; sleeping solver sets.
- `engine/ccd.ts` for bullet path (single-threaded port of Box2D's bullet stage).
- `PhysicsDebugValidation` system + warning dedupe.
- Performance pass: profile a 200-body scene; optimise hot allocations.

### Milestone 6 — Hardening and docs (1 week)

**Tickets: VP-27.** (The `architecture/SOLVER.md` write-up and the fuzz-testing
pass below are M6 deliverables but are not yet ticketed — see _granularity gaps_
at the end of the ticket list.)

- Doc reconciliation: every docs page asserts a tested behaviour.
- Internal `architecture/SOLVER.md` capturing the solver port in detail.
- One round of fuzz testing: random scene generation, no NaN, no infinite loops.

**Total: ~12 weeks for one engineer, ~7 weeks for two working in parallel (M2/M3 can split).**

## Vecs Dependencies

This plan relies on the Vecs capabilities below. Because we own both libraries, anything missing is filed as a **Vecs change**, not worked around inside vecs-physics. Availability is given against the `physics` branch:

| Capability                      | Vecs API                                                                                                                                                 | Status                                                                                                                              | Used by                                                                | If unavailable                                                                                                                                                                                         |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Relationships (`ChildOf`)       | `set(ChildOf, { target })`, `entity.parent(ChildOf)`, `entity.children(ChildOf)`, DSL `{ parent }` / `{ target }` / `{ up: [ChildOf, […]] }`, `Iter.src` | **Landed** on `physics`.                                                                                                            | Shape↔body wiring, reparenting, force/impulse target resolution.       | N/A — core to the design.                                                                                                                                                                              |
| World singleton                 | `world.component(C).add(Singleton)`; instance on the component's own entity, read via `world.get(C)`                                                     | **Landed** (`modules/singleton.ts`).                                                                                                | `PhysicsRoot` state holder.                                            | Fall back to a `WeakMap<World, PhysicsState>` keyed by world. Low risk.                                                                                                                                |
| Relationship fan-out reactivity | `TargetTerm` re-evaluates all sources when a target's membership changes                                                                                 | **Landed** (`terms/target_term.ts`).                                                                                                | Order-independent body/shape creation; `{ parent: Body }` membership.  | Re-introduce body `enter` child-walk + accept a creation-order constraint.                                                                                                                             |
| System update silencing         | `System.ignoreSource(source: QueryDSL \| Query)` — ignore updates originating from matched systems                                                       | **Landed** (`system.ts`, in `physics`). Systems are entities (`System` component), so match them via a marker (`PhysicsSystemTag`). | Pose-sync feedback suppression.                                        | Engine-origin tagging fallback (stamp each engine write with step index + per-body last-written pose; treat an echo within epsilon as the engine's own write) exists if ever needed; not required now. |
| Query grouping                  | `Query.groupBy([...], keyFn)` and `groupBy(ChildOf)` → `Group` per parent                                                                                | **Uncommitted** in the `cascade` worktree (`group.ts`), unreviewed.                                                                 | _Optional_ convenience for mass recompute / compound-body diagnostics. | None needed — not on the critical path; the internal shape list is canonical.                                                                                                                          |

Action items for the Vecs side:

1. **`System.ignoreSource` is available in `physics`** (`dev` merged). It carries the semantics this plan assumes: an update event (from `entity.set`/`modified` inside a system's deferred scope) carries the originating system identity, and a consumer with a matching `ignoreSource` predicate drops it. Re-verify that contract with a focused test when wiring VP-6.
2. **Decide `groupBy`'s fate independently.** vecs-physics does not block on it; if it merges, revisit `PhysicsMassRecompute` only if we ever drop the internal shape list.
3. Reparenting needs no special Vecs support: it rides the `ChildOf` relationship's reactive events.

## Risks And Open Questions

### Risks

1. **Float parity with the Box2D C build.** A TypeScript port will not match Box2D's results to the last ULP. On the target platform (**x64 Linux**) the trajectories track closely, so tolerance-based parity is reliable; the risk is only that _long_ runs accumulate small differences. Mitigation: keep step-by-step parity windows short (a few hundred steps), and for longer scenarios assert geometric/stability properties (e.g. "ball comes to rest within Δx of expected", "stack does not explode") rather than exact transforms. Run-to-run reproducibility on x64 Linux is unaffected — it holds regardless.
2. **Dependence on Vecs feature semantics.** Pose-sync requires `System.ignoreSource` (landed in `physics`); `groupBy` (optional) is uncommitted in the `cascade` worktree. Re-verify `ignoreSource`'s source-attribution semantics with a focused test at VP-6. Mitigation: a thin, well-tested fallback (engine-origin tagging) can stand in for one milestone — see **Vecs Dependencies**.
3. **`Box.width`/`height` setter footgun.** Direct setter doesn't trigger `modified`. Mitigation: clearly document it. Consider, in v2, generating a wrapper that auto-marks modified.
4. **Event-array `length = 0` reuse.** If user code retains the array reference across frames, they'll see in-place mutation. This is per the docs but easy to miss. Tests should explicitly verify the array is the same instance after clear.
5. **Generation overflow.** Box2D uses `uint16_t` generation per slot. After 65k creates/destroys in one slot, ids wrap. We can use a plain `number` (53-bit safe int) for negligible cost. Recommend: use `number`, no overflow concern.
6. **Single physics install per world.** Tests may want multiple worlds. The `PhysicsRoot` singleton is per-world, so multiple worlds are fine. Re-install on the same world is forbidden (the `Singleton` marker throws on a second instance, giving us the guard for free). If needed, add `uninstallPhysics(world)` in v2.

### Open Questions

None. The pre-M3 solver decisions are now settled below.

### Settled Decisions

- Internal state: world-scoped `Singleton` component (`PhysicsRoot`), reached via `getPhysics(world)`.
- Internal handles: `(index, generation)` tuples; never public.
- Component registration order: as listed above (`ChildOf` is built-in; do not register).
- System reactivity: systems, not hooks.
- Parent/child model: the Vecs `ChildOf` relationship component. `shape.set(ChildOf, { target: body })`.
- Reparent detection: reactive `enter`/`exit`/`.update(ChildOf)` in `PhysicsShapeLifecycle`; no scan.
- Pose-sync feedback suppression: `PhysicsPoseSyncIn.ignoreSource([PhysicsSystemTag])`. **`ignoreSource` lives on `Query`** (a dev merge relocated it from `System`; the prose above still says `System.ignoreSource` in places). Source attribution: a mutation is credited to the system entity that made it (`world._currentSource` at enqueue, surfaced as `_routingSource` during drain); a consumer drops updates whose source is a member of its silence query. Entry-time initialization is never silenced, so a body still initializes through a tagged source. Confirmed with a focused Vecs-level test (`tests/lifecycle/ignore_source.test.ts`) at VP-6. (Settled VP-6.)
- Pose-sync `update` delivery: a watchlisted component generates an `update` (a) when the entity **enters** the query — `Query._enter` replays every watched component present at entry through `_notifyModified` (a `System` buffers it to its inbox; the silence filter is bypassed on entry) — and (b) when a component already on the entity is **modified**. Consequence: a watched pose/velocity component **added** to a body that is already a query member (it already has `Body`, so adding the component does not re-enter the `requires(Body)` query) is not seen until it is next written. The canonical pose/velocity components (`Position`/`Rotation`/`LinearVelocity`/`AngularVelocity`) are present at body creation, so they are caught on entry; `PhysicsBodyLifecycle.enter` also reads them straight into the sim. (Settled VP-6.)
- `createBody(storage, set, entity, type)`: the storage primitive now records the owning `Entity` and numeric body type on `InternalBody` (the VP-5 thin record grew, as planned). The public string `Body.type` → numeric translation and solver-set placement live in `PhysicsBodyLifecycle` (the components/ → engine/ boundary). (Settled VP-6.)
- `PhysicsPoseSyncOut` write-back is gated to **dynamic** bodies (kinematic/static poses are user-owned). It iterates `state.bodyMoveEvents` (the solver's per-step move-event list — Box2D's `bodyMoveEvents`), which holds the awake bodies finalized that step. (Settled VP-6; move-event consumption wired VP-7.)
- Solver sub-step size is uniform: `h = dt / subSteps` for every sub-step (Box2D `context.h`). The body integrator (`engine/step.ts`) ports `b2IntegrateVelocitiesTask` (gravity gated on `invMass > 0`, Pade damping `1/(1+h·c)`, force), `b2IntegratePositionsTask` (motion-lock zeroing, linear/angular speed caps, delta-pose advance), and the body-write half of `b2FinalizeBodiesTask` (fold delta-pose into centre/rotation, derive origin `p = c − R·localCenter`, reset deltas/forces, advance the sweep baseline, push a move event). Constraint stages (prepare/warm-start/solve/relax/restitution/store-impulses), sleep, and CCD are no-ops until their tickets. (Settled VP-7.)
- Mass is not computed until VP-12, so a freshly created dynamic body has `invMass = 0` (infinite mass) and will not fall. Tests that need motion seed `sim.invMass` directly until `b2UpdateBodyMassData` lands. ~~Box2D gives a massless dynamic body a default mass of 1; the mass ticket will do the same.~~ **Corrected at VP-12:** that claim is false — box2d's `b2UpdateBodyMassData` (body.c) keeps a massless dynamic body at `mass = 0, invMass = 0` (it does not fall); the `dynamic-body-without-density` debug check flags the misconfiguration. vecs-physics now matches box2d. (Noted VP-7, corrected VP-12.)
- Silent impulse zero: direct property writes, bypass `modified` (`ignoreSource` does not address waking _user_ watchers, so it cannot replace this).
- Event array semantics: clear-in-place, modified only on new events.
- Geometry updates: same-type in place, type-swap is delete + create via exclusivity.
- Mass recomputation: dirty flag + final pre-step recompute system.
- Sleep: supported in v1 via `Sleep` component. Defaults match Box2D.
- Trigonometry: use `Math.cos`/`Math.sin`/`Math.atan2` directly, not Box2D's polynomial approximations (`b2ComputeCosSin`/`b2Atan2`). Simpler and more accurate on the x64 target; the parity tests' tolerances absorb the difference. (See `src/math/rot.ts`.) Revisit only if bit-for-bit matching against a Box2D C capture is ever required.
- Solver flavour: v1 uses Box2D v3-style TGS, not PGS. PGS is simpler per iteration, but it would weaken the package's Box2D v3 parity claim and create a second solver/tuning path. If performance is an issue, reduce `subSteps` or optimise hot storage/allocations before considering a solver rewrite. (Settled pre-M3.)
- Continuous collision detection: CCD remains in M5 for v1. M3/M4 may carry a clearly marked no-op internal stub while contacts/events/solver land, but a public v1 release must not claim `enableContinuous: true` unless the bullet/TOI path is implemented and covered by parity tests. If CCD slips past v1, change the default to `false`, document it as unavailable, and debug-warn when `Body.bullet` or `enableContinuous: true` is used. (Settled pre-M3.)
- Internal id generations: `IdPool` owns the per-slot generation (bumped on `free`), so validity is a single `pool.isValid(handle)`. Box2D instead keeps the generation on the object; we consolidate it into the pool. (See `src/util/id_pool.ts`.)
- Solver-set transfers move object references, not bytes. Box2D `memcpy`s a `b2BodySim`/`b2ContactSim`/… into the target set then frees the source slot; we push the same JS object into the target dense array and swap-pop it from the source. Index bookkeeping is identical to Box2D (swap-pop fills the hole with the last element and repairs its stored `localIndex` via its back-pointer). A porting-fidelity instance: same model, idiomatic representation. (Settled VP-5; see `src/engine/solver_set.ts` `transferBody`.)
- Code style: private class members are `_`-prefixed (enforced by the `local/internal-underscore` lint rule).
- Component shapes: `docs/components.md` is authoritative when it is stricter than the defaults table here. Settled at VP-3: `BodyType` is a **string** enum (`"static"|"kinematic"|"dynamic"`), not numeric.
- Porting fidelity: port Box2D's **model**, not its C representation. Don't be slavishly literal about C-level choices (fixed-width ints, `void*` opaque pointers, struct layout) — translate the intent into idiomatic JS. See _Box2D Porting Strategy → Port the model, not the C representation_. Concretely: 64-bit fields default to `number` (not `bigint`) unless >2^53 range is truly needed; opaque user data is an arbitrary-value field, not a faked pointer/number.
- Collision filter width: `CollisionFilter.categoryBits`/`maskBits` are **32-bit `number`**, not Box2D's `uint64_t`. 32 categories is ample and lets filtering use native JS bitwise ops (`(catA & maskB) !== 0`) instead of bigint. Default mask is `0xffffffff`. `Material.userMaterialId` is likewise a plain `number` (opaque id, not a bitfield), so the package has **no `bigint` in its public surface**. (Decided VP-3; diverges from the original PLAN/box2d 64-bit width.)

## Required Implementation Tickets

Below is the ticket breakdown the engineering team can pick up directly. Each ticket lists files, tests, and a definition of done. The _Phase_ groupings below are conceptual; the **milestone** each ticket gates is tagged on the phase header (and called out inline where a phase straddles two milestones). The authoritative milestone definitions and their full ticket sets are in **Implementation Milestones** above.

### Phase: Foundation — Milestone 0

- **VP-1: math/vec2, math/rot, math/transform, math/aabb, math/constants.**
  - Files: `src/math/*.ts`. Port `math_functions.c`; mirror constants from `constants.h`/`core.c`.
  - Tests: port `test/test_math.c::MathTest` and `test/test_collision.c::AABBTest`/`AABBRayCastTest` to `tests/math/`.
  - DoD: 100% of methods used by later modules exist with Box2D-equivalent semantics.

- **VP-2: util/id_pool, util/handle, util/dense_array, util/warn, util/bitset.**
  - Files: `src/util/*.ts`.
  - Tests: id pool generation increments, dense array swap-pop preserves indices, warn-once semantics.

- **VP-3: All public components + index.ts public exports.**
  - Files: `src/components/*.ts`, `src/index.ts`.
  - Tests: defaults table verified component-by-component.

- **VP-4: installPhysics skeleton.**
  - Files: `src/install.ts`, `src/engine/state.ts`.
  - DoD: registers components, sets exclusivity, creates phases, attaches empty PhysicsState. World can start without errors.

### Phase: Body lifecycle — Milestone 1

- **VP-5: engine/body.ts — InternalBody, BodySim, BodyState; solver sets; transfer functions.**
  - Files: `src/engine/body.ts`, `src/engine/solver_set.ts`.
  - Tests: transfers between awake/static/disabled sets preserve indices.

- **VP-6: systems/lifecycle.ts (`PhysicsBodyLifecycle`) + systems/pose_sync_in.ts + systems/pose_sync_out.ts.**
  - Files: `src/systems/lifecycle.ts`, `src/systems/pose_sync_in.ts`, `src/systems/pose_sync_out.ts`.
  - DoD: body create/destroy, teleport, and feedback suppression work — `PhysicsPoseSyncIn.ignoreSource([PhysicsSystemTag])` ignores the engine's own write-back while honouring user teleports.
  - Depends on Vecs `System.ignoreSource` (see **Vecs Dependencies**). If unavailable, ship the documented engine-origin-tag fallback for this milestone only.

- **VP-7: systems/step.ts — minimal engineStep (gravity only).**
  - DoD: dynamic body falls under gravity; matches `pos.y = 4 - 0.5*10*t^2` (no contact yet).

### Phase: Shape lifecycle — Milestone 2

- **VP-8: engine/shape.ts — InternalShape, GeometryUnion, AABB compute, mass compute.**

- **VP-9: engine/dynamic*tree.ts — full BVH port (`dynamic_tree.c`, `b2DynamicTree*\*`).**
  - Tests: port the full `test/test_dynamic_tree.c` suite (`TreeRayCastTest`, `TreeMultipleProxiesTest`, `TreeQueryTest`, `TreeMoveAndEnlargeTest`, `TreeRebuildAndValidateTest`, `TreeRowHeightTest`, `TreeGridHeightTest`, `TreeGridMovementTest`).

- **VP-10: engine/broad_phase.ts — three trees, moveSet, pairSet, pair query.**

- **VP-11: systems/lifecycle.ts (shape half: `PhysicsShapeLifecycle`, incl. reactive `ChildOf` reparenting) + material/filter/pose sync systems.**
  - The shape query is `{ all: [{ any: [Box, Circle, Capsule, Segment, Polygon, Chain] }, { parent: Body }] }`; reparenting rides `enter`/`exit`/`.update(ChildOf)`. No separate reparent-scan module.

- **VP-12: engine/mass.ts (`geometry.c` mass integrals + `body.c::b2UpdateBodyMassData`) + systems/mass_recompute.ts.**
  - Tests: `test_shape.c::ShapeMassTest` (circle `mass == π`, `center == (1,0)`, `I == 0.5π`; capsule/polygon brackets); `DeferredMassFlagSyncTest` at the world level.

### Phase: Narrow phase — Milestone 2 (VP-13, VP-14) → Milestone 3 (VP-15)

- **VP-13: engine/manifold/ — port the twelve `b2Collide*` functions from `manifold.c`, one sub-ticket per pair.**
  - VP-13a `b2CollideCircles`, VP-13b `b2CollidePolygonAndCircle`/`b2CollideCapsuleAndCircle`, VP-13c `b2CollidePolygons` (do first — capsule/segment reduce to it), VP-13d `b2CollideCapsules`/`b2CollidePolygonAndCapsule`/`b2CollideSegmentAndCapsule`, VP-13e `b2CollideSegmentAndCircle`/`b2CollideSegmentAndPolygon`, VP-13f `b2CollideChainSegmentAnd{Circle,Capsule,Polygon}` (ghost-vertex one-sided collision).
  - Manifold IDs (`b2MakeId`) must be stable frame-to-frame for warm-starting.

- **VP-14: engine/narrow_phase.ts — dispatch by ordered shape-type pair (`contact.c::b2UpdateContact`) and contact update.**

- **VP-15: engine/contact.ts — persistence (`b2SimplexCache`), edges, begin/end touch flags.** _(Milestone 3 — contact persistence is an M3 deliverable, not M2.)_

### Phase: Solver — Milestone 3

- **VP-16: engine/island.ts — build, merge (`island.c`).**

- **VP-17: engine/solver.ts — TGS port (`solver.c` + `contact_solver.c`).**
  - Largest ticket. Subdivide along the stage order (see **Solver pipeline**): `b2PrepareContacts_Overflow`, `b2IntegrateVelocitiesTask`, `b2WarmStartContacts_Overflow`, `b2SolveContacts_Overflow(true)`, `b2IntegratePositionsTask`, `b2SolveContacts_Overflow(false)` (relax), `b2ApplyRestitution_Overflow`, `b2StoreImpulses_Overflow`. Port `core.c::b2MakeSoft` verbatim.

- **VP-18: `hello_world` parity green (`test_world.c::HelloWorld`; 90 steps, final `\|y−1.00\| < 0.01`).**

### Phase: Forces / events / kinematic — Milestone 4

- **VP-19: systems/forces.ts + systems/impulse_accumulate.ts + systems/impulse_zero.ts.**

- **VP-20: systems/kinematic.ts.**

- **VP-21: engine/sensor.ts + systems/events.ts.**

- **VP-22: HitEvents threshold scan.**

### Phase: Polish — Milestone 5 (VP-23–VP-26) → Milestone 6 (VP-27)

- **VP-23: Sleep + island split.**

- **VP-24: Continuous collision for bullets.**

- **VP-25: PhysicsDebugValidation system.**

- **VP-26: Performance pass and benchmarks.**

- **VP-27: Doc audit — every doc page links to a passing test.** _(Milestone 6.)_

### Granularity gaps to ticket before the back half

The first two milestones (VP-1…VP-7, ✅ done) are correctly grained — each ticket
is roughly one focused PR. A few later tickets are oversized or have fuzzy
boundaries and should be split before they are picked up:

- **VP-17 (solver) is the worst offender** — it is flagged "the largest ticket"
  and already told to subdivide along the eight solver stages, but those
  sub-tickets are not enumerated. Promote them to first-class tickets (VP-17a…h)
  the way VP-13 is already split (VP-13a…f): prepare-contacts, integrate-vel
  (done in VP-7), warm-start, solve, integrate-pos (done in VP-7), relax,
  restitution, store-impulses, plus `b2MakeSoft`.
- **VP-8 vs VP-12 own overlapping "mass compute"** — VP-8's DoD says "mass
  compute" and VP-12 is `engine/mass.ts` (the mass integrals). Draw the line:
  VP-8 should own only the shape record + geometry union + AABB; all mass
  integrals belong to VP-12.
- **VP-11 bundles three systems** (`PhysicsShapeLifecycle` incl. reparenting,
  `PhysicsMaterialFilterSync`, `PhysicsShapePoseSync`) — the milestone lists them
  as three. Consider splitting at least material/filter sync out, since filter
  changes carry a contact-refiltering cost worth its own DoD.
- **VP-21 bundles `engine/sensor.ts` + `systems/events.ts`** — the engine-side
  sensor overlap detection and the event-publish system are independent enough to
  be two tickets.
- **M6 is under-ticketed** — only VP-27 (doc audit) exists; the
  `architecture/SOLVER.md` write-up and the fuzz-testing pass are M6 deliverables
  with no ticket. Add VP-28 (SOLVER.md) and VP-29 (fuzz harness).

## Unresolved Decisions

None. The former pre-M3 decisions are settled:

1. **Solver flavour:** TGS for v1, matching Box2D v3.
2. **CCD scope:** keep CCD in M5 for v1; M3/M4 may stub internally, but no public v1 may default `enableContinuous` to `true` unless CCD actually works.
3. **`System.ignoreSource`:** landed in `physics` and verified at VP-6.

## Recommendation

**Engineering can begin Milestone 0 immediately without further design review.** The component model, public API, package layout, internal state attachment (singleton), identifier strategy, and Vecs integration (relationships) are all settled against current Vecs. Tests for Milestone 0 can be written from the component defaults table and the `installPhysics` contract above.

The one cross-library dependency, `System.ignoreSource` (pose-sync), has landed in `physics`; re-verify its semantics with a focused test at VP-6 (see **Vecs Dependencies**).

The architecture is fully signed off for Milestone 3. No further design reviews are required until v2 unless implementation uncovers a solver correctness blocker.

## Appendix: Source Files Studied

### `lib/vecs-physics/docs/`

- `index.md`, `getting-started.md`, `bodies.md`, `shapes.md`, `materials-and-filters.md`, `forces-and-impulses.md`, `events.md`, `kinematic-motion.md`, `systems-and-phases.md`, `debug-validation.md`, `internals.md`, `roadmap.md`, `components.md`.

### `lib/vecs/src/` (current layout, post-refactor)

- `world/` (split module) — `world.components.ts` (`component`, `setExclusiveComponents`), `world.pipeline.ts`, `world.queries.ts`, `world.modules.ts`, `world.deferred.ts` — defer/flush, phases, progress, registration.
- `entity/` (split module) — `entity.components.ts` (set/add/attach/remove/getMut/modified), `entity.relationships.ts` (`parent(ref)`, `children(ref)`, incoming-link maintenance), `entity.lifecycle.ts` (destroy + relationship cleanup).
- `relationship.ts` — `Relationship` base + built-in `ChildOf`.
- `query.ts` — predicate compilation, watchlists, `enter`/`exit`/`update`/`each`/`forEach`/`sort`/`groupBy` routing.
- `system.ts` — inbox model, `_run` defer scope, phase binding, tick sources, `ignoreSource` (feedback silencing).
- `dsl.ts` — query DSL surface: `all`/`any`/`not`/`only`/`target`/`source`/`parent`/`children`/`test`.
- `inject.ts` — `up`/`down` relationship injection, `Iter` cursor with `src` source-tracking.
- `terms/` — per-term classes incl. `target_term.ts` (relationship fan-out reactivity).
- `modules/singleton.ts` — `Singleton` one-instance-per-world enforcement.
- `group.ts` (in `cascade` worktree, uncommitted) — `Query.groupBy` projection.
- `phase.ts`, `command.ts`, `component.ts`, `component_meta.ts`, `filter.ts`, `timer.ts`, `index.ts`.

### `lib/vecs-physics/box2d/` (read for porting)

Public surface and constants:

- `include/box2d/types.h`, `id.h`, `collision.h`, `math_functions.h`, `constants.h`, `base.h`.
- `docs/hello.md`, `simulation.md` — sectioned through Joints (joints skimmed; deferred).

Source to port (open per ticket; the original path goes in a comment in each ported file):

- Pipeline orchestration: `solver.c` (`b2Solve`, `b2SolverTask`, `b2IntegrateVelocitiesTask`, `b2IntegratePositionsTask`, `b2FinalizeBodiesTask`, `b2SolveContinuous`), `solver.h` (`b2SolverStageType` — the stage order, see **Solver pipeline**).
- Constraint solving: `contact_solver.c` (`b2PrepareContacts_Overflow`, `b2WarmStartContacts_Overflow`, `b2SolveContacts_Overflow`, `b2ApplyRestitution_Overflow`, `b2StoreImpulses_Overflow`), `contact_solver.h`.
- Soft-constraint coefficients & constants: `core.c` (`b2MakeSoft`), `constants.h`.
- Narrow phase: `manifold.c` (the twelve `b2Collide*` functions), `contact.c` (`b2UpdateContact`, begin/end-touch flags, `b2SimplexCache` persistence).
- Broad phase: `broad_phase.c`, `dynamic_tree.c` (`b2DynamicTree_*`).
- Bodies/shapes/mass: `body.c` (`b2UpdateBodyMassData`, `b2Body_SetType` transfer logic), `shape.c`, `geometry.c`, `aabb.c`.
- Sets, islands, sensors: `solver_set.c`, `island.c`, `sensor.c`.
- Collision primitives: `distance.c` (`b2ShapeDistance`/GJK, `b2ShapeCast`, `b2TimeOfImpact`), `math_functions.c`.
- Hull validation subset: `hull.c` (`b2ComputeHull`, `b2ValidateHull`) — enough to validate convex polygons.

Test sources (golden references — see **Box2D parity matrix**):

- `test/test_world.c`, `test_shape.c`, `test_collision.c`, `test_distance.c`, `test_dynamic_tree.c`, `test_math.c`, `test_determinism.c`; runner `test/main.c`.
- `samples/sample_stacking.cpp`, `sample_continuous.cpp`, `sample_events.cpp`, `sample_bodies.cpp`, `sample_robustness.cpp`, `sample_determinism.cpp`, `sample_benchmark.cpp` — integration scenarios.

Files explicitly skipped for v1: every joint source (`joint.c`, `*_joint.c`), `mover.c`, `constraint_graph.c`, `parallel_for.c`, `scheduler.c`, `atomic.h`, `arena_allocator.c`, `bitset.c`, `table.c` — replaced by built-ins or out of scope.
