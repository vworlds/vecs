# Queries

Queries let you ask the live physics world questions right now: what does this ray hit, and what overlaps this region?

This page covers obtaining the `physics(world)` accessor, each query method, filter and result types, and the broad-phase vs precise-phase distinction.

## Core Concept

`vecs-physics` is component-driven for simulation state, but ray casts and overlap checks are naturally synchronous reads against the current world, not state that fits a component. For these, `vecs-physics` exposes exactly one imperative entry point: `physics(world)`.

```ts
import { physics } from "@vworlds/vecs-physics";

const q = physics(world);
```

- `physics(world)` throws if `world.module(PhysicsModule)` has not been called yet. Call it only after installing `PhysicsModule`.
- The returned `PhysicsQueries` facade is stable: repeated calls for the same `world` return the same instance, so calling `physics(world)` every frame does not allocate.
- All four methods are synchronous, read-only, and never wake bodies, never create or destroy entities, and never mutate the world. You can call them freely from any system without affecting the simulation.
- Results are always Vecs **shape entities** (or plain data describing a hit on one), never Box2D handles. To get the owning body, use `entity.parent` (the shape's `ChildOf` parent).

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

Both ray casts and overlap queries accept an optional `filter`.

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

Every result — `RayHit.entity`, and each entry of the `Entity[]` returned by `overlapAABB`/`overlapCircle` — is the **shape** entity, the same entity you created as a child of a body with `ChildOf`. Use `entity.parent` to reach the body entity.

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
