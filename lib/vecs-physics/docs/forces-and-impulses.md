# Forces And Impulses

This page explains how to push, pull, spin, and kick physics bodies in `vecs-physics` using ECS components.

Use forces and torques for effects that persist over time. Use impulses and angular impulses for one-shot changes in velocity.

## Core Concepts

`vecs-physics` exposes four movement intent components:

| Component        | Meaning                  | Duration                                  |
| ---------------- | ------------------------ | ----------------------------------------- |
| `Force`          | Push or pull along x/y.  | Applies every physics step while present. |
| `Torque`         | Rotational force.        | Applies every physics step while present. |
| `Impulse`        | Instant linear kick.     | Applies once per update.                  |
| `AngularImpulse` | Instant rotational kick. | Applies once per update.                  |

Each component can be added directly to the entity with `Body`, or to an immediate child of that body entity.

```ts
player.set(Force, { x: 10, y: 0 });
```

```ts
world.entity().add(ChildOf, player).set(Force, { x: 10, y: 0 });
```

Physics resolves the target body using only the current entity and its immediate parent. It does not search grandparents or deeper ancestors.

## Components

```ts
export class Force {
  x = 0;
  y = 0;
  wake = true;
}

export class Torque {
  value = 0;
  wake = true;
}

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

`wake` controls whether applying a non-zero effect wakes a sleeping body. The default is `true` because user-driven movement usually means the body should participate in simulation immediately. A zero effect never wakes a body, whatever `wake` says. See [Sleeping Bodies And Zero Loads](#sleeping-bodies-and-zero-loads).

Units follow Box2D conventions:

| Field                    | Unit            |
| ------------------------ | --------------- |
| `Force.x`, `Force.y`     | Newtons         |
| `Torque.value`           | Newton-meters   |
| `Impulse.x`, `Impulse.y` | Newton-seconds  |
| `AngularImpulse.value`   | Angular impulse |

See [Bodies](./bodies.md) for body setup and [Coordinate System And Units](./index.md#coordinate-system-and-units) for unit conventions.

## Minimal Force Example

This applies a continuous force to the right while the `Force` component remains on the body entity.

```ts
import { Body, BodyType, Force, Position } from "@vworlds/vecs-physics";

const player = world
  .entity()
  .set(Position, { x: 0, y: 4 })
  .set(Body, { type: BodyType.Dynamic })
  .set(Force, { x: 10, y: 0 });
```

To stop the force, remove the component.

```ts
player.remove(Force);
```

## Minimal Impulse Example

This applies a one-shot upward kick.

```ts
import { Body, BodyType, Impulse, Position } from "@vworlds/vecs-physics";

const player = world.entity().set(Position, { x: 0, y: 4 }).set(Body, { type: BodyType.Dynamic });

player.set(Impulse, { x: 0, y: 8 });
```

After physics consumes the impulse, it silently resets `Impulse.x` and `Impulse.y` to `0` without removing the component and without calling `entity.modified(Impulse)`.

This avoids archetype churn.

## Body Entity Vs Child Entity

For simple cases, add movement components directly to the body entity.

```ts
player.set(Force, { x: 0, y: 20 });
```

For advanced cases, put each force or impulse source on its own child entity.

```ts
const leftTractorBeam = world.entity().add(ChildOf, player).set(Force, { x: -15, y: 5 });

const rightTractorBeam = world.entity().add(ChildOf, player).set(Force, { x: 10, y: 12 });
```

This is useful when multiple independent systems contribute forces to the same body. For example, a ship might have thrust, gravity, wind, and two tractor beams all active at the same time.

Each source can be updated or removed independently.

```ts
leftTractorBeam.remove(Force);
```

## Target Resolution

Physics applies a force-like component to a body using this rule:

```ts
function resolveTarget(entity: Entity): Entity | undefined {
  if (entity.get(Body)) {
    return entity;
  }

  if (entity.parent?.get(Body)) {
    return entity.parent;
  }

  return undefined;
}
```

This applies:

```ts
player.set(Body, { type: BodyType.Dynamic });
player.set(Force, { x: 1, y: 0 });
```

This also applies:

```ts
world.entity().add(ChildOf, player).set(Force, { x: 1, y: 0 });
```

This does not apply, because the force entity is a grandchild of the body entity:

```ts
const source = world.entity().add(ChildOf, player);

world.entity().add(ChildOf, source).set(Force, { x: 1, y: 0 });
```

In normal mode, invalid force sources are ignored. In debug mode, `vecs-physics` can warn once per invalid entity. See [Debug Validation](./debug-validation.md).

## Persistent Forces

`Force` and `Torque` are persistent. If the component exists, physics applies it every step.

```ts
ship.set(Force, { x: 50, y: 0 });
```

If the force changes, update the component.

```ts
ship.set(Force, { x: 100, y: 0 });
```

If the force should stop, remove the component.

```ts
ship.remove(Force);
```

This pattern works well for:

- Thrusters.
- Gravity fields.
- Wind.
- Tractor beams.
- Magnetic pulls.
- Constant rotational motors.

## Persistent Torque

Use `Torque` for continuous angular force.

```ts
ship.set(Torque, { value: 12 });
```

Or attach it as a child source.

```ts
world.entity().add(ChildOf, ship).set(Torque, { value: -8 });
```

Remove the component to stop applying torque.

```ts
ship.remove(Torque);
```

## Queued Impulses

`Impulse` and `AngularImpulse` are reactive one-shot commands.

The proper ECS API is `entity.set(...)`.

```ts
player.set(Impulse, { x: 0, y: 10 });
```

Physics listens for `Impulse` updates and queues the kick internally. If multiple impulse updates happen before the physics step, they accumulate.

```ts
player.set(Impulse, { x: 1, y: 0 });
player.set(Impulse, { x: 2, y: 0 });
player.set(Impulse, { x: 0, y: 3 });
```

The effective impulse before the next step is:

```ts
{ x: 3, y: 3 }
```

After applying the queued impulse, physics silently resets the public fields to zero.

```ts
// After physics consumes it:
player.get(Impulse); // { x: 0, y: 0, wake: true }
```

The component remains attached. This avoids moving the entity between archetypes just because it received a one-shot kick.

## Angular Impulses

Use `AngularImpulse` for one-shot rotational kicks.

```ts
ship.set(AngularImpulse, { value: 3 });
```

Multiple updates before the physics step accumulate.

```ts
ship.set(AngularImpulse, { value: 1 });
ship.set(AngularImpulse, { value: 2 });

// Effective angular impulse: 3
```

After physics applies the pending angular impulse, it silently resets `value` to `0` without removing the component.

## Child Impulses

Like forces, impulses can live on child entities.

```ts
world.entity().add(ChildOf, player).set(Impulse, { x: 0, y: 6 });
```

This can be useful when a gameplay system wants to own the source of the impulse separately from the body.

For example, a temporary explosion entity can be parented to the body for one frame, set an impulse, and then be destroyed later by gameplay code.

```ts
const explosionKick = world.entity().add(ChildOf, enemy).set(Impulse, { x: 12, y: 4 });
```

Physics consumes the impulse and resets it to zero. Gameplay code decides whether the child entity should stay or be destroyed.

## Updating Existing Impulse Components

Use `set`, not direct mutation, when you want physics to see a new impulse.

Correct:

```ts
player.set(Impulse, { x: 0, y: 8 });
```

To add another kick before the physics step, set only the additional delta. Do not include the current public impulse fields, because each `set(Impulse, ...)` queues the full value.

```ts
player.set(Impulse, { x: 2, y: 0 });
```

Avoid direct mutation unless you also mark the component modified.

```ts
const impulse = player.get(Impulse) as Impulse | undefined;

if (impulse) {
  // This queues a single upward kick. It does not add to prior public fields.
  impulse.x = 0;
  impulse.y = 8;
  player.modified(Impulse);
}
```

Prefer `set` because it is shorter and naturally reactive.

## Sleeping Bodies And Zero Loads

Box2D puts a body to sleep once it has moved slower than its sleep threshold (`Sleep.threshold`, `0.05` m/s by default) for half a second, and stops simulating it until something disturbs it. A force, torque, or impulse is one such disturbance: with `wake: true`, applying it to a sleeping body wakes it.

A zero load changes nothing physically, so waking a body for one would only keep it awake for no reason. `vecs-physics` therefore never applies one. The rule:

> A zero load never wakes a body. `wake` applies to non-zero loads.

Zero means exactly zero, not small. A load with any non-zero component, such as `{ x: 0, y: 3 }`, is non-zero.

| Load             | Zero when                             |
| ---------------- | ------------------------------------- |
| `Force`          | `x === 0 && y === 0`.                 |
| `Torque`         | `value === 0`.                        |
| `Impulse`        | `x === 0 && y === 0` when you set it. |
| `AngularImpulse` | `value === 0` when you set it.        |

A zero impulse is ignored when you set it: it is not queued and its `wake` does not count. Impulses are also judged by their sum when physics applies them. Two impulses set before the same step that cancel out, such as `{ x: 5, y: 0 }` and `{ x: -5, y: 0 }`, sum to exactly zero and are skipped, so they do not wake the body either.

Non-zero loads keep Box2D behavior:

| Load     | `wake`  | Sleeping body                      |
| -------- | ------- | ---------------------------------- |
| Zero     | any     | Stays asleep. Nothing is applied.  |
| Non-zero | `true`  | Wakes up. The load is applied.     |
| Non-zero | `false` | Stays asleep. The load is ignored. |

`wake` only matters for a sleeping body. An awake dynamic body always receives a non-zero load.

### Idle Thrust

This is what makes a persistent thrust component safe to keep. Leave the `Force` on the ship, write the thrust into it while the player thrusts, and write zero when they let go. You do not need to remove the component or set `wake: false` for the idle case.

```ts
function thrust(ship: Entity, x: number, y: number): void {
  ship.set(Force, { x, y });
}

thrust(ship, 40, 0); // Thrusting: wakes a sleeping ship and pushes it.
thrust(ship, 0, 0); // Let go: skipped, so the ship can come to rest and fall asleep.
```

Physics skips the idle `Force` before it reaches Box2D, so it also costs no wasm call per step. `Torque`, `Impulse`, and `AngularImpulse` follow the same rule, so a zero `Impulse` set every tick while the input is idle is dropped as it is set.

### Waking A Body Or Keeping It Awake

A zero load cannot wake a body, so do not use one as a keep-alive. To wake a body, or to keep it awake, use the `Sleep` component (see [Bodies](./bodies.md#sleep)). It has three fields, `enabled`, `awake`, and `threshold`, and setting it writes all three to Box2D (`lib/vecs-physics/src/body/lifecycle.ts`):

- `awake: true` wakes a sleeping body.
- `enabled: false` stops the body from ever falling asleep, and wakes it if it is asleep.

```ts
ship.set(Sleep, { awake: true }); // Wake it now. It can fall asleep again later.
ship.set(Sleep, { enabled: false }); // Keep it awake for good.
```

## Common Patterns

### Jump

```ts
function jump(player: Entity): void {
  player.set(Impulse, { x: 0, y: 8 });
}
```

### Constant Thrust

```ts
function startThrust(ship: Entity): void {
  ship.set(Force, { x: 50, y: 0 });
}

function stopThrust(ship: Entity): void {
  ship.remove(Force);
}
```

Removing the component is not required to let the ship sleep. You can keep it and write `{ x: 0, y: 0 }` instead. See [Idle Thrust](#idle-thrust).

### Multiple Tractor Beams

```ts
const beamA = world.entity().add(ChildOf, player).set(Force, { x: -20, y: 5 });

const beamB = world.entity().add(ChildOf, player).set(Force, { x: 15, y: 10 });
```

Remove one beam without affecting the other.

```ts
beamA.destroy();
```

### Explosion Kick

```ts
function applyExplosionKick(
  body: Entity,
  directionX: number,
  directionY: number,
  strength: number
): void {
  body.set(Impulse, {
    x: directionX * strength,
    y: directionY * strength,
  });
}
```

### Spin Kick

```ts
function spin(body: Entity): void {
  body.set(AngularImpulse, { value: 4 });
}
```

## Gotchas

### Forces Persist

A `Force` keeps applying until it is changed or removed.

```ts
player.set(Force, { x: 100, y: 0 });
```

This is not a one-frame push. Use `Impulse` for one-shot movement.

### A Zero Load Never Wakes A Body

`wake: true` does not make a zero `Force`, `Torque`, `Impulse`, or `AngularImpulse` wake a sleeping body, and a persistent `Force { x: 0, y: 0 }` does not keep its body awake. To wake a body, or keep it awake, use `Sleep`. See [Sleeping Bodies And Zero Loads](#sleeping-bodies-and-zero-loads).

### Impulses Are Reset Silently

After physics consumes an `Impulse`, it sets `x` and `y` back to zero without calling `modified`.

This means systems listening for `Impulse` updates are not notified when physics performs cleanup. They only see user/gameplay updates.

### Use `set` For Impulses

Physics reacts to component updates. If you mutate an `Impulse` object directly and do not call `modified(Impulse)`, physics will not treat it as a new kick.

Prefer:

```ts
entity.set(Impulse, { x: 0, y: 5 });
```

### Child Sources Must Be Immediate Children

This works:

```ts
source.add(ChildOf, body);
source.set(Force, { x: 1, y: 0 });
```

This does not work if `source.parent` is not the entity with `Body`.

### Static Bodies Do Not Respond Like Dynamic Bodies

Forces and impulses are meaningful for dynamic bodies. Static bodies do not move from forces. Kinematic bodies are controlled by velocity or kinematic targets, not by forces in the usual dynamic-body sense.

See [Kinematic Motion](./kinematic-motion.md) for kinematic target components.

## Related Pages

- [Bodies](./bodies.md)
- [Kinematic Motion](./kinematic-motion.md)
- [Systems And Phases](./systems-and-phases.md)
- [Debug Validation](./debug-validation.md)
