# Kinematic Motion

This page explains how to move kinematic bodies with `KinematicTargetPosition` and `KinematicTargetRotation`.

Kinematic bodies are useful when gameplay code should drive motion directly, while physics still handles contacts against dynamic bodies. Typical examples include moving platforms, elevators, doors, scripted hazards, and top-down actors that should not be pushed around by forces.

## Core Concepts

A kinematic body is created by adding `Body` with `type: BodyType.Kinematic`.

```ts
const platform = world
  .entity()
  .set(Position, { x: 0, y: 2 })
  .set(Body, { type: BodyType.Kinematic });
```

Kinematic bodies are not controlled by forces or impulses. Instead, they move according to velocity or target motion set by the application.

`vecs-physics` provides target components for common kinematic movement:

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

If one of these components is present on a kinematic body, physics attempts to move the real `Position` or `Rotation` toward the target during each physics step.

When the body reaches the target within `tolerance`, the component stays attached but physics stops applying target motion.

## Minimal Example

Create a kinematic platform and move it to `x = 5`.

```ts
import { World } from "@vworlds/vecs";
import {
  Body,
  BodyType,
  Box,
  KinematicTargetPosition,
  Position,
  PhysicsModule,
} from "@vworlds/vecs-physics";

const world = new World();

world.module(
  PhysicsModule.configure({
    gravity: { x: 0, y: -10 },
    fixedTimeStep: 1 / 60,
    subSteps: 4,
  })
);

const platform = world
  .entity()
  .set(Position, { x: 0, y: 2 })
  .set(Body, { type: BodyType.Kinematic })
  .set(KinematicTargetPosition, { x: 5, y: 2 });

world.entity().set(ChildOf, { target: platform }).set(Box, { hx: 2, hy: 0.25 });

world.progress(performance.now(), 1000 / 60);
```

## Moving A Platform Back And Forth

Because target components stay attached, gameplay systems can update them whenever the destination changes.

```ts
class MovingPlatform {
  left = -4;
  right = 4;
  goingRight = true;
}

world.component(MovingPlatform);

world
  .system("MovePlatforms")
  .with(MovingPlatform, Position, KinematicTargetPosition)
  .each(
    [MovingPlatform, Position, KinematicTargetPosition],
    (entity, [platform, position, target]) => {
      const destinationX = platform.goingRight ? platform.right : platform.left;

      if (Math.abs(position.x - destinationX) <= target.tolerance) {
        platform.goingRight = !platform.goingRight;
        target.x = platform.goingRight ? platform.right : platform.left;
        target.y = position.y;
        entity.modified(KinematicTargetPosition);
      }
    }
  );
```

This system does not remove or re-add `KinematicTargetPosition`. It updates the component in place and calls `modified` so physics sees the new target.

## Rotating Toward A Target

Use `KinematicTargetRotation` for scripted angular movement.

```ts
const door = world
  .entity()
  .set(Position, { x: 3, y: 0 })
  .set(Rotation, { angle: 0 })
  .set(Body, { type: BodyType.Kinematic })
  .set(KinematicTargetRotation, {
    angle: Math.PI / 2,
    tolerance: 0.001,
  });
```

If `Rotation` is missing, physics treats the current angle as `0`. Add `Rotation` when game code or rendering code needs to read the body's angle.

## Position And Rotation Together

Both target components can be present on the same kinematic body.

```ts
entity
  .set(KinematicTargetPosition, { x: 8, y: 2 })
  .set(KinematicTargetRotation, { angle: Math.PI });
```

Physics attempts to converge both the position and the rotation. Each target uses its own tolerance.

## Options

### `KinematicTargetPosition`

| Property    | Default | Description                                            |
| ----------- | ------: | ------------------------------------------------------ |
| `x`         |     `0` | Target world x position in meters.                     |
| `y`         |     `0` | Target world y position in meters.                     |
| `tolerance` | `0.001` | Distance threshold for considering the target reached. |
| `wake`      |  `true` | Whether to wake the body while applying target motion. |

### `KinematicTargetRotation`

| Property    | Default | Description                                            |
| ----------- | ------: | ------------------------------------------------------ |
| `angle`     |     `0` | Target world angle in radians.                         |
| `tolerance` | `0.001` | Angular threshold for considering the target reached.  |
| `wake`      |  `true` | Whether to wake the body while applying target motion. |

With the default `wake: true`, target motion wakes a sleeping body while physics applies the target. If you explicitly set `wake: false`, a sleeping body can remain asleep until another disturbance wakes it.

`Body.bullet` and the `enableContinuous` option are body/world CCD controls, not kinematic target controls. They can coexist with kinematic bodies, but target components only decide the velocity needed to approach the requested pose.

Debug validation does not require target components on kinematic bodies, but `debug: true` is useful for catching the adjacent structural mistakes: missing `Body`, shape entities without an immediate body parent, and invalid geometry.

## Direct Teleporting

Changing `Position` or `Rotation` directly teleports the body.

```ts
entity.set(Position, { x: 10, y: 3 });
```

Use direct `Position` or `Rotation` writes for teleports, respawns, level setup, and hard corrections.

Use `KinematicTargetPosition` or `KinematicTargetRotation` when the body should move through the world over physics steps.

## Common Gotchas

### Target Components Only Affect Kinematic Bodies

`KinematicTargetPosition` and `KinematicTargetRotation` are meant for entities with:

```ts
entity.set(Body, { type: BodyType.Kinematic });
```

On static or dynamic bodies, target components are ignored.

### The Target Component Is Not Removed Automatically

Physics leaves target components attached after the target is reached.

This avoids archetype churn and lets systems keep stable queries. If you want to stop querying for reached targets, remove the component yourself.

```ts
entity.remove(KinematicTargetPosition);
```

### Update Targets With Vecs Mutation Rules

If you mutate a target component directly, mark it modified.

```ts
const target = entity.getMut(KinematicTargetPosition);
if (target) {
  target.x = 12;
  target.y = 4;
}
```

`getMut` marks the component modified for you. If you use `get`, TypeScript treats the component as readonly, and physics will not be notified unless you later call `entity.modified(KinematicTargetPosition)`.

### Do Not Use Forces For Kinematic Motion

Kinematic bodies do not respond to `Force`, `Torque`, `Impulse`, or `AngularImpulse` like dynamic bodies do. Use target components or velocity components instead.

## Related Pages

- [Bodies](./bodies.md)
- [Forces And Impulses](./forces-and-impulses.md)
- [Systems And Phases](./systems-and-phases.md)
- [Shapes](./shapes.md)
