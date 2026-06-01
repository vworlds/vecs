// Polygon-pair narrow-phase manifold (VP-13b).
//
// Upstream source: box2d/src/manifold.c
//   - b2ClipPolygons    (static helper)
//   - b2FindMaxSeparation (static helper)
//   - b2CollidePolygons
//
// Engine module boundary: import only from math/, engine/manifold/types.ts,
// and engine/distance.ts.

import { LINEAR_SLOP, SPECULATIVE_DISTANCE } from "../../math/constants.js";
import { dot, sub, mulAdd, crossSV, crossVS } from "../../math/vec2.js";
import { rotateVector } from "../../math/rot.js";
import { invMulTransforms, transformPoint } from "../../math/transform.js";
import type { Transform } from "../../math/transform.js";
import { emptyManifold, makeId, type Manifold } from "./types.js";
import { segmentDistance } from "../distance.js";

// ─── Local polygon shape ──────────────────────────────────────────────────────

/** Internal flat polygon representation for manifold computations. */
interface LocalPoly {
  vertices: Array<{ x: number; y: number }>;
  normals: Array<{ x: number; y: number }>;
  count: number;
  radius: number;
}

// ─── PolygonShape (public input mirror of GeometryUnion PolygonGeometry) ─────

export interface PolygonShape {
  vertices: Float32Array;
  normals: Float32Array;
  count: number;
  radius: number;
  centroidX: number;
  centroidY: number;
}

// ─── b2FindMaxSeparation ─────────────────────────────────────────────────────

// Mirrors b2FindMaxSeparation in manifold.c.
function findMaxSeparation(
  poly1: LocalPoly,
  poly2: LocalPoly
): { edgeIndex: number; maxSeparation: number } {
  let bestIndex = 0;
  let maxSep = -Number.MAX_VALUE;

  for (let i = 0; i < poly1.count; i++) {
    const n = poly1.normals[i];
    const v1 = poly1.vertices[i];
    let si = Number.MAX_VALUE;
    for (let j = 0; j < poly2.count; j++) {
      const sij = dot(n, sub(poly2.vertices[j], v1));
      if (sij < si) {
        si = sij;
      }
    }
    if (si > maxSep) {
      maxSep = si;
      bestIndex = i;
    }
  }

  return { edgeIndex: bestIndex, maxSeparation: maxSep };
}

// ─── b2ClipPolygons ──────────────────────────────────────────────────────────

// Mirrors the static b2ClipPolygons in manifold.c.
function clipPolygons(
  polyA: LocalPoly,
  polyB: LocalPoly,
  edgeA: number,
  edgeB: number,
  flip: boolean
): Manifold {
  const manifold = emptyManifold();

  let poly1: LocalPoly, poly2: LocalPoly;
  let i11: number, i12: number, i21: number, i22: number;

  if (flip) {
    poly1 = polyB;
    poly2 = polyA;
    i11 = edgeB;
    i12 = edgeB + 1 < polyB.count ? edgeB + 1 : 0;
    i21 = edgeA;
    i22 = edgeA + 1 < polyA.count ? edgeA + 1 : 0;
  } else {
    poly1 = polyA;
    poly2 = polyB;
    i11 = edgeA;
    i12 = edgeA + 1 < polyA.count ? edgeA + 1 : 0;
    i21 = edgeB;
    i22 = edgeB + 1 < polyB.count ? edgeB + 1 : 0;
  }

  const normal = poly1.normals[i11];
  const v11 = poly1.vertices[i11];
  const v12 = poly1.vertices[i12];
  const v21 = poly2.vertices[i21];
  const v22 = poly2.vertices[i22];

  // tangent = b2CrossSV(1, normal) = {-normal.y, normal.x}
  const tangent = crossSV(1, normal);

  const lower1 = 0;
  const upper1 = dot(sub(v12, v11), tangent);

  // Incident edge goes opposite to tangent (CCW winding)
  const upper2 = dot(sub(v21, v11), tangent);
  const lower2 = dot(sub(v22, v11), tangent);

  // Disjoint?
  if (upper2 < lower1 || upper1 < lower2) {
    return manifold;
  }

  let vLower: { x: number; y: number };
  if (lower2 < lower1 && upper2 - lower2 > Number.EPSILON) {
    vLower = {
      x: v22.x + ((lower1 - lower2) / (upper2 - lower2)) * (v21.x - v22.x),
      y: v22.y + ((lower1 - lower2) / (upper2 - lower2)) * (v21.y - v22.y),
    };
  } else {
    vLower = { ...v22 };
  }

  let vUpper: { x: number; y: number };
  if (upper2 > upper1 && upper2 - lower2 > Number.EPSILON) {
    vUpper = {
      x: v22.x + ((upper1 - lower2) / (upper2 - lower2)) * (v21.x - v22.x),
      y: v22.y + ((upper1 - lower2) / (upper2 - lower2)) * (v21.y - v22.y),
    };
  } else {
    vUpper = { ...v21 };
  }

  const separationLower = dot(sub(vLower, v11), normal);
  const separationUpper = dot(sub(vUpper, v11), normal);

  const r1 = poly1.radius;
  const r2 = poly2.radius;
  const radius = r1 + r2;

  // Put contact points at midpoint, accounting for radii
  vLower = mulAdd(vLower, 0.5 * (r1 - r2 - separationLower), normal);
  vUpper = mulAdd(vUpper, 0.5 * (r1 - r2 - separationUpper), normal);

  if (!flip) {
    manifold.normal = { ...normal };
    manifold.points[0].anchorA = { ...vLower };
    manifold.points[0].separation = separationLower - radius;
    manifold.points[0].id = makeId(i11, i22);
    manifold.points[1].anchorA = { ...vUpper };
    manifold.points[1].separation = separationUpper - radius;
    manifold.points[1].id = makeId(i12, i21);
    manifold.pointCount = 2;
  } else {
    manifold.normal = { x: -normal.x, y: -normal.y };
    manifold.points[0].anchorA = { ...vUpper };
    manifold.points[0].separation = separationUpper - radius;
    manifold.points[0].id = makeId(i21, i12);
    manifold.points[1].anchorA = { ...vLower };
    manifold.points[1].separation = separationLower - radius;
    manifold.points[1].id = makeId(i22, i11);
    manifold.pointCount = 2;
  }

  return manifold;
}

// ─── b2CollidePolygons ────────────────────────────────────────────────────────

/**
 * Compute the collision manifold between two convex polygons.
 *
 * Mirrors `b2CollidePolygons` in manifold.c. Uses SAT + edge clipping.
 * Calls {@link segmentDistance} for the disjoint case.
 */
export function collidePolygons(
  polygonA: PolygonShape,
  xfA: Transform,
  polygonB: PolygonShape,
  xfB: Transform
): Manifold {
  const linearSlop = LINEAR_SLOP;
  const speculativeDistance = SPECULATIVE_DISTANCE;

  // Shift polyA to origin to reduce round-off
  const origin = {
    x: polygonA.vertices[0],
    y: polygonA.vertices[1],
  };
  const sfA: Transform = {
    q: xfA.q,
    p: {
      x: xfA.p.x + xfA.q.c * origin.x - xfA.q.s * origin.y,
      y: xfA.p.y + xfA.q.s * origin.x + xfA.q.c * origin.y,
    },
  };
  const xf = invMulTransforms(sfA, xfB);

  // Build localPolyA (shifted to origin)
  const localPolyA: LocalPoly = {
    count: polygonA.count,
    radius: polygonA.radius,
    vertices: [],
    normals: [],
  };
  localPolyA.vertices[0] = { x: 0, y: 0 };
  localPolyA.normals[0] = {
    x: polygonA.normals[0],
    y: polygonA.normals[1],
  };
  for (let i = 1; i < localPolyA.count; i++) {
    localPolyA.vertices[i] = {
      x: polygonA.vertices[i * 2] - origin.x,
      y: polygonA.vertices[i * 2 + 1] - origin.y,
    };
    localPolyA.normals[i] = {
      x: polygonA.normals[i * 2],
      y: polygonA.normals[i * 2 + 1],
    };
  }

  // Build localPolyB in polyA's frame
  const localPolyB: LocalPoly = {
    count: polygonB.count,
    radius: polygonB.radius,
    vertices: [],
    normals: [],
  };
  for (let i = 0; i < localPolyB.count; i++) {
    localPolyB.vertices[i] = transformPoint(xf, {
      x: polygonB.vertices[i * 2],
      y: polygonB.vertices[i * 2 + 1],
    });
    localPolyB.normals[i] = {
      x: xf.q.c * polygonB.normals[i * 2] - xf.q.s * polygonB.normals[i * 2 + 1],
      y: xf.q.s * polygonB.normals[i * 2] + xf.q.c * polygonB.normals[i * 2 + 1],
    };
  }

  const { edgeIndex: edgeA, maxSeparation: separationA } = findMaxSeparation(
    localPolyA,
    localPolyB
  );
  const { edgeIndex: edgeB, maxSeparation: separationB } = findMaxSeparation(
    localPolyB,
    localPolyA
  );

  const radius = localPolyA.radius + localPolyB.radius;

  if (separationA > speculativeDistance + radius || separationB > speculativeDistance + radius) {
    return emptyManifold();
  }

  // Find incident edge
  let flip: boolean;
  let edgeAFinal = edgeA;
  let edgeBFinal = edgeB;

  if (separationA >= separationB) {
    flip = false;
    const searchDir = localPolyA.normals[edgeA];
    let minDot = Number.MAX_VALUE;
    for (let i = 0; i < localPolyB.count; i++) {
      const d = dot(searchDir, localPolyB.normals[i]);
      if (d < minDot) {
        minDot = d;
        edgeBFinal = i;
      }
    }
  } else {
    flip = true;
    const searchDir = localPolyB.normals[edgeB];
    let minDot = Number.MAX_VALUE;
    for (let i = 0; i < localPolyA.count; i++) {
      const d = dot(searchDir, localPolyA.normals[i]);
      if (d < minDot) {
        minDot = d;
        edgeAFinal = i;
      }
    }
  }

  let manifold: Manifold;

  if (separationA > 0.1 * linearSlop || separationB > 0.1 * linearSlop) {
    // Polygons are disjoint — find closest points between edges
    const i11 = edgeAFinal;
    const i12 = edgeAFinal + 1 < localPolyA.count ? edgeAFinal + 1 : 0;
    const i21 = edgeBFinal;
    const i22 = edgeBFinal + 1 < localPolyB.count ? edgeBFinal + 1 : 0;

    const v11 = localPolyA.vertices[i11];
    const v12 = localPolyA.vertices[i12];
    const v21 = localPolyB.vertices[i21];
    const v22 = localPolyB.vertices[i22];

    const result = segmentDistance(v11, v12, v21, v22);
    const dist = Math.sqrt(result.distanceSquared);
    const separation = dist - radius;

    if (separation > speculativeDistance) {
      return emptyManifold();
    }

    // Try clipping first
    manifold = clipPolygons(localPolyA, localPolyB, edgeAFinal, edgeBFinal, flip);

    // Check if vertex-vertex contact has substantially larger separation
    let minSep = Number.MAX_VALUE;
    for (let i = 0; i < manifold.pointCount; i++) {
      if (manifold.points[i].separation < minSep) {
        minSep = manifold.points[i].separation;
      }
    }

    if (separation + 0.1 * linearSlop < minSep) {
      // Vertex-vertex wins
      const invDist = 1 / dist;
      let normal: { x: number; y: number };
      let c1: { x: number; y: number };
      let c2: { x: number; y: number };
      let id: number;

      if (result.fraction1 === 0 && result.fraction2 === 0) {
        normal = { x: (v21.x - v11.x) * invDist, y: (v21.y - v11.y) * invDist };
        c1 = mulAdd(v11, localPolyA.radius, normal);
        c2 = mulAdd(v21, -localPolyB.radius, normal);
        id = makeId(i11, i21);
      } else if (result.fraction1 === 0 && result.fraction2 === 1) {
        normal = { x: (v22.x - v11.x) * invDist, y: (v22.y - v11.y) * invDist };
        c1 = mulAdd(v11, localPolyA.radius, normal);
        c2 = mulAdd(v22, -localPolyB.radius, normal);
        id = makeId(i11, i22);
      } else if (result.fraction1 === 1 && result.fraction2 === 0) {
        normal = { x: (v21.x - v12.x) * invDist, y: (v21.y - v12.y) * invDist };
        c1 = mulAdd(v12, localPolyA.radius, normal);
        c2 = mulAdd(v21, -localPolyB.radius, normal);
        id = makeId(i12, i21);
      } else {
        // fraction1 === 1 && fraction2 === 1
        normal = { x: (v22.x - v12.x) * invDist, y: (v22.y - v12.y) * invDist };
        c1 = mulAdd(v12, localPolyA.radius, normal);
        c2 = mulAdd(v22, -localPolyB.radius, normal);
        id = makeId(i12, i22);
      }

      manifold.normal = normal;
      manifold.points[0].anchorA = {
        x: c1.x + 0.5 * (c2.x - c1.x),
        y: c1.y + 0.5 * (c2.y - c1.y),
      };
      manifold.points[0].separation = dist - radius;
      manifold.points[0].id = id;
      manifold.pointCount = 1;
    }
  } else {
    // Polygons overlap — clip edges
    manifold = clipPolygons(localPolyA, localPolyB, edgeAFinal, edgeBFinal, flip);
  }

  // Convert manifold to world space
  if (manifold.pointCount > 0) {
    manifold.normal = rotateVector(xfA.q, manifold.normal);
    for (let i = 0; i < manifold.pointCount; i++) {
      const mp = manifold.points[i];
      // anchor points relative to shape origin in world space
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
  }

  return manifold;
}
// Transitional stub kept alive for surviving engine code; full deletion happens in M7-10.
