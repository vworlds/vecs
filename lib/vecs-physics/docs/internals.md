# Internals

This page explains how `vecs-physics` is organized internally: how Vecs entities map to physics objects, how the engine keeps Box2D's architecture, and which implementation details are intentionally hidden from application code.

Most users do not need this page to use the library. It is useful when debugging physics behavior, contributing to `vecs-physics`, or trying to understand why the public API is shaped around bodies, child shape entities, and reactive components.

## Core Idea

`vecs-physics` is not a wrapper around a JavaScript Box2D port.

It is a Vecs-native physics engine that ports Box2D's simulation architecture and math into ECS terms.

The public API is components:

```ts
entity.set(Position, { x: 0, y: 4 });
entity.set(Body, { type: BodyType.Dynamic });
```

The internal engine still has concepts equivalent to Box2D's:

| Public Vecs concept                          | Internal physics concept           |
| -------------------------------------------- | ---------------------------------- |
| Entity with `Body`                           | Physics body                       |
| Child entity with `Box`, `Circle`, etc.      | Physics shape                      |
| `Position` and `Rotation`                    | Body transform                     |
| `Material`                                   | Shape density and surface material |
| `CollisionFilter`                            | Shape filter                       |
| `Force`, `Torque`, `Impulse`                 | Body force and impulse inputs      |
| `ContactEvents`, `SensorEvents`, `HitEvents` | Post-step event buffers            |

Application code should not depend on internal body ids, shape ids, contact ids, arrays, solver data, or broad-phase proxies.

## Internal World State

`installPhysics(world, options)` creates the internal physics world and registers Vecs systems that keep it synchronized with ECS state.

Conceptually, the internal state owns:

- Body storage.
- Shape storage.
- Contact storage.
- Broad-phase acceleration structures.
- Solver islands.
- Sleeping state.
- Event buffers.
- Pending force and impulse queues.
- Entity-to-physics-object mappings.

This state is not exposed as normal user-facing ECS components. It may be stored in private structures owned by the physics plugin, in internal-only components, or both. That is an implementation detail.

The important public guarantee is this: Vecs components are the source of user intent, and the physics engine writes back only the public state it owns, such as `Position`, `Rotation`, velocities, and event components.

## Entity Mapping

A body is created from an entity with `Body`.

```ts
const player = world.entity().set(Position, { x: 0, y: 4 }).set(Body, { type: BodyType.Dynamic });
```

A shape is created from an immediate child entity with one geometry component.

```ts
world.entity().setParent(player).set(Box, { hx: 0.5, hy: 1 });
```

The internal engine tracks mappings similar to:

```ts
bodyEntity -> internalBody
shapeEntity -> internalShape
internalShape -> shapeEntity
internalBody -> bodyEntity
```

These mappings let the solver process dense internal arrays while events and writebacks resolve back to Vecs entities.

## Why Shapes Are Child Entities

Box2D bodies can have multiple shapes. Shapes are local to their body and do not move independently in world space.

Vecs represents this naturally with child entities:

```ts
const body = world.entity().set(Position, { x: 0, y: 0 }).set(Body, { type: BodyType.Dynamic });

world.entity().setParent(body).set(Box, { hx: 0.5, hy: 1 });
world.entity().setParent(body).set(Circle, { radius: 0.25 }).set(ShapePosition, { x: 0, y: 1 });
```

This avoids a nested `Shapes` array component that would need custom diffing and manual `modified()` calls. It also lets Vecs' existing lifecycle machinery do useful work:

- Adding a child geometry entity creates a physics shape.
- Removing the geometry component destroys the physics shape.
- Destroying the child entity destroys the physics shape.
- Destroying the parent body entity destroys the internal body and all internal shapes.
- Adding `Material`, `CollisionFilter`, `Sensor`, or event components changes behavior for that shape only.

## Dense Internal Storage

Vecs entities are flexible and ergonomic. Physics solvers need dense, cache-friendly storage.

Internally, `vecs-physics` should not iterate arbitrary ECS component maps during narrow phase or solving. It should maintain physics-native arrays for simulation work.

Examples of dense internal data:

```ts
type InternalBody = {
  entity: Entity;
  positionX: number;
  positionY: number;
  angle: number;
  linearVelocityX: number;
  linearVelocityY: number;
  angularVelocity: number;
  inverseMass: number;
  inverseInertia: number;
  awake: boolean;
};
```

```ts
type InternalShape = {
  entity: Entity;
  bodyIndex: number;
  type: ShapeType;
  density: number;
  friction: number;
  restitution: number;
  categoryBits: bigint;
  maskBits: bigint;
  groupIndex: number;
  sensor: boolean;
};
```

The exact structures may differ, but the goal is the same as Box2D: keep simulation data compact and avoid using the ECS as the hot solver representation.

## Handles And Generations

Box2D's C API uses opaque ids with generation counters to avoid stale references.

`vecs-physics` does not expose these ids publicly, but the same idea is useful internally.

An internal handle can identify a body or shape by index plus generation:

```ts
type BodyHandle = {
  index: number;
  generation: number;
};
```

This protects internal queues and event buffers from stale objects after destruction and reuse.

Application code should use Vecs `Entity` references, not physics handles.

## Synchronization Pipeline

The physics systems are installed into Vecs phases. The exact phase names can be defaulted by `installPhysics` or supplied by advanced users.

A typical frame has three internal stages.

### 1. Sync ECS Into Physics

Before stepping, physics consumes ECS changes:

- New `Body` entities create internal bodies.
- Removed `Body` components destroy internal bodies.
- New child geometry entities create internal shapes.
- Removed geometry components destroy internal shapes.
- Modified `Position` or `Rotation` teleports bodies.
- Modified `LinearVelocity` or `AngularVelocity` updates body velocities.
- Modified `Material` updates shape material and mass.
- Modified `CollisionFilter` updates shape filtering.
- Modified `Impulse` queues one-shot kicks.

Forces and torques are persistent while present, so they are read during step preparation rather than removed.

### 2. Step The Simulation

The internal world advances one fixed timestep.

`vecs-physics` assumes the `delta` passed through Vecs is fixed according to the installed `fixedTimeStep` option. It does not need to run a variable-frame accumulator in the first version.

The step performs the Box2D-style simulation work:

- Broad-phase pair discovery.
- Narrow-phase collision generation.
- Contact updates.
- Island construction.
- Constraint solving.
- Velocity and position integration.
- Sleeping.
- Event generation.

### 3. Sync Physics Back Into ECS

After stepping, physics writes public results back:

- Dynamic body `Position` and `Rotation` are updated from simulation results.
- Velocity components are updated when present.
- `ContactEvents`, `SensorEvents`, and `HitEvents` components are filled when present on shape entities.
- Event components are marked modified only when new events arrive.

This lets normal Vecs systems react after physics:

```ts
world
  .system("ReactToContacts")
  .query(ContactEvents)
  .update(ContactEvents, (shape, events) => {
    for (const event of events.begin) {
      // event.other is the other shape entity
    }
  });
```

## Writeback Rules

Physics writeback follows the public API contract.

For dynamic bodies:

- Initial `Position` and optional `Rotation` seed the internal body.
- Physics owns `Position` and `Rotation` after stepping.
- User modification of `Position` or `Rotation` is treated as teleport intent.

For static and kinematic bodies:

- User modifications to `Position` and `Rotation` are pushed into the physics world.
- Kinematic target components can drive motion toward a target pose.

For event components:

- Event arrays are cleared every physics step.
- New events are pushed into arrays.
- `entity.modified(EventComponent)` is called only when new events arrive.
- If previous arrays were non-empty and the next step has no events, arrays are cleared silently.

## Force And Impulse Internals

Forces are persistent. The engine reads all active force sources each physics step.

```ts
player.set(Force, { x: 1, y: 2 });
```

Child force entities allow multiple independent sources:

```ts
world.entity().setParent(player).set(Force, { x: 10, y: 0 });
```

The target body resolution is intentionally shallow:

```ts
function resolveTarget(entity: Entity): Entity | undefined {
  if (entity.get(Body)) return entity;
  if (entity.parent?.get(Body)) return entity.parent;
  return undefined;
}
```

The engine does not recurse through grandparents.

Impulses are reactive. Each `Impulse` update queues a kick internally. Multiple updates before the step accumulate.

```ts
player.set(Impulse, { x: 1, y: 0 });
player.set(Impulse, { x: 2, y: 0 });
player.set(Impulse, { x: 0, y: 3 });

// Internal pending impulse: { x: 3, y: 3 }
```

After applying pending impulse values, physics silently resets public impulse fields to zero without calling `modified(Impulse)`.

This avoids archetype churn while keeping the public API reactive.

## Events Internals

Box2D exposes event arrays after the world step. `vecs-physics` preserves this model internally but routes events to shape entities that opted in.

For a contact between shape A and shape B:

- If shape A has `ContactEvents`, append `{ other: shapeBEntity }` to shape A's event array.
- If shape B has `ContactEvents`, append `{ other: shapeAEntity }` to shape B's event array.
- Mark only the event components that received new events as modified.

Same idea for hit and sensor events.

If the implementation already has the other body entity available at no meaningful cost, event payloads may include it. The guaranteed minimal event identity is the other shape entity.

## Debug Validation

Normal mode should ignore invalid ECS structures efficiently.

Debug mode can inspect common mistakes and warn once per entity/issue code.

Examples:

- Shape entity has no immediate parent body.
- Dynamic body has no non-sensor shape with non-zero density.
- `Chain` has fewer than four points.
- `Polygon` is invalid.
- Shape-local components are attached to a body entity.
- Body components are attached to a shape entity by mistake.

Warnings must be deduplicated. A bad entity should not flood the console every frame.

## Common Gotchas

### Internal Data Is Not Public API

Do not rely on internal ids, array indices, private properties, or generated handles. They can change without a public API break.

Use entities and components instead.

### ECS Is Not The Solver Storage

It is tempting to make every solver concept a public component. That would make the engine easy to inspect but slow and noisy.

The ECS is for user-authored state and integration points. The solver should use dense internal storage.

### Child Shape Lookup Is Shallow

Shape entities and force-source entities use immediate parent rules. This is intentional because it keeps behavior predictable and cheap.

This applies:

```ts
shape.setParent(body);
```

This does not apply to `body` unless the middle entity has its own `Body`:

```ts
grandchild.setParent(child);
child.setParent(body);
```

### Silent Cleanup Must Not Emit User Events

Physics may mutate internal or public component fields for cleanup, such as zeroing `Impulse` after applying it. Cleanup should not call `modified()` unless the user-facing state change is intended to trigger systems.

## Related Pages

- [Systems And Phases](./systems-and-phases.md)
- [Bodies](./bodies.md)
- [Shapes](./shapes.md)
- [Forces And Impulses](./forces-and-impulses.md)
- [Events](./events.md)
- [Debug Validation](./debug-validation.md)
