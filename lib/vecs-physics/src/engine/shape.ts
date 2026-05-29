// Internal shape model. The engine-layer counterpart to the public geometry
// components (Box, Circle, Capsule, Segment, Polygon, Chain).
//
// VP-8 scope: type, geometry union, local pose, local centroid, world AABB.
// Fields deferred to later tickets are documented in comments:
//   - VP-10: proxyKey, fatAabbMin/Max (broad-phase proxy)
//   - VP-11: bodyHandle, entity, prevShape/nextShape, density/friction/
//            restitution/rollingResistance/tangentSpeed/userMaterialId,
//            categoryBits/maskBits/groupIndex, sensor/enableContactEvents/
//            enableHitEvents/enableSensorEvents, sensorIndex
//   - VP-12: no mass fields on InternalShape (mass lives on BodySim)
//
// Engine module boundary: import only from math/ and util/.
//
// Upstream sources:
//   box2d/include/box2d/collision.h  — b2ShapeType enum, b2ChainSegment
//   box2d/src/geometry.c             — shape construction
//   box2d/src/hull.c                 — hull validation

import type { AABB } from "../math/aabb.js";
import type { Transform } from "../math/transform.js";
import type { ShapeHandle } from "../util/handle.js";
import { IdPool } from "../util/id_pool.js";
import {
  computeAABB,
  computeHull,
  makeBox,
  makePolygon,
  validateHull,
  type ChainSegmentGeometry,
  type GeometryUnion,
  type PolygonGeometry,
  MAX_POLYGON_VERTICES,
} from "./geometry.js";

// Re-export GeometryUnion so callers can import it from here.
export type { GeometryUnion, PolygonGeometry, ChainSegmentGeometry };

// ─── ShapeType ────────────────────────────────────────────────────────────────

/**
 * Numeric shape type. Ordering matches `b2ShapeType` in Box2D:
 * circle=0, capsule=1, segment=2, polygon=3, chainSegment=4.
 * The narrow-phase dispatch table uses these values as row/column indices.
 */
export const enum ShapeType {
  Circle = 0,
  Capsule = 1,
  Segment = 2,
  Polygon = 3,
  ChainSegment = 4,
}

// ─── InternalShape ────────────────────────────────────────────────────────────

/**
 * Sparse, handle-indexed shape record. Intentionally thin: VP-8 populates only
 * the fields needed for geometry and AABB. See the block comments above for the
 * deferral map.
 */
export interface InternalShape {
  // ── Geometry & local pose ──────────────────────────────────────────────────
  type: ShapeType;
  geometry: GeometryUnion;

  /** Shape-local pose relative to the body origin. Populated from
   * `ShapePosition` / `ShapeRotation` by VP-11. */
  localX: number;
  localY: number;
  localCos: number;
  localSin: number;

  /** Centroid of the geometry in body-local space (not affected by the local
   * pose transform — the shape-lifecycle system computes the final world
   * centroid). */
  localCentroidX: number;
  localCentroidY: number;

  // ── Computed world AABB (tight, no fat margin) ────────────────────────────
  aabbMinX: number;
  aabbMinY: number;
  aabbMaxX: number;
  aabbMaxY: number;

  // ── VP-10 deferred: broad-phase proxy ─────────────────────────────────────
  // proxyKey: number;          // broad-phase proxy id (DynamicTree leaf key)
  // fatAabbMinX: number;       // enlarged AABB for proxy re-fit hysteresis
  // fatAabbMinY: number;
  // fatAabbMaxX: number;
  // fatAabbMaxY: number;

  // ── VP-11 deferred: body linkage & material/filter/sensor ─────────────────
  // bodyHandle: BodyHandle | null;
  // entity: Entity;
  // prevShape: ShapeHandle | null;   // linked list on the body
  // nextShape: ShapeHandle | null;
  // density: number;
  // friction: number;
  // restitution: number;
  // rollingResistance: number;
  // tangentSpeed: number;
  // userMaterialId: number;
  // categoryBits: number;
  // maskBits: number;
  // groupIndex: number;
  // sensor: boolean;
  // enableContactEvents: boolean;
  // enableHitEvents: boolean;
  // enableSensorEvents: boolean;
  // sensorIndex: number;   // into PhysicsState.sensors, or -1
}

// ─── ShapeStorage ─────────────────────────────────────────────────────────────

/**
 * Owns the sparse {@link InternalShape} table and the handle allocator.
 * Mirrors {@link BodyStorage} from `engine/body.ts`.
 */
export class ShapeStorage {
  /** Sparse, indexed by a {@link ShapeHandle}'s index; `undefined` = freed. */
  public readonly records: (InternalShape | undefined)[] = [];

  /** Allocates shape handle indices, stamping each with a generation. */
  public readonly idPool = new IdPool<ShapeHandle>();

  /** Live shape at a handle index. Throws if the slot is empty. */
  public get(index: number): InternalShape {
    const shape = this.records[index];
    if (shape === undefined) {
      throw new Error(`no shape at index ${index}`);
    }
    return shape;
  }
}

// ─── Per-shape constructors ────────────────────────────────────────────────────
//
// These take plain numbers (engine must not import components/) and a world
// transform (for the initial AABB computation). The local pose fields are
// seeded from the transform; VP-11 will override them from ShapePosition/
// ShapeRotation.

/** Build an {@link InternalShape} for a circle. */
export function makeCircleShape(radius: number, xf: Transform): InternalShape {
  const geom = { kind: "circle" as const, cx: 0, cy: 0, radius };
  const aabb = computeAABB(geom, xf);
  return makeShape(ShapeType.Circle, geom, xf, 0, 0, aabb);
}

/** Build an {@link InternalShape} for a capsule. */
export function makeCapsuleShape(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  radius: number,
  xf: Transform
): InternalShape {
  const geom = { kind: "capsule" as const, ax, ay, bx, by, radius };
  const aabb = computeAABB(geom, xf);
  // Centroid at midpoint of the two centers.
  const centX = 0.5 * (ax + bx);
  const centY = 0.5 * (ay + by);
  return makeShape(ShapeType.Capsule, geom, xf, centX, centY, aabb);
}

/** Build an {@link InternalShape} for a two-sided segment. */
export function makeSegmentShape(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  xf: Transform
): InternalShape {
  const geom = { kind: "segment" as const, ax, ay, bx, by };
  const aabb = computeAABB(geom, xf);
  const centX = 0.5 * (ax + bx);
  const centY = 0.5 * (ay + by);
  return makeShape(ShapeType.Segment, geom, xf, centX, centY, aabb);
}

/**
 * Build an {@link InternalShape} for a convex polygon from a user-supplied
 * vertex array.
 *
 * Validates convexity on construction (PLAN.md → _Component Model_: "validate
 * convexity on create not update"). Throws if:
 * - more than {@link MAX_POLYGON_VERTICES} vertices are supplied, or
 * - `b2ComputeHull` / `b2ValidateHull` reject the vertices as non-convex.
 */
export function makePolygonShape(
  pts: ReadonlyArray<{ x: number; y: number }>,
  radius: number,
  xf: Transform
): InternalShape {
  if (pts.length > MAX_POLYGON_VERTICES) {
    throw new Error(
      `Polygon has ${pts.length} vertices but the maximum is ${MAX_POLYGON_VERTICES}`
    );
  }

  const hull = computeHull(pts);
  if (hull.count < 3 || !validateHull(hull)) {
    throw new Error(
      `Polygon vertices do not form a valid convex hull (${pts.length} input points, hull count=${hull.count}). ` +
        "Check that points are not collinear and that the polygon is convex."
    );
  }

  const geom = makePolygon(hull, radius);
  const aabb = computeAABB(geom, xf);
  return makeShape(ShapeType.Polygon, geom, xf, geom.centroidX, geom.centroidY, aabb);
}

/**
 * Expand a chain of points into per-segment {@link InternalShape} records.
 *
 * One-sided collision: each segment's right side is the collision surface
 * (matching `b2ChainSegment`). Ghost vertices prevent internal collisions:
 * - Open chain: first segment's ghost1 reflects the direction before pts[0];
 *   last segment's ghost2 reflects the direction after pts[N-1].
 * - Loop chain: ghost1/ghost2 wrap around.
 *
 * The `chainId` field is 0; VP-11 will fill it in when linking chain shapes
 * to their owning body.
 *
 * @param points - At least 2 points (the chain generates `points.length - 1`
 *   segments for open chains, `points.length` for loops).
 * @param loop - Whether the chain closes back to the first point.
 * @param xf - World transform for AABB computation.
 */
export function makeChainSegments(
  points: ReadonlyArray<{ x: number; y: number }>,
  loop: boolean,
  xf: Transform
): InternalShape[] {
  const n = points.length;
  const segCount = loop ? n : n - 1;
  const result: InternalShape[] = [];

  for (let i = 0; i < segCount; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % n]!;

    // Ghost vertex before a (ghost1).
    let ghost1x: number;
    let ghost1y: number;
    if (loop) {
      const prev = points[(i - 1 + n) % n]!;
      ghost1x = prev.x;
      ghost1y = prev.y;
    } else if (i === 0) {
      // Reflect: ghost1 = a + (a - b) = 2a - b
      ghost1x = 2 * a.x - b.x;
      ghost1y = 2 * a.y - b.y;
    } else {
      ghost1x = points[i - 1]!.x;
      ghost1y = points[i - 1]!.y;
    }

    // Ghost vertex after b (ghost2).
    let ghost2x: number;
    let ghost2y: number;
    if (loop) {
      const next = points[(i + 2) % n]!;
      ghost2x = next.x;
      ghost2y = next.y;
    } else if (i === segCount - 1) {
      // Reflect: ghost2 = b + (b - a) = 2b - a
      ghost2x = 2 * b.x - a.x;
      ghost2y = 2 * b.y - a.y;
    } else {
      ghost2x = points[i + 2]!.x;
      ghost2y = points[i + 2]!.y;
    }

    const geom: ChainSegmentGeometry = {
      kind: "chainSegment",
      ghost1X: ghost1x,
      ghost1Y: ghost1y,
      ax: a.x,
      ay: a.y,
      bx: b.x,
      by: b.y,
      ghost2X: ghost2x,
      ghost2Y: ghost2y,
      chainId: 0,
    };

    const aabb = computeAABB(geom, xf);
    const centX = 0.5 * (a.x + b.x);
    const centY = 0.5 * (a.y + b.y);
    result.push(makeShape(ShapeType.ChainSegment, geom, xf, centX, centY, aabb));
  }

  return result;
}

// ─── Internal helper ──────────────────────────────────────────────────────────

/** Build an {@link InternalShape} from pre-computed parts. Local pose is seeded
 * from the supplied transform so that a shape created at the identity transform
 * has `localX=0, localY=0, localCos=1, localSin=0` — the shape-lifecycle
 * system (VP-11) overwrites these from `ShapePosition` / `ShapeRotation`. */
function makeShape(
  type: ShapeType,
  geometry: GeometryUnion,
  xf: Transform,
  centX: number,
  centY: number,
  aabb: AABB
): InternalShape {
  return {
    type,
    geometry,
    localX: xf.p.x,
    localY: xf.p.y,
    localCos: xf.q.c,
    localSin: xf.q.s,
    localCentroidX: centX,
    localCentroidY: centY,
    aabbMinX: aabb.lowerBound.x,
    aabbMinY: aabb.lowerBound.y,
    aabbMaxX: aabb.upperBound.x,
    aabbMaxY: aabb.upperBound.y,
  };
}
