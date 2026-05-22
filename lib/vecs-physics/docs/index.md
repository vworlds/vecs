# vecs-physics

`vecs-physics` is a native 2D physics library for the Vecs Entity Component System. It ports the architecture, math, and simulation model of Box2D into idiomatic Vecs components and systems.

The goal is not to expose a JavaScript Box2D binding. Users should not create Box2D worlds, bodies, shapes, handles, or callbacks. Users work with entities and components. `vecs-physics` owns the simulation internals.

```ts
const world = new World();

installPhysics(world, {
  gravity: { x: 0, y: -10 },
  fixedTimeStep: 1 / 60,
  subSteps: 4,
});

world.start();
```

## Documentation

- [Getting Started](./getting-started.md) - install, setup, and first falling box.
- [Core Components](./components.md) - public component reference.
- [Bodies](./bodies.md) - body types, position sync, velocities, damping, sleep, and motion locks.
- [Shapes](./shapes.md) - child shape entities, geometry components, local shape pose, and shape lifecycle.
- [Materials And Filters](./materials-and-filters.md) - density, friction, restitution, collision categories, masks, and groups.
- [Forces And Impulses](./forces-and-impulses.md) - persistent forces, queued impulses, child force sources, and update semantics.
- [Events](./events.md) - contact, hit, and sensor event components.
- [Kinematic Motion](./kinematic-motion.md) - target position and target rotation for kinematic bodies.
- [Systems And Phases](./systems-and-phases.md) - install phases, fixed timestep assumptions, and frame ordering.
- [Debug Validation](./debug-validation.md) - optional diagnostics for invalid ECS structures.
- [Internals](./internals.md) - port architecture, broad phase, solver, islands, and Box2D lineage.
- [Roadmap](./roadmap.md) - deferred features such as ray casts, overlap queries, shape casts, and joints.

## Design Principles

`vecs-physics` follows Vecs first.

Users describe simulation state with normal Vecs components. Systems can query, update, add, and remove those components using the same APIs they use for gameplay. Physics reacts to component presence and component updates.

`vecs-physics` follows Box2D where it matters.

The internal engine keeps Box2D's proven concepts: worlds, bodies, shapes, contacts, islands, broad phase, forces, impulses, mass properties, sleeping, continuous collision, and sub-stepping. These are implementation details unless they improve the ECS API.

`vecs-physics` avoids unnecessary archetype churn.

Persistent effects stay as components. One-shot effects can be consumed silently without removing their component. Event arrays are cleared and reused. Invalid structures are ignored in normal mode.

`vecs-physics` is explicit by component presence.

If a behavior needs to exist, add the component. If the component is missing, that behavior is absent. Missing optional components use useful defaults.

## Quick Example

This creates a static ground body and a dynamic box body with one child shape.

```ts
import { World } from "@vworlds/vecs";
import {
  Body,
  BodyType,
  Box,
  ContactEvents,
  Material,
  Position,
  installPhysics,
} from "@vworlds/vecs-physics";

const world = new World();

installPhysics(world, {
  gravity: { x: 0, y: -10 },
  fixedTimeStep: 1 / 60,
  subSteps: 4,
});

const ground = world.entity().set(Position, { x: 0, y: -1 }).add(Body);

world.entity().setParent(ground).set(Box, { hx: 25, hy: 1 });

const player = world.entity().set(Position, { x: 0, y: 4 }).set(Body, { type: BodyType.Dynamic });

world
  .entity()
  .setParent(player)
  .set(Box, { hx: 0.5, hy: 0.5 })
  .set(Material, { density: 1, friction: 0.6 })
  .add(ContactEvents);

world.start();

world.progress(performance.now(), 1000 / 60);
```

## Installation And Setup

Install physics once before `world.start()`.

```ts
installPhysics(world, options);
```

`installPhysics` registers physics components, marks mutually exclusive shape components, installs physics systems, and creates the internal simulation state.

```ts
installPhysics(world, {
  gravity: { x: 0, y: -10 },
  fixedTimeStep: 1 / 60,
  subSteps: 4,
  debug: false,
});
```

Default setup is meant to work without custom phase wiring. Advanced callers can provide phases or phase names so physics can sit at a specific point in an existing Vecs pipeline.

```ts
installPhysics(world, {
  preStepPhase: "physics-pre",
  stepPhase: "physics-step",
  postStepPhase: "physics-post",
});
```

See [Systems And Phases](./systems-and-phases.md).

## Coordinate System And Units

`vecs-physics` uses Box2D-style units.

Positions are in meters. Velocities are meters per second. Forces are newtons. Impulses are newton-seconds. Angles are radians.

Rendering code should convert meters to pixels or scene units. `vecs-physics` does not perform rendering scale conversion.

## Bodies

An entity participates in physics when it has a `Body` component.

```ts
const body = world.entity().set(Position, { x: 0, y: 4 }).set(Body, { type: BodyType.Dynamic });
```

Missing `Body` means the entity is ignored by physics.

Adding `Body` with no properties creates a static body.

```ts
entity.add(Body);
```

This works because Vecs components have default constructors. `new Body()` is valid and represents a static body.

```ts
export enum BodyType {
  Static = "static",
  Kinematic = "kinematic",
  Dynamic = "dynamic",
}

export class Body {
  type = BodyType.Static;
  bullet = false;
  enabled = true;
  allowFastRotation = false;
}
```

`Body` stays intentionally modest. Optional tunables live in separate components such as `Damping`, `GravityScale`, `MotionLocks`, and `Sleep`.

See [Bodies](./bodies.md).

## Position And Rotation

`vecs-physics` exports canonical pose components.

```ts
export class Position {
  x = 0;
  y = 0;
}

export class Rotation {
  angle = 0;
}
```

`Position` is required for a body to have a useful initial location. `Rotation` is optional. Missing `Rotation` means angle `0`.

For dynamic bodies, physics writes simulation results back into `Position` and `Rotation` after each step.

If user code modifies `Position` or `Rotation`, physics treats that as a teleport and pushes the new pose into the simulation before the next step.

For static and kinematic bodies, user modifications to `Position` and `Rotation` move the body in the physics simulation.

## Shape Entities

Shapes are represented as child entities of a body entity.

```ts
const body = world.entity().set(Position, { x: 0, y: 4 }).set(Body, { type: BodyType.Dynamic });

const shape = world.entity().setParent(body).set(Box, { hx: 0.5, hy: 1 });
```

A shape entity must be an immediate child of an entity with `Body`. `vecs-physics` does not recursively search ancestors.

Shape-local pose uses separate components.

```ts
export class ShapePosition {
  x = 0;
  y = 0;
}

export class ShapeRotation {
  angle = 0;
}
```

Missing `ShapePosition` means local offset `{ x: 0, y: 0 }`. Missing `ShapeRotation` means local angle `0`.

## Geometry Components

Each shape entity has one geometry component.

```ts
export class Box {
  hx = 0.5;
  hy = 0.5;

  get width() {
    return this.hx * 2;
  }

  set width(value: number) {
    this.hx = value / 2;
  }

  get height() {
    return this.hy * 2;
  }

  set height(value: number) {
    this.hy = value / 2;
  }
}
```

`Box` stores half extents because Box2D's box representation and helpers are half-extents-native. Width and height accessors are provided for convenience.

Other geometry components:

```ts
export class Circle {
  radius = 0.5;
}

export class Capsule {
  x1 = -0.5;
  y1 = 0;
  x2 = 0.5;
  y2 = 0;
  radius = 0.25;
}

export class Segment {
  x1 = -0.5;
  y1 = 0;
  x2 = 0.5;
  y2 = 0;
}

export class Polygon {
  vertices: Vec2[] = [];
  radius = 0;
}

export class Chain {
  points: Vec2[] = [];
  loop = false;
}
```

Geometry components are mutually exclusive.

```ts
world.setExclusiveComponents(Box, Circle, Capsule, Segment, Polygon, Chain);
```

Adding one geometry component removes the previous one from the same entity.

See [Shapes](./shapes.md).

## Materials

`Material` is optional. Missing `Material` uses Box2D defaults.

```ts
export class Material {
  density = 1;
  friction = 0.6;
  restitution = 0;
  rollingResistance = 0;
  tangentSpeed = 0;
  userMaterialId = 0n;
}
```

Default material behavior:

| Property            | Default | Meaning                         |
| ------------------- | ------: | ------------------------------- |
| `density`           |     `1` | Shape contributes mass.         |
| `friction`          |   `0.6` | Dry surface friction.           |
| `restitution`       |     `0` | No bounce.                      |
| `rollingResistance` |     `0` | No rolling resistance.          |
| `tangentSpeed`      |     `0` | No conveyor-belt tangent speed. |
| `userMaterialId`    |    `0n` | No application material id.     |

Changing `Material` on a live shape updates the physical shape. Density changes update body mass.

See [Materials And Filters](./materials-and-filters.md).

## Collision Filtering

`CollisionFilter` is optional. Missing `CollisionFilter` uses Box2D defaults.

```ts
export class CollisionFilter {
  categoryBits = 1n;
  maskBits = 0xffff_ffff_ffff_ffffn;
  groupIndex = 0;
}
```

Default collision filtering means category `1`, collides with everything, no group override.

Changing `CollisionFilter` on a live shape updates the physical shape. This can be expensive because existing contacts may be destroyed and recreated.

See [Materials And Filters](./materials-and-filters.md).

## Sensor Shapes

Sensors are expressed by component presence.

```ts
export class Sensor {}
```

Add `Sensor` to a shape entity to make that shape report overlaps without collision response.

```ts
world.entity().setParent(body).set(Box, { hx: 2, hy: 1 }).add(Sensor).add(SensorEvents);
```

Missing `Sensor` means the shape is solid.

## Velocities

Velocity components are authoritative in both directions.

```ts
export class LinearVelocity {
  x = 0;
  y = 0;
}

export class AngularVelocity {
  value = 0;
}
```

If user code modifies `LinearVelocity` or `AngularVelocity`, physics applies the new velocity to the body.

After stepping, physics writes the simulated velocity back into these components when they are present.

Last update wins according to Vecs phase ordering.

See [Bodies](./bodies.md).

## Forces

Forces are persistent while the `Force` component is present.

```ts
export class Force {
  x = 0;
  y = 0;
  wake = true;
}
```

Simple API: add `Force` directly to the body entity.

```ts
player.set(Force, { x: 1, y: 2 });
```

Advanced API: add `Force` to an immediate child of the body entity.

```ts
const tractorBeam = world.entity().setParent(player).set(Force, { x: 10, y: 22 });
```

This lets multiple independent force sources act on one body. A spaceship can be pulled by two tractor beams while also receiving another child force from a planet's gravity field.

A force applies if the current entity has `Body`, or if its immediate parent has `Body`. Physics does not search grandparents or deeper ancestors.

Removing the `Force` component stops the force.

`Torque` follows the same model.

```ts
export class Torque {
  value = 0;
  wake = true;
}
```

See [Forces And Impulses](./forces-and-impulses.md).

## Impulses

Impulses are one-shot kicks expressed through persistent components.

```ts
export class Impulse {
  x = 0;
  y = 0;
  wake = true;
}

export class AngularImpulse {
  value = 0;
  wake = true;
}
```

Simple API:

```ts
player.set(Impulse, { x: 1, y: 2 });
```

Advanced API:

```ts
world.entity().setParent(player).set(Impulse, { x: 5, y: 0 });
```

Impulse targeting follows the same immediate entity-or-parent rule as `Force`.

Physics reacts to `Impulse` updates. Each update queues a kick internally. If `Impulse` is set multiple times before the physics step, the kicks accumulate.

```ts
player.set(Impulse, { x: 1, y: 0 });
player.set(Impulse, { x: 2, y: 0 });
player.set(Impulse, { x: 0, y: 3 });

// Effective kick before the next step: { x: 3, y: 3 }
```

After applying the pending impulse, physics silently sets public impulse fields back to zero without calling `entity.modified(Impulse)`. The component remains attached to avoid archetype churn.

See [Forces And Impulses](./forces-and-impulses.md).

## Kinematic Targets

Kinematic bodies can be driven toward target pose components.

```ts
export class KinematicTargetPosition {
  x = 0;
  y = 0;
  tolerance = 0.001;
  wake = true;
}

export class KinematicTargetRotation {
  angle = 0;
  tolerance = 0.001;
  wake = true;
}
```

If present on a kinematic body, physics attempts to converge `Position` and `Rotation` toward the target. Once the target is reached within tolerance, physics leaves the component in place but stops applying target motion.

See [Kinematic Motion](./kinematic-motion.md).

## Events

Events are opt-in by component presence on shape entities.

```ts
export class ContactEvents {
  begin: ContactEvent[] = [];
  end: ContactEvent[] = [];
}

export type ContactEvent = {
  other: Entity;
};
```

Add `ContactEvents` to a shape entity to receive contact begin/end events involving that shape. If both shapes have `ContactEvents`, both receive events. If only one shape has `ContactEvents`, only that shape receives events.

```ts
world.entity().setParent(player).set(Box, { hx: 0.5, hy: 0.5 }).add(ContactEvents);
```

Systems can react normally with Vecs update handlers.

```ts
world
  .system("DamagePlayers")
  .query({ AND: [{ PARENT: Player }, ContactEvents] })
  .update(ContactEvents, (shapeEntity, events) => {
    for (const event of events.begin) {
      // event.other is the other shape entity
    }
  });
```

`HitEvents` and `SensorEvents` follow the same pattern.

```ts
export class SensorEvents {
  begin: SensorEvent[] = [];
  end: SensorEvent[] = [];
}

export class HitEvents {
  hits: HitEvent[] = [];
}
```

Event arrays are cleared every physics step. If new events arrive, physics pushes events and calls `entity.modified(EventComponent)`. If a previous step had events and the next step has none, physics clears the arrays silently and does not call `modified`.

Event payloads always include the other shape entity. If the other body entity is already available at no meaningful cost during implementation, event payloads may also include it.

See [Events](./events.md).

## Lifecycle Rules

Physics objects are created and destroyed from ECS structure.

| ECS change                 | Physics behavior                                  |
| -------------------------- | ------------------------------------------------- |
| Add `Body`                 | Create a physics body.                            |
| Remove `Body`              | Destroy the physics body and its internal shapes. |
| Destroy body entity        | Destroy the physics body and its internal shapes. |
| Add valid child geometry   | Create a shape on the parent body.                |
| Remove geometry component  | Destroy the shape.                                |
| Change geometry            | Update or recreate the shape.                     |
| Reparent shape entity      | Destroy/recreate shape if parent body changes.    |
| Set `Body.enabled = false` | Disable the body in the simulation.               |

Normal mode ignores invalid structures efficiently. Debug mode warns about them.

See [Shapes](./shapes.md) and [Debug Validation](./debug-validation.md).

## Debug Validation

Debug validation is optional.

```ts
installPhysics(world, { debug: true });
```

In normal mode, invalid component combinations are ignored as if they do not exist.

In debug mode, `vecs-physics` warns about invalid structures without flooding the console. Warnings are deduplicated by entity and issue code.

Examples:

- Shape entity without an immediate parent `Body`.
- Dynamic body with no non-sensor shape with non-zero density.
- Chain with fewer than four points.
- Invalid polygon.
- Shape-local components placed on a body entity.

See [Debug Validation](./debug-validation.md).

## Deferred Features

The first version focuses on bodies, shapes, materials, filters, forces, impulses, kinematic targets, and events.

Deferred to later versions:

- Ray casts.
- Shape casts.
- AABB overlap queries.
- Imperative physics query API.
- Joints.
- Character mover helpers.

See [Roadmap](./roadmap.md).

## Relationship To Box2D

`vecs-physics` keeps the Box2D simulation model but changes the public programming model.

Box2D terms still matter internally:

- A Vecs `Body` entity corresponds to a physics body.
- A child geometry entity corresponds to a physics shape.
- `Position` and `Rotation` correspond to body transforms.
- `Material` and `CollisionFilter` correspond to shape definition fields.
- `Force`, `Torque`, `Impulse`, and `AngularImpulse` correspond to body force and impulse APIs.
- `ContactEvents`, `SensorEvents`, and `HitEvents` correspond to post-step event arrays.

Users do not manage Box2D handles. They manage Vecs entities and components.
