# vecs-physics

`@vworlds/vecs-physics` is a Box2D v3-to-Vecs physics port: it keeps the Box2D simulation model while exposing an idiomatic Vecs ECS API built from components, systems, phases, and a single `installPhysics(world, opts?)` entry point.

## Install

```sh
npm install @vworlds/vecs-physics
```

## Hello World

```ts
import { ChildOf, World } from "@vworlds/vecs";
import { Body, BodyType, Box, Position, Rotation, installPhysics } from "@vworlds/vecs-physics";

const world = new World();
installPhysics(world, { gravity: { x: 0, y: -10 }, fixedTimeStep: 1 / 60 });
world.start();

const ground = world.entity().set(Position, { x: 0, y: -1 }).add(Body);
world.entity().set(ChildOf, { target: ground }).set(Box, { hx: 25, hy: 1 });

const box = world
  .entity()
  .set(Position, { x: 0, y: 4 })
  .set(Rotation, { angle: 0 })
  .set(Body, { type: BodyType.Dynamic });
world.entity().set(ChildOf, { target: box }).set(Box, { hx: 0.5, hy: 0.5 });

let now = 0;
for (let i = 0; i < 60; i++) {
  now += 1000 / 60;
  world.progress(now, 1000 / 60);
}

const p = box.get(Position)!;
const r = box.get(Rotation)!;
console.log(`final pose: x=${p.x.toFixed(3)} y=${p.y.toFixed(3)} angle=${r.angle.toFixed(3)}`);
```

## v1 Features

| Area              | Included surface                                                   |
| ----------------- | ------------------------------------------------------------------ |
| Bodies and shapes | Static, kinematic, and dynamic bodies with child shape entities.   |
| Sleep             | Per-body `Sleep` plus world `enableSleep` defaulting to `true`.    |
| CCD               | `Body.bullet` and fast-body continuous collision detection.        |
| Events            | Opt-in `ContactEvents`, `SensorEvents`, and `HitEvents`.           |
| Kinematics        | `KinematicTargetPosition` and `KinematicTargetRotation`.           |
| Forces            | Persistent forces/torques and one-shot impulses.                   |
| Materials         | Density, friction, restitution, rolling resistance, tangent speed. |
| Filtering         | Category bits, mask bits, and group index collision filters.       |
| Debug             | Optional debug validation via `installPhysics(world, { debug })`.  |

## v1 Limitations

- No joints.
- No ray casts or shape casts.
- No public AABB overlap queries.
- No public character movement helpers.
- No debug drawing API.
- Single-threaded solver only.
- No contact recycling.
- No public sensor time-of-impact hits queue.
- Dynamic `Sensor` marker toggles require recreating the shape in v1.
- Open-chain ghost vertices at sharp endpoints are deferred to v2 parity work.

## Learn More

- [Getting Started](./docs/getting-started.md)
- [Core Components](./docs/components.md)
- [Bodies](./docs/bodies.md)
- [Shapes](./docs/shapes.md)
- [Events](./docs/events.md)
- [Systems And Phases](./docs/systems-and-phases.md)
- [Debug Validation](./docs/debug-validation.md)
- [Internals](./docs/internals.md)
- [Roadmap](./docs/roadmap.md)
- [Architecture Plan](./architecture/PLAN.md)
- [Solver Implementation Map](./architecture/SOLVER.md)

## Examples

Run examples from this package directory:

```sh
tsx examples/hello_world.ts
tsx examples/sensor_trigger.ts
tsx examples/kinematic_platform.ts
tsx examples/contact_events.ts
```
