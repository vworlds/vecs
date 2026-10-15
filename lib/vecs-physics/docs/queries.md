# Queries

Queries let you ask the live physics world questions right now: what does this ray hit, what would this shape hit if it moved, and what overlaps this region?

This page covers obtaining the `physics(world)` accessor, each query method, filter and result types, and the broad-phase vs precise-phase distinction.

## Core Concept

`vecs-physics` is component-driven for simulation state, but ray casts, shape casts, and overlap checks are naturally synchronous reads against the current world, not state that fits a component. For these, `vecs-physics` exposes exactly one imperative entry point: `physics(world)`.

```ts
import { physics } from "@vworlds/vecs-physics";

const q = physics(world);
```

- `physics(world)` throws if `world.module(PhysicsModule)` has not been called yet. Call it only after installing `PhysicsModule`.
- The returned `PhysicsQueries` facade is stable: repeated calls for the same `world` return the same instance, so calling `physics(world)` every frame does not allocate.
- All query methods are synchronous, read-only, and never wake bodies, never create or destroy entities, and never mutate the world. You can call them freely from any system without affecting the simulation.
- Results are always Vecs **shape entities** (or plain data describing a hit on one), never Box2D handles. To get the owning body, use `entity.parent` (the shape's `ChildOf` parent).

## Stats

`physics(world).stats()` returns the live Box2D body, shape, joint and contact counts as plain data.

```ts
const { bodyCount, shapeCount } = physics(world).stats();
```

The counts track Box2D rather than entities: destroying a body entity removes it from the counts
when the reaper runs in the next step. Chain segments count as one shape each. Use it to assert
that handles return to baseline after teardown.

## Settings And Body Motion

Three reads expose what a peer needs to predict a body, as the dead-reckoning sync in
`@vworlds/vecs-phaser-server` does:

| Method                    | Returns                                                                                                            | Cost                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `settings()`              | `PhysicsSettings`: the world's `gravity`, `fixedTimeStep`, `subSteps` and `maximumLinearSpeed`, defaults filled in | none; one shared, frozen object                                             |
| `isAwake(entity)`         | whether the entity's body is awake; `false` without a live body                                                    | one Box2D call, no allocation: fine per body per step                       |
| `bodyMotion(entity, out)` | fills a `BodyMotion`; `false` without a live body                                                                  | one composite fast-path call, reusable wasm scratch, no per-call allocation |

`BodyMotion` holds `awake`, the velocities `vx`, `vy`, `w`, `linearDamping`, `angularDamping`, the
center of mass in body coordinates `localCenterX`, `localCenterY`, `allowFastRotation`, and the
`gravityScale` Box2D applies, which is 0 for a body without mass (static or kinematic) whatever its
`GravityScale`. A sleeping body reports zero velocities. Allocate one and reuse it:

```ts
const motion = new BodyMotion();
if (physics(world).bodyMotion(rock, motion) && motion.awake) {
  send(motion.vx, motion.vy, motion.w);
}
```

## Ray Casts

A ray cast answers: what shape would a ray from `from` to `to` hit?

```ts
export interface RayHit {
  entity: Entity; // the shape entity that was hit
  point: Vec2; // world-space hit point
  normal: Vec2; // world-space unit surface normal at the hit point
  fraction: number; // fraction along from -> to, in [0, 1]
}
```

### `rayCastClosest`

Returns the closest hit along the ray, or `undefined` if the ray hits nothing.

```ts
const hit = physics(world).rayCastClosest({
  from: { x: 0, y: 2 },
  to: { x: 10, y: 2 },
});

if (hit) {
  console.log(hit.entity.eid, hit.point.x, hit.point.y, hit.normal.x, hit.normal.y, hit.fraction);
}
```

Use this for line-of-sight checks, bullet traces, mouse picking, and ground checks.

### `rayCastAll`

Returns every shape the ray crosses, in the order Box2D reports them (fractions ascending).

```ts
const hits = physics(world).rayCastAll({
  from: { x: -10, y: 0 },
  to: { x: 10, y: 0 },
});

for (const hit of hits) {
  console.log(hit.entity.eid, hit.fraction);
}
```

A ray that crosses nothing returns `[]`.

## Shape Casts

A shape cast answers: if this shape moved from `from` to `to`, what would it hit? Where a ray cast sweeps a point, a shape cast sweeps a whole geometry — use it for swept collision checks, character movement, fast projectile prediction, and placement previews.

The cast geometry is any single-shape geometry component (`Box`, `Circle`, `Capsule`, `Segment`, or `Polygon`) — the same classes shape entities use, in the same local coordinates. Pass a standalone instance, or a live entity's own component (`entity.get(Circle)!`). `Chain` cannot be cast.

```ts
export type CastGeometry = Box | Capsule | Circle | Polygon | Segment;

export interface ShapeCastHit {
  entity: Entity; // the shape entity that was hit
  point: Vec2; // world-space contact point at first touch
  normal: Vec2; // world-space unit surface normal (zero vector when fraction is 0)
  fraction: number; // fraction along from -> to at first touch, in [0, 1]
}
```

The geometry is placed with its local origin at `from` (rotated by the optional `rotation`, in radians) and swept in a straight line until its origin reaches `to`. `fraction` measures how far along that sweep the geometry first touches the hit shape — a cast that starts already touching or overlapping a shape reports it at `fraction: 0` with a zero `normal`.

### `shapeCastClosest`

Returns the first shape the sweep would touch, or `undefined` if it touches nothing.

```ts
import { Circle, physics } from "@vworlds/vecs-physics";

const probe = new Circle();
probe.radius = 0.5;

const hit = physics(world).shapeCastClosest({
  shape: probe,
  from: { x: 0, y: 2 },
  to: { x: 10, y: 2 },
});

if (hit) {
  console.log(hit.entity.eid, hit.point.x, hit.point.y, hit.normal.x, hit.normal.y, hit.fraction);
}
```

Because the surface of the cast geometry leads its origin, the hit `fraction` is shorter than the equivalent ray cast's: a circle of radius `0.5` stops half a meter short of where a ray along the same line would land.

Throws if `shape` is a `Polygon` with no vertices or more than 8 (Box2D's polygon vertex limit; see [Shapes](./shapes.md)).

### `shapeCastAll`

Returns every shape the sweep would touch, each with its own first-contact `point`, `normal`, and `fraction`, in the order Box2D reports them.

```ts
const hits = physics(world).shapeCastAll({
  shape: probe,
  from: { x: -10, y: 0 },
  to: { x: 10, y: 0 },
});

for (const hit of hits) {
  console.log(hit.entity.eid, hit.fraction);
}
```

A sweep that touches nothing returns `[]`.

## Overlap Queries

Overlap queries answer: what shapes occupy this region right now? Both overlap methods return `Entity[]` — the matched shape entities, with no duplicates.

### `overlapAABB` (broad-phase)

Returns every shape entity whose **fat AABB** overlaps `[min, max]`.

```ts
const hits = physics(world).overlapAABB({
  min: { x: -5, y: -5 },
  max: { x: 5, y: 5 },
});

for (const entity of hits) {
  console.log(entity.eid);
}
```

`overlapAABB` is a broad-phase query: Box2D pads each shape's AABB for movement, so this can **over-report** relative to exact shape overlap. Use it for cheap proximity checks, editor selection, or as a first pass before a more precise check.

### `overlapCircle` (precise mid-phase)

Returns every shape entity that precisely overlaps a circle centered at `center` with the given `radius`.

```ts
const hits = physics(world).overlapCircle({
  center: { x: 0, y: 0 },
  radius: 1.5,
});

for (const entity of hits) {
  console.log(entity.eid);
}
```

`overlapCircle` is the precise mid-phase variant: a shape sitting inside the circle's bounding AABB but outside the circle's radius is excluded. Use it for area triggers, proximity checks, and spawn validation where the broad-phase margin of `overlapAABB` would be misleading.

## Filters

Every query method accepts an optional `filter`.

```ts
export interface QueryFilter {
  categoryBits?: number; // default 0xffffffff
  maskBits?: number; // default 0xffffffff
}
```

A query's defaults are the inverse of a shape's defaults: a shape defaults to `categoryBits: 1`, but a query with no filter defaults `categoryBits` and `maskBits` to `0xffffffff`, so a query with no filter sees everything.

The collision rule between a query `Q` and a shape `S` is the same as Box2D's:

```
(Q.categoryBits & S.maskBits) != 0 && (S.categoryBits & Q.maskBits) != 0
```

Example: only hit shapes in category `0b10`.

```ts
const hit = physics(world).rayCastClosest({
  from: { x: 0, y: 2 },
  to: { x: 10, y: 2 },
  filter: { maskBits: 0b10 },
});
```

## Results Are Shape Entities

Every result — `RayHit.entity`, `ShapeCastHit.entity`, and each entry of the `Entity[]` returned by `overlapAABB`/`overlapCircle` — is the **shape** entity, the same entity you created as a child of a body with `ChildOf`. Use `entity.parent` to reach the body entity.

```ts
const hit = physics(world).rayCastClosest({ from: { x: -10, y: 0 }, to: { x: 10, y: 0 } });

if (hit) {
  const shape = hit.entity;
  const body = shape.parent;
  console.log("hit body", body?.eid, "via shape", shape.eid);
}
```

If a hit shape's entity has been destroyed since the last step, that hit is silently dropped — it will not appear in results.

## Worked Examples

### Line Of Sight

Check whether a guard can see a target by casting a ray between them and confirming the closest hit is the target's own shape.

```ts
const hit = physics(world).rayCastClosest({
  from: { x: guardPos.x, y: guardPos.y },
  to: { x: targetPos.x, y: targetPos.y },
});

const canSeeTarget = hit !== undefined && hit.entity.eid === targetShape.eid;
```

If a wall sits between the guard and the target, `rayCastClosest` returns the wall's shape first and `canSeeTarget` is `false`.

### Swept Movement Check

Before moving a character this frame, sweep its own collision capsule along the intended motion and clamp the move to the first hit.

```ts
const capsule = playerShape.get(Capsule)!; // the player's own collision geometry

const from = { x: playerPos.x, y: playerPos.y };
const to = { x: playerPos.x + move.x, y: playerPos.y + move.y };

const hit = physics(world).shapeCastClosest({ shape: capsule, from, to });

const allowed = hit?.fraction ?? 1;
player.set(Position, {
  x: playerPos.x + move.x * allowed,
  y: playerPos.y + move.y * allowed,
});
```

A `fraction` of `0` means the capsule is already touching something at `from` — the character cannot move along this vector at all.

### Area Trigger

Use `overlapAABB` for a cheap first pass over a region, then `overlapCircle` to confirm a precise radius check.

```ts
const region = physics(world).overlapAABB({
  min: { x: zone.x - zone.radius, y: zone.y - zone.radius },
  max: { x: zone.x + zone.radius, y: zone.y + zone.radius },
});

const inRange = physics(world).overlapCircle({
  center: { x: zone.x, y: zone.y },
  radius: zone.radius,
});

console.log(`broad-phase candidates: ${region.length}, precise hits: ${inRange.length}`);
```

`region.length` can be greater than or equal to `inRange.length` because `overlapAABB` includes shapes whose padded AABB reaches into the box but whose actual geometry does not reach the circle.

## Related Pages

- [Events](./events.md) - contact, hit, and sensor event components.
- [Materials And Filters](./materials-and-filters.md) - collision categories, masks, and groups for shapes.
- [Shapes](./shapes.md) - shape entities and geometry components.
- [Roadmap](./roadmap.md) - what is shipped vs deferred.
