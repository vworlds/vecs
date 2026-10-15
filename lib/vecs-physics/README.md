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
import {
  Body,
  BodyType,
  Box,
  Position,
  PhysicsModule,
  preloadPhysics,
} from "@vworlds/vecs-physics";

await preloadPhysics();
const world = new World();
world.module(PhysicsModule, { gravity: { x: 0, y: -10 }, fixedTimeStep: 1 / 60 });

const ground = world.entity().set(Body, { type: BodyType.Static }).set(Position, { x: 0, y: -1 });
world.entity().add(ChildOf, ground).set(Box, { width: 100, height: 2 });

const box = world.entity().set(Body, { type: BodyType.Dynamic }).set(Position, { x: 0, y: 4 });
world.entity().add(ChildOf, box).set(Box, { width: 1, height: 1 });

let now = 0;
for (let i = 0; i < 60; i++) {
  now += 1000 / 60;
  world.progress(now, 1000 / 60);
}

const finalPosition = box.get(Position)!;
console.log(finalPosition.x.toFixed(3), finalPosition.y.toFixed(3));
world.dispose();
```

When finished, [dispose the world](./docs/getting-started.md#disposing-a-physics-world)
to release its physics resources and live-world slot. See that guide for Box2D's
128-live-world process limit and the registration error when it is reached.

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

## New In V2

- `Detectable` - marker component that makes a solid shape visible to sensors (Box2D v3 requires both the sensor shape and the visited shape to opt in to sensor events).
- Joints - revolute, distance, prismatic, wheel, weld, filter, and motor constraints between two bodies, modelled as a joint entity with `JointBodyA`/`JointBodyB` relationships, an exclusive joint-type component, and optional motor/limit/spring features. See [Joints](./docs/joints.md).
- `physics(world)` - imperative, read-only query API: spatial queries return shape entities or plain data; `settings`, `isAwake` and `bodyMotion` support body prediction; `poseChanges` exposes a reused post-step body-entity view without extra pose watchers. No Box2D handles escape. See [Queries](./docs/queries.md), including [pose-change lifetime and filtering](./docs/queries.md#pose-changes).

```ts
import { Circle, physics } from "@vworlds/vecs-physics";

const hit = physics(world).rayCastClosest({ from: { x: 0, y: 2 }, to: { x: 10, y: 2 } });
if (hit) {
  console.log(hit.entity, hit.point, hit.normal, hit.fraction);
}

const probe = new Circle();
const swept = physics(world).shapeCastClosest({
  shape: probe,
  from: { x: 0, y: 2 },
  to: { x: 10, y: 2 },
});
console.log(swept?.fraction);

const overlapping = physics(world).overlapAABB({ min: { x: -5, y: -5 }, max: { x: 5, y: 5 } });
for (const entity of overlapping) {
  console.log(entity);
}
```

## V1 Limitations

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
tsx examples/raycast.ts
tsx examples/overlap_query.ts
tsx examples/sensor_detectable.ts
tsx examples/revolute_pendulum.ts
```

Or run them all in sequence via `npm run examples`.

## Learn More

- [Getting Started](./docs/getting-started.md)
- [Core Components](./docs/components.md)
- [Bodies](./docs/bodies.md)
- [Shapes](./docs/shapes.md)
- [Events](./docs/events.md)
- [Queries](./docs/queries.md)
- [Joints](./docs/joints.md)
- [Systems And Phases](./docs/systems-and-phases.md)
- [Debug Validation](./docs/debug-validation.md)
- [Internals](./docs/internals.md)
- [Roadmap](./docs/roadmap.md)

## Architecture

- [Architecture Plan](./architecture/ARCHITECTURE.md)
