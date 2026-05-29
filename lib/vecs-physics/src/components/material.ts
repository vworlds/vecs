// Material, collision filtering, and the sensor marker. Defaults match
// `b2DefaultShapeDef()` / `b2DefaultSurfaceMaterial()` / `b2DefaultFilter()`
// (see `box2d/src/types.c`). Public API — see `docs/components.md`.
//
// `categoryBits`/`maskBits` are 64-bit, so they are `bigint`; Box2D uses
// `uint64_t`. `userMaterialId` is likewise a `bigint`.

/** Physical surface material for a shape (bundles density + surface props). */
export class Material {
  density = 1;
  friction = 0.6;
  restitution = 0;
  rollingResistance = 0;
  tangentSpeed = 0;
  userMaterialId = 0n;
}

/** Collision category/mask/group. Missing means category 1, collides with all. */
export class CollisionFilter {
  categoryBits = 1n;
  maskBits = 0xffff_ffff_ffff_ffffn;
  groupIndex = 0;
}

/** Marks a shape as an overlap-only sensor (no collision response). */
export class Sensor {}
