# Roadmap

This page describes what is intentionally included in the first version of `vecs-physics`, what is deferred, and how those future features are expected to fit into the Vecs API.

The first version focuses on the core simulation loop: bodies, shapes, materials, filters, forces, impulses, kinematic targets, and events. The simulation backend is `box2d3-wasm`, with Vecs entities and components as the public API.

## Version 1 Scope

The initial version is designed to make normal rigid-body gameplay work with a native Vecs API.

Included areas:

| Area              | Status   | Notes                                                                                     |
| ----------------- | -------- | ----------------------------------------------------------------------------------------- |
| Bodies            | Included | `Body`, `Position`, `Rotation`, velocities, and optional body tunables.                   |
| Shapes            | Included | Child shape entities with exclusive geometry components.                                  |
| Materials         | Included | Box2D-compatible defaults for density, friction, and restitution.                         |
| Collision filters | Included | Category bits, mask bits, and group index.                                                |
| Sensors           | Included | `Sensor` component on shape entities; `Detectable` marks solid shapes visible to sensors. |
| Forces            | Included | Persistent `Force` and `Torque` components.                                               |
| Impulses          | Included | Reactive one-shot `Impulse` and `AngularImpulse` components.                              |
| Kinematic targets | Included | Target position and rotation components for kinematic bodies.                             |
| Contact events    | Included | Shape-local `ContactEvents` component.                                                    |
| Sensor events     | Included | Shape-local `SensorEvents` component.                                                     |
| Hit events        | Included | Shape-local `HitEvents` component.                                                        |
| Sleeping          | Included | `Sleep` component plus world `enableSleep: true` default.                                 |
| Continuous CCD    | Included | `Body.bullet` / fast-body CCD with `enableContinuous: true` default.                      |
| Debug validation  | Included | Optional deduplicated warnings for invalid ECS structures.                                |

The goal for v1 is that this kind of game object should be straightforward:

```ts
const player = world.entity().set(Position, { x: 0, y: 4 }).set(Body, { type: BodyType.Dynamic });

world.entity().set(ChildOf, { target: player }).set(Box, { hx: 0.5, hy: 1 }).add(ContactEvents);

player.set(Impulse, { x: 0, y: 8 });
```

## Version 2 Additions

Version 2 adds the `Detectable` marker component and an imperative, read-only query API via `physics(world)`.

| Area                 | Status   | Notes                                                                                                        |
| -------------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `Detectable`         | Included | Marker component on a shape entity that makes a solid shape visible to sensors.                              |
| Ray casts            | Included | `physics(world).rayCastClosest` and `physics(world).rayCastAll`.                                             |
| AABB overlap queries | Included | `physics(world).overlapAABB` (broad-phase, fat AABB) and `physics(world).overlapCircle` (precise mid-phase). |

### Ray Casts

Ray casts answer the question: what shape would this ray hit?

```ts
import { physics } from "@vworlds/vecs-physics";

const hit = physics(world).rayCastClosest({
  from: { x: 0, y: 2 },
  to: { x: 10, y: 2 },
  filter: { categoryBits: 1, maskBits: 0xffffffff },
});

if (hit) {
  console.log(hit.entity); // shape entity
  console.log(hit.point.x, hit.point.y);
  console.log(hit.normal.x, hit.normal.y);
}
```

Use cases:

- Line-of-sight checks.
- Bullet traces.
- Mouse picking.
- Ground checks.
- Sensor-like checks for fast projectiles.

`rayCastAll` returns every shape the ray crosses, in fraction-ascending order, instead of only the closest:

```ts
const hits = physics(world).rayCastAll({
  from: { x: -10, y: 0 },
  to: { x: 10, y: 0 },
});

for (const hit of hits) {
  console.log(hit.entity, hit.fraction);
}
```

See [Queries](./queries.md) and [Materials And Filters](./materials-and-filters.md), [Events](./events.md).

### AABB Overlap Queries

Overlap queries answer the question: which shapes overlap this region?

```ts
import { physics } from "@vworlds/vecs-physics";

const hits = physics(world).overlapAABB({
  min: { x: -5, y: -5 },
  max: { x: 5, y: 5 },
});

for (const entity of hits) {
  console.log(entity); // shape entity
}
```

Use cases:

- Area triggers.
- Editor selection.
- Proximity checks.
- Spawn validation.
- Cheap broad-phase gameplay queries.

`overlapAABB` is a broad-phase query against fat AABBs: it can over-report relative to exact shape overlap. `overlapCircle` is the precise mid-phase variant:

```ts
const hits = physics(world).overlapCircle({
  center: { x: 0, y: 0 },
  radius: 1.5,
});

for (const entity of hits) {
  console.log(entity); // shape entity
}
```

See [Queries](./queries.md).

## Deferred Features

The following features are intentionally not part of the first version.

They are important, but they should come after the body/shape/event model is solid. Box2D already exposes many of these primitives through `box2d3-wasm`; the remaining work is designing and implementing the vecs-physics adapters without leaking Box2D handles into the public API.

### V2 Carries From V1 Closeout

The M5 closeout left four explicit v2 carries:

- Open-chain ghost-vertex fidelity at sharp endpoints: loop chains use real neighbor ghosts; open-chain endpoints use reflection, which is correct for straight chains but still needs sharp-endpoint Box2D parity work.
- Dynamic `Sensor` marker toggle: switching solid ↔ sensor at runtime needs contact teardown, sensor-storage create/destroy, and mass/proxy invariant handling; recreating the shape is the v1 workaround.
- CoM-shift velocity adjustment: v1 sleep state uses `v = ω = 0`, making the shift identically zero in the covered cases; revisit if v2 adds runtime center-of-mass changes that can affect sleeping bodies.
- Sensor TOI hits queue: v1 sensor events use the regular overlap pass; TOI-precise sensor hits are deferred until sensor CCD use cases need them.

### Shape Casts

**Shipped: `physics(world).shapeCastClosest` and `physics(world).shapeCastAll`.** See
[Queries](./queries.md) for the full model. A shape cast sweeps a `CastGeometry` — the
same geometry component classes shape entities use (`Box`, `Circle`, `Capsule`,
`Segment`, `Polygon`) — from `from` to `to` and reports `ShapeCastHit`s (shape entity,
contact point, normal, fraction):

```ts
const probe = new Circle();
probe.radius = 0.5;

const hit = physics(world).shapeCastClosest({
  shape: probe,
  from: { x: 0, y: 1 },
  to: { x: 10, y: 1 },
});
```

Use cases: swept collision checks, fast projectile prediction, character movement,
and placement previews.

### Character Movement Helpers

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

### Joints

**Shipped: revolute, distance, weld, and filter joints.** See [Joints](./joints.md)
for the full model. A joint is its own entity that references the two connected
bodies through the `JointBodyA`/`JointBodyB` relationships, carries one exclusive
joint-type component, and layers optional feature components (`JointMotor`,
`JointLimit`, `JointLinearSpring`, `JointAngularSpring`) whose presence enables
the feature.

Still pending:

- **Prismatic, wheel, and motor joints.** These need an axis (prismatic/wheel) or
  a velocity-drive model (motor) on top of the existing scaffolding; they slot
  into the same component model as added def-builders and setter maps.
- **Breakable-joint events.** Box2D exposes joint force/torque thresholds and
  joint events; a vecs-physics event surface for them is not yet wired.

See also: [Bodies](./bodies.md), [Shapes](./shapes.md).

### Debug Drawing

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

### Serialization And Networking

Serialization is not part of the first version.

Vecs already has related packages for networking and binary encoding. `vecs-physics` should remain compatible with ordinary component serialization where possible, but internal physics engine data should not be treated as authoritative save data.

Recommended direction:

- Serialize public components such as `Position`, `Rotation`, `Body`, geometry, `Material`, and `CollisionFilter`.
- Rebuild the internal physics engine when loading.
- Do not serialize internal broad-phase, contact, island, or solver data.

## Common Mistakes

### Expecting Deferred Features In V1

If you need character movers immediately, they are not part of the first version.

Ray casts and overlap queries shipped in v2 via `physics(world)`, and shape casts have shipped on the same facade — see [Queries](./queries.md). Revolute, distance, weld, and filter joints have shipped — see [Joints](./joints.md). Use shape entities, sensors, and contact events for gameplay that does not yet have a dedicated query or constraint API.

### Building Public APIs Around Internal Handles

Future features should continue to return Vecs entities, not internal handles.

Prefer this:

```ts
const hit = physics(world).rayCastClosest(ray);
console.log(hit?.entity);
```

Avoid this:

```ts
console.log(hit?.shapeId);
```

The whole point of `vecs-physics` is that users work with ECS entities and components.

### Adding Features Before The Core Model Is Stable

Character movers depend on stable body and shape lifecycle rules. If those rules change later, every advanced API becomes harder to keep consistent. (Joints and shape casts shipped on top of the now-stable body/shape lifecycle — see [Joints](./joints.md) and [Queries](./queries.md).)

## Related Pages

- [Getting Started](./getting-started.md)
- [Bodies](./bodies.md)
- [Shapes](./shapes.md)
- [Forces And Impulses](./forces-and-impulses.md)
- [Events](./events.md)
- [Internals](./internals.md)
