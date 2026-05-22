# Bodies

Bodies are the physics objects that move, collide, sleep, receive forces, and own shapes. This page explains how to create bodies, how `Position` and `Rotation` sync with physics, how velocity components work, and which optional body-tuning components are available.

## Core Concepts

An entity participates in physics when it has a `Body` component.

```ts
const entity = world
  .entity()
  .set(Position, { x: 0, y: 4 })
  .set(Body, { type: BodyType.Dynamic });
```

Missing `Body` means the entity is ignored by physics.

Adding `Body` with no properties creates a static body.

```ts
entity.add(Body);
```

This works because Vecs components have default constructors. `new Body()` is valid and contains the default body configuration.

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

`Body` is intentionally small. Less common tuning options live in optional components such as `Damping`, `GravityScale`, `MotionLocks`, and `Sleep`.

## Body Types

| Type | Use For | Simulation Behavior |
| --- | --- | --- |
| `BodyType.Static` | Ground, walls, level geometry | Does not move under simulation. Collides with dynamic bodies. |
| `BodyType.Kinematic` | Moving platforms, scripted objects | Moves according to velocity or kinematic targets. Does not respond to forces. |
| `BodyType.Dynamic` | Players, crates, projectiles, debris | Fully simulated. Responds to gravity, forces, impulses, and contacts. |

Choose the type at creation whenever possible. Changing body type later is supported, but it is more expensive than creating the body with the correct type.

## Minimal Examples

### Static Ground

```ts
const ground = world
  .entity()
  .set(Position, { x: 0, y: -1 })
  .add(Body);

world
  .entity()
  .setParent(ground)
  .set(Box, { hx: 25, hy: 1 });
```

`add(Body)` creates a static body because `Body.type` defaults to `BodyType.Static`.

### Dynamic Box

```ts
const crate = world
  .entity()
  .set(Position, { x: 0, y: 4 })
  .set(Body, { type: BodyType.Dynamic });

world
  .entity()
  .setParent(crate)
  .set(Box, { hx: 0.5, hy: 0.5 });
```

The `Box` is a child entity. Bodies do not define their own collision geometry directly. See [Shapes](./shapes.md).

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

`Position` is the body's world position. `Rotation` is the body's world rotation in radians.

`Rotation` is optional. Missing `Rotation` means angle `0`.

```ts
world
  .entity()
  .set(Position, { x: 0, y: 4 })
  .set(Body, { type: BodyType.Dynamic });
```

This creates a dynamic body at `(0, 4)` with rotation `0`.

### Dynamic Bodies

For dynamic bodies, physics owns `Position` and `Rotation` after the simulation starts.

The usual flow is:

1. User sets initial `Position` and optional `Rotation`.
2. Physics creates the body from those values.
3. Each physics step writes the simulated pose back into `Position` and `Rotation`.

If user code modifies `Position` or `Rotation`, physics treats that as a teleport.

```ts
const pos = player.getMut(Position);
if (pos) {
  pos.x = 10;
  pos.y = 5;
}
```

Because `getMut(Position)` marks the component modified, physics will push the new position into the simulation before the next step.

### Static And Kinematic Bodies

For static and kinematic bodies, changing `Position` or `Rotation` moves the body in the simulation.

This is useful for level pieces, platforms, doors, and scripted objects.

```ts
platform.set(Position, { x: 4, y: 2 });
```

Moving static bodies can be expensive if done frequently. Prefer kinematic bodies for objects that move every frame.

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

```ts
player.set(LinearVelocity, { x: 3, y: 0 });
player.set(AngularVelocity, { value: Math.PI });
```

Last update wins according to Vecs phase ordering. If a gameplay system writes velocity before the physics phase, physics uses that velocity for the step. If a gameplay system writes velocity after the physics phase, the new value is visible immediately and will be applied before the next physics step.

### Kinematic Motion With Velocity

Kinematic bodies move according to velocity. They are useful for moving platforms and scripted hazards.

```ts
const platform = world
  .entity()
  .set(Position, { x: 0, y: 2 })
  .set(Body, { type: BodyType.Kinematic })
  .set(LinearVelocity, { x: 2, y: 0 });

world
  .entity()
  .setParent(platform)
  .set(Box, { hx: 2, hy: 0.25 });
```

Kinematic bodies do not respond to forces or impulses. Use velocity or kinematic target components instead.

## Optional Body Components

`Body` contains only common body identity flags. Optional components configure specific behavior.

### Damping

Damping reduces velocity over time.

```ts
export class Damping {
  linear = 0;
  angular = 0;
}
```

```ts
ship.set(Damping, { linear: 0.1, angular: 0.5 });
```

Linear damping affects `LinearVelocity`. Angular damping affects `AngularVelocity`.

Large damping values can make results sensitive to timestep. Use small values unless you intentionally want heavy drag.

### GravityScale

`GravityScale` changes how strongly gravity affects a body.

```ts
export class GravityScale {
  value = 1;
}
```

```ts
balloon.set(GravityScale, { value: -0.25 });
```

Useful values:

| Value | Effect |
| ---: | --- |
| `1` | Normal gravity. |
| `0` | No gravity. |
| `2` | Twice normal gravity. |
| Negative | Gravity pulls the opposite direction. |

### MotionLocks

`MotionLocks` restricts body movement.

```ts
export class MotionLocks {
  x = false;
  y = false;
  rotation = false;
}
```

```ts
cart.set(MotionLocks, { y: true, rotation: true });
```

This example allows movement along x, blocks movement along y, and blocks rotation.

### Sleep

Sleeping lets inactive bodies stop simulating until they are disturbed.

```ts
export class Sleep {
  enabled = true;
  awake = true;
  threshold = 0.05;
}
```

```ts
crate.set(Sleep, { enabled: true, awake: true });
```

Sleeping is good for performance. Disable it for bodies that must always update, such as player-controlled bodies or gameplay-critical sensors.

## Body Flags

### `bullet`

Use `bullet` sparingly for fast dynamic bodies where tunneling through static geometry would be noticeable.

```ts
projectile.set(Body, {
  type: BodyType.Dynamic,
  bullet: true,
});
```

Bullets improve continuous collision detection, but they are not a complete replacement for ray casts or shape casts for very fast projectiles. Query and cast APIs are planned for a later version. See [Roadmap](./roadmap.md).

### `enabled`

Disabled bodies remain represented by ECS entities but are removed from active simulation.

```ts
door.set(Body, { enabled: false });
```

Disabling and enabling bodies can be more expensive than letting sleeping handle inactive objects. Use `enabled` for gameplay state, not as a per-frame optimization.

### `allowFastRotation`

`allowFastRotation` permits bypassing normal rotational speed limits. It is mainly useful for circular objects such as wheels.

```ts
wheel.set(Body, {
  type: BodyType.Dynamic,
  allowFastRotation: true,
});
```

## Lifecycle

Physics body lifecycle follows ECS structure.

| ECS Change | Physics Behavior |
| --- | --- |
| Add `Body` | Create a physics body. |
| Remove `Body` | Destroy the physics body and its internal shapes. |
| Destroy body entity | Destroy the physics body and its internal shapes. |
| Modify `Body` | Update body type, enabled state, and flags. |
| Modify `Position` or `Rotation` | Teleport or move the body. |
| Modify velocity components | Apply the new velocity. |

Shapes are created from immediate child entities with geometry components. See [Shapes](./shapes.md).

## Common Mistakes

### Adding Shape Geometry To The Body Entity

Do not put `Box`, `Circle`, or other geometry components directly on the body entity.

```ts
// Incorrect
world
  .entity()
  .set(Position, { x: 0, y: 4 })
  .set(Body, { type: BodyType.Dynamic })
  .set(Box, { hx: 0.5, hy: 0.5 });
```

Use a child entity for the shape.

```ts
// Correct
const body = world
  .entity()
  .set(Position, { x: 0, y: 4 })
  .set(Body, { type: BodyType.Dynamic });

world
  .entity()
  .setParent(body)
  .set(Box, { hx: 0.5, hy: 0.5 });
```

### Expecting A Body Without `Body` To Simulate

`Position` alone does not create a physics body.

```ts
// Ignored by physics
world.entity().set(Position, { x: 0, y: 4 });
```

Add `Body` to opt in.

```ts
world
  .entity()
  .set(Position, { x: 0, y: 4 })
  .set(Body, { type: BodyType.Dynamic });
```

### Forgetting `modified` After Direct Mutation

Vecs only reacts to component changes when you use `set`, `getMut`, or `modified`.

```ts
// Not recommended: no modified signal
const pos = player.get(Position) as Position | undefined;
if (pos) {
  pos.x = 10;
}
```

Use `getMut` for in-place edits.

```ts
const pos = player.getMut(Position);
if (pos) {
  pos.x = 10;
}
```

Or use `set`.

```ts
player.set(Position, { x: 10, y: 5 });
```

### Using Dynamic Bodies For Scripted Platforms

Dynamic bodies respond to forces and contacts. Moving platforms are usually kinematic.

```ts
platform
  .set(Body, { type: BodyType.Kinematic })
  .set(LinearVelocity, { x: 1, y: 0 });
```

## Related Pages

- [Shapes](./shapes.md) - add geometry to bodies with child entities.
- [Forces And Impulses](./forces-and-impulses.md) - apply persistent forces and one-shot kicks.
- [Kinematic Motion](./kinematic-motion.md) - drive kinematic bodies toward target positions and rotations.
- [Systems And Phases](./systems-and-phases.md) - understand when physics reads and writes body components.
- [Debug Validation](./debug-validation.md) - enable warnings for invalid body and shape structures.
