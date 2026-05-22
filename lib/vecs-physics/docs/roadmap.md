# Roadmap

This page describes what is intentionally included in the first version of `vecs-physics`, what is deferred, and how those future features are expected to fit into the Vecs API.

The first version focuses on the core simulation loop: bodies, shapes, materials, filters, forces, impulses, kinematic targets, and events.

## Version 1 Scope

The initial version is designed to make normal rigid-body gameplay work with a native Vecs API.

Included areas:

| Area              | Status   | Notes                                                                   |
| ----------------- | -------- | ----------------------------------------------------------------------- |
| Bodies            | Included | `Body`, `Position`, `Rotation`, velocities, and optional body tunables. |
| Shapes            | Included | Child shape entities with exclusive geometry components.                |
| Materials         | Included | Box2D-compatible defaults for density, friction, and restitution.       |
| Collision filters | Included | Category bits, mask bits, and group index.                              |
| Sensors           | Included | `Sensor` component on shape entities.                                   |
| Forces            | Included | Persistent `Force` and `Torque` components.                             |
| Impulses          | Included | Reactive one-shot `Impulse` and `AngularImpulse` components.            |
| Kinematic targets | Included | Target position and rotation components for kinematic bodies.           |
| Contact events    | Included | Shape-local `ContactEvents` component.                                  |
| Sensor events     | Included | Shape-local `SensorEvents` component.                                   |
| Hit events        | Included | Shape-local `HitEvents` component.                                      |
| Debug validation  | Included | Optional deduplicated warnings for invalid ECS structures.              |

The goal for v1 is that this kind of game object should be straightforward:

```ts
const player = world.entity().set(Position, { x: 0, y: 4 }).set(Body, { type: BodyType.Dynamic });

world.entity().setParent(player).set(Box, { hx: 0.5, hy: 1 }).add(ContactEvents);

player.set(Impulse, { x: 0, y: 8 });
```

## Deferred Features

The following features are intentionally not part of the first version.

They are important, but they should come after the body/shape/event model is solid.

## Ray Casts

Ray casts answer the question: what shape would this ray hit?

Expected use cases:

- Line-of-sight checks.
- Bullet traces.
- Mouse picking.
- Ground checks.
- Sensor-like checks for fast projectiles.

Expected API direction:

```ts
const hit = physics.rayCastClosest({
  from: { x: 0, y: 2 },
  to: { x: 10, y: 2 },
  filter: { categoryBits: 1n, maskBits: 0xffff_ffff_ffff_ffffn },
});

if (hit) {
  console.log(hit.entity); // shape entity
  console.log(hit.point.x, hit.point.y);
  console.log(hit.normal.x, hit.normal.y);
}
```

Ray casts are likely to be exposed through an imperative API returned by `installPhysics`, not through request components.

Reason: ray casts are synchronous queries against the current physics world. They are usually easier to use as direct reads than as ECS state.

See also: [Materials And Filters](./materials-and-filters.md), [Events](./events.md).

## AABB Overlap Queries

Overlap queries answer the question: which shapes overlap this box-shaped area?

Expected use cases:

- Area triggers.
- Editor selection.
- Proximity checks.
- Spawn validation.
- Cheap broad-phase gameplay queries.

Expected API direction:

```ts
const hits = physics.overlapAABB({
  min: { x: -5, y: -5 },
  max: { x: 5, y: 5 },
});

for (const hit of hits) {
  console.log(hit.entity); // shape entity
}
```

Like ray casts, overlap queries are expected to be imperative reads.

## Shape Casts

Shape casts answer the question: if this shape moved along this vector, what would it hit?

Expected use cases:

- Swept collision checks.
- Fast projectile prediction.
- Character movement.
- Placement previews.

Expected API direction:

```ts
const hit = physics.shapeCast({
  shape: new Circle({ radius: 0.5 }),
  from: { x: 0, y: 1 },
  translation: { x: 10, y: 0 },
});
```

The exact shape construction API is not settled. It should reuse the same geometry concepts as shape entities where possible.

## Character Movement Helpers

Box2D includes mover-style APIs for kinematic character movement. `vecs-physics` may eventually expose these as higher-level helpers.

Expected use cases:

- Platformer characters.
- Top-down characters.
- Sliding along walls.
- Ground detection.
- Step or slope handling.

Possible API direction:

```ts
const result = physics.moveCapsule({
  position: player.get(Position)!,
  capsule: { x1: 0, y1: -0.5, x2: 0, y2: 0.5, radius: 0.25 },
  translation: { x: input.x, y: input.y },
});

player.set(Position, result.position);
```

This is deferred because character movement tends to become game-specific quickly. The first version should provide reliable rigid-body primitives before adding opinionated movement helpers.

## Joints

Joints connect two bodies with constraints.

Expected joint types:

- Distance joints.
- Motor joints.
- Filter joints.
- Prismatic joints.
- Revolute joints.
- Weld joints.
- Wheel joints.

Likely ECS model:

```ts
const joint = world
  .entity()
  .set(JointBodies, { a: bodyA, b: bodyB })
  .set(RevoluteJoint, {
    localAnchorA: { x: 0, y: 0 },
    localAnchorB: { x: 0, y: 0 },
    enableMotor: true,
    motorSpeed: 2,
    maxMotorTorque: 10,
  });
```

Joint components should probably be exclusive in the same way geometry components are exclusive. One joint entity should represent one joint type.

Joints are deferred because they introduce a second relationship model besides parent/child shapes. We need the body and shape lifecycle to be stable before adding cross-entity constraints.

See also: [Bodies](./bodies.md), [Shapes](./shapes.md).

## Debug Drawing

Debug drawing is useful, but rendering is not part of `vecs-physics`.

Expected API direction:

```ts
physics.debugDraw({
  drawSegment(a, b, color) {},
  drawPolygon(vertices, color) {},
  drawCircle(center, radius, color) {},
});
```

The engine should provide geometry to caller-owned drawing code. It should not depend on Canvas, WebGL, Pixi, Three.js, or any renderer.

## Serialization And Networking

Serialization is not part of the first version.

Vecs already has related packages for networking and binary encoding. `vecs-physics` should remain compatible with ordinary component serialization where possible, but internal physics state should not be treated as authoritative save data.

Recommended direction:

- Serialize public components such as `Position`, `Rotation`, `Body`, geometry, `Material`, and `CollisionFilter`.
- Rebuild internal physics state when loading.
- Do not serialize internal broad-phase, contact, island, or solver data.

## Common Mistakes

### Expecting Deferred Features In V1

If you need ray casts, joints, or character movers immediately, they are not part of the first version.

Use shape entities, sensors, and contact events for v1 gameplay when possible.

### Building Public APIs Around Internal Handles

Future features should continue to return Vecs entities, not internal handles.

Prefer this:

```ts
const hit = physics.rayCastClosest(ray);
console.log(hit?.entity);
```

Avoid this:

```ts
console.log(hit?.shapeId);
```

The whole point of `vecs-physics` is that users work with ECS entities and components.

### Adding Features Before The Core Model Is Stable

Joints, casts, and character movers all depend on stable body and shape lifecycle rules. If those rules change later, every advanced API becomes harder to keep consistent.

## Related Pages

- [Getting Started](./getting-started.md)
- [Bodies](./bodies.md)
- [Shapes](./shapes.md)
- [Forces And Impulses](./forces-and-impulses.md)
- [Events](./events.md)
- [Internals](./internals.md)
