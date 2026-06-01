// Segment-family narrow-phase manifold functions (VP-13d).
//
// Upstream source: box2d/src/manifold.c
//   - b2CollideSegmentAndCircle  (reduces to b2CollideCapsuleAndCircle)
//   - b2CollideSegmentAndPolygon (reduces to b2CollidePolygons via b2MakeCapsule)
//
// Engine module boundary: import only from math/, engine/manifold/*.

import type { Transform } from "../../math/transform.js";
import type { Manifold } from "./types.js";
import { type CircleShape, collideCapsuleAndCircle } from "./circles.js";
import { collidePolygons, type PolygonShape } from "./polygons.js";

export interface SegmentShape {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

// ─── b2CollideSegmentAndCircle ────────────────────────────────────────────────

/**
 * Compute the collision manifold between a segment and a circle.
 *
 * Mirrors `b2CollideSegmentAndCircle` in manifold.c:
 * treats the segment as a zero-radius capsule.
 */
export function collideSegmentAndCircle(
  segmentA: SegmentShape,
  xfA: Transform,
  circleB: CircleShape,
  xfB: Transform
): Manifold {
  return collideCapsuleAndCircle(
    { ax: segmentA.ax, ay: segmentA.ay, bx: segmentA.bx, by: segmentA.by, radius: 0 },
    xfA,
    circleB,
    xfB
  );
}

// ─── b2CollideSegmentAndPolygon ───────────────────────────────────────────────

/**
 * Compute the collision manifold between a segment and a polygon.
 *
 * Mirrors `b2CollideSegmentAndPolygon` in manifold.c:
 * converts the segment to a zero-radius 2-vertex polygon and delegates.
 */
export function collideSegmentAndPolygon(
  segmentA: SegmentShape,
  xfA: Transform,
  polygonB: PolygonShape,
  xfB: Transform
): Manifold {
  // mirrors b2MakeCapsule with radius = 0
  const ax = segmentA.ax;
  const ay = segmentA.ay;
  const bx = segmentA.bx;
  const by = segmentA.by;
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.sqrt(dx * dx + dy * dy);
  const inv = len > Number.EPSILON ? 1 / len : 0;
  const axisX = dx * inv;
  const axisY = dy * inv;
  const nx = axisY;
  const ny = -axisX;

  const polygonA: PolygonShape = {
    vertices: new Float32Array([ax, ay, bx, by]),
    normals: new Float32Array([nx, ny, -nx, -ny]),
    count: 2,
    radius: 0,
    centroidX: (ax + bx) * 0.5,
    centroidY: (ay + by) * 0.5,
  };
  return collidePolygons(polygonA, xfA, polygonB, xfB);
}
// Transitional stub kept alive for surviving engine code; full deletion happens in M7-10.
