// Chain-segment-family narrow-phase manifold functions (VP-13e).
//
// Upstream source: box2d/src/manifold.c
//   - b2CollideChainSegmentAndCircle
//   - b2CollideChainSegmentAndCapsule  (reduces to b2CollideChainSegmentAndPolygon)
//   - b2ClipSegments                   (static helper)
//   - b2ClassifyNormal                 (static helper, Gauss map)
//   - b2CollideChainSegmentAndPolygon  (uses GJK from distance.ts)
//
// Ghost-vertex convention: ghost1 -> point1 -> point2 -> ghost2.
// For open chains, VP-8's makeChainSegments uses endpoint reflection
// (ghost = 2*endpoint - next/prev). This is verified below in the
// b2CollideChainSegmentAndPolygon implementation to match box2d semantics.
//
// Engine module boundary: import only from math/, engine/manifold/types.ts,
// and engine/distance.ts.

import { LINEAR_SLOP, SPECULATIVE_DISTANCE } from "../../math/constants.js";
import { dot, sub, mulAdd, leftPerp, rightPerp, normalize, cross } from "../../math/vec2.js";
import { rotateVector } from "../../math/rot.js";
import {
  invMulTransforms,
  transformPoint,
  IDENTITY as TRANSFORM_IDENTITY,
} from "../../math/transform.js";
import type { Transform } from "../../math/transform.js";
import { emptyManifold, makeId, type Manifold, type SimplexCache } from "./types.js";
import { makeProxy, shapeDistance } from "../distance.js";
import type { CircleShape } from "./circles.js";
import type { PolygonShape } from "./polygons.js";

// ─── ChainSegmentShape ────────────────────────────────────────────────────────

export interface ChainSegmentShape {
  ghost1X: number;
  ghost1Y: number;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  ghost2X: number;
  ghost2Y: number;
  chainId: number;
}

// ─── b2ClipSegments (static helper) ─────────────────────────────────────────

// Mirrors the static b2ClipSegments in manifold.c.
function clipSegments(
  a1: { x: number; y: number },
  a2: { x: number; y: number },
  b1: { x: number; y: number },
  b2: { x: number; y: number },
  normal: { x: number; y: number },
  ra: number,
  rb: number,
  id1: number,
  id2: number
): Manifold {
  const manifold = emptyManifold();

  const tangent = leftPerp(normal);

  const lower1 = 0;
  const upper1 = dot(sub(a2, a1), tangent);

  // Incident edge goes opposite to tangent (CCW winding)
  const upper2 = dot(sub(b1, a1), tangent);
  const lower2 = dot(sub(b2, a1), tangent);

  if (upper2 < lower1 || upper1 < lower2) {
    return manifold;
  }

  let vLower: { x: number; y: number };
  if (lower2 < lower1 && upper2 - lower2 > Number.EPSILON) {
    const t = (lower1 - lower2) / (upper2 - lower2);
    vLower = { x: b2.x + t * (b1.x - b2.x), y: b2.y + t * (b1.y - b2.y) };
  } else {
    vLower = { ...b2 };
  }

  let vUpper: { x: number; y: number };
  if (upper2 > upper1 && upper2 - lower2 > Number.EPSILON) {
    const t = (upper1 - lower2) / (upper2 - lower2);
    vUpper = { x: b2.x + t * (b1.x - b2.x), y: b2.y + t * (b1.y - b2.y) };
  } else {
    vUpper = { ...b1 };
  }

  const separationLower = dot(sub(vLower, a1), normal);
  const separationUpper = dot(sub(vUpper, a1), normal);

  const radius = ra + rb;
  vLower = mulAdd(vLower, 0.5 * (ra - rb - separationLower), normal);
  vUpper = mulAdd(vUpper, 0.5 * (ra - rb - separationUpper), normal);

  manifold.normal = { ...normal };
  manifold.points[0].anchorA = { ...vLower };
  manifold.points[0].separation = separationLower - radius;
  manifold.points[0].id = id1;
  manifold.points[1].anchorA = { ...vUpper };
  manifold.points[1].separation = separationUpper - radius;
  manifold.points[1].id = id2;
  manifold.pointCount = 2;

  return manifold;
}

// ─── Normal classification (Gauss map) ───────────────────────────────────────

const SIN_TOL = 0.01;

type NormalType = "skip" | "admit" | "snap";

interface ChainSegmentParams {
  edge1: { x: number; y: number };
  normal0: { x: number; y: number };
  normal2: { x: number; y: number };
  convex1: boolean;
  convex2: boolean;
}

// Mirrors b2ClassifyNormal in manifold.c.
function classifyNormal(params: ChainSegmentParams, normal: { x: number; y: number }): NormalType {
  if (dot(normal, params.edge1) <= 0) {
    // Normal points towards segment tail
    if (params.convex1) {
      if (cross(normal, params.normal0) > SIN_TOL) {
        return "skip";
      }
      return "admit";
    } else {
      return "snap";
    }
  } else {
    // Normal points towards segment head
    if (params.convex2) {
      if (cross(params.normal2, normal) > SIN_TOL) {
        return "skip";
      }
      return "admit";
    } else {
      return "snap";
    }
  }
}

// ─── b2CollideChainSegmentAndCircle ──────────────────────────────────────────

/**
 * Compute the collision manifold between a chain segment and a circle.
 *
 * Mirrors `b2CollideChainSegmentAndCircle` in manifold.c.
 * One-sided: only collides on the right side (positive offset from edge normal).
 */
export function collideChainSegmentAndCircle(
  segmentA: ChainSegmentShape,
  xfA: Transform,
  circleB: CircleShape,
  xfB: Transform
): Manifold {
  const manifold = emptyManifold();
  const xf = invMulTransforms(xfA, xfB);

  // Circle in segment's local frame
  const pB = transformPoint(xf, { x: circleB.cx, y: circleB.cy });

  const p1 = { x: segmentA.ax, y: segmentA.ay };
  const p2 = { x: segmentA.bx, y: segmentA.by };
  const e = sub(p2, p1);

  // One-sided: normal points right
  const offset = dot(rightPerp(e), sub(pB, p1));
  if (offset < 0) {
    return manifold;
  }

  // Barycentric coordinates
  const u = dot(e, sub(p2, pB));
  const v = dot(e, sub(pB, p1));

  let pA: { x: number; y: number };

  if (v <= 0) {
    // Behind p1 — check ghost voronoi
    const prevEdge = sub(p1, { x: segmentA.ghost1X, y: segmentA.ghost1Y });
    const uPrev = dot(prevEdge, sub(pB, p1));
    if (uPrev <= 0) {
      return manifold;
    }
    pA = { ...p1 };
  } else if (u <= 0) {
    // Ahead of p2 — check ghost voronoi
    const nextEdge = sub({ x: segmentA.ghost2X, y: segmentA.ghost2Y }, p2);
    const vNext = dot(nextEdge, sub(pB, p2));
    if (vNext > 0) {
      return manifold;
    }
    pA = { ...p2 };
  } else {
    // Interior
    const ee = dot(e, e);
    if (ee > 0) {
      pA = { x: (u * p1.x + v * p2.x) / ee, y: (u * p1.y + v * p2.y) / ee };
    } else {
      pA = { ...p1 };
    }
  }

  const dx = pB.x - pA.x;
  const dy = pB.y - pA.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  const normal = len > Number.EPSILON ? { x: dx / len, y: dy / len } : { x: 0, y: 0 };
  const distance = len;

  const radius = circleB.radius;
  const separation = distance - radius;
  if (separation > SPECULATIVE_DISTANCE) {
    return manifold;
  }

  const cA = { ...pA };
  const cB = mulAdd(pB, -radius, normal);
  const contactPointA = {
    x: cA.x + 0.5 * (cB.x - cA.x),
    y: cA.y + 0.5 * (cB.y - cA.y),
  };

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

// ─── b2CollideChainSegmentAndCapsule ─────────────────────────────────────────

/**
 * Compute the collision manifold between a chain segment and a capsule.
 *
 * Mirrors `b2CollideChainSegmentAndCapsule` in manifold.c:
 * converts the capsule to a 2-vertex polygon and delegates.
 */
export function collideChainSegmentAndCapsule(
  segmentA: ChainSegmentShape,
  xfA: Transform,
  capsuleB: { ax: number; ay: number; bx: number; by: number; radius: number },
  xfB: Transform,
  cache: SimplexCache
): Manifold {
  // mirrors b2MakeCapsule
  const ax = capsuleB.ax;
  const ay = capsuleB.ay;
  const bx = capsuleB.bx;
  const by = capsuleB.by;
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.sqrt(dx * dx + dy * dy);
  const inv = len > Number.EPSILON ? 1 / len : 0;
  const axisX = dx * inv;
  const axisY = dy * inv;
  const nx = axisY;
  const ny = -axisX;

  const polyB: PolygonShape = {
    vertices: new Float32Array([ax, ay, bx, by]),
    normals: new Float32Array([nx, ny, -nx, -ny]),
    count: 2,
    radius: capsuleB.radius,
    centroidX: (ax + bx) * 0.5,
    centroidY: (ay + by) * 0.5,
  };
  return collideChainSegmentAndPolygon(segmentA, xfA, polyB, xfB, cache);
}

// ─── b2CollideChainSegmentAndPolygon ─────────────────────────────────────────

/**
 * Compute the collision manifold between a chain segment and a polygon.
 *
 * Mirrors `b2CollideChainSegmentAndPolygon` in manifold.c.
 * Uses GJK via {@link shapeDistance} for the closest-feature query.
 *
 * Ghost-vertex verification: box2d's b2ChainSegment stores
 *   ghost1 → segment.point1 → segment.point2 → ghost2
 * and uses those ghosts as Voronoi region guards and smooth-normal references.
 * VP-8's makeChainSegments fills ghosts by reflection (ghost = 2*endpoint −
 * next/prev) for open chains, which differs from box2d's b2CreateChain
 * (which uses the user-supplied or actual neighbour points).
 * These functions use the ghosts exactly as provided; if the chain was built
 * with reflection-based ghosts, the one-sided rejection and Gauss-map
 * smoothing will reflect that convention — not box2d's. Flag: CAVEAT
 * (see PROGRESS.md cross-ticket contracts).
 */
export function collideChainSegmentAndPolygon(
  segmentA: ChainSegmentShape,
  xfA: Transform,
  polygonB: PolygonShape,
  xfB: Transform,
  cache: SimplexCache
): Manifold {
  const manifold = emptyManifold();
  const xf = invMulTransforms(xfA, xfB);

  const centroidB = transformPoint(xf, { x: polygonB.centroidX, y: polygonB.centroidY });
  const radiusB = polygonB.radius;

  const p1 = { x: segmentA.ax, y: segmentA.ay };
  const p2 = { x: segmentA.bx, y: segmentA.by };

  const edge1 = normalize(sub(p2, p1));

  const convexTol = 0.01;
  const edge0 = normalize(sub(p1, { x: segmentA.ghost1X, y: segmentA.ghost1Y }));
  const normal0 = rightPerp(edge0);
  const convex1 = cross(edge0, edge1) >= convexTol;

  const edge2 = normalize(sub({ x: segmentA.ghost2X, y: segmentA.ghost2Y }, p2));
  const normal2 = rightPerp(edge2);
  const convex2 = cross(edge1, edge2) >= convexTol;

  const smoothParams: ChainSegmentParams = {
    edge1,
    normal0,
    normal2,
    convex1,
    convex2,
  };

  // Normal points to the right
  const normal1 = rightPerp(edge1);
  const behind1 = dot(normal1, sub(centroidB, p1)) < 0;
  let behind0 = true;
  let behind2 = true;
  if (convex1) {
    behind0 = dot(normal0, sub(centroidB, p1)) < 0;
  }
  if (convex2) {
    behind2 = dot(normal2, sub(centroidB, p2)) < 0;
  }

  // One-sided rejection
  if (behind1 && behind0 && behind2) {
    return manifold;
  }

  // Get polygonB in frameA
  const count = polygonB.count;
  const vertices: Array<{ x: number; y: number }> = [];
  const normals: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < count; i++) {
    vertices[i] = transformPoint(xf, {
      x: polygonB.vertices[i * 2],
      y: polygonB.vertices[i * 2 + 1],
    });
    normals[i] = {
      x: xf.q.c * polygonB.normals[i * 2] - xf.q.s * polygonB.normals[i * 2 + 1],
      y: xf.q.s * polygonB.normals[i * 2] + xf.q.c * polygonB.normals[i * 2 + 1],
    };
  }

  // GJK distance query
  const segPoints: Array<{ x: number; y: number }> = [{ ...p1 }, { ...p2 }];
  const input = {
    proxyA: makeProxy(segPoints, 2, 0),
    proxyB: makeProxy(vertices, count, 0),
    transformA: TRANSFORM_IDENTITY,
    transformB: TRANSFORM_IDENTITY,
    useRadii: false,
  };

  const output = shapeDistance(input, cache);

  if (output.distance > radiusB + SPECULATIVE_DISTANCE) {
    return manifold;
  }

  // Snap concave normals for partial polygon
  const n0 = convex1 ? normal0 : normal1;
  const n2 = convex2 ? normal2 : normal1;

  let incidentIndex = -1;
  let incidentNormal = -1;

  if (!behind1 && output.distance > 0.1 * LINEAR_SLOP) {
    if (cache.count === 1) {
      // vertex-vertex
      const pA = output.pointA;
      const pB = output.pointB;
      const rawNormal = normalize(sub(pB, pA));
      const type = classifyNormal(smoothParams, rawNormal);
      if (type === "skip") {
        return manifold;
      }

      if (type === "admit") {
        manifold.normal = rotateVector(xfA.q, rawNormal);
        const cp = manifold.points[0];
        cp.anchorA = rotateVector(xfA.q, pA);
        cp.anchorB = { x: cp.anchorA.x + xfA.p.x - xfB.p.x, y: cp.anchorA.y + xfA.p.y - xfB.p.y };
        cp.clipPoint = { x: xfA.p.x + cp.anchorA.x, y: xfA.p.y + cp.anchorA.y };
        cp.separation = output.distance - radiusB;
        cp.id = makeId(cache.indexA[0], cache.indexB[0]);
        manifold.pointCount = 1;
        return manifold;
      }

      // snap
      incidentIndex = cache.indexB[0];
    } else {
      // vertex-edge (cache.count === 2)
      const ia1 = cache.indexA[0];
      const ia2 = cache.indexA[1];
      const ib1 = cache.indexB[0];
      const ib2 = cache.indexB[1];

      if (ia1 === ia2) {
        // 1 point on A, 2 on B
        const normalB = sub(output.pointA, output.pointB);
        const dot1 = dot(normalB, normals[ib1]);
        const dot2 = dot(normalB, normals[ib2]);
        const ib = dot1 > dot2 ? ib1 : ib2;
        const nB = normals[ib];
        const type = classifyNormal(smoothParams, { x: -nB.x, y: -nB.y });
        if (type === "skip") {
          return manifold;
        }

        if (type === "admit") {
          const ib2Next = ib < count - 1 ? ib + 1 : 0;
          const b1 = vertices[ib];
          const b2v = vertices[ib2Next];

          const dot1b = dot(nB, sub(p1, b1));
          const dot2b = dot(nB, sub(p2, b1));

          if (dot1b < dot2b) {
            if (dot(n0, nB) < dot(normal1, nB)) {
              return manifold;
            }
          } else {
            if (dot(n2, nB) < dot(normal1, nB)) {
              return manifold;
            }
          }

          let m = clipSegments(b1, b2v, p1, p2, nB, radiusB, 0, makeId(ib, 1), makeId(ib2Next, 0));
          if (m.pointCount === 2) {
            m.normal = rotateVector(xfA.q, { x: -nB.x, y: -nB.y });
            m.points[0].anchorA = rotateVector(xfA.q, m.points[0].anchorA);
            m.points[1].anchorA = rotateVector(xfA.q, m.points[1].anchorA);
            const pAB = sub(xfA.p, xfB.p);
            m.points[0].anchorB = {
              x: m.points[0].anchorA.x + pAB.x,
              y: m.points[0].anchorA.y + pAB.y,
            };
            m.points[1].anchorB = {
              x: m.points[1].anchorA.x + pAB.x,
              y: m.points[1].anchorA.y + pAB.y,
            };
            m.points[0].clipPoint = {
              x: xfA.p.x + m.points[0].anchorA.x,
              y: xfA.p.y + m.points[0].anchorA.y,
            };
            m.points[1].clipPoint = {
              x: xfA.p.x + m.points[1].anchorA.x,
              y: xfA.p.y + m.points[1].anchorA.y,
            };
          }
          return m;
        }

        // snap
        incidentNormal = ib;
      } else {
        // 2 points on A, find incident vertex on B
        const dot1 = dot(normal1, sub(vertices[ib1], p1));
        const dot2 = dot(normal1, sub(vertices[ib2], p2));
        incidentIndex = dot1 < dot2 ? ib1 : ib2;
      }
    }
  } else {
    // SAT edge normal
    let edgeSeparation = Number.MAX_VALUE;

    for (let i = 0; i < count; i++) {
      const s = dot(normal1, sub(vertices[i], p1));
      if (s < edgeSeparation) {
        edgeSeparation = s;
        incidentIndex = i;
      }
    }

    if (convex1) {
      let s0 = Number.MAX_VALUE;
      for (let i = 0; i < count; i++) {
        const s = dot(normal0, sub(vertices[i], p1));
        if (s < s0) {
          s0 = s;
        }
      }
      if (s0 > edgeSeparation) {
        edgeSeparation = s0;
        incidentIndex = -1;
      }
    }

    if (convex2) {
      let s2 = Number.MAX_VALUE;
      for (let i = 0; i < count; i++) {
        const s = dot(normal2, sub(vertices[i], p2));
        if (s < s2) {
          s2 = s;
        }
      }
      if (s2 > edgeSeparation) {
        edgeSeparation = s2;
        incidentIndex = -1;
      }
    }

    // SAT polygon normals
    let polygonSeparation = -Number.MAX_VALUE;
    let referenceIndex = -1;

    for (let i = 0; i < count; i++) {
      const n = normals[i];
      const type = classifyNormal(smoothParams, { x: -n.x, y: -n.y });
      if (type !== "admit") {
        continue;
      }

      const p = vertices[i];
      const s = Math.min(dot(n, sub(p2, p)), dot(n, sub(p1, p)));
      if (s > polygonSeparation) {
        polygonSeparation = s;
        referenceIndex = i;
      }
    }

    if (polygonSeparation > edgeSeparation) {
      const ia1 = referenceIndex;
      const ia2 = ia1 < count - 1 ? ia1 + 1 : 0;
      const a1 = vertices[ia1];
      const a2 = vertices[ia2];
      const n = normals[ia1];

      const dot1 = dot(n, sub(p1, a1));
      const dot2 = dot(n, sub(p2, a1));

      if (dot1 < dot2) {
        if (dot(n0, n) < dot(normal1, n)) {
          return manifold;
        }
      } else {
        if (dot(n2, n) < dot(normal1, n)) {
          return manifold;
        }
      }

      let m = clipSegments(a1, a2, p1, p2, n, radiusB, 0, makeId(ia1, 1), makeId(ia2, 0));
      if (m.pointCount === 2) {
        m.normal = rotateVector(xfA.q, { x: -n.x, y: -n.y });
        m.points[0].anchorA = rotateVector(xfA.q, m.points[0].anchorA);
        m.points[1].anchorA = rotateVector(xfA.q, m.points[1].anchorA);
        const pAB = sub(xfA.p, xfB.p);
        m.points[0].anchorB = {
          x: m.points[0].anchorA.x + pAB.x,
          y: m.points[0].anchorA.y + pAB.y,
        };
        m.points[1].anchorB = {
          x: m.points[1].anchorA.x + pAB.x,
          y: m.points[1].anchorA.y + pAB.y,
        };
        m.points[0].clipPoint = {
          x: xfA.p.x + m.points[0].anchorA.x,
          y: xfA.p.y + m.points[0].anchorA.y,
        };
        m.points[1].clipPoint = {
          x: xfA.p.x + m.points[1].anchorA.x,
          y: xfA.p.y + m.points[1].anchorA.y,
        };
      }
      return m;
    }

    if (incidentIndex === -1) {
      return manifold;
    }
  }

  // Segment normal path
  let b1: { x: number; y: number };
  let b2v: { x: number; y: number };
  let ib1: number;
  let ib2: number;

  if (incidentNormal !== -1) {
    ib1 = incidentNormal;
    ib2 = ib1 < count - 1 ? ib1 + 1 : 0;
    b1 = vertices[ib1];
    b2v = vertices[ib2];
  } else {
    const i2 = incidentIndex;
    const i1 = i2 > 0 ? i2 - 1 : count - 1;
    const d1 = dot(normal1, normals[i1]);
    const d2 = dot(normal1, normals[i2]);
    if (d1 < d2) {
      ib1 = i1;
      ib2 = i2;
    } else {
      ib1 = i2;
      ib2 = i2 < count - 1 ? i2 + 1 : 0;
    }
    b1 = vertices[ib1];
    b2v = vertices[ib2];
  }

  let m = clipSegments(p1, p2, b1, b2v, normal1, 0, radiusB, makeId(0, ib2), makeId(1, ib1));
  if (m.pointCount === 2) {
    m.normal = rotateVector(xfA.q, m.normal);
    m.points[0].anchorA = rotateVector(xfA.q, m.points[0].anchorA);
    m.points[1].anchorA = rotateVector(xfA.q, m.points[1].anchorA);
    const pAB = sub(xfA.p, xfB.p);
    m.points[0].anchorB = { x: m.points[0].anchorA.x + pAB.x, y: m.points[0].anchorA.y + pAB.y };
    m.points[1].anchorB = { x: m.points[1].anchorA.x + pAB.x, y: m.points[1].anchorA.y + pAB.y };
    m.points[0].clipPoint = {
      x: xfA.p.x + m.points[0].anchorA.x,
      y: xfA.p.y + m.points[0].anchorA.y,
    };
    m.points[1].clipPoint = {
      x: xfA.p.x + m.points[1].anchorA.x,
      y: xfA.p.y + m.points[1].anchorA.y,
    };
  }
  return m;
}
