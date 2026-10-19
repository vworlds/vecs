// Geometry components. Exactly one per shape entity; every concrete geometry
// implements the `Shape` umbrella so `PhysicsModule` enforces mutual exclusivity
// (setting one evicts any previous geometry). Single Box2D shapes also implement
// the internal `SingleShape` tier; `Chain` is separate because Box2D exposes it
// through `b2ChainId` plus underlying segment shapes.
// Public API — see `docs/components.md`.
//
// These are plain data classes: every field is initialised on the class body so
// `new C()` yields a valid, default-shaped instance (the Vecs zero-arg
// contract). No imports from behavior modules or adapter/ beyond type-only `b2*Id`
// handle types — components are pure data.

import type { b2ChainId, b2ShapeId } from "../adapter/engine.js";
import type { Vec2 } from "@vworlds/vecs";

/**
 * Empty umbrella marker for the six geometry components. Every shape entity carries
 * exactly one concrete geometry (`Box`, `Circle`, `Capsule`, `Segment`,
 * `Polygon`, or `Chain`); each implements `Shape` so queries and systems can
 * match any geometry without enumerating every concrete type.
 */
export abstract class Shape {}

/**
 * Internal marker for geometries backed by one Box2D `b2ShapeId`. Chains are
 * intentionally excluded because Box2D creates them through `b2ChainId` and
 * exposes their collision segments separately.
 */
export abstract class SingleShape extends Shape {
  /** @internal Engine-owned Box2D shape handle. Set by the single-shape lifecycle system. */
  _shapeId: b2ShapeId | undefined = undefined;
}

/**
 * Axis-aligned box in local shape space, stored as half extents (`hx`/`hy`) to
 * match Box2D's internal representation. The `width`/`height` accessors are
 * read/write ergonomics over the half extents.
 *
 * Vecs cannot observe accessor writes: after `box.width = 2` the caller must
 * still go through `entity.set(Box, …)` or `entity.modified(Box)` for physics
 * to notice. See PLAN → Box accessors.
 */
export class Box extends SingleShape {
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
export class Circle extends SingleShape {
  radius = 0.5;
}

/** Capsule geometry: two local endpoints joined by a radius. */
export class Capsule extends SingleShape {
  x1 = -0.5;
  y1 = 0;
  x2 = 0.5;
  y2 = 0;
  radius = 0.25;
}

/** Line-segment geometry. */
export class Segment extends SingleShape {
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
export class Polygon extends SingleShape {
  vertices: Vec2[] = [];
  radius = 0;
}

/** Chain geometry for static terrain. Needs at least four points. For open chains,
 * the first and last points are explicit ghost vertices, not collision segments;
 * they determine the endpoint normals. */
export class Chain extends Shape {
  /** @internal Engine-owned Box2D chain handle. Set by the chain lifecycle system. */
  _chainId: b2ChainId | undefined = undefined;
  /** @internal Public shape indices of the chain's generated segment shapes. */
  _segmentIndices: number[] = [];
  points: Vec2[] = [];
  loop = false;
}
