# Debug Validation

Debug validation helps catch invalid physics component combinations while keeping normal runtime behavior quiet and fast.

In normal mode, `vecs-physics` ignores entities that do not match the expected physics structure. In debug mode, it warns about those structures once, without flooding the console.

## Core Concept

Physics is opt-in by component presence.

An entity with `Body` becomes a physics body. A child entity with a geometry component such as `Box`, `Circle`, or `Polygon` becomes a shape only when its immediate parent has `Body`.

If the structure is incomplete or invalid, normal mode treats it as absent.

```ts
// Ignored by physics in normal mode: no Body component.
world.entity().set(Position, { x: 0, y: 0 });

// Ignored by physics in normal mode: Box is not under a Body entity.
world.entity().set(Box, { hx: 0.5, hy: 0.5 });
```

Debug validation exists for development, tests, and editor workflows where silent ignoring would hide mistakes.

## Enabling Debug Validation

Enable validation when installing physics.

```ts
installPhysics(world, {
  gravity: { x: 0, y: -10 },
  fixedTimeStep: 1 / 60,
  subSteps: 4,
  debug: true,
});
```

When `debug` is omitted or `false`, validation warnings are disabled.

```ts
installPhysics(world, {
  gravity: { x: 0, y: -10 },
  fixedTimeStep: 1 / 60,
  subSteps: 4,
});
```

## Minimal Example

This creates an invalid shape entity. In normal mode it is ignored. In debug mode it produces one warning.

```ts
const world = new World();

installPhysics(world, {
  gravity: { x: 0, y: -10 },
  fixedTimeStep: 1 / 60,
  subSteps: 4,
  debug: true,
});

world.entity().set(Box, { hx: 0.5, hy: 0.5 });

world.start();
world.progress(performance.now(), 1000 / 60);
```

Expected warning shape:

```text
[vecs-physics] shape-without-parent-body: Entity12 has geometry but its immediate parent does not have Body.
```

The exact wording may vary, but warnings include a stable issue code and the relevant entity id.

## Warning Deduplication

Validation warnings are deduplicated by entity and issue code.

If the same invalid entity remains invalid for 600 frames, it should not log 600 times. It should warn once.

For example, this should produce one warning, not one warning per frame.

```ts
const shape = world.entity().set(Box, { hx: 0.5, hy: 0.5 });

for (let frame = 0; frame < 600; frame++) {
  world.progress(frame * 16.666, 1000 / 60);
}
```

If the issue changes, a new warning can be emitted.

```ts
shape.setParent(bodyWithoutBodyComponent);
// New structure, possibly a new validation issue.
```

## Common Warnings

| Code | Meaning | Fix |
| --- | --- | --- |
| `shape-without-parent-body` | A geometry entity is not an immediate child of a `Body` entity. | Set the shape entity's parent to the body entity. |
| `body-without-position` | An entity has `Body` but no `Position`. | Add `Position`, or accept that the body starts at the origin if supported. |
| `dynamic-body-without-density` | A dynamic body has no non-sensor shape with non-zero density. | Add a shape with `Material.density > 0`. |
| `chain-too-few-points` | `Chain.points` has fewer than four points. | Provide at least four points. |
| `polygon-invalid` | `Polygon.vertices` cannot form a valid convex polygon. | Use a valid convex polygon with sensible winding and non-overlapping points. |
| `shape-position-on-body` | `ShapePosition` appears on a body entity. | Move `ShapePosition` to a child shape entity. |
| `position-on-shape-entity` | A shape entity uses body `Position` instead of `ShapePosition`. | Use `ShapePosition` for shape-local offsets. |

## Valid Body And Shape Structure

The most common validation issue is putting shape components on the wrong entity.

Correct structure:

```ts
const body = world
  .entity()
  .set(Position, { x: 0, y: 4 })
  .set(Body, { type: BodyType.Dynamic });

world
  .entity()
  .setParent(body)
  .set(Box, { hx: 0.5, hy: 0.5 });
```

Incorrect structure:

```ts
world
  .entity()
  .set(Position, { x: 0, y: 4 })
  .set(Body, { type: BodyType.Dynamic })
  .set(Box, { hx: 0.5, hy: 0.5 });
```

`Box`, `Circle`, `Capsule`, `Segment`, `Polygon`, and `Chain` belong on child shape entities, not on the body entity.

## Immediate Parent Rule

Shape entities and force source entities use the immediate parent only.

`vecs-physics` does not recursively search ancestors for a `Body`.

This works:

```ts
const player = world
  .entity()
  .set(Position, { x: 0, y: 0 })
  .set(Body, { type: BodyType.Dynamic });

world
  .entity()
  .setParent(player)
  .set(Box, { hx: 0.5, hy: 0.5 });
```

This is ignored by physics:

```ts
const player = world
  .entity()
  .set(Position, { x: 0, y: 0 })
  .set(Body, { type: BodyType.Dynamic });

const container = world.entity().setParent(player);

world
  .entity()
  .setParent(container)
  .set(Box, { hx: 0.5, hy: 0.5 });
```

To fix it, make the shape an immediate child of `player`, or add `Body` to `container` if it should be its own physics body.

## Dynamic Body Density

Dynamic bodies need mass. Mass normally comes from non-sensor shapes with non-zero density.

This can be invalid:

```ts
const body = world
  .entity()
  .set(Position, { x: 0, y: 4 })
  .set(Body, { type: BodyType.Dynamic });

world
  .entity()
  .setParent(body)
  .set(Box, { hx: 0.5, hy: 0.5 })
  .set(Material, { density: 0 });
```

Use a positive density for ordinary dynamic bodies.

```ts
world
  .entity()
  .setParent(body)
  .set(Box, { hx: 0.5, hy: 0.5 })
  .set(Material, { density: 1 });
```

Missing `Material` is fine. It uses the default density `1`.

## Shape-Local Pose Mistakes

Body pose and shape-local pose use different components.

Use `Position` and `Rotation` on body entities.

```ts
body.set(Position, { x: 10, y: 4 });
body.set(Rotation, { angle: Math.PI / 4 });
```

Use `ShapePosition` and `ShapeRotation` on shape entities.

```ts
shape.set(ShapePosition, { x: 0, y: -0.25 });
shape.set(ShapeRotation, { angle: 0 });
```

This is a common mistake:

```ts
shape.set(Position, { x: 0, y: -0.25 });
```

`Position` on a shape entity is not a shape-local offset. Use `ShapePosition` instead.

## Geometry Validation

Some geometry components have structural requirements.

`Chain` needs at least four points.

```ts
shape.set(Chain, {
  points: [
    { x: -2, y: 0 },
    { x: -1, y: 1 },
    { x: 1, y: 1 },
    { x: 2, y: 0 },
  ],
});
```

`Polygon` should represent a valid convex polygon.

```ts
shape.set(Polygon, {
  vertices: [
    { x: -0.5, y: -0.5 },
    { x: 0.5, y: -0.5 },
    { x: 0.5, y: 0.5 },
    { x: -0.5, y: 0.5 },
  ],
});
```

Self-intersecting, concave, duplicate, or near-zero-area polygons may be ignored and warned about in debug mode.

## Normal Mode Behavior

Normal mode should not throw or warn for invalid ECS structures.

It should ignore them efficiently.

This lets gameplay code build entities incrementally without needing every intermediate state to be physically valid.

```ts
const body = world.entity();

// Temporarily incomplete. Ignored by physics until Body and Position exist.
body.set(Position, { x: 0, y: 0 });
body.set(Body, { type: BodyType.Dynamic });
```

This also keeps production logs clean.

## Troubleshooting

### My shape is not colliding

Check these first:

- The shape entity is an immediate child of an entity with `Body`.
- The shape entity has exactly one geometry component such as `Box` or `Circle`.
- The body entity has `Position`.
- The body is enabled.
- The shape is not marked with `Sensor` if you expect collision response.
- `CollisionFilter.categoryBits` and `CollisionFilter.maskBits` allow the two shapes to collide.

### My dynamic body is not moving

Check these first:

- `Body.type` is `BodyType.Dynamic`.
- The body has a valid shape with positive density.
- The body is not sleeping, disabled, or locked by `MotionLocks`.
- Gravity, forces, impulses, or velocities are actually being applied before the physics step.

### I get too many warnings

Warnings should be deduplicated. If the same issue logs every frame, that is a bug in debug validation.

If many different entities are invalid, fix the first structural issue. Often one wrong prefab or factory creates many invalid entities.

## Related Pages

- [Getting Started](./getting-started.md)
- [Bodies](./bodies.md)
- [Shapes](./shapes.md)
- [Materials And Filters](./materials-and-filters.md)
- [Systems And Phases](./systems-and-phases.md)
