// Distance primitives for VP-13b (b2SegmentDistance) and VP-13e (GJK).
//
// Upstream source: box2d/src/distance.c
//   - b2SegmentDistance    (13b, used by b2CollidePolygons)
//   - b2MakeProxy          (13e, used by b2CollideChainSegmentAndPolygon)
//   - b2ShapeDistance      (13e, GJK — used by b2CollideChainSegmentAndPolygon)
//
// Engine module boundary: import only from math/ and engine/manifold/types.ts.

import { MAX_POLYGON_VERTICES } from "./geometry.js";
import {
  IDENTITY as TRANSFORM_IDENTITY,
  invMulTransforms,
  transformPoint,
} from "../math/transform.js";
import type { Transform } from "../math/transform.js";
import { dot, sub, normalize, mulAdd } from "../math/vec2.js";
import { rotateVector } from "../math/rot.js";
import type { SimplexCache } from "./manifold/types.js";

// ─── b2SegmentDistance ────────────────────────────────────────────────────────

/** Result of {@link segmentDistance}. Mirrors `b2SegmentDistanceResult`. */
export interface SegmentDistanceResult {
  closest1: { x: number; y: number };
  closest2: { x: number; y: number };
  fraction1: number;
  fraction2: number;
  distanceSquared: number;
}

/**
 * Compute the distance between two line segments, clamping at the end points.
 *
 * Mirrors `b2SegmentDistance` in distance.c (Ericson 5.1.9).
 */
export function segmentDistance(
  p1: { x: number; y: number },
  q1: { x: number; y: number },
  p2: { x: number; y: number },
  q2: { x: number; y: number }
): SegmentDistanceResult {
  const d1 = sub(q1, p1);
  const d2 = sub(q2, p2);
  const r = sub(p1, p2);
  const dd1 = dot(d1, d1);
  const dd2 = dot(d2, d2);
  const rd1 = dot(r, d1);
  const rd2 = dot(r, d2);

  const epsSqr = Number.EPSILON * Number.EPSILON;

  let f1 = 0;
  let f2 = 0;

  if (dd1 < epsSqr || dd2 < epsSqr) {
    // Degenerate
    if (dd1 >= epsSqr) {
      // Segment 2 degenerate
      f1 = Math.max(0, Math.min(1, -rd1 / dd1));
      f2 = 0;
    } else if (dd2 >= epsSqr) {
      // Segment 1 degenerate
      f1 = 0;
      f2 = Math.max(0, Math.min(1, rd2 / dd2));
    } else {
      f1 = 0;
      f2 = 0;
    }
  } else {
    const d12 = dot(d1, d2);
    const denominator = dd1 * dd2 - d12 * d12;

    f1 = 0;
    if (denominator !== 0) {
      f1 = Math.max(0, Math.min(1, (d12 * rd2 - rd1 * dd2) / denominator));
    }

    f2 = (d12 * f1 + rd2) / dd2;

    if (f2 < 0) {
      f2 = 0;
      f1 = Math.max(0, Math.min(1, -rd1 / dd1));
    } else if (f2 > 1) {
      f2 = 1;
      f1 = Math.max(0, Math.min(1, (d12 - rd1) / dd1));
    }
  }

  const closest1 = mulAdd(p1, f1, d1);
  const closest2 = mulAdd(p2, f2, d2);
  const dx = closest1.x - closest2.x;
  const dy = closest1.y - closest2.y;
  const distanceSquared = dx * dx + dy * dy;

  return { closest1, closest2, fraction1: f1, fraction2: f2, distanceSquared };
}

// ─── b2ShapeProxy ────────────────────────────────────────────────────────────

/** A convex point cloud with a radius. Mirrors `b2ShapeProxy`. */
export interface ShapeProxy {
  points: Array<{ x: number; y: number }>;
  count: number;
  radius: number;
}

/**
 * Build a ShapeProxy from a point array.
 *
 * Mirrors `b2MakeProxy` in distance.c.
 */
export function makeProxy(
  points: ReadonlyArray<{ x: number; y: number }>,
  count: number,
  radius: number
): ShapeProxy {
  const n = Math.min(count, MAX_POLYGON_VERTICES);
  const pts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < n; i++) {
    pts.push({ x: points[i].x, y: points[i].y });
  }
  return { points: pts, count: n, radius };
}

// ─── GJK internals ───────────────────────────────────────────────────────────

interface SimplexVertex {
  wA: { x: number; y: number };
  wB: { x: number; y: number };
  w: { x: number; y: number };
  a: number;
  indexA: number;
  indexB: number;
}

interface Simplex {
  v1: SimplexVertex;
  v2: SimplexVertex;
  v3: SimplexVertex;
  count: number;
}

function makeSimplexVertex(): SimplexVertex {
  return {
    wA: { x: 0, y: 0 },
    wB: { x: 0, y: 0 },
    w: { x: 0, y: 0 },
    a: 0,
    indexA: 0,
    indexB: 0,
  };
}

function findSupport(proxy: ShapeProxy, dx: number, dy: number): number {
  let best = 0;
  let bestVal = proxy.points[0].x * dx + proxy.points[0].y * dy;
  for (let i = 1; i < proxy.count; i++) {
    const v = proxy.points[i].x * dx + proxy.points[i].y * dy;
    if (v > bestVal) {
      bestVal = v;
      best = i;
    }
  }
  return best;
}

function makeSimplexFromCache(
  cache: SimplexCache,
  proxyA: ShapeProxy,
  localProxyB: ShapeProxy
): Simplex {
  const s: Simplex = {
    v1: makeSimplexVertex(),
    v2: makeSimplexVertex(),
    v3: makeSimplexVertex(),
    count: 0,
  };

  const verts: SimplexVertex[] = [s.v1, s.v2, s.v3];

  s.count = cache.count > 3 ? 3 : cache.count;
  for (let i = 0; i < s.count; i++) {
    const v = verts[i];
    v.indexA = cache.indexA[i];
    v.indexB = cache.indexB[i];
    v.wA = { ...proxyA.points[v.indexA] };
    v.wB = { ...localProxyB.points[v.indexB] };
    v.w = sub(v.wA, v.wB);
    v.a = -1; // invalid
  }

  if (s.count === 0) {
    const v = verts[0];
    v.indexA = 0;
    v.indexB = 0;
    v.wA = { ...proxyA.points[0] };
    v.wB = { ...localProxyB.points[0] };
    v.w = sub(v.wA, v.wB);
    v.a = 1;
    s.count = 1;
  }

  return s;
}

function makeSimplexCache(s: Simplex): SimplexCache {
  const verts = [s.v1, s.v2, s.v3];
  const c: SimplexCache = { count: s.count, indexA: [0, 0, 0], indexB: [0, 0, 0] };
  for (let i = 0; i < s.count; i++) {
    c.indexA[i] = verts[i].indexA;
    c.indexB[i] = verts[i].indexB;
  }
  return c;
}

function weight2(
  a1: number,
  w1: { x: number; y: number },
  a2: number,
  w2: { x: number; y: number }
): { x: number; y: number } {
  return { x: a1 * w1.x + a2 * w2.x, y: a1 * w1.y + a2 * w2.y };
}

function weight3(
  a1: number,
  w1: { x: number; y: number },
  a2: number,
  w2: { x: number; y: number },
  a3: number,
  w3: { x: number; y: number }
): { x: number; y: number } {
  return {
    x: a1 * w1.x + a2 * w2.x + a3 * w3.x,
    y: a1 * w1.y + a2 * w2.y + a3 * w3.y,
  };
}

function computeWitnessPoints(s: Simplex): {
  a: { x: number; y: number };
  b: { x: number; y: number };
} {
  switch (s.count) {
    case 1:
      return { a: { ...s.v1.wA }, b: { ...s.v1.wB } };
    case 2:
      return {
        a: weight2(s.v1.a, s.v1.wA, s.v2.a, s.v2.wA),
        b: weight2(s.v1.a, s.v1.wB, s.v2.a, s.v2.wB),
      };
    case 3: {
      const a = weight3(s.v1.a, s.v1.wA, s.v2.a, s.v2.wA, s.v3.a, s.v3.wA);
      return { a, b: { ...a } };
    }
    default:
      return { a: { x: 0, y: 0 }, b: { x: 0, y: 0 } };
  }
}

// Returns the direction towards the origin. Mirrors b2SolveSimplex2.
function solveSimplex2(s: Simplex): { x: number; y: number } {
  const w1 = s.v1.w;
  const w2 = s.v2.w;
  const e12 = sub(w2, w1);

  const d12_2 = -dot(w1, e12);
  if (d12_2 <= 0) {
    s.v1.a = 1;
    s.count = 1;
    return { x: -w1.x, y: -w1.y };
  }

  const d12_1 = dot(w2, e12);
  if (d12_1 <= 0) {
    s.v2.a = 1;
    s.count = 1;
    s.v1 = { ...s.v2 };
    return { x: -w2.x, y: -w2.y };
  }

  const inv_d12 = 1 / (d12_1 + d12_2);
  s.v1.a = d12_1 * inv_d12;
  s.v2.a = d12_2 * inv_d12;
  s.count = 2;
  // b2CrossSV( b2Cross(w1+w2, e12), e12 )
  const sum = { x: w1.x + w2.x, y: w1.y + w2.y };
  const crossVal = sum.x * e12.y - sum.y * e12.x; // b2Cross(sum, e12)
  // b2CrossSV(s, v): {-s*v.y, s*v.x}
  return { x: -crossVal * e12.y, y: crossVal * e12.x };
}

// Mirrors b2SolveSimplex3.
function solveSimplex3(s: Simplex): { x: number; y: number } {
  const w1 = s.v1.w;
  const w2 = s.v2.w;
  const w3 = s.v3.w;

  const e12 = sub(w2, w1);
  const w1e12 = dot(w1, e12);
  const w2e12 = dot(w2, e12);
  const d12_1 = w2e12;
  const d12_2 = -w1e12;

  const e13 = sub(w3, w1);
  const w1e13 = dot(w1, e13);
  const w3e13 = dot(w3, e13);
  const d13_1 = w3e13;
  const d13_2 = -w1e13;

  const e23 = sub(w3, w2);
  const w2e23 = dot(w2, e23);
  const w3e23 = dot(w3, e23);
  const d23_1 = w3e23;
  const d23_2 = -w2e23;

  // n123 = cross(e12, e13)
  const n123 = e12.x * e13.y - e12.y * e13.x;
  const d123_1 = n123 * (w2.x * w3.y - w2.y * w3.x);
  const d123_2 = n123 * (w3.x * w1.y - w3.y * w1.x);
  const d123_3 = n123 * (w1.x * w2.y - w1.y * w2.x);

  if (d12_2 <= 0 && d13_2 <= 0) {
    s.v1.a = 1;
    s.count = 1;
    return { x: -w1.x, y: -w1.y };
  }

  if (d12_1 > 0 && d12_2 > 0 && d123_3 <= 0) {
    const inv = 1 / (d12_1 + d12_2);
    s.v1.a = d12_1 * inv;
    s.v2.a = d12_2 * inv;
    s.count = 2;
    const sum = { x: w1.x + w2.x, y: w1.y + w2.y };
    const c = sum.x * e12.y - sum.y * e12.x;
    return { x: -c * e12.y, y: c * e12.x };
  }

  if (d13_1 > 0 && d13_2 > 0 && d123_2 <= 0) {
    const inv = 1 / (d13_1 + d13_2);
    s.v1.a = d13_1 * inv;
    s.v3.a = d13_2 * inv;
    s.count = 2;
    s.v2 = { ...s.v3 };
    const sum = { x: w1.x + w3.x, y: w1.y + w3.y };
    const c = sum.x * e13.y - sum.y * e13.x;
    return { x: -c * e13.y, y: c * e13.x };
  }

  if (d12_1 <= 0 && d23_2 <= 0) {
    s.v2.a = 1;
    s.count = 1;
    s.v1 = { ...s.v2 };
    return { x: -w2.x, y: -w2.y };
  }

  if (d13_1 <= 0 && d23_1 <= 0) {
    s.v3.a = 1;
    s.count = 1;
    s.v1 = { ...s.v3 };
    return { x: -w3.x, y: -w3.y };
  }

  if (d23_1 > 0 && d23_2 > 0 && d123_1 <= 0) {
    const inv = 1 / (d23_1 + d23_2);
    s.v2.a = d23_1 * inv;
    s.v3.a = d23_2 * inv;
    s.count = 2;
    s.v1 = { ...s.v3 };
    const sum = { x: w2.x + w3.x, y: w2.y + w3.y };
    const c = sum.x * e23.y - sum.y * e23.x;
    return { x: -c * e23.y, y: c * e23.x };
  }

  // Triangle
  const inv = 1 / (d123_1 + d123_2 + d123_3);
  s.v1.a = d123_1 * inv;
  s.v2.a = d123_2 * inv;
  s.v3.a = d123_3 * inv;
  s.count = 3;
  return { x: 0, y: 0 };
}

// ─── DistanceInput / DistanceOutput ──────────────────────────────────────────

/** Input for {@link shapeDistance}. Mirrors `b2DistanceInput`. */
export interface DistanceInput {
  proxyA: ShapeProxy;
  proxyB: ShapeProxy;
  transformA: Transform;
  transformB: Transform;
  useRadii: boolean;
}

/** Output of {@link shapeDistance}. Mirrors `b2DistanceOutput`. */
export interface DistanceOutput {
  pointA: { x: number; y: number };
  pointB: { x: number; y: number };
  normal: { x: number; y: number };
  distance: number;
  iterations: number;
  simplexCount: number;
}

// ─── b2ShapeDistance (GJK) ───────────────────────────────────────────────────

/**
 * Compute the closest points between two convex shapes.
 *
 * Mirrors `b2ShapeDistance` in distance.c. Uses the GJK algorithm.
 *
 * @param input - The distance input (proxies, transforms, useRadii flag).
 * @param cache - Warm-start cache; zero-initialize on the first call, then
 *   reuse across frames for performance. This is updated in place.
 */
export function shapeDistance(input: DistanceInput, cache: SimplexCache): DistanceOutput {
  const output: DistanceOutput = {
    pointA: { x: 0, y: 0 },
    pointB: { x: 0, y: 0 },
    normal: { x: 0, y: 0 },
    distance: 0,
    iterations: 0,
    simplexCount: 0,
  };

  const proxyA = input.proxyA;

  // Build localProxyB in frame A to reduce round-off
  const xf = invMulTransforms(input.transformA, input.transformB);
  const localProxyB: ShapeProxy = {
    count: input.proxyB.count,
    radius: input.proxyB.radius,
    points: input.proxyB.points.map((p) => transformPoint(xf, p)),
  };

  const simplex = makeSimplexFromCache(cache, proxyA, localProxyB);

  const vertices: SimplexVertex[] = [simplex.v1, simplex.v2, simplex.v3];

  const saveA: number[] = [0, 0, 0];
  const saveB: number[] = [0, 0, 0];

  let nonUnitNormal = { x: 0, y: 0 };

  const maxIterations = 20;
  let iteration = 0;

  while (iteration < maxIterations) {
    // Save for duplicate check
    const saveCount = simplex.count;
    for (let i = 0; i < saveCount; i++) {
      saveA[i] = vertices[i].indexA;
      saveB[i] = vertices[i].indexB;
    }

    let d: { x: number; y: number };
    switch (simplex.count) {
      case 1:
        d = { x: -simplex.v1.w.x, y: -simplex.v1.w.y };
        break;
      case 2:
        d = solveSimplex2(simplex);
        break;
      default:
        d = solveSimplex3(simplex);
        break;
    }

    // Origin enclosed in triangle → overlap
    if (simplex.count === 3) {
      const { a, b } = computeWitnessPoints(simplex);
      output.pointA = transformPoint(input.transformA, a);
      output.pointB = transformPoint(input.transformA, b);
      return output;
    }

    // Degenerate direction → overlap
    if (d.x * d.x + d.y * d.y < Number.EPSILON * Number.EPSILON) {
      const { a, b } = computeWitnessPoints(simplex);
      output.pointA = transformPoint(input.transformA, a);
      output.pointB = transformPoint(input.transformA, b);
      return output;
    }

    nonUnitNormal = d;

    // Support point
    const vertex = vertices[simplex.count];
    vertex.indexA = findSupport(proxyA, d.x, d.y);
    vertex.wA = { ...proxyA.points[vertex.indexA] };
    vertex.indexB = findSupport(localProxyB, -d.x, -d.y);
    vertex.wB = { ...localProxyB.points[vertex.indexB] };
    vertex.w = sub(vertex.wA, vertex.wB);

    iteration++;

    // Duplicate check — main termination
    let duplicate = false;
    for (let i = 0; i < saveCount; i++) {
      if (vertex.indexA === saveA[i] && vertex.indexB === saveB[i]) {
        duplicate = true;
        break;
      }
    }
    if (duplicate) {
      break;
    }

    simplex.count++;
  }

  // Prepare output
  const normalVec = normalize(nonUnitNormal);
  const normal = rotateVector(input.transformA.q, normalVec);

  const { a: localA, b: localB } = computeWitnessPoints(simplex);
  const dx = localA.x - localB.x;
  const dy = localA.y - localB.y;
  const dist = Math.sqrt(dx * dx + dy * dy);

  output.normal = normal;
  output.distance = dist;
  output.pointA = transformPoint(input.transformA, localA);
  output.pointB = transformPoint(input.transformA, localB);
  output.iterations = iteration;
  output.simplexCount = 1;

  // Update cache
  const updated = makeSimplexCache(simplex);
  cache.count = updated.count;
  cache.indexA = updated.indexA;
  cache.indexB = updated.indexB;

  // Apply radii if requested
  if (input.useRadii) {
    const rA = input.proxyA.radius;
    const rB = input.proxyB.radius;
    output.distance = Math.max(0, output.distance - rA - rB);
    output.pointA = mulAdd(output.pointA, rA, normal);
    output.pointB = { x: output.pointB.x - rB * normal.x, y: output.pointB.y - rB * normal.y };
  }

  return output;
}

// Re-export for convenience
export { emptySimplexCache } from "./manifold/types.js";
