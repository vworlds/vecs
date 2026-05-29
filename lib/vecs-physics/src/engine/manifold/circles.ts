// Circles-family narrow-phase manifold functions (VP-13a).
//
// Upstream source: box2d/src/manifold.c
//   - b2CollideCircles
//   - b2CollideCapsuleAndCircle
//   - b2CollidePolygonAndCircle
//
// Engine module boundary: import only from math/ and engine/manifold/.

import { SPECULATIVE_DISTANCE } from "../../math/constants.js";
import { dot, lerp, mulAdd, mulSub, normalize, sub } from "../../math/vec2.js";
import { rotateVector } from "../../math/rot.js";
import { invMulTransforms, transformPoint } from "../../math/transform.js";
import type { Transform } from "../../math/transform.js";
import { emptyManifold, type Manifold } from "./types.js";

// ─── geometry shapes (local mirror of box2d structs) ─────────────────────────

export interface CircleShape {
  cx: number;
  cy: number;
  radius: number;
}

export interface CapsuleShape {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  radius: number;
}

// PolygonShape is used by b2CollidePolygonAndCircle.
// vertices[i*2], vertices[i*2+1] = x,y of vertex i
// normals[i*2], normals[i*2+1] = nx,ny of normal i
export interface PolygonShape {
  vertices: Float32Array;
  normals: Float32Array;
  count: number;
  radius: number;
  centroidX: number;
  centroidY: number;
}

// ─── getLengthAndNormalize ────────────────────────────────────────────────────

// Mirrors b2GetLengthAndNormalize: returns { normal, distance }.
// If the vector is degenerate, returns {0,0} normal and 0 distance.
function getLengthAndNormalize(dx: number, dy: number): { nx: number; ny: number; len: number } {
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < Number.EPSILON) {
    return { nx: 0, ny: 0, len: 0 };
  }
  return { nx: dx / len, ny: dy / len, len };
}

// ─── b2CollideCircles ────────────────────────────────────────────────────────

/**
 * Compute the collision manifold between two circles.
 *
 * Mirrors `b2CollideCircles` in manifold.c.
 */
export function collideCircles(
  circleA: CircleShape,
  xfA: Transform,
  circleB: CircleShape,
  xfB: Transform
): Manifold {
  const manifold = emptyManifold();

  // xf = xfA^-1 * xfB  (circleB center in frame of circleA)
  const xf = invMulTransforms(xfA, xfB);

  // pointA is the center of circleA in its local frame
  const pointA = { x: circleA.cx, y: circleA.cy };
  // pointB is circleB's center transformed into circleA's frame
  const pointB = transformPoint(xf, { x: circleB.cx, y: circleB.cy });

  const { nx, ny, len } = getLengthAndNormalize(pointB.x - pointA.x, pointB.y - pointA.y);
  const normal = { x: nx, y: ny };

  const radiusA = circleA.radius;
  const radiusB = circleB.radius;
  const separation = len - radiusA - radiusB;

  if (separation > SPECULATIVE_DISTANCE) {
    return manifold;
  }

  const cA = mulAdd(pointA, radiusA, normal);
  const cB = mulAdd(pointB, -radiusB, normal);
  const contactPointA = lerp(cA, cB, 0.5);

  manifold.normal = rotateVector(xfA.q, normal);
  const mp = manifold.points[0];
  mp.anchorA = rotateVector(xfA.q, contactPointA);
  mp.anchorB = {
    x: mp.anchorA.x + xfA.p.x - xfB.p.x,
    y: mp.anchorA.y + xfA.p.y - xfB.p.y,
  };
  mp.clipPoint = { x: mp.anchorA.x + xfA.p.x, y: mp.anchorA.y + xfA.p.y };
  mp.separation = separation;
  mp.id = 0;
  manifold.pointCount = 1;
  return manifold;
}

// ─── b2CollideCapsuleAndCircle ───────────────────────────────────────────────

/**
 * Compute the collision manifold between a capsule and a circle.
 *
 * Mirrors `b2CollideCapsuleAndCircle` in manifold.c.
 */
export function collideCapsuleAndCircle(
  capsuleA: CapsuleShape,
  xfA: Transform,
  circleB: CircleShape,
  xfB: Transform
): Manifold {
  const manifold = emptyManifold();

  const xf = invMulTransforms(xfA, xfB);

  // circle center in capsule's local frame
  const pB = transformPoint(xf, { x: circleB.cx, y: circleB.cy });

  const p1 = { x: capsuleA.ax, y: capsuleA.ay };
  const p2 = { x: capsuleA.bx, y: capsuleA.by };
  const e = sub(p2, p1);

  // Closest point on segment to pB
  const s1 = dot(sub(pB, p1), e);
  const s2 = dot(sub(p2, pB), e);

  let pA: { x: number; y: number };
  if (s1 < 0) {
    pA = p1;
  } else if (s2 < 0) {
    pA = p2;
  } else {
    const s = s1 / dot(e, e);
    pA = mulAdd(p1, s, e);
  }

  const { nx, ny, len } = getLengthAndNormalize(pB.x - pA.x, pB.y - pA.y);
  const normal = { x: nx, y: ny };

  const radiusA = capsuleA.radius;
  const radiusB = circleB.radius;
  const separation = len - radiusA - radiusB;

  if (separation > SPECULATIVE_DISTANCE) {
    return manifold;
  }

  const cA = mulAdd(pA, radiusA, normal);
  const cB = mulAdd(pB, -radiusB, normal);
  const contactPointA = lerp(cA, cB, 0.5);

  manifold.normal = rotateVector(xfA.q, normal);
  const mp = manifold.points[0];
  mp.anchorA = rotateVector(xfA.q, contactPointA);
  mp.anchorB = {
    x: mp.anchorA.x + xfA.p.x - xfB.p.x,
    y: mp.anchorA.y + xfA.p.y - xfB.p.y,
  };
  mp.clipPoint = { x: xfA.p.x + mp.anchorA.x, y: xfA.p.y + mp.anchorA.y };
  mp.separation = separation;
  mp.id = 0;
  manifold.pointCount = 1;
  return manifold;
}

// ─── b2CollidePolygonAndCircle ───────────────────────────────────────────────

/**
 * Compute the collision manifold between a polygon and a circle.
 *
 * Mirrors `b2CollidePolygonAndCircle` in manifold.c.
 */
export function collidePolygonAndCircle(
  polygonA: PolygonShape,
  xfA: Transform,
  circleB: CircleShape,
  xfB: Transform
): Manifold {
  const manifold = emptyManifold();
  const speculativeDistance = SPECULATIVE_DISTANCE;

  const xf = invMulTransforms(xfA, xfB);

  // Circle in polygon's local frame
  const center = transformPoint(xf, { x: circleB.cx, y: circleB.cy });
  const radiusA = polygonA.radius;
  const radiusB = circleB.radius;
  const radius = radiusA + radiusB;

  // Find the min-separating edge
  const vertexCount = polygonA.count;
  let normalIndex = 0;
  let separation = -Number.MAX_VALUE;

  for (let i = 0; i < vertexCount; i++) {
    const nx = polygonA.normals[i * 2];
    const ny = polygonA.normals[i * 2 + 1];
    const vx = polygonA.vertices[i * 2];
    const vy = polygonA.vertices[i * 2 + 1];
    const s = nx * (center.x - vx) + ny * (center.y - vy);
    if (s > separation) {
      separation = s;
      normalIndex = i;
    }
  }

  if (separation > radius + speculativeDistance) {
    return manifold;
  }

  // Vertices of the reference edge
  const vertIndex1 = normalIndex;
  const vertIndex2 = vertIndex1 + 1 < vertexCount ? vertIndex1 + 1 : 0;
  const v1 = {
    x: polygonA.vertices[vertIndex1 * 2],
    y: polygonA.vertices[vertIndex1 * 2 + 1],
  };
  const v2 = {
    x: polygonA.vertices[vertIndex2 * 2],
    y: polygonA.vertices[vertIndex2 * 2 + 1],
  };

  // Barycentric coordinates
  const u1 = dot(sub(center, v1), sub(v2, v1));
  const u2 = dot(sub(center, v2), sub(v1, v2));

  if (u1 < 0 && separation > Number.EPSILON) {
    // Closest to v1
    const nv = normalize(sub(center, v1));
    const sep = dot(sub(center, v1), nv);
    if (sep > radius + speculativeDistance) {
      return manifold;
    }
    const cA = mulAdd(v1, radiusA, nv);
    const cB = mulSub(center, radiusB, nv);
    const contactPointA = lerp(cA, cB, 0.5);
    manifold.normal = rotateVector(xfA.q, nv);
    const mp = manifold.points[0];
    mp.anchorA = rotateVector(xfA.q, contactPointA);
    mp.anchorB = {
      x: mp.anchorA.x + xfA.p.x - xfB.p.x,
      y: mp.anchorA.y + xfA.p.y - xfB.p.y,
    };
    mp.clipPoint = { x: xfA.p.x + mp.anchorA.x, y: xfA.p.y + mp.anchorA.y };
    mp.separation = dot(sub(cB, cA), nv);
    mp.id = 0;
    manifold.pointCount = 1;
  } else if (u2 < 0 && separation > Number.EPSILON) {
    // Closest to v2
    const nv = normalize(sub(center, v2));
    const sep = dot(sub(center, v2), nv);
    if (sep > radius + speculativeDistance) {
      return manifold;
    }
    const cA = mulAdd(v2, radiusA, nv);
    const cB = mulSub(center, radiusB, nv);
    const contactPointA = lerp(cA, cB, 0.5);
    manifold.normal = rotateVector(xfA.q, nv);
    const mp = manifold.points[0];
    mp.anchorA = rotateVector(xfA.q, contactPointA);
    mp.anchorB = {
      x: mp.anchorA.x + xfA.p.x - xfB.p.x,
      y: mp.anchorA.y + xfA.p.y - xfB.p.y,
    };
    mp.clipPoint = { x: xfA.p.x + mp.anchorA.x, y: xfA.p.y + mp.anchorA.y };
    mp.separation = dot(sub(cB, cA), nv);
    mp.id = 0;
    manifold.pointCount = 1;
  } else {
    // Closest to edge interior
    const nx = polygonA.normals[normalIndex * 2];
    const ny = polygonA.normals[normalIndex * 2 + 1];
    const normal = { x: nx, y: ny };
    manifold.normal = rotateVector(xfA.q, normal);

    // cA: projection of circle center onto reference edge
    const cA = mulAdd(center, radiusA - dot(sub(center, v1), normal), normal);
    // cB: deepest point on circle wrt the reference edge
    const cB = mulSub(center, radiusB, normal);
    const contactPointA = lerp(cA, cB, 0.5);

    const mp = manifold.points[0];
    mp.anchorA = rotateVector(xfA.q, contactPointA);
    mp.anchorB = {
      x: mp.anchorA.x + xfA.p.x - xfB.p.x,
      y: mp.anchorA.y + xfA.p.y - xfB.p.y,
    };
    mp.clipPoint = { x: xfA.p.x + mp.anchorA.x, y: xfA.p.y + mp.anchorA.y };
    mp.separation = separation - radius;
    mp.id = 0;
    manifold.pointCount = 1;
  }

  return manifold;
}
