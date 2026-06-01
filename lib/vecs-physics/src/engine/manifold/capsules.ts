// Capsule-family narrow-phase manifold functions (VP-13c).
//
// Upstream source: box2d/src/manifold.c
//   - b2CollideCapsules        (segment-distance + clip)
//   - b2CollideSegmentAndCapsule (reduces to b2CollideCapsules)
//   - b2CollidePolygonAndCapsule (reduces to b2CollidePolygons)
//
// Engine module boundary: import only from math/, engine/manifold/types.ts,
// and engine/manifold/polygons.ts.

import { LINEAR_SLOP, SPECULATIVE_DISTANCE } from "../../math/constants.js";
import { dot, sub, mulAdd, leftPerp, normalize } from "../../math/vec2.js";
import { rotateVector } from "../../math/rot.js";
import { invMulTransforms, transformPoint } from "../../math/transform.js";
import type { Transform } from "../../math/transform.js";
import { emptyManifold, makeId, type Manifold } from "./types.js";
import { collidePolygons, type PolygonShape } from "./polygons.js";

export interface CapsuleShape {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  radius: number;
}

export interface SegmentShape {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

// ─── makeCapsulePoly ─────────────────────────────────────────────────────────

// Mirrors the static b2MakeCapsule in manifold.c: converts a capsule
// (or zero-radius segment) into a 2-vertex polygon for use in collidePolygons.
function makeCapsulePoly(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  radius: number
): PolygonShape {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.sqrt(dx * dx + dy * dy);
  const inv = len > Number.EPSILON ? 1 / len : 0;
  const axisX = dx * inv;
  const axisY = dy * inv;
  // right perp: {axisY, -axisX}
  const nx = axisY;
  const ny = -axisX;

  const vertices = new Float32Array([ax, ay, bx, by]);
  const normals = new Float32Array([nx, ny, -nx, -ny]);
  const centroidX = (ax + bx) * 0.5;
  const centroidY = (ay + by) * 0.5;

  return { vertices, normals, count: 2, radius, centroidX, centroidY };
}

// ─── b2CollideCapsules ────────────────────────────────────────────────────────

/**
 * Compute the collision manifold between two capsules.
 *
 * Mirrors `b2CollideCapsules` in manifold.c.
 * Uses closest-points-on-segments (Ericson 5.1.9) + SAT clipping.
 */
export function collideCapsules(
  capsuleA: CapsuleShape,
  xfA: Transform,
  capsuleB: CapsuleShape,
  xfB: Transform
): Manifold {
  // Shift polyA to origin at capsuleA.center1
  const origin = { x: capsuleA.ax, y: capsuleA.ay };
  const sfA: Transform = {
    q: xfA.q,
    p: {
      x: xfA.p.x + xfA.q.c * origin.x - xfA.q.s * origin.y,
      y: xfA.p.y + xfA.q.s * origin.x + xfA.q.c * origin.y,
    },
  };
  const xf = invMulTransforms(sfA, xfB);

  const p1 = { x: 0, y: 0 };
  const q1 = { x: capsuleA.bx - capsuleA.ax, y: capsuleA.by - capsuleA.ay };
  const p2 = transformPoint(xf, { x: capsuleB.ax, y: capsuleB.ay });
  const q2 = transformPoint(xf, { x: capsuleB.bx, y: capsuleB.by });

  const d1 = sub(q1, p1);
  const d2 = sub(q2, p2);

  const dd1 = dot(d1, d1);
  const dd2 = dot(d2, d2);

  const epsSqr = Number.EPSILON * Number.EPSILON;

  const r = sub(p1, p2);
  const rd1 = dot(r, d1);
  const rd2 = dot(r, d2);
  const d12 = dot(d1, d2);
  const denom = dd1 * dd2 - d12 * d12;

  let f1 = 0;
  if (denom !== 0) {
    f1 = Math.max(0, Math.min(1, (d12 * rd2 - rd1 * dd2) / denom));
  }

  let f2 = (d12 * f1 + rd2) / dd2;
  if (f2 < 0) {
    f2 = 0;
    f1 = Math.max(0, Math.min(1, -rd1 / dd1));
  } else if (f2 > 1) {
    f2 = 1;
    f1 = Math.max(0, Math.min(1, (d12 - rd1) / dd1));
  }

  const closest1 = mulAdd(p1, f1, d1);
  const closest2 = mulAdd(p2, f2, d2);
  const dcx = closest2.x - closest1.x;
  const dcy = closest2.y - closest1.y;
  const distanceSquared = dcx * dcx + dcy * dcy;

  const manifold = emptyManifold();
  const radiusA = capsuleA.radius;
  const radiusB = capsuleB.radius;
  const radius = radiusA + radiusB;
  const maxDistance = radius + SPECULATIVE_DISTANCE;

  if (distanceSquared > maxDistance * maxDistance) {
    return manifold;
  }

  const distance = Math.sqrt(distanceSquared);

  // Unit axes for length computation
  const lenD1 = Math.sqrt(dd1);
  const lenD2 = Math.sqrt(dd2);
  const u1 = lenD1 > Number.EPSILON ? { x: d1.x / lenD1, y: d1.y / lenD1 } : { x: 1, y: 0 };
  const u2 = lenD2 > Number.EPSILON ? { x: d2.x / lenD2, y: d2.y / lenD2 } : { x: 1, y: 0 };

  const length1 = lenD1;
  const length2 = lenD2;

  // Does segment B project outside segment A?
  const fp2 = dot(sub(p2, p1), u1);
  const fq2 = dot(sub(q2, p1), u1);
  const outsideA = (fp2 <= 0 && fq2 <= 0) || (fp2 >= length1 && fq2 >= length1);

  // Does segment A project outside segment B?
  const fp1 = dot(sub(p1, p2), u2);
  const fq1 = dot(sub(q1, p2), u2);
  const outsideB = (fp1 <= 0 && fq1 <= 0) || (fp1 >= length2 && fq1 >= length2);

  if (!outsideA && !outsideB) {
    // Attempt to clip using SAT
    let normalA = leftPerp(u1);
    const ss1A = dot(sub(p2, p1), normalA);
    const ss2A = dot(sub(q2, p1), normalA);
    const s1pA = Math.min(ss1A, ss2A);
    const s1nA = Math.min(-ss1A, -ss2A);
    let separationA: number;
    if (s1pA > s1nA) {
      separationA = s1pA;
    } else {
      separationA = s1nA;
      normalA = { x: -normalA.x, y: -normalA.y };
    }

    let normalB = leftPerp(u2);
    const ss1B = dot(sub(p1, p2), normalB);
    const ss2B = dot(sub(q1, p2), normalB);
    const s1pB = Math.min(ss1B, ss2B);
    const s1nB = Math.min(-ss1B, -ss2B);
    let separationB: number;
    if (s1pB > s1nB) {
      separationB = s1pB;
    } else {
      separationB = s1nB;
      normalB = { x: -normalB.x, y: -normalB.y };
    }

    // biased to avoid feature flip-flop
    if (separationA + 0.1 * LINEAR_SLOP >= separationB) {
      manifold.normal = normalA;

      let cp = { ...p2 };
      let cq = { ...q2 };

      if (fp2 < 0 && fq2 > 0) {
        cp = {
          x: p2.x + (-fp2 / (fq2 - fp2)) * (q2.x - p2.x),
          y: p2.y + (-fp2 / (fq2 - fp2)) * (q2.y - p2.y),
        };
      } else if (fq2 < 0 && fp2 > 0) {
        cq = {
          x: q2.x + (-fq2 / (fp2 - fq2)) * (p2.x - q2.x),
          y: q2.y + (-fq2 / (fp2 - fq2)) * (p2.y - q2.y),
        };
      }

      if (fp2 > length1 && fq2 < length1) {
        cp = {
          x: p2.x + ((fp2 - length1) / (fp2 - fq2)) * (q2.x - p2.x),
          y: p2.y + ((fp2 - length1) / (fp2 - fq2)) * (q2.y - p2.y),
        };
      } else if (fq2 > length1 && fp2 < length1) {
        cq = {
          x: q2.x + ((fq2 - length1) / (fq2 - fp2)) * (p2.x - q2.x),
          y: q2.y + ((fq2 - length1) / (fq2 - fp2)) * (p2.y - q2.y),
        };
      }

      const sp = dot(sub(cp, p1), normalA);
      const sq = dot(sub(cq, p1), normalA);

      if (sp <= distance + LINEAR_SLOP || sq <= distance + LINEAR_SLOP) {
        manifold.points[0].anchorA = mulAdd(cp, 0.5 * (radiusA - radiusB - sp), normalA);
        manifold.points[0].separation = sp - radius;
        manifold.points[0].id = makeId(0, 0);
        manifold.points[1].anchorA = mulAdd(cq, 0.5 * (radiusA - radiusB - sq), normalA);
        manifold.points[1].separation = sq - radius;
        manifold.points[1].id = makeId(0, 1);
        manifold.pointCount = 2;
      }
    } else {
      // normal always points from A to B
      manifold.normal = { x: -normalB.x, y: -normalB.y };

      let cp = { ...p1 };
      let cq = { ...q1 };

      if (fp1 < 0 && fq1 > 0) {
        cp = {
          x: p1.x + (-fp1 / (fq1 - fp1)) * (q1.x - p1.x),
          y: p1.y + (-fp1 / (fq1 - fp1)) * (q1.y - p1.y),
        };
      } else if (fq1 < 0 && fp1 > 0) {
        cq = {
          x: q1.x + (-fq1 / (fp1 - fq1)) * (p1.x - q1.x),
          y: q1.y + (-fq1 / (fp1 - fq1)) * (p1.y - q1.y),
        };
      }

      if (fp1 > length2 && fq1 < length2) {
        cp = {
          x: p1.x + ((fp1 - length2) / (fp1 - fq1)) * (q1.x - p1.x),
          y: p1.y + ((fp1 - length2) / (fp1 - fq1)) * (q1.y - p1.y),
        };
      } else if (fq1 > length2 && fp1 < length2) {
        cq = {
          x: q1.x + ((fq1 - length2) / (fq1 - fp1)) * (p1.x - q1.x),
          y: q1.y + ((fq1 - length2) / (fq1 - fp1)) * (p1.y - q1.y),
        };
      }

      const sp = dot(sub(cp, p2), normalB);
      const sq = dot(sub(cq, p2), normalB);

      if (sp <= distance + LINEAR_SLOP || sq <= distance + LINEAR_SLOP) {
        manifold.points[0].anchorA = mulAdd(cp, 0.5 * (radiusB - radiusA - sp), normalB);
        manifold.points[0].separation = sp - radius;
        manifold.points[0].id = makeId(0, 0);
        manifold.points[1].anchorA = mulAdd(cq, 0.5 * (radiusB - radiusA - sq), normalB);
        manifold.points[1].separation = sq - radius;
        manifold.points[1].id = makeId(1, 0);
        manifold.pointCount = 2;
      }
    }
  }

  if (manifold.pointCount === 0) {
    // Single-point fallback
    let normal: { x: number; y: number };
    const dx2 = closest2.x - closest1.x;
    const dy2 = closest2.y - closest1.y;
    if (dx2 * dx2 + dy2 * dy2 > epsSqr) {
      normal = normalize({ x: dx2, y: dy2 });
    } else {
      normal = leftPerp(u1);
    }

    const c1 = mulAdd(closest1, radiusA, normal);
    const c2 = mulAdd(closest2, -radiusB, normal);

    const i1 = f1 === 0 ? 0 : 1;
    const i2 = f2 === 0 ? 0 : 1;

    manifold.normal = normal;
    manifold.points[0].anchorA = {
      x: c1.x + 0.5 * (c2.x - c1.x),
      y: c1.y + 0.5 * (c2.y - c1.y),
    };
    manifold.points[0].separation = distance - radius;
    manifold.points[0].id = makeId(i1, i2);
    manifold.pointCount = 1;
  }

  // Convert to world space
  manifold.normal = rotateVector(xfA.q, manifold.normal);
  for (let i = 0; i < manifold.pointCount; i++) {
    const mp = manifold.points[i];
    const rotated = rotateVector(xfA.q, {
      x: mp.anchorA.x + origin.x,
      y: mp.anchorA.y + origin.y,
    });
    mp.anchorA = rotated;
    mp.anchorB = {
      x: rotated.x + xfA.p.x - xfB.p.x,
      y: rotated.y + xfA.p.y - xfB.p.y,
    };
    mp.clipPoint = { x: xfA.p.x + rotated.x, y: xfA.p.y + rotated.y };
  }

  return manifold;
}

// ─── b2CollideSegmentAndCapsule ───────────────────────────────────────────────

/**
 * Compute the collision manifold between a segment and a capsule.
 *
 * Mirrors `b2CollideSegmentAndCapsule` in manifold.c:
 * treats segment as zero-radius capsule and delegates to collideCapsules.
 */
export function collideSegmentAndCapsule(
  segmentA: SegmentShape,
  xfA: Transform,
  capsuleB: CapsuleShape,
  xfB: Transform
): Manifold {
  const capsuleA: CapsuleShape = {
    ax: segmentA.ax,
    ay: segmentA.ay,
    bx: segmentA.bx,
    by: segmentA.by,
    radius: 0,
  };
  return collideCapsules(capsuleA, xfA, capsuleB, xfB);
}

// ─── b2CollidePolygonAndCapsule ───────────────────────────────────────────────

/**
 * Compute the collision manifold between a polygon and a capsule.
 *
 * Mirrors `b2CollidePolygonAndCapsule` in manifold.c:
 * converts capsule to a 2-vertex polygon and delegates to collidePolygons.
 */
export function collidePolygonAndCapsule(
  polygonA: PolygonShape,
  xfA: Transform,
  capsuleB: CapsuleShape,
  xfB: Transform
): Manifold {
  const polyB = makeCapsulePoly(
    capsuleB.ax,
    capsuleB.ay,
    capsuleB.bx,
    capsuleB.by,
    capsuleB.radius
  );
  return collidePolygons(polygonA, xfA, polyB, xfB);
}
