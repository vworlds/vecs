# Shapes

Shapes define the collision geometry attached to a physics body. In `vecs-physics`, each shape is a normal Vecs entity that is an immediate child of an entity with a `Body` component.

This page covers shape entities, geometry components, local shape pose, lifecycle behavior, and common shape setup patterns.

## Core Concept

A body entity owns motion. A shape entity owns collision geometry.

```ts
const body = world.entity().set(Position, { x: 0, y: 4 }).set(Body, { type: BodyType.Dynamic });

const shape = world.entity().set(ChildOf, { target: body }).set(Box, { hx: 0.5, hy: 1 });
```

The shape must be an immediate child of the body entity. `vecs-physics` does not search grandparents or deeper ancestors.

```ts
// Works: shape's parent has Body.
shape.set(ChildOf, { target: body });

// Ignored by physics: shape's grandparent has Body, but parent does not.
grandchildShape.set(ChildOf, { target: nonBodyChild });
```

This model makes compound bodies natural: one body entity can have many child shape entities.

## Minimal Example

This creates a dynamic body with one box shape.

```ts
import { Body, BodyType, Box, Position } from "@vworlds/vecs-physics";

const crate = world.entity().set(Position, { x: 0, y: 4 }).set(Body, { type: BodyType.Dynamic });

world.entity().set(ChildOf, { target: crate }).set(Box, { hx: 0.5, hy: 0.5 });
```

The `Box` uses default material and collision filtering if no `Material` or `CollisionFilter` component is present.

## Shape Entities

A shape entity usually has:

- A parent entity with `Body`.
- Exactly one geometry component: `Box`, `Circle`, `Capsule`, `Segment`, `Polygon`, or `Chain`.
- Optional local pose: `ShapePosition`, `ShapeRotation`.
- Optional physics behavior: `Sensor`, `Material`, `CollisionFilter`, event components.

Example with all common parts:

```ts
world
  .entity()
  .set(ChildOf, { target: player })
  .set(ShapePosition, { x: 0, y: -0.25 })
  .set(ShapeRotation, { angle: 0 })
  .set(Box, { hx: 0.5, hy: 1 })
  .set(Material, { density: 1, friction: 0.6 })
  .add(ContactEvents);
```

## Local Shape Pose

Shape pose is local to the parent body.

```ts
export class ShapePosition {
  x = 0;
  y = 0;
}

export class ShapeRotation {
  angle = 0;
}
```

If `ShapePosition` is missing, the local offset is `{ x: 0, y: 0 }`.

If `ShapeRotation` is missing, the local angle is `0`.

Use `Position` and `Rotation` on body entities. Use `ShapePosition` and `ShapeRotation` on shape entities.

```ts
const body = world.entity().set(Position, { x: 10, y: 3 }).set(Body, { type: BodyType.Dynamic });

world.entity().set(ChildOf, { target: body }).set(ShapePosition, { x: 0, y: 1 }).set(Circle, { radius: 0.25 });
```

In this example, the circle is one meter above the body origin in body-local space.

## Geometry Components

Each shape entity should have one geometry component.

The geometry components are mutually exclusive. Adding one removes the previous one from the same entity.

```ts
world.setExclusiveComponents(Box, Circle, Capsule, Segment, Polygon, Chain);
```

`installPhysics(world, options)` performs this setup for physics components.

### Box

`Box` stores half extents because Box2D's box representation is half-extents-native.

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

```ts
world.entity().set(ChildOf, { target: body }).set(Box, { hx: 0.5, hy: 1 });
```

You can use `width` and `height` accessors when working with the component instance.

```ts
const box = shape.getMut(Box);
if (box) {
  box.width = 2;
  box.height = 4;
}
```

Because `getMut(Box)` marks the component modified, physics will update the live shape.

### Circle

```ts
export class Circle {
  radius = 0.5;
}
```

```ts
world.entity().set(ChildOf, { target: body }).set(Circle, { radius: 0.75 });
```

### Capsule

Capsules are defined by two local endpoints and a radius.

```ts
export class Capsule {
  x1 = -0.5;
  y1 = 0;
  x2 = 0.5;
  y2 = 0;
  radius = 0.25;
}
```

```ts
world.entity().set(ChildOf, { target: body }).set(Capsule, {
  x1: -0.5,
  y1: 0,
  x2: 0.5,
  y2: 0,
  radius: 0.25,
});
```

Use capsules for rounded characters, pills, projectiles, and objects that should not snag on corners as easily as boxes.

### Segment

Segments are line segments in local body space.

```ts
export class Segment {
  x1 = -0.5;
  y1 = 0;
  x2 = 0.5;
  y2 = 0;
}
```

```ts
world.entity().set(ChildOf, { target: staticBody }).set(Segment, { x1: -5, y1: 0, x2: 5, y2: 0 });
```

Segments are best for static environment edges. For long terrain made of many connected edges, use `Chain`.

### Polygon

Polygons are convex shapes defined by local vertices.

```ts
export type Vec2 = { x: number; y: number };

export class Polygon {
  vertices: Vec2[] = [];
  radius = 0;
}
```

```ts
world
  .entity()
  .set(ChildOf, { target: body })
  .set(Polygon, {
    vertices: [
      { x: -0.5, y: 0 },
      { x: 0.5, y: 0 },
      { x: 0, y: 1 },
    ],
  });
```

Polygons should be convex and have valid winding. In normal mode, invalid polygons are ignored. In debug mode, invalid polygons produce deduplicated warnings.

### Chain

Chains are connected line segments, usually for static terrain.

```ts
export class Chain {
  points: Vec2[] = [];
  loop = false;
}
```

```ts
world
  .entity()
  .set(ChildOf, { target: staticBody })
  .set(Chain, {
    points: [
      { x: -4, y: 0 },
      { x: -2, y: 1 },
      { x: 0, y: 0 },
      { x: 2, y: -1 },
      { x: 4, y: 0 },
    ],
  });
```

Chains need at least four points. They are an advanced shape type and should normally be attached to static bodies.

## Compound Bodies

A compound body is one body entity with multiple child shape entities.

```ts
const ship = world.entity().set(Position, { x: 0, y: 5 }).set(Body, { type: BodyType.Dynamic });

world.entity().set(ChildOf, { target: ship }).set(Box, { hx: 1, hy: 0.25 });

world
  .entity()
  .set(ChildOf, { target: ship })
  .set(ShapePosition, { x: -0.9, y: 0.4 })
  .set(Circle, { radius: 0.25 });

world.entity().set(ChildOf, { target: ship }).set(ShapePosition, { x: 0.9, y: 0.4 }).set(Circle, { radius: 0.25 });
```

All three shapes move as one rigid body. They do not move relative to each other during simulation.

## Sensors

Add `Sensor` to make a shape detect overlaps without producing collision response.

```ts
world.entity().set(ChildOf, { target: body }).set(Box, { hx: 2, hy: 1 }).add(Sensor).add(SensorEvents);
```

Missing `Sensor` means the shape is solid.

Sensor events are opt-in. Add `SensorEvents` only to shapes that should receive sensor begin/end events.

See [Events](./events.md).

## Materials And Filters

Shapes use useful defaults when `Material` or `CollisionFilter` is missing.

```ts
world.entity().set(ChildOf, { target: body }).set(Box, { hx: 0.5, hy: 0.5 });
```

Default material values:

| Property            | Default |
| ------------------- | ------: |
| `density`           |     `1` |
| `friction`          |   `0.6` |
| `restitution`       |     `0` |
| `rollingResistance` |     `0` |
| `tangentSpeed`      |     `0` |

Default collision filtering means category `1`, mask all bits, and group `0`, so the shape collides with everything by default.

Override defaults with components.

```ts
world
  .entity()
  .set(ChildOf, { target: body })
  .set(Box, { hx: 0.5, hy: 0.5 })
  .set(Material, { density: 2, friction: 0.3 })
  .set(CollisionFilter, { categoryBits: 0b10n, maskBits: 0b101n });
```

See [Materials And Filters](./materials-and-filters.md).

## Lifecycle

Physics shapes follow ECS lifecycle changes.

| ECS change                            | Physics behavior                               |
| ------------------------------------- | ---------------------------------------------- |
| Add valid child geometry under a body | Create a physics shape.                        |
| Remove geometry component             | Destroy the physics shape.                     |
| Change geometry component             | Update or recreate the physics shape.          |
| Reparent shape entity                 | Destroy/recreate shape if parent body changes. |
| Destroy shape entity                  | Destroy the physics shape.                     |
| Remove parent `Body`                  | Destroy the body and its internal shapes.      |

Live geometry changes are supported, but they can be more expensive than changing material or filter properties. Prefer creating shapes with their intended geometry when possible.

## Common Mistakes

### Shape Is Not An Immediate Child Of A Body

This is ignored by physics:

```ts
const body = world.entity().add(Body);
const child = world.entity().set(ChildOf, { target: body });

world.entity().set(ChildOf, { target: child }).set(Box, { hx: 1, hy: 1 });
```

Only the immediate parent is checked. Put the shape directly under the body entity.

### Using Position On A Shape Entity

`Position` is for body entities. Use `ShapePosition` for local shape offsets.

```ts
// Wrong for shape local offset.
shape.set(Position, { x: 1, y: 0 });

// Correct.
shape.set(ShapePosition, { x: 1, y: 0 });
```

### Forgetting Dynamic Bodies Need Density

Dynamic bodies need at least one non-sensor shape with non-zero density to behave normally.

Missing `Material` is fine because the default density is `1`.

This can be a problem:

```ts
world.entity().set(ChildOf, { target: dynamicBody }).set(Box, { hx: 1, hy: 1 }).set(Material, { density: 0 });
```

### Invalid Polygon Or Chain Data

Polygons should be convex and valid. Chains need at least four points. In normal mode invalid shapes are ignored. In debug mode `vecs-physics` warns once per issue.

## Related Pages

- [Bodies](./bodies.md) - body types, position sync, and velocity behavior.
- [Materials And Filters](./materials-and-filters.md) - density, friction, restitution, categories, masks, and groups.
- [Events](./events.md) - contact, hit, and sensor event components.
- [Debug Validation](./debug-validation.md) - optional warnings for invalid shape structures.
