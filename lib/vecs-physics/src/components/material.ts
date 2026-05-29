// Material, collision filtering, and the sensor marker. Defaults match
// `b2DefaultShapeDef()` / `b2DefaultSurfaceMaterial()` / `b2DefaultFilter()`
// (see `box2d/src/types.c`). Public API — see `docs/components.md`.
//
// Divergence from Box2D: `categoryBits`/`maskBits` are 32-bit and stored as
// plain `number`, not Box2D's `uint64_t`. 32 categories is plenty, and JS
// bitwise ops (`&`, `|`) are native 32-bit, so filtering — `(catA & maskB) !==
// 0` — stays fast and bigint-free. `userMaterialId` is an opaque id (not a
// bitfield), also a `number`. See PLAN → Settled Decisions.

/** Physical surface material for a shape (bundles density + surface props). */
export class Material {
  density = 1;
  friction = 0.6;
  restitution = 0;
  rollingResistance = 0;
  tangentSpeed = 0;
  userMaterialId = 0;
}

/** Collision category/mask/group. Missing means category 1, collides with all. */
export class CollisionFilter {
  categoryBits = 1;
  maskBits = 0xffffffff;
  groupIndex = 0;
}

/** Marks a shape as an overlap-only sensor (no collision response). */
export class Sensor {}
