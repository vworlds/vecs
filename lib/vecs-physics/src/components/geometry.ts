// Geometry components. Exactly one per shape entity; `PhysicsModule` marks them
// mutually exclusive so adding one removes any previous geometry. Defaults match
// the documented shapes. Public API — see `docs/components.md`.

/** Plain 2D point used by {@link Polygon} and {@link Chain}. */
export type Vec2 = { x: number; y: number };

/**
 * Axis-aligned box in local shape space, stored as half extents (`hx`/`hy`) to
 * match Box2D's internal representation. The `width`/`height` accessors are
 * read/write ergonomics over the half extents.
 *
 * Vecs cannot observe accessor writes: after `box.width = 2` the caller must
 * still go through `entity.set(Box, …)` or `entity.modified(Box)` for physics
 * to notice. See PLAN → Box accessors.
 */
export class Box {
  hx = 0.5;
  hy = 0.5;

  get width(): number {
    return this.hx * 2;
  }

  set width(value: number) {
    this.hx = value / 2;
  }

  get height(): number {
    return this.hy * 2;
  }

  set height(value: number) {
    this.hy = value / 2;
  }
}

/** Circle geometry. */
export class Circle {
  radius = 0.5;
}

/** Capsule geometry: two local endpoints joined by a radius. */
export class Capsule {
  x1 = -0.5;
  y1 = 0;
  x2 = 0.5;
  y2 = 0;
  radius = 0.25;
}

/** Line-segment geometry. */
export class Segment {
  x1 = -0.5;
  y1 = 0;
  x2 = 0.5;
  y2 = 0;
}

/**
 * Convex polygon geometry (up to `B2_MAX_POLYGON_VERTICES` = 8 vertices).
 * Convexity and vertex count are validated on shape creation, not on every
 * update. See PLAN → Vec2 in Polygon / Chain.
 */
export class Polygon {
  vertices: Vec2[] = [];
  radius = 0;
}

/** Chain geometry for static terrain. Needs at least four points. */
export class Chain {
  points: Vec2[] = [];
  loop = false;
}
