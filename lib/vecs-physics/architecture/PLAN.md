# vecs-physics Engineering Architecture Plan

Status: draft for engineering review.
Author: architecture pass over the docs, Vecs internals, and Box2D source.
Target: v1 of `@vworlds/vecs-physics`.

## Executive Summary

`vecs-physics` is a native Vecs 2D rigid-body engine. The simulation model is Box2D's. The public model is Vecs entities and components. Users never see a `b2WorldId`, a `b2BodyId`, a callback, or a handle.

The plan ports Box2D's simulation pipeline (broad-phase BVH → narrow-phase manifolds → island building → constraint solver → sleep / writeback / events) into TypeScript, then wraps that engine in a small set of Vecs systems that read intent from components and write results back to components. The engine sits behind a private `PhysicsState` attached to the world by `WeakMap<World, PhysicsState>`. Entities map to dense internal indices through (index, generation) handles. Hot solver storage is plain TypedArrays / dense object arrays; the ECS is the **interface**, not the solver representation.

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
- Cross-platform deterministic float behaviour at the bit level. We get deterministic order; bit-identical results across JS engines are not guaranteed. Document this.

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

1. Register every public component class via `world.registerComponent(...)`.
2. Call `world.setExclusiveComponents(Box, Circle, Capsule, Segment, Polygon, Chain)`.
3. Create or look up the three physics phases. Names default to `"physics-pre"`, `"physics-step"`, `"physics-post"`.
4. Install the physics systems into those phases (listed below).
5. Allocate a `PhysicsState` and bind it to the world via `WeakMap<World, PhysicsState>`.
6. Throw if called after `world.start()` (Vecs registration is locked).
7. Throw if called twice on the same world (single install per world).

Order in `installPhysics` matters: registration before `setExclusiveComponents` before `system(...)`. The function itself runs before `world.start()`.

### Authoritative Component Defaults

These are part of the contract. They must match Box2D's `b2DefaultBodyDef()`, `b2DefaultShapeDef()`, `b2DefaultFilter()`, `b2DefaultSurfaceMaterial()`:

| Component                      | Field                             | Default                  |
| ------------------------------ | --------------------------------- | ------------------------ |
| `Body`                         | `type`                            | `BodyType.Static`        |
|                                | `bullet`                          | `false`                  |
|                                | `enabled`                         | `true`                   |
|                                | `allowFastRotation`               | `false`                  |
| `Position`                     | `x, y`                            | `0, 0`                   |
| `Rotation`                     | `angle`                           | `0`                      |
| `LinearVelocity`               | `x, y`                            | `0, 0`                   |
| `AngularVelocity`              | `value`                           | `0`                      |
| `Damping`                      | `linear, angular`                 | `0, 0`                   |
| `GravityScale`                 | `value`                           | `1`                      |
| `MotionLocks`                  | `x, y, rotation`                  | `false, false, false`    |
| `Sleep`                        | `enabled, awake, threshold`       | `true, true, 0.05`       |
| `ShapePosition`                | `x, y`                            | `0, 0`                   |
| `ShapeRotation`                | `angle`                           | `0`                      |
| `Box`                          | `hx, hy`                          | `0.5, 0.5`               |
| `Circle`                       | `radius`                          | `0.5`                    |
| `Capsule`                      | `x1, y1, x2, y2, radius`          | `-0.5, 0, 0.5, 0, 0.25`  |
| `Segment`                      | `x1, y1, x2, y2`                  | `-0.5, 0, 0.5, 0`        |
| `Polygon`                      | `vertices, radius`                | `[], 0`                  |
| `Chain`                        | `points, loop`                    | `[], false`              |
| `Material`                     | `density`                         | `1`                      |
|                                | `friction`                        | `0.6`                    |
|                                | `restitution`                     | `0`                      |
|                                | `rollingResistance, tangentSpeed` | `0, 0`                   |
|                                | `userMaterialId`                  | `0n`                     |
| `CollisionFilter`              | `categoryBits`                    | `1n`                     |
|                                | `maskBits`                        | `0xffff_ffff_ffff_ffffn` |
|                                | `groupIndex`                      | `0`                      |
| `Force` / `Impulse`            | `x, y, wake`                      | `0, 0, true`             |
| `Torque` / `AngularImpulse`    | `value, wake`                     | `0, true`                |
| `KinematicTargetPosition`      | `x, y, tolerance, wake`           | `0, 0, 0.001, true`      |
| `KinematicTargetRotation`      | `angle, tolerance, wake`          | `0, 0.001, true`         |
| `ContactEvents`/`SensorEvents` | `begin, end`                      | `[], []`                 |
| `HitEvents`                    | `hits`                            | `[]`                     |

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
│   │   ├── lifecycle.ts          Body / shape create-destroy-update systems.
│   │   ├── pose_sync_in.ts       Teleports: Position/Rotation/velocity user-writes → engine.
│   │   ├── forces.ts             Force/Torque gather + Impulse/AngularImpulse accumulation.
│   │   ├── kinematic.ts          KinematicTargetPosition/Rotation drive.
│   │   ├── step.ts               PhysicsStep — invokes engine.step(dt, subSteps).
│   │   ├── pose_sync_out.ts      Writeback: engine → Position/Rotation/velocity components.
│   │   ├── events.ts             ContactEvents, HitEvents, SensorEvents publish.
│   │   ├── reparent_scan.ts      Pre-step scan for reparented shapes (see Reparenting).
│   │   └── debug.ts              Debug validation (only registered if debug:true).
│   │
│   ├── engine/
│   │   ├── state.ts              PhysicsState + WeakMap accessor.
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

The single exception we may want is a non-exported `_ShapeParentLink` marker storing the parent body's eid at the moment the shape was created. This would let the reparent scan be component-driven instead of map-driven. **Recommendation: do not add it in v1.** The reparent scan over `PhysicsState.shapeByEntity` is small enough.

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

const _physics = new WeakMap<World, PhysicsState>();

export function attachPhysics(world: World, state: PhysicsState): void {
  _physics.set(world, state);
}
export function getPhysics(world: World): PhysicsState {
  const s = _physics.get(world);
  if (!s) throw new Error("installPhysics(world, ...) must be called before world.start()");
  return s;
}
```

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
  userMaterialId: bigint;

  categoryBits: bigint;
  maskBits: bigint;
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

1. `registerComponent(Position)`, `(Rotation)`, `(LinearVelocity)`, `(AngularVelocity)`, `(Body)`.
2. `(Damping)`, `(GravityScale)`, `(MotionLocks)`, `(Sleep)`.
3. `(ShapePosition)`, `(ShapeRotation)`.
4. `(Box)`, `(Circle)`, `(Capsule)`, `(Segment)`, `(Polygon)`, `(Chain)`.
5. `(Material)`, `(CollisionFilter)`, `(Sensor)`.
6. `(Force)`, `(Torque)`, `(Impulse)`, `(AngularImpulse)`.
7. `(KinematicTargetPosition)`, `(KinematicTargetRotation)`.
8. `(ContactEvents)`, `(SensorEvents)`, `(HitEvents)`.
9. `world.setExclusiveComponents(Box, Circle, Capsule, Segment, Polygon, Chain)`.
10. Phase creation/lookup (defaults: `physics-pre`, `physics-step`, `physics-post`).
11. System creation (next subsection).
12. `PhysicsState` allocation and attach.

The exact ordering matters for deterministic component type ids: Vecs assigns ids in registration order (starting at 256), so registering in the same order on every world produces matching ids. Cross-instance determinism cares; tests should not.

### Internal-state attachment

**Decision: `WeakMap<World, PhysicsState>`**.

Reasons over the alternatives:

- A private singleton entity is overkill — we'd need a private component, a query, and an enter handler to find it.
- Closure-captured state inside `installPhysics` is functionally identical to a WeakMap but cannot be reached from tests or from other modules in the package.
- A WeakMap GCs along with the world; nothing leaks if a test creates and discards many worlds.

A single exported helper:

```ts
export function getPhysics(world: World): PhysicsState {
  /* throws if not installed */
}
```

is the only legal way to reach engine internals from inside the package. Outside the package, the helper is not exported. Engineers must avoid stuffing references to `PhysicsState` into user-visible types.

### Entity-reference safety

`Entity` objects in Vecs persist as JS objects even after `entity.destroy()` — Vecs sets `_destroyed = true` and removes the entity from the world map, but the object reference may still be held by user code or by our internal arrays. This is safe for **reads** (`entity.get(C)` returns undefined; `entity.eid` is stable; `entity.parent` is cleared). It is **unsafe for writes** (`entity.set` enqueues a command that `_set` will no-op via `_destroyed`).

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
      PhysicsLifecycle              (enter/exit/update for Body and geometry components)
      PhysicsReparentScan           (detect shape reparenting)
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
- Hooks can't `entity.set(...)` safely without re-entering the queue. For zeroing impulses we need silent writes, which we do **outside** Vecs's command machinery entirely (direct property writes; see Silent Mutations).
- Systems give us a single, debuggable choke point per phase. This is worth more than the marginal latency of one frame's delay.

The one exception we use hooks for: nothing in v1. We may add `onRemove(Body)` later as a defensive teardown if the lifecycle system somehow misses an event, but the system path is sufficient.

## System And Phase Pipeline

Each system below lists: phase, query, callbacks, ordering. Every system runs single-threaded.

### `PhysicsLifecycle` (phase: `physics-pre`)

One system, several callbacks. Owns body and shape creation/destruction.

- Query A: `Body`. Tracks body entities.
  - `.enter([Position, Rotation], (e, [pos, rot]) => { ... })` — create internal body at pos (or origin), with rotation (or 0). Read `Body.type`, copy to internal body. Read optional `Damping`/`GravityScale`/`MotionLocks`/`Sleep`/`LinearVelocity`/`AngularVelocity` from `e` directly during this callback. Insert into appropriate solver set. Add to `bodyByEntity`. Walk `e.children` for any with geometry components; for each, create an InternalShape if not already in `shapeByEntity`.
  - `.exit((e) => { ... })` — look up `bodyByEntity[e.eid]`. Destroy the internal body: walk shape linked list, destroy each shape (proxy + contacts); remove from solver set; release id. Remove from `bodyByEntity`. **Do not** touch the entity; it may already be destroyed.
  - `.update(Body, (e, body) => { ... })` — `body.type`/`bullet`/`enabled`/`allowFastRotation` changes propagate to internal body. Type changes go through `BodyTransfer` between solver sets. Enable/disable transfers between AWAKE_SET and DISABLED_SET.

- Query B: `{ OR: [Box, Circle, Capsule, Segment, Polygon, Chain] }`. Tracks geometry entities.
  - `.enter((e) => { ... })` — check `e.parent` for `Body`. If none → record skip in debug. If yes → create InternalShape parented to that body's handle. If the parent body's mass should be auto-updated, mark `body.massDirty = true`. Add to `shapeByEntity`.
  - `.exit((e) => { ... })` — look up `shapeByEntity[e.eid]`. Destroy the internal shape (proxy, edges from body's contact list, remove from broad phase). Mark body mass dirty. Remove from map.
  - `.update(Box, ...)`, `.update(Circle, ...)`, etc. — same callback per geometry type: re-validate geometry, copy to internal shape, recompute AABB, mark mass dirty, mark proxy enlarged so broad-phase refits.

  Because geometry components are exclusive, adding `Circle` to an entity that has `Box` fires Box exit → Circle enter; the system observes them in arrival order and naturally destroys the old shape before creating the new one.

This system embeds the **enter/exit ordering** requirement that solves the body-vs-shape creation race. Both inboxes drain in arrival order, but inside one `_run` we don't sort them — we process them sequentially. We rely on the fact that Vecs routes commands in arrival order: if user does `body.set(Body); child.setParent(body).set(Box)`, the Set(Body) command routes first, then SetParent, then Set(Box). Each routing immediately re-evaluates queries for that entity, so:

- After Set(Body) → Query A enters body → push enter event for Query A.
- After Set(Box) on child → Query B enters child → push enter event for Query B.

Both events end up in the system's single inbox, in that order. `_run` then dispatches them — Body enter fires first (creates internal body), Box enter fires second (parent has Body in ECS → shape attaches).

The **reverse order** is also handled correctly: if user does `child.setParent(some_temp).set(Box); body.set(Body); child.setParent(body)`, then Query B enters first (Box added, parent has no Body → skip create). When Body is added to `body`, Query A enters → `enter` callback walks `body.children` and discovers `child` with `Box` but no entry in `shapeByEntity` → creates the shape now. SetParent third → no Vecs event (parent isn't a component) → `PhysicsReparentScan` picks it up next step (see below).

### `PhysicsReparentScan` (phase: `physics-pre`)

Solves the "Vecs doesn't notify on `setParent`" problem.

```ts
.run((now, delta) => {
  const physics = getPhysics(world);
  physics.shapeByEntity.forEach((shapeHandle, eid) => {
    const e = world.entity(eid);
    if (!e || e._destroyed) {
      // Should have been cleaned up by lifecycle; defensive.
      destroyShape(physics, shapeHandle);
      physics.shapeByEntity.delete(eid);
      return;
    }
    const internal = physics.shapes[shapeHandle.index];
    const parentEntity = e.parent;
    const expectedBodyHandle = parentEntity ? physics.bodyByEntity.get(parentEntity.eid) : undefined;

    if (internal.bodyHandle === expectedBodyHandle) return;   // unchanged

    // Reparenting detected: destroy + recreate the shape.
    destroyShape(physics, shapeHandle);
    physics.shapeByEntity.delete(eid);
    if (expectedBodyHandle) {
      createShapeFromEntity(physics, e, expectedBodyHandle);   // re-adds to shapeByEntity
    }
  });
});
```

Cost: O(#shapes) per step. For the body+shape scale of typical games (hundreds to low thousands of shapes) this is negligible — it is plain map iteration with one parent lookup each. We document this cost in `internals.md`.

Alternative considered: subscribe to a global `setParent` hook on Vecs. Vecs does not expose one. We could add one in a focused vecs-side patch, but that's a separate change with its own review. v1 lives without it.

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

Important: this system runs **after** `PhysicsPoseSyncOut` of the previous frame. Why? Because `PhysicsPoseSyncOut` writes to `Position`/`Rotation` using `entity.modified(...)`, which queues update events for **next frame's** inbox of `PhysicsPoseSyncIn`. We don't want to interpret physics's own writeback as a teleport. The solution: in `PhysicsPoseSyncOut`, we **do not** call `entity.modified(Position)` — we write the field and only mark modified if the user has other update-watchers downstream. Actually, this breaks the docs contract ("physics writes Position back" must trigger user systems watching Position).

**Resolution: tag the engine's own writes.** `PhysicsPoseSyncOut` uses `entity.set(Position, { x, y })`, which queues a Set command. When `PhysicsPoseSyncIn` runs **next frame**, its inbox contains those updates. We need to distinguish engine-origin updates from user-origin updates.

Two options:

1. **Step-index gate**: when `PhysicsPoseSyncOut` writes pose, also stamp `state.bodyLastEngineWriteStep[handle.index] = stepIndex`. When `PhysicsPoseSyncIn` sees a Position update for body `b`, it compares `state.stepIndex` against `bodyLastEngineWriteStep[b]`. If the engine wrote pose during the immediately preceding step **and** the simulated pose matches the current Position component value, treat as no-op. If it doesn't match, treat as teleport. This handles the case where a user code in `physics-post` after `PhysicsPoseSyncOut` also wrote Position (genuine teleport intent).
2. **In-flight flag**: surround engine writeback with `state.suppressTeleportUpdates = true; ... ; state.suppressTeleportUpdates = false;`. `PhysicsPoseSyncIn` checks the flag, but that flag is per-frame and Vecs's command queue defers — the flag is already false by the time `PhysicsPoseSyncIn` runs next frame. So option 2 doesn't work as stated.

The realistic implementation: **track per-body last-known-engine pose**. After writeback, store `(x, y, angle)` in a parallel array. When `PhysicsPoseSyncIn` fires for that body, compare incoming Position vs last-known-engine pose. If equal (within epsilon), it's the engine's own writeback echoing back — drop. If different, user teleported in between.

This is straightforward to implement and the cost is one Float32 comparison per dynamic body per frame. We document this contract clearly.

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

- Query: `world.filter({ OR: [Force, Torque] })` — a non-reactive filter, walked once per step.
- For each match `e`:
  - Resolve target: if `e.get(Body)` exists → target is `e`. Else if `e.parent?.get(Body)` exists → target is `e.parent`. Else skip (debug warn if enabled).
  - Look up body handle.
  - If `e.get(Force)`: add to `body.forceX/forceY`. If `wake=true`, wake the body.
  - If `e.get(Torque)`: add to `body.torque`. Same wake rule.

Forces are accumulated into `BodySim.force/torque` for the upcoming step. After the step, the engine zeroes `BodySim.force/torque` itself (Box2D does this in `update transforms`); next step we accumulate fresh values.

### `PhysicsImpulseAccumulate` (phase: `physics-pre`)

Reactive — drains `Impulse` and `AngularImpulse` update events.

- `.update(Impulse, (e, impulse) => { ... })` and `.update(AngularImpulse, (e, ai) => { ... })`.
- For each update event:
  - Resolve target body (same immediate-parent rule).
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

### `PhysicsMassRecompute` (phase: `physics-pre`)

Last system in pre. Walks all bodies with `massDirty = true`, recomputes mass + inertia + local center from current shapes (`b2UpdateBodyMassData` equivalent):

- For each shape on the body: `b2ComputeShapeMass` returns `MassData{ mass, center, inertia }`. Combine over shapes using parallel-axis theorem.
- Dynamic body with zero total mass: zero out inertia/invInertia/invMass, set flags accordingly. Warn in debug.
- Update `body.mass`, `body.inertia`, `body.invMass`, `body.invInertia`, `body.localCenter`.
- Clear `massDirty`.

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
- Stamp `lastEngineWritePose[handle.index] = (x, y, angle)` for the teleport-detection logic in `PhysicsPoseSyncIn`.

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
  - `shape-without-parent-body`: `{ AND: [{ OR: [Box, Circle, ...]}, { NOT: { PARENT: Body } }] }` — query on entry warns once per entity+code.
  - `dynamic-body-without-density`: after `PhysicsMassRecompute`, walk dynamic bodies whose total mass is 0.
  - `chain-too-few-points`: in geometry update handler when `Chain.points.length < 4`.
  - `polygon-invalid`: in polygon update handler when `b2ValidateHull` (ported) rejects vertices.
  - `shape-position-on-body`: query `{ AND: [Body, ShapePosition] }`.
  - `position-on-shape-entity`: query `{ AND: [{ OR: [Box, ...] }, Position] }`. Note: shape entities **may** have Position from user code by accident; the docs flag this as a mistake.

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
    – PhysicsLifecycle Query A re-evaluates → enter event queued in inbox
  → PhysicsLifecycle._run() (this or next frame):
    – read Position/Rotation/velocity/Damping/GravityScale/MotionLocks/Sleep
    – idPool.acquire() → handle (index, generation)
    – construct InternalBody, BodySim, BodyState
    – place in solver set (AWAKE if dynamic, STATIC if static, etc.)
    – walk children for existing geometry entities → create shapes
    – bodyByEntity.set(eid, handle)
    – body.massDirty = true if dynamic & has shapes
```

### Remove `Body`

```text
user: entity.remove(Body)  OR  entity.destroy()
  → Vecs queues Remove (or Destroy which iterates components)
  → PhysicsLifecycle Query A exit fires
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
user: world.entity().setParent(body).set(Box, {hx, hy})
  → SetParent + Set commands queue
  → routing: child gets Box → Query B enters (geometry query)
  → PhysicsLifecycle._run (geometry enter callback):
    – check child.parent?.get(Body) — if no, skip (debug warn).
    – read ShapePosition / ShapeRotation / Material / CollisionFilter / Sensor from child
    – compute initial AABB in world space
    – idPool.acquire() → shapeHandle
    – construct InternalShape; insert into broad-phase tree of body.type
    – link into body.shapeHead linked list
    – shapeByEntity.set(eid, shapeHandle)
    – body.massDirty = true
```

### Change geometry component

Two sub-cases:

1. **Same component, props changed** (e.g. `box.set(Box, {hx: 0.7})`): geometry update handler resizes in place; AABB recomputed; mass dirty; broad-phase proxy enlarged.
2. **Geometry type swapped** (Box → Circle): exclusivity removes Box first → Query B exit → destroy old shape. Then Circle adds → Query B enter → create new shape.

Both are correct under Vecs's natural ordering.

### Remove geometry

Query B exit fires → destroy proxy, edges, contacts touching this shape; release shape id; clear `shapeByEntity`; mark body mass dirty.

### Reparent shape

Handled by `PhysicsReparentScan` (see above). Destroy + recreate the shape with the new parent (or destroy outright if new parent has no Body).

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

| Direction     | Source                           | Mechanism                            | Notes                                                         |
| ------------- | -------------------------------- | ------------------------------------ | ------------------------------------------------------------- |
| User → engine | `entity.set(Position, ...)`      | `PhysicsPoseSyncIn.update(Position)` | Teleport unless echo of last engine write (within epsilon).   |
| User → engine | `entity.set(LinearVelocity,...)` | `PhysicsPoseSyncIn.update(LinearV)`  | Always applied; tracked similarly to detect echoes if needed. |
| Engine → user | Body moved during step           | `PhysicsPoseSyncOut.run`             | `entity.set(Position, {x,y})`; stamp lastEngineWritePose.     |
| Engine → user | Body velocity changed            | `PhysicsPoseSyncOut.run`             | Only writes to components present on the entity.              |

Echo detection: compare `Math.abs(componentValue - lastEngineWriteValue) < 1e-9`. The numbers are bit-identical when round-tripped through Vecs because Vecs only copies the values back via `Object.assign`. In practice we can use strict equality on floats (the value came from us last frame and went straight back through Vecs).

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

## Determinism And Ordering

v1 is single-threaded. Determinism is a function of:

1. **Entity creation order.** Vecs assigns eids monotonically. Tests should not assume specific eid values, but identical entity-creation sequences must yield identical eids.
2. **Internal id assignment order.** Our `IdPool` reuses freed slots before allocating new ones; the order is deterministic given an identical sequence of acquire/release calls.
3. **System ordering.** Phases run in registration order; systems within a phase run in registration order; inbox events fire in arrival order. All deterministic.
4. **Math.** JavaScript's `Math.*` is not bit-deterministic across engines, but for a single V8 instance the results are stable. We don't promise cross-engine bit-identity; we promise cross-run identity on the same engine.
5. **Map iteration.** ES Map iteration follows insertion order. We rely on this for `bodyByEntity`, `shapeByEntity`.

Box2D-equivalence tests must run in a single V8 instance (Node `vitest`) and expect tight float tolerances (1e-5 or tighter for short simulations, looser for long ones).

## Performance Strategy

Order of priority for v1:

1. **Don't pessimise the ECS.** The lifecycle systems must not iterate every entity every frame. They use reactive queries that index by component type, so they only see entities that changed.
2. **Reactive force gather is per-step, but cheap.** A `world.filter({ OR: [Force, Torque] })` walks all entities each step. For 1000 entities that's a 1000-iteration loop with a single component lookup per iteration. The filter is built once at install. Acceptable for v1.
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

### Box2D parity matrix

Mirror every Box2D unit test that exercises functionality v1 supports. `box2d/test/` and `box2d/samples/` are sources. For each, a corresponding test under `lib/vecs-physics/tests/parity/`. Naming: `tests/parity/<box2d_test_name>.test.ts`. Each test must assert at least one trajectory check against the expected Box2D output (manually captured once, kept as a JSON snapshot under `tests/parity/snapshots/`).

Minimum parity set for v1:

- `hello_world` — 90 steps of dynamic box dropping onto static ground.
- `falling_chain` — chain shape on static, several dynamic balls dropping.
- `compound_body` — multiple shapes on one body.
- `restitution` — bouncing ball at varying restitution values.
- `friction_ramp` — boxes sliding down inclined static body.
- `sleep_threshold` — bodies coming to rest and going to sleep.
- `bullet_vs_static` — high-velocity bullet not tunnelling.
- `sensor_overlap` — sensor begin/end events.

### Required functional tests (from the brief)

| Area                         | Test                                                                                                                               |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Component defaults           | `new Body()` matches `b2DefaultBodyDef()` projected to our subset; same for every component.                                       |
| Component registration       | `installPhysics` registers every public component; `world.getComponentMeta(Body)` works post-install.                              |
| Component exclusivity        | Adding `Circle` after `Box` removes `Box`. Adding `Polygon` removes `Circle`.                                                      |
| Body creation                | `entity.set(Body, dynamic)` + Position + child Box → after `progress`, body falls.                                                 |
| Body destruction             | `body.destroy()` removes the internal body; child shape entity is also destroyed; subsequent steps don't read deleted slot.        |
| Shape child creation         | Adding `Box` after `Body` and before `start()` succeeds; same after start; same in subsequent frame.                               |
| Shape child destruction      | Removing geometry component destroys internal shape; body persists; mass recomputed.                                               |
| Immediate-parent rule        | Geometry on a grandchild of Body is ignored. Force on grandchild is ignored.                                                       |
| Missing optional defaults    | Body without Position starts at origin; without Rotation, angle 0; without Material, density 1; without CollisionFilter, mask all. |
| Force persistence            | `Force(10, 0)` on dynamic body produces 10 N every step until removed.                                                             |
| Multiple child forces        | Two child entities with Force, each with different vector — body sees the sum.                                                     |
| Impulse accumulation         | `set(Impulse, {x:1}); set(Impulse, {x:2}); set(Impulse, {x:3})` → body receives 6 N·s impulse before next step.                    |
| Silent impulse zeroing       | After step, `entity.get(Impulse)` has `x=0, y=0` but `entity.events.has(Impulse update)` is false (no modified fired).             |
| Dynamic pose sync            | After step, `entity.get(Position)` returns physics result. `entity.get(LinearVelocity)` updated if present.                        |
| User teleport                | Mid-simulation `entity.set(Position, {...})` moves the body. Next step starts from teleported position.                            |
| Echo vs teleport             | The Pose-sync-out write does **not** subsequently trigger teleport in the next pre-step.                                           |
| Kinematic target convergence | Kinematic body with `KinematicTargetPosition` moves toward target each step; stops within tolerance; component stays attached.     |
| Kinematic target re-engage   | After body reaches target, updating the target moves it again.                                                                     |
| Contact event opt-in         | Two shapes colliding; only the one with `ContactEvents` receives events.                                                           |
| Empty event step is silent   | Frame N produces contact events → `modified` fires. Frame N+1 no events → no `modified` fires; array empty.                        |
| Sensor opt-in                | Sensor without `SensorEvents` produces nothing. With it, begin/end fire on overlap.                                                |
| Hit event threshold          | Slow contact does not produce HitEvent; fast contact does.                                                                         |
| Debug warning dedupe         | Invalid structure persisting for 600 steps logs exactly once.                                                                      |
| Debug warning re-arm         | Structure becomes valid, then becomes invalid again → second warning emitted.                                                      |
| Reparenting                  | Shape moved to a new Body — next step it is a shape on the new body.                                                               |
| Reparenting to non-Body      | Shape moved to an entity without Body — shape is destroyed.                                                                        |
| Filter change                | Updating `CollisionFilter` to exclude an existing partner destroys their contact within one step.                                  |

### Test infrastructure

- `tests/fixtures/world.ts` — `makePhysicsWorld(opts)` helper.
- `tests/fixtures/step.ts` — `runSteps(world, n)` helper that calls `progress(t, 1000/60)` `n` times.
- `tests/fixtures/snapshot.ts` — `snapshotPositions(world, entities)` → JSON; comparable against `tests/parity/snapshots/*.json` with configurable tolerance.

Coverage gate: tests must hit every code path in `src/systems/` and the engine pipeline orchestrator. Engine internals (manifold/\* etc.) are exercised through parity tests + targeted unit tests.

## Implementation Milestones

### Milestone 0 — Scaffolding + math + components (1 week)

- `src/math/*` and `src/util/*` ported.
- All public component classes registered, with defaults and accessor pairs.
- `installPhysics` implemented down to component registration + phase creation, but engine is a no-op.
- Test matrix for component defaults / registration / exclusivity green.

### Milestone 1 — Body lifecycle + pose sync (1.5 weeks)

- `engine/state.ts`, `engine/body.ts`, `IdPool`, solver sets (storage only).
- `PhysicsLifecycle` for Body (no shape yet); `PhysicsPoseSyncIn`/`Out` with echo detection.
- Tests: body creation/destruction, teleport, default pose, default Body type.
- Engine `step()` is a no-op integrator (gravity only on dynamic bodies, no contacts). Falling-body test passes (no ground collision yet).

### Milestone 2 — Shape lifecycle + broad/narrow phase (3 weeks)

- `engine/shape.ts`, `engine/broad_phase.ts`, `engine/dynamic_tree.ts`.
- `engine/manifold/` for circle×circle, circle×polygon, polygon×polygon, capsule×*, segment×*.
- `PhysicsLifecycle` for geometry; `PhysicsReparentScan`; `PhysicsMaterialFilterSync`; `PhysicsShapePoseSync`.
- `engine/narrow_phase.ts` dispatch table.
- `engine/mass.ts`.
- Tests: contact generation (no solving yet — bodies pass through), AABB queries internally consistent, reparenting, mass updates.

### Milestone 3 — Contacts + sequential-impulse solver (3 weeks)

- `engine/contact.ts` (persistence, edges, manifolds).
- `engine/island.ts` (build, merge; split deferred to M5).
- `engine/solver.ts` (warm-start, prepare, integrate-velocity, solve, integrate-position, relax, restitution, store).
- Box2D `hello_world` parity test green.
- Tests: stacking stability, restitution, friction, compound body.

### Milestone 4 — Forces, impulses, kinematic, events (1.5 weeks)

- `PhysicsForceGather`, `PhysicsImpulseAccumulate`, `PhysicsImpulseZero`, `PhysicsKinematicTargets`, `PhysicsEvents`.
- `engine/sensor.ts` for sensor overlap.
- All v1 functional tests green.
- Parity tests for `sensor_overlap`, `friction_ramp`, `bullet_vs_static` (minus continuous CCD).

### Milestone 5 — Sleep + continuous CCD + debug validation (1.5 weeks)

- Island split for sleep candidates; sleeping solver sets.
- `engine/ccd.ts` for bullet path (single-threaded port of Box2D's bullet stage).
- `PhysicsDebugValidation` system + warning dedupe.
- Performance pass: profile a 200-body scene; optimise hot allocations.

### Milestone 6 — Hardening and docs (1 week)

- Doc reconciliation: every docs page asserts a tested behaviour.
- Internal `architecture/SOLVER.md` capturing the solver port in detail.
- One round of fuzz testing: random scene generation, no NaN, no infinite loops.

**Total: ~12 weeks for one engineer, ~7 weeks for two working in parallel (M2/M3 can split).**

## Risks And Open Questions

### Risks

1. **Solver determinism vs JS Math.** Box2D guarantees bit-determinism with specific compiler flags. We don't. Long-running parity tests will drift. Mitigation: cap parity assertion windows at 5–10 seconds simulated; for longer windows use looser tolerances or geometric properties (e.g. "ball comes to rest within Δx of expected").
2. **Reparent scan cost.** O(#shapes) per frame is fine until #shapes ≫ #bodies (chain shapes inflate the count). Watch for this in profiling; if it dominates, add a `ParentDirty` flag set by a Vecs setParent hook (requires upstream Vecs change).
3. **`Box.width`/`height` setter footgun.** Direct setter doesn't trigger `modified`. Mitigation: clearly document it. Consider, in v2, generating a wrapper that auto-marks modified.
4. **Event-array `length = 0` reuse.** If user code retains the array reference across frames, they'll see in-place mutation. This is per the docs but easy to miss. Tests should explicitly verify the array is the same instance after clear.
5. **Generation overflow.** Box2D uses `uint16_t` generation per slot. After 65k creates/destroys in one slot, ids wrap. We can use a plain `number` (53-bit safe int) for negligible cost. Recommend: use `number`, no overflow concern.
6. **Single physics install per world.** Tests may want multiple worlds. The WeakMap supports that. They may also want re-install. We forbid it (throw on second install). If needed, add `uninstallPhysics(world)` in v2.

### Open Questions (need eng review before M3)

**Q1. Solver flavour: TGS or PGS?** Box2D v3 uses Temporal Gauss-Seidel (TGS) with sub-stepping. PGS (the v2-era classic) is simpler to port and to debug. TGS is more stable. We currently plan TGS to preserve parity with current Box2D. If parity tests become too brittle, falling back to PGS for v1 is acceptable; we'd lose the "exact same output" guarantee but keep "same behaviour".

**Recommendation: TGS.** It's the documented direction; bringing it up later is harder than getting it right now.

**Q2. Bullet/CCD scope.** Box2D's bullet path uses TOI computation and a second sub-pass. Porting this is real work and the doc explicitly says "bullets are not a substitute for ray casts." For v1 we could ship without CCD and document it. Users who hit tunnelling would set `enableContinuous: false` (default true) or accept the limitation.

**Recommendation: ship `enableContinuous` true, but the bullet path may be a stub that does nothing in M3/M4 and gets filled in M5.** Parity tests for bullets stay yellow until M5.

**Q3. Vecs `setParent` hook.** Adding a global `world.onSetParent((entity, oldParent, newParent) => ...)` to Vecs would let us avoid the per-step reparent scan. This is a ~30-line patch to `lib/vecs/src/entity.ts` and `world.ts`. Not required for v1 correctness, but it would clean up `PhysicsReparentScan`.

**Recommendation: defer the Vecs change to v2.** The scan is small. Don't change two libraries at once.

### Resolved Decisions

- Internal state: `WeakMap<World, PhysicsState>`. Decided.
- Internal handles: `(index, generation)` tuples; never public. Decided.
- Component registration order: as listed above. Decided.
- System reactivity: systems, not hooks. Decided.
- Reparent detection: per-step scan over `shapeByEntity`. Decided.
- Silent impulse zero: direct property writes, bypass `modified`. Decided.
- Event array semantics: clear-in-place, modified only on new events. Decided.
- Geometry updates: same-type in place, type-swap is delete + create via exclusivity. Decided.
- Mass recomputation: dirty flag + final pre-step recompute system. Decided.
- Sleep: supported in v1 via `Sleep` component. Defaults match Box2D. Decided.

## Required Implementation Tickets

Below is the ticket breakdown the engineering team can pick up directly. Each ticket lists files, tests, and a definition of done.

### Phase: Foundation

- **VP-1: math/vec2, math/rot, math/transform, math/aabb, math/constants.**
  - Files: `src/math/*.ts`.
  - Tests: per-function unit tests under `tests/math/`. Mirror Box2D math tests where they exist.
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

### Phase: Body lifecycle

- **VP-5: engine/body.ts — InternalBody, BodySim, BodyState; solver sets; transfer functions.**
  - Files: `src/engine/body.ts`, `src/engine/solver_set.ts`.
  - Tests: transfers between awake/static/disabled sets preserve indices.

- **VP-6: systems/lifecycle.ts (body half) + systems/pose_sync_in.ts + systems/pose_sync_out.ts.**
  - Files: `src/systems/lifecycle.ts`, `src/systems/pose_sync_in.ts`, `src/systems/pose_sync_out.ts`.
  - DoD: body create/destroy, teleport, echo-detection works.

- **VP-7: systems/step.ts — minimal engineStep (gravity only).**
  - DoD: dynamic body falls under gravity; matches `pos.y = 4 - 0.5*10*t^2` (no contact yet).

### Phase: Shape lifecycle

- **VP-8: engine/shape.ts — InternalShape, GeometryUnion, AABB compute, mass compute.**

- **VP-9: engine/dynamic_tree.ts — full BVH port.**
  - Tests: insertion/removal/move correctness; balanced after N random operations.

- **VP-10: engine/broad_phase.ts — three trees, moveSet, pairSet, pair query.**

- **VP-11: systems/lifecycle.ts (shape half) + systems/reparent_scan.ts + material/filter/pose sync systems.**

- **VP-12: engine/mass.ts + systems/mass_recompute.ts.**

### Phase: Narrow phase

- **VP-13: engine/manifold/ — one ticket per pair type.**
  - VP-13a circle×circle, VP-13b circle×polygon, VP-13c polygon×polygon, VP-13d capsule×*, VP-13e segment×*, VP-13f chainSegment×\*.

- **VP-14: engine/narrow_phase.ts — dispatch and contact update.**

- **VP-15: engine/contact.ts — persistence, edges, begin/end touch flags.**

### Phase: Solver

- **VP-16: engine/island.ts — build, merge.**

- **VP-17: engine/solver.ts — TGS port.**
  - Largest ticket. Subdivide if needed: prepare, warm-start, solve, position, restitution, store.

- **VP-18: Box2D `hello_world` parity test green.**

### Phase: Forces / events / kinematic

- **VP-19: systems/forces.ts + systems/impulse_accumulate.ts + systems/impulse_zero.ts.**

- **VP-20: systems/kinematic.ts.**

- **VP-21: engine/sensor.ts + systems/events.ts.**

- **VP-22: HitEvents threshold scan.**

### Phase: Polish

- **VP-23: Sleep + island split.**

- **VP-24: Continuous collision for bullets.**

- **VP-25: PhysicsDebugValidation system.**

- **VP-26: Performance pass and benchmarks.**

- **VP-27: Doc audit — every doc page links to a passing test.**

## Unresolved Decisions

Two items remain open and should be settled before Milestone 3 starts:

1. **Solver flavour** (TGS vs PGS) — recommended TGS for parity; needs sign-off.
2. **CCD inclusion in M5 vs deferral** — recommended ship `enableContinuous` flag, stub CCD until M5; needs sign-off.

A third optional item, not blocking:

3. **Vecs `setParent` hook** — would simplify reparent scan. Defer to v2.

## Recommendation

**Engineering can begin Milestone 0 immediately without further design review.** The component model, public API, package layout, internal state attachment, identifier strategy, and Vecs integration are all settled. Tests for Milestone 0 can be written from the component defaults table and the `installPhysics` contract above.

Before Milestone 3 starts (the solver port), schedule a 1-hour solver review meeting to lock in TGS vs PGS and CCD scope. After that meeting the architecture is fully signed off and no further design reviews are required until v2.

## Appendix: Source Files Studied

### `lib/vecs-physics/docs/`

- `index.md`, `getting-started.md`, `bodies.md`, `shapes.md`, `materials-and-filters.md`, `forces-and-impulses.md`, `events.md`, `kinematic-motion.md`, `systems-and-phases.md`, `debug-validation.md`, `internals.md`, `roadmap.md`, `components.md`.

### `lib/vecs/src/`

- `world.ts` — defer/flush, phases, runPhase/progress, exclusivity, component registration.
- `entity.ts` — set/add/attach/remove/destroy/modified/setParent semantics, deferred mode.
- `query.ts` — predicate compilation, watchlists, enter/exit/update routing.
- `system.ts` — inbox model, `_run` defer scope, phase binding.
- `dsl.ts` — query DSL surface and the `PARENT` operator.
- `phase.ts`, `command.ts`, `component.ts`, `filter.ts`, `timer.ts`, `index.ts`.

### `lib/vecs-physics/box2d/` (read for porting)

- `include/box2d/types.h`, `id.h`, `collision.h`, `math_functions.h`, `constants.h`, `base.h` — public API surface and constants.
- `docs/hello.md`, `simulation.md` — sectioned through Joints (joints skimmed; deferred).
- `src/body.h`, `shape.h`, `physics_world.h`, `broad_phase.h`, `contact.h`, `solver.h`, `island.h`, `solver_set.h`, `sensor.h` — internal data structures and the algorithms we port.

Files explicitly left for later reads at implementation time:

- `src/body.c`, `shape.c`, `physics_world.c`, `broad_phase.c`, `contact.c`, `contact_solver.c`, `solver.c`, `solver_set.c`, `island.c`, `sensor.c`, `dynamic_tree.c`, `geometry.c`, `distance.c`, `manifold.c`, `math_functions.c`, `aabb.c` — full source bodies; opened per ticket.

Files explicitly skipped for v1: every joint source, `mover.c`, `constraint_graph.c`, `parallel_for.c`, `scheduler.c`, `arena_allocator.c`, `hull.c` (except convex-validity helper), `bitset.c`, `table.c`.
