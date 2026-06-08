# @vworlds/vecs-physics

`vecs-physics` is a Box2D v3 to Vecs port: the solver model follows Box2D, while the public API is idiomatic Vecs ECS through components, systems, phases, and `world.module(PhysicsModule)`.

## Install

```sh
npm install @vworlds/vecs @vworlds/vecs-physics
```

## HelloWorld Quickstart

This is the M3 parity scene: a dynamic box starts at `y = 4`, falls onto static ground at `y = -1`, steps 60 frames at `1 / 60`, and prints the final pose.

```ts
import { ChildOf, World } from "@vworlds/vecs";
import { Body, BodyType, Box, Position, PhysicsModule } from "@vworlds/vecs-physics";

const world = new World();
world.module(PhysicsModule.configure({ gravity: { x: 0, y: -10 }, fixedTimeStep: 1 / 60 }));

const ground = world.entity().set(Body, { type: BodyType.Static }).set(Position, { x: 0, y: -1 });
world.entity().set(ChildOf, { target: ground }).set(Box, { width: 100, height: 2 });

const box = world.entity().set(Body, { type: BodyType.Dynamic }).set(Position, { x: 0, y: 4 });
world.entity().set(ChildOf, { target: box }).set(Box, { width: 1, height: 1 });

let now = 0;
for (let i = 0; i < 60; i++) {
  now += 1000 / 60;
  world.progress(now, 1000 / 60);
}

const finalPosition = box.get(Position)!;
console.log(finalPosition.x.toFixed(3), finalPosition.y.toFixed(3));
```

## V1 Features

| Feature              | Included in v1                                                         |
| -------------------- | ---------------------------------------------------------------------- |
| Sleep                | `Sleep` component and `enableSleep: true` default.                     |
| Continuous collision | `Body.bullet` and `enableContinuous: true` default.                    |
| Contact events       | Shape-local `ContactEvents` begin/end arrays.                          |
| Sensor events        | `Sensor` plus opt-in `SensorEvents`.                                   |
| Hit events           | Shape-local `HitEvents` for high-speed impacts.                        |
| Kinematic targets    | `KinematicTargetPosition` and `KinematicTargetRotation`.               |
| Forces and impulses  | `Force`, `Torque`, `Impulse`, and `AngularImpulse`.                    |
| Materials            | Density, friction, restitution, rolling resistance, and tangent speed. |
| Collision filters    | Category bits, mask bits, and group index.                             |
| Debug validation     | Optional deduplicated warnings with `debug: true`.                     |

## V1 Limitations

- No joints.
- No ray casts or shape casts.
- No AABB overlap queries.
- No public character mover helpers.
- No debug drawing API.
- Single-threaded solver only.
- No contact recycling.
- No public sensor TOI hits queue.
- Dynamic `Sensor` marker toggles require recreating the shape in v1.
- Open-chain ghost vertices at sharp endpoints are deferred to v2 parity work.

## Examples

Run examples from this package directory:

```sh
tsx examples/hello_world.ts
tsx examples/sensor_trigger.ts
tsx examples/kinematic_platform.ts
tsx examples/contact_events.ts
```

Or run all four in sequence via `npm run examples`.

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

## Architecture

- [Architecture Plan](./architecture/PLAN.md)
- [Solver Map](./architecture/SOLVER.md)
