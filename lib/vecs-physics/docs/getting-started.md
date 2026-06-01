# Getting Started

This guide shows how to install `vecs-physics`, add it to a Vecs world, create a static ground body, create a dynamic box body, and advance the simulation.

`vecs-physics` is native to Vecs. You create entities and components. The Box2D WASM backend creates and updates its internal bodies and shapes from that ECS state.

## Install

Install `vecs` and `vecs-physics` in the same project.

```sh
npm install @vworlds/vecs @vworlds/vecs-physics
```

## Core Idea

A physics object is usually two entities:

- A body entity with `Position` and `Body`.
- One or more child shape entities with geometry such as `Box`, `Circle`, or `Polygon`.

```ts
const body = world.entity().set(Position, { x: 0, y: 4 }).set(Body, { type: BodyType.Dynamic });

world.entity().set(ChildOf, { target: body }).set(Box, { hx: 0.5, hy: 0.5 });
```

The body entity controls simulation behavior. The child entity defines the collision shape. Multiple child shapes create a compound body.

The parent/child link is Vecs' built-in `ChildOf` relationship: `shape.set(ChildOf, { target: body })` makes `shape` an immediate child of `body`. `ChildOf` is exported from `@vworlds/vecs`. Physics reads the link reactively, so re-targeting a shape to a different body (or removing the link) updates the simulation on the next step.

## Minimal Falling Box

This example creates a world with gravity, a static ground, and one dynamic box.

```ts
import { World, ChildOf } from "@vworlds/vecs";
import {
  Body,
  BodyType,
  Box,
  Position,
  installPhysics,
  preloadPhysics,
} from "@vworlds/vecs-physics";

await preloadPhysics();

const world = new World();

installPhysics(world, {
  gravity: { x: 0, y: -10 },
  fixedTimeStep: 1 / 60,
  subSteps: 4,
});

const ground = world.entity().set(Position, { x: 0, y: -1 }).add(Body);

world.entity().set(ChildOf, { target: ground }).set(Box, { hx: 25, hy: 1 });

const box = world.entity().set(Position, { x: 0, y: 4 }).set(Body, { type: BodyType.Dynamic });

world.entity().set(ChildOf, { target: box }).set(Box, { hx: 0.5, hy: 0.5 });

world.start();

world.progress(performance.now(), 1000 / 60);
```

`preloadPhysics()` loads the `box2d3-wasm` module once for the process. It must resolve before `installPhysics()` creates the internal Box2D world.

`ground.add(Body)` creates a static body because `Body` defaults to `BodyType.Static`.

The dynamic box falls because it has `BodyType.Dynamic`, a `Position`, and a child shape with non-zero density. Missing `Material` uses the physics defaults: density `1`, friction `0.6`, and restitution `0`.

## Reading The Simulated Position

After each physics step, dynamic bodies write their simulated pose back into `Position` and optional `Rotation`.

```ts
world.progress(performance.now(), 1000 / 60);

const position = box.get(Position);

if (position) {
  console.log(position.x, position.y);
}
```

`Position` uses physics units, not pixels. `vecs-physics` uses Box2D-style meters. Convert to pixels in your rendering layer.

## Adding Rotation

`Rotation` is optional. Missing `Rotation` means angle `0`.

```ts
import { Rotation } from "@vworlds/vecs-physics";

const tiltedBox = world
  .entity()
  .set(Position, { x: 0, y: 4 })
  .set(Rotation, { angle: Math.PI / 8 })
  .set(Body, { type: BodyType.Dynamic });
```

If the body rotates during simulation and has a `Rotation` component, physics updates it after each step.

## Creating A Compound Body

Add multiple child shape entities to one body entity.

```ts
import { ShapePosition } from "@vworlds/vecs-physics";

const ship = world.entity().set(Position, { x: 0, y: 5 }).set(Body, { type: BodyType.Dynamic });

world.entity().set(ChildOf, { target: ship }).set(Box, { hx: 1, hy: 0.25 });

world
  .entity()
  .set(ChildOf, { target: ship })
  .set(ShapePosition, { x: 0, y: 0.5 })
  .set(Box, { hx: 0.25, hy: 0.75 });
```

`ShapePosition` is local to the parent body. Missing `ShapePosition` means local `{ x: 0, y: 0 }`.

## Adding Contact Events

Events are opt-in. Add `ContactEvents` to a shape entity if you want that shape to receive begin/end contact events.

```ts
import { ContactEvents } from "@vworlds/vecs-physics";

const playerShape = world
  .entity()
  .set(ChildOf, { target: box })
  .set(Box, { hx: 0.5, hy: 0.5 })
  .add(ContactEvents);

world
  .system("LogContacts")
  .requires(ContactEvents)
  .update(ContactEvents, (shapeEntity, events) => {
    for (const event of events.begin) {
      console.log("contact with shape", event.other.eid);
    }
  });
```

If `ContactEvents` is missing, that shape does not receive contact events. This keeps event processing explicit and cheap.

## Applying A Force

A `Force` component applies every physics step while it is present.

```ts
import { Force } from "@vworlds/vecs-physics";

box.set(Force, { x: 10, y: 0 });
```

You can also place a force on an immediate child of a body entity. This is useful when multiple independent effects act on the same body.

```ts
const tractorBeam = world.entity().set(ChildOf, { target: box }).set(Force, { x: 25, y: 0 });

// Later:
tractorBeam.remove(Force);
```

A force applies only when the entity itself has `Body`, or when its immediate parent has `Body`. Physics does not search grandparents.

## Applying An Impulse

An `Impulse` component is a one-shot kick. Set it when you want the kick to happen.

```ts
import { Impulse } from "@vworlds/vecs-physics";

box.set(Impulse, { x: 0, y: 5 });
```

Physics reacts to the component update, applies the pending impulse before stepping, then silently sets `x` and `y` back to `0` without removing the component. This avoids archetype churn.

If you set `Impulse` multiple times before the physics step, the kicks accumulate.

```ts
box.set(Impulse, { x: 1, y: 0 });
box.set(Impulse, { x: 2, y: 0 });
box.set(Impulse, { x: 0, y: 3 });

// Effective impulse before the next step: { x: 3, y: 3 }
```

## Setup Options

`preloadPhysics` must resolve before `installPhysics`, and `installPhysics` must run before `world.start()`.

```ts
await preloadPhysics();

installPhysics(world, {
  gravity: { x: 0, y: -10 },
  fixedTimeStep: 1 / 60,
  subSteps: 4,
  debug: false,
});
```

Common options:

| Option             |            Default | Description                                                                          |
| ------------------ | -----------------: | ------------------------------------------------------------------------------------ |
| `gravity`          | `{ x: 0, y: -10 }` | World gravity in meters per second squared.                                          |
| `fixedTimeStep`    |           `1 / 60` | Physics step size in seconds. Vecs `delta` is expected to be fixed.                  |
| `subSteps`         |                `4` | Solver substeps per physics step. More substeps improve stability and cost more CPU. |
| `debug`            |            `false` | Enables deduplicated warnings for invalid ECS structures.                            |
| `enableSleep`      |             `true` | Allows inactive bodies with `Sleep.enabled` to fall asleep.                          |
| `enableContinuous` |             `true` | Enables continuous collision for bullet and fast-body paths.                         |

Advanced callers can pass phase names or phase objects to place physics systems inside an existing Vecs pipeline. See [Systems And Phases](./systems-and-phases.md).

## Common Mistakes

### Installing Physics After `world.start()`

Physics components and systems must be registered before `world.start()`.

```ts
await preloadPhysics();
installPhysics(world);
world.start();
```

### Adding Geometry Directly To A Body Entity

Shapes should be child entities of the body entity.

```ts
// Good
const body = world.entity().set(Position, { x: 0, y: 4 }).set(Body, { type: BodyType.Dynamic });
world.entity().set(ChildOf, { target: body }).set(Box, { hx: 0.5, hy: 0.5 });
```

### Forgetting `Body`

An entity without `Body` is ignored by physics, even if it has `Position`.

```ts
world.entity().set(Position, { x: 0, y: 4 }); // Not a physics body
```

### Expecting Pixels

Physics uses meters. Rendering code should convert meters to pixels.

```ts
sprite.x = position.x * pixelsPerMeter;
sprite.y = -position.y * pixelsPerMeter;
```

### Using A Grandchild Force

Forces and impulses target the current entity if it has `Body`, or the immediate parent if that parent has `Body`. Grandparents are ignored.

```ts
const child = world.entity().set(ChildOf, { target: box });
world.entity().set(ChildOf, { target: child }).set(Force, { x: 10, y: 0 }); // Ignored unless child has Body
```

## Related Pages

- [Core Components](./components.md)
- [Bodies](./bodies.md)
- [Shapes](./shapes.md)
- [Forces And Impulses](./forces-and-impulses.md)
- [Events](./events.md)
- [Systems And Phases](./systems-and-phases.md)
