# Core Components

This page summarizes the public components exported by `vecs-physics`: what each one means, where it belongs, and how physics reacts to it.

For full usage examples, see [Getting Started](./getting-started.md), [Bodies](./bodies.md), [Shapes](./shapes.md), [Forces And Impulses](./forces-and-impulses.md), and [Events](./events.md).

## Component Model

`vecs-physics` is controlled through normal Vecs components.

Add a component to opt into a behavior. Remove it to opt out. Missing optional components use useful physics defaults.

```ts
const body = world.entity().set(Position, { x: 0, y: 4 }).set(Body, { type: BodyType.Dynamic });

world.entity().setParent(body).set(Box, { hx: 0.5, hy: 0.5 });
```

The body entity owns body-level state. Shape entities are immediate children of body entities.

## Minimal Example

This is the smallest dynamic body with one box shape.

```ts
const box = world.entity().set(Position, { x: 0, y: 4 }).set(Body, { type: BodyType.Dynamic });

world.entity().setParent(box).set(Box, { hx: 0.5, hy: 0.5 });
```

The child shape uses default material and collision filtering:

| Missing component | Default behavior                                       |
| ----------------- | ------------------------------------------------------ |
| `Material`        | Density `1`, friction `0.6`, restitution `0`.          |
| `CollisionFilter` | Category `1`, collides with all categories, group `0`. |
| `ShapePosition`   | Local `{ x: 0, y: 0 }`.                                |
| `ShapeRotation`   | Local angle `0`.                                       |
| `Sensor`          | Solid shape, not a sensor.                             |
| Event components  | No events are recorded for that shape.                 |

## Body Components

### `Position`

Canonical world-space body position.

```ts
export class Position {
  x = 0;
  y = 0;
}
```

Use it on entities with `Body`.

```ts
entity.set(Position, { x: 10, y: 2 });
```

For dynamic bodies, physics writes simulated positions back into this component after each step. If user code modifies `Position`, physics treats it as a teleport before the next step.

### `Rotation`

Optional world-space body rotation in radians.

```ts
export class Rotation {
  angle = 0;
}
```

Missing `Rotation` means angle `0`.

```ts
entity.set(Rotation, { angle: Math.PI / 2 });
```

Like `Position`, user writes are treated as teleports.

### `Body`

Marks an entity as a physics body.

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

Missing `Body` means the entity is ignored by physics.

Adding `Body` with no properties creates a static body.

```ts
ground.add(Body);
```

Use `BodyType.Dynamic` for bodies that respond to forces, impulses, gravity, and contacts.

```ts
player.set(Body, { type: BodyType.Dynamic });
```

Use `BodyType.Kinematic` for bodies moved by user-authored velocity or targets.

```ts
platform.set(Body, { type: BodyType.Kinematic });
```

Use `BodyType.Static` for immovable level geometry.

```ts
wall.add(Body);
```

### `LinearVelocity`

Body linear velocity in meters per second.

```ts
export class LinearVelocity {
  x = 0;
  y = 0;
}
```

Velocity components are authoritative in both directions. If user code modifies `LinearVelocity`, physics applies it to the body. After stepping, physics writes current velocity back when the component is present.

```ts
player.set(LinearVelocity, { x: 3, y: 0 });
```

### `AngularVelocity`

Body angular velocity in radians per second.

```ts
export class AngularVelocity {
  value = 0;
}
```

```ts
wheel.set(AngularVelocity, { value: 10 });
```

## Optional Body Tunables

`Body` stays small. Less common body settings live in optional components.

### `Damping`

Controls linear and angular damping.

```ts
export class Damping {
  linear = 0;
  angular = 0;
}
```

```ts
ship.set(Damping, { linear: 0.1, angular: 0.4 });
```

### `GravityScale`

Scales world gravity for one body.

```ts
export class GravityScale {
  value = 1;
}
```

```ts
balloon.set(GravityScale, { value: -0.2 });
```

### `MotionLocks`

Restricts body translation or rotation.

```ts
export class MotionLocks {
  x = false;
  y = false;
  rotation = false;
}
```

```ts
elevator.set(MotionLocks, { x: true, rotation: true });
```

### `Sleep`

Controls body sleeping behavior.

```ts
export class Sleep {
  enabled = true;
  awake = true;
  threshold = 0.05;
}
```

```ts
importantBody.set(Sleep, { enabled: false });
```

See [Bodies](./bodies.md) for details.

## Shape Pose Components

Shape entities use local pose components. These are relative to their immediate parent body.

### `ShapePosition`

Optional local shape offset.

```ts
export class ShapePosition {
  x = 0;
  y = 0;
}
```

```ts
world.entity().setParent(body).set(ShapePosition, { x: 0, y: -0.5 }).set(Box, { hx: 0.5, hy: 1 });
```

Missing `ShapePosition` means local offset `{ x: 0, y: 0 }`.

### `ShapeRotation`

Optional local shape rotation in radians.

```ts
export class ShapeRotation {
  angle = 0;
}
```

Missing `ShapeRotation` means local angle `0`.

## Geometry Components

Every shape entity should have exactly one geometry component.

`installPhysics` marks these components as mutually exclusive:

```ts
world.setExclusiveComponents(Box, Circle, Capsule, Segment, Polygon, Chain);
```

Adding one geometry component removes any previous geometry component from that entity.

### `Box`

Axis-aligned box geometry in local shape space.

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

`hx` and `hy` are half extents. This matches Box2D's internal representation. Use `width` and `height` accessors when that is more natural.

```ts
shape.set(Box, { hx: 0.5, hy: 1 });
```

### `Circle`

Circle geometry.

```ts
export class Circle {
  radius = 0.5;
}
```

### `Capsule`

Capsule geometry using two local endpoints and a radius.

```ts
export class Capsule {
  x1 = -0.5;
  y1 = 0;
  x2 = 0.5;
  y2 = 0;
  radius = 0.25;
}
```

### `Segment`

Line segment geometry.

```ts
export class Segment {
  x1 = -0.5;
  y1 = 0;
  x2 = 0.5;
  y2 = 0;
}
```

### `Polygon`

Convex polygon geometry.

```ts
export type Vec2 = { x: number; y: number };

export class Polygon {
  vertices: Vec2[] = [];
  radius = 0;
}
```

Polygons should be convex and valid for the physics engine. In normal mode, invalid polygons are ignored. In debug mode, `vecs-physics` warns once per issue.

### `Chain`

Chain geometry for static terrain-like shapes.

```ts
export class Chain {
  points: Vec2[] = [];
  loop = false;
}
```

Chains need at least four points. They are an advanced feature with Box2D-style one-sided collision behavior.

See [Shapes](./shapes.md) for details.

## Material And Collision Components

### `Material`

Optional physical material for a shape.

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

Missing `Material` uses the same defaults.

```ts
shape.set(Material, { friction: 0.3, restitution: 0.1 });
```

### `CollisionFilter`

Optional collision category, mask, and group.

```ts
export class CollisionFilter {
  categoryBits = 1n;
  maskBits = 0xffff_ffff_ffff_ffffn;
  groupIndex = 0;
}
```

Missing `CollisionFilter` means category `1`, collides with everything, group `0`.

```ts
shape.set(CollisionFilter, {
  categoryBits: 0b0010n,
  maskBits: 0b0101n,
});
```

See [Materials And Filters](./materials-and-filters.md).

## Sensor Component

`Sensor` marks a shape as an overlap-only sensor.

```ts
export class Sensor {}
```

Sensors do not create collision response. Add event components if you want overlap events.

```ts
world.entity().setParent(body).set(Box, { hx: 2, hy: 1 }).add(Sensor).add(SensorEvents);
```

Missing `Sensor` means the shape is solid.

## Force And Impulse Components

These components can live either on a body entity or on an immediate child of a body entity.

Physics does not recursively search ancestors. A force or impulse applies only when the current entity has `Body`, or the immediate parent has `Body`.

### `Force`

Persistent force in newtons.

```ts
export class Force {
  x = 0;
  y = 0;
  wake = true;
}
```

```ts
player.set(Force, { x: 1, y: 2 });
```

Child force source:

```ts
world.entity().setParent(player).set(Force, { x: 10, y: 22 });
```

### `Torque`

Persistent angular force.

```ts
export class Torque {
  value = 0;
  wake = true;
}
```

### `Impulse`

One-shot linear impulse in newton-seconds.

```ts
export class Impulse {
  x = 0;
  y = 0;
  wake = true;
}
```

```ts
player.set(Impulse, { x: 0, y: 5 });
```

Physics reacts to each `Impulse` update. Multiple updates before the physics step accumulate internally. After applying the kick, physics silently sets `x` and `y` back to `0` without calling `modified(Impulse)`.

### `AngularImpulse`

One-shot angular impulse.

```ts
export class AngularImpulse {
  value = 0;
  wake = true;
}
```

Physics reacts to each `AngularImpulse` update. Multiple updates before the physics step accumulate internally. After applying the kick, physics silently sets `value` back to `0` without calling `modified(AngularImpulse)`.

See [Forces And Impulses](./forces-and-impulses.md).

## Kinematic Target Components

Kinematic target components drive kinematic bodies toward a target pose.

### `KinematicTargetPosition`

```ts
export class KinematicTargetPosition {
  x = 0;
  y = 0;
  tolerance = 0.001;
  wake = true;
}
```

### `KinematicTargetRotation`

```ts
export class KinematicTargetRotation {
  angle = 0;
  tolerance = 0.001;
  wake = true;
}
```

If a target remains attached after the body reaches it, physics leaves the component in place and stops applying target motion while the body is within tolerance.

See [Kinematic Motion](./kinematic-motion.md).

## Event Components

Events are opt-in on shape entities.

### `ContactEvents`

```ts
export class ContactEvents {
  begin: ContactEvent[] = [];
  end: ContactEvent[] = [];
}

export type ContactEvent = {
  other: Entity;
};
```

Add it to a shape entity to receive contact begin/end events for that shape.

```ts
shape.add(ContactEvents);
```

### `SensorEvents`

```ts
export class SensorEvents {
  begin: SensorEvent[] = [];
  end: SensorEvent[] = [];
}

export type SensorEvent = {
  other: Entity;
};
```

Add it to a sensor or shape entity to receive sensor overlap events.

### `HitEvents`

```ts
export class HitEvents {
  hits: HitEvent[] = [];
}

export type HitEvent = {
  other: Entity;
  x: number;
  y: number;
  normalX: number;
  normalY: number;
  speed: number;
};
```

Event arrays are cleared every physics step. If new events arrive, physics marks the event component modified. If no new events arrive, physics stays quiet.

See [Events](./events.md).

## Common Gotchas

### Shape Entities Must Be Immediate Children

This works:

```ts
shape.setParent(body);
```

This is ignored because physics does not search grandparents:

```ts
grandchildShape.setParent(someChildOfBody);
```

### `Rotation` Is Optional

Do not add `Rotation` just to represent zero angle. Missing `Rotation` already means zero.

### Use Shape Pose Components On Shapes

Use `ShapePosition` and `ShapeRotation` on shape entities. Use `Position` and `Rotation` on body entities.

### Impulse Cleanup Is Silent

After physics applies an `Impulse` or `AngularImpulse`, it zeroes the public fields without emitting another component update. This avoids infinite command loops and archetype churn.

### Event Components Are Opt-In

A shape with no `ContactEvents`, `SensorEvents`, or `HitEvents` receives no event arrays. This keeps event processing cheap by default.

## Related Pages

- [Getting Started](./getting-started.md)
- [Bodies](./bodies.md)
- [Shapes](./shapes.md)
- [Materials And Filters](./materials-and-filters.md)
- [Forces And Impulses](./forces-and-impulses.md)
- [Events](./events.md)
- [Kinematic Motion](./kinematic-motion.md)
