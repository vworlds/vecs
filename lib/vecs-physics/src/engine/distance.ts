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

// ─── b2TimeOfImpact types + implementation ────────────────────────────────────
//
// Ported from distance.c:935-1426 (b2MakeSeparationFunction, b2FindMinSeparation,
// b2EvaluateSeparation, b2TimeOfImpact) and distance.c:14-30 (b2GetSweepTransform).
// Also b2MakeSweep from body.h:235-244.
//
// These are the CCD (continuous collision detection) primitives used by
// solveContinuous (engine/ccd.ts → solver.c:379-541).
//
// IMPORTANT: This is delicate numerical code. Port verbatim from box2d. Do not
// "simplify" or restructure unless you are fixing a real bug.

import { nlerp } from "../math/rot.js";
import type { Rot } from "../math/rot.js";

/** Mirrors `b2Sweep` (collision.h:441-448). Records the motion of a body
 * across a time step for the conservative-advancement (TOI) algorithm.
 * `localCenter` is the body's CoM in body-local space; `c1`/`c2` are the
 * world-space CoM at the start and end of the sweep; `q1`/`q2` are the
 * start/end rotations. */
export interface Sweep {
  /** Local centre of mass in body-local space. Mirrors `b2Sweep.localCenter`. */
  localCenter: { x: number; y: number };
  /** Starting world-space centre of mass. Mirrors `b2Sweep.c1`. */
  c1: { x: number; y: number };
  /** Ending world-space centre of mass. Mirrors `b2Sweep.c2`. */
  c2: { x: number; y: number };
  /** Starting world rotation. Mirrors `b2Sweep.q1`. */
  q1: Rot;
  /** Ending world rotation. Mirrors `b2Sweep.q2`. */
  q2: Rot;
}

/** Input to {@link timeOfImpact}. Mirrors `b2TOIInput` (collision.h:454-461). */
export interface TOIInput {
  /** Proxy for the static / slow shape (shape A). */
  proxyA: ShapeProxy;
  /** Proxy for the fast / swept shape (shape B). */
  proxyB: ShapeProxy;
  /** Sweep for shape A. */
  sweepA: Sweep;
  /** Sweep for shape B. */
  sweepB: Sweep;
  /** Maximum fraction of the sweep to evaluate ([0, maxFraction]). */
  maxFraction: number;
}

/** TOI outcome state. Mirrors `b2TOIState` (collision.h:464-471). */
export const enum TOIState {
  Unknown = 0,
  Failed = 1,
  Overlapped = 2,
  Hit = 3,
  Separated = 4,
}

/** Output of {@link timeOfImpact}. Mirrors `b2TOIOutput` (collision.h:474-487). */
export interface TOIOutput {
  /** Outcome of the TOI search. */
  state: TOIState;
  /** Hit point in world space (valid only when state === Hit). */
  point: { x: number; y: number };
  /** Hit normal in world space (valid only when state === Hit). */
  normal: { x: number; y: number };
  /** Sweep fraction at the first touch ([0, maxFraction]). */
  fraction: number;
}

// ─── b2GetSweepTransform ─────────────────────────────────────────────────────

/** Evaluate the transform sweep at time `t` ∈ [0, 1]. Lerps positions,
 * nlreps rotations, then shifts the origin to the local-center CoM.
 *
 * Mirrors `b2GetSweepTransform` (distance.c:14-30).
 * Reference: https://fgiesen.wordpress.com/2012/08/15/linear-interpolation-past-present-and-future/
 */
export function getSweepTransform(
  sweep: Sweep,
  t: number
): import("../math/transform.js").Transform {
  const omt = 1 - t;
  const px = omt * sweep.c1.x + t * sweep.c2.x;
  const py = omt * sweep.c1.y + t * sweep.c2.y;
  // b2NLerp: linear interp of (c,s), then normalize (distance.c:21-26)
  const q = nlerp(sweep.q1, sweep.q2, t);
  // Shift to origin: p = p - rotateVector(q, localCenter) (distance.c:28)
  const lcx = sweep.localCenter.x;
  const lcy = sweep.localCenter.y;
  // rotateVector(q, localCenter):
  const rx = q.c * lcx - q.s * lcy;
  const ry = q.s * lcx + q.c * lcy;
  return { p: { x: px - rx, y: py - ry }, q };
}

// ─── b2MakeSweep ─────────────────────────────────────────────────────────────

/** Build a {@link Sweep} from a {@link BodySim}-shaped object. Only the
 * fields `center0X/Y`, `centerX/Y`, `rotation0Cos/Sin`, `cos/sin`, and
 * `localCenterX/Y` are read — this avoids importing `BodySim` (engine
 * cross-dep allowed since ccd.ts is in the same module layer).
 *
 * Mirrors `b2MakeSweep` (body.h:235-244):
 *   s.c1 = bodySim->center0; s.c2 = bodySim->center;
 *   s.q1 = bodySim->rotation0; s.q2 = bodySim->transform.q;
 *   s.localCenter = bodySim->localCenter;
 */
export function makeSweep(sim: {
  center0X: number;
  center0Y: number;
  centerX: number;
  centerY: number;
  rotation0Cos: number;
  rotation0Sin: number;
  cos: number;
  sin: number;
  localCenterX: number;
  localCenterY: number;
}): Sweep {
  return {
    c1: { x: sim.center0X, y: sim.center0Y },
    c2: { x: sim.centerX, y: sim.centerY },
    q1: { c: sim.rotation0Cos, s: sim.rotation0Sin },
    q2: { c: sim.cos, s: sim.sin },
    localCenter: { x: sim.localCenterX, y: sim.localCenterY },
  };
}

// ─── Separation function internals ────────────────────────────────────────────
//
// Mirrors b2SeparationType / b2SeparationFunction / b2MakeSeparationFunction /
// b2FindMinSeparation / b2EvaluateSeparation (distance.c:927-1136).

const enum SeparationType {
  Points = 0, // b2_pointsType
  FaceA = 1, // b2_faceAType
  FaceB = 2, // b2_faceBType
}

interface SeparationFunction {
  proxyA: ShapeProxy;
  proxyB: ShapeProxy;
  sweepA: Sweep;
  sweepB: Sweep;
  localPoint: { x: number; y: number };
  axis: { x: number; y: number };
  type: SeparationType;
}

/** Mirrors `b2MakeSeparationFunction` (distance.c:945-1019).
 * Builds a separation function from the GJK cache and the two sweeps at t1. */
function _makeSeparationFunction(
  cache: SimplexCache,
  proxyA: ShapeProxy,
  sweepA: Sweep,
  proxyB: ShapeProxy,
  sweepB: Sweep,
  t1: number
): SeparationFunction {
  const f: SeparationFunction = {
    proxyA,
    proxyB,
    sweepA,
    sweepB,
    localPoint: { x: 0, y: 0 },
    axis: { x: 0, y: 0 },
    type: SeparationType.Points,
  };

  const count = cache.count;
  // B2_ASSERT(0 < count && count < 3) (distance.c:953)

  const xfA = getSweepTransform(sweepA, t1);
  const xfB = getSweepTransform(sweepB, t1);

  if (count === 1) {
    // distance.c:961-970: b2_pointsType
    f.type = SeparationType.Points;
    const localPointA = proxyA.points[cache.indexA[0]!]!;
    const localPointB = proxyB.points[cache.indexB[0]!]!;
    const pointA = _transformPoint(xfA, localPointA);
    const pointB = _transformPoint(xfB, localPointB);
    // axis = normalize(pointB - pointA)
    const dx = pointB.x - pointA.x;
    const dy = pointB.y - pointA.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > 0) {
      f.axis = { x: dx / len, y: dy / len };
    }
    f.localPoint = { x: 0, y: 0 };
    return f;
  }

  if (cache.indexA[0] === cache.indexA[1]) {
    // distance.c:972-995: b2_faceBType (two points on B, one on A)
    f.type = SeparationType.FaceB;
    const localPointB1 = proxyB.points[cache.indexB[0]!]!;
    const localPointB2 = proxyB.points[cache.indexB[1]!]!;
    // axis = b2CrossVS(localPointB2 - localPointB1, 1.0f) = rightPerp
    const ex = localPointB2.x - localPointB1.x;
    const ey = localPointB2.y - localPointB1.y;
    // b2CrossVS(v, 1) = { v.y, -v.x } ... wait, b2CrossVS(v, s) = { s*v.y, -s*v.x }
    // distance.c:980: f.axis = b2CrossVS(b2Sub(localPointB2, localPointB1), 1.0f)
    // b2CrossVS({ex,ey}, 1.0) = {1.0*ey, -1.0*ex} = {ey, -ex}
    let ax = ey;
    let ay = -ex;
    const alen = Math.sqrt(ax * ax + ay * ay);
    if (alen > 0) {
      ax /= alen;
      ay /= alen;
    }
    // normal = rotate(xfB.q, axis)
    const nx = xfB.q.c * ax - xfB.q.s * ay;
    const ny = xfB.q.s * ax + xfB.q.c * ay;
    f.localPoint = {
      x: 0.5 * (localPointB1.x + localPointB2.x),
      y: 0.5 * (localPointB1.y + localPointB2.y),
    };
    const pointB = _transformPoint(xfB, f.localPoint);
    const localPointA = proxyA.points[cache.indexA[0]!]!;
    const pointA = _transformPoint(xfA, localPointA);
    // s = dot(pointA - pointB, normal); if s < 0 flip axis
    const s = (pointA.x - pointB.x) * nx + (pointA.y - pointB.y) * ny;
    if (s < 0) {
      ax = -ax;
      ay = -ay;
    }
    f.axis = { x: ax, y: ay };
    return f;
  }

  // distance.c:997-1019: b2_faceAType (two points on A, one or two on B)
  f.type = SeparationType.FaceA;
  const localPointA1 = proxyA.points[cache.indexA[0]!]!;
  const localPointA2 = proxyA.points[cache.indexA[1]!]!;
  // axis = b2CrossVS(localPointA2 - localPointA1, 1.0f)
  const ex = localPointA2.x - localPointA1.x;
  const ey = localPointA2.y - localPointA1.y;
  let ax = ey;
  let ay = -ex;
  const alen = Math.sqrt(ax * ax + ay * ay);
  if (alen > 0) {
    ax /= alen;
    ay /= alen;
  }
  // normal = rotate(xfA.q, axis)
  const nx = xfA.q.c * ax - xfA.q.s * ay;
  const ny = xfA.q.s * ax + xfA.q.c * ay;
  f.localPoint = {
    x: 0.5 * (localPointA1.x + localPointA2.x),
    y: 0.5 * (localPointA1.y + localPointA2.y),
  };
  const pointA = _transformPoint(xfA, f.localPoint);
  const localPointB = proxyB.points[cache.indexB[0]!]!;
  const pointB = _transformPoint(xfB, localPointB);
  const s = (pointB.x - pointA.x) * nx + (pointB.y - pointA.y) * ny;
  if (s < 0) {
    ax = -ax;
    ay = -ay;
  }
  f.axis = { x: ax, y: ay };
  return f;
}

/** Helper: transform a local point by a Transform. */
function _transformPoint(
  xf: { p: { x: number; y: number }; q: { c: number; s: number } },
  p: { x: number; y: number }
): { x: number; y: number } {
  return {
    x: xf.p.x + xf.q.c * p.x - xf.q.s * p.y,
    y: xf.p.y + xf.q.s * p.x + xf.q.c * p.y,
  };
}

/** Helper: invRotateVector (transpose-rotate). Mirrors `b2InvRotateVector`. */
function _invRotateVector(
  q: { c: number; s: number },
  v: { x: number; y: number }
): { x: number; y: number } {
  return { x: q.c * v.x + q.s * v.y, y: -q.s * v.x + q.c * v.y };
}

/** Find the support point index of `proxy` along `dir`. Mirrors `b2FindSupport` (distance.c:148). */
function _findSupport(proxy: ShapeProxy, dir: { x: number; y: number }): number {
  let best = 0;
  let bestVal = proxy.points[0]!.x * dir.x + proxy.points[0]!.y * dir.y;
  for (let i = 1; i < proxy.count; i++) {
    const v = proxy.points[i]!.x * dir.x + proxy.points[i]!.y * dir.y;
    if (v > bestVal) {
      bestVal = v;
      best = i;
    }
  }
  return best;
}

/** Find the minimum separation (most-penetrating witness pair) at time `t`.
 * Returns the separation distance and writes `indexA`/`indexB` out-params.
 *
 * Mirrors `b2FindMinSeparation` (distance.c:1021-1086). */
function _findMinSeparation(
  f: SeparationFunction,
  t: number
): { separation: number; indexA: number; indexB: number } {
  const xfA = getSweepTransform(f.sweepA, t);
  const xfB = getSweepTransform(f.sweepB, t);
  let indexA = -1;
  let indexB = -1;
  let separation = 0;

  switch (f.type) {
    case SeparationType.Points: {
      // distance.c:1028-1043
      const axisA = _invRotateVector(xfA.q, f.axis);
      const axisB = _invRotateVector(xfB.q, { x: -f.axis.x, y: -f.axis.y });
      indexA = _findSupport(f.proxyA, axisA);
      indexB = _findSupport(f.proxyB, axisB);
      const localPointA = f.proxyA.points[indexA]!;
      const localPointB = f.proxyB.points[indexB]!;
      const pointA = _transformPoint(xfA, localPointA);
      const pointB = _transformPoint(xfB, localPointB);
      separation = (pointB.x - pointA.x) * f.axis.x + (pointB.y - pointA.y) * f.axis.y;
      break;
    }
    case SeparationType.FaceA: {
      // distance.c:1046-1060
      const normal = {
        x: xfA.q.c * f.axis.x - xfA.q.s * f.axis.y,
        y: xfA.q.s * f.axis.x + xfA.q.c * f.axis.y,
      };
      const pointA = _transformPoint(xfA, f.localPoint);
      const axisB = _invRotateVector(xfB.q, { x: -normal.x, y: -normal.y });
      indexA = -1;
      indexB = _findSupport(f.proxyB, axisB);
      const localPointB = f.proxyB.points[indexB]!;
      const pointB = _transformPoint(xfB, localPointB);
      separation = (pointB.x - pointA.x) * normal.x + (pointB.y - pointA.y) * normal.y;
      break;
    }
    case SeparationType.FaceB: {
      // distance.c:1063-1078
      const normal = {
        x: xfB.q.c * f.axis.x - xfB.q.s * f.axis.y,
        y: xfB.q.s * f.axis.x + xfB.q.c * f.axis.y,
      };
      const pointB = _transformPoint(xfB, f.localPoint);
      const axisA = _invRotateVector(xfA.q, { x: -normal.x, y: -normal.y });
      indexB = -1;
      indexA = _findSupport(f.proxyA, axisA);
      const localPointA = f.proxyA.points[indexA]!;
      const pointA = _transformPoint(xfA, localPointA);
      separation = (pointA.x - pointB.x) * normal.x + (pointA.y - pointB.y) * normal.y;
      break;
    }
  }
  return { separation, indexA, indexB };
}

/** Evaluate separation for a fixed witness pair at time `t`.
 * Mirrors `b2EvaluateSeparation` (distance.c:1089-1136). */
function _evaluateSeparation(
  f: SeparationFunction,
  indexA: number,
  indexB: number,
  t: number
): number {
  const xfA = getSweepTransform(f.sweepA, t);
  const xfB = getSweepTransform(f.sweepB, t);
  switch (f.type) {
    case SeparationType.Points: {
      // distance.c:1096-1105
      const localPointA = f.proxyA.points[indexA]!;
      const localPointB = f.proxyB.points[indexB]!;
      const pointA = _transformPoint(xfA, localPointA);
      const pointB = _transformPoint(xfB, localPointB);
      return (pointB.x - pointA.x) * f.axis.x + (pointB.y - pointA.y) * f.axis.y;
    }
    case SeparationType.FaceA: {
      // distance.c:1108-1117
      const normal = {
        x: xfA.q.c * f.axis.x - xfA.q.s * f.axis.y,
        y: xfA.q.s * f.axis.x + xfA.q.c * f.axis.y,
      };
      const pointA = _transformPoint(xfA, f.localPoint);
      const localPointB = f.proxyB.points[indexB]!;
      const pointB = _transformPoint(xfB, localPointB);
      return (pointB.x - pointA.x) * normal.x + (pointB.y - pointA.y) * normal.y;
    }
    case SeparationType.FaceB: {
      // distance.c:1120-1130
      const normal = {
        x: xfB.q.c * f.axis.x - xfB.q.s * f.axis.y,
        y: xfB.q.s * f.axis.x + xfB.q.c * f.axis.y,
      };
      const pointB = _transformPoint(xfB, f.localPoint);
      const localPointA = f.proxyA.points[indexA]!;
      const pointA = _transformPoint(xfA, localPointA);
      return (pointA.x - pointB.x) * normal.x + (pointA.y - pointB.y) * normal.y;
    }
  }
}

// ─── b2TimeOfImpact ───────────────────────────────────────────────────────────

/** Compute the upper bound on time before two shapes penetrate. Uses
 * conservative advancement (local separating axis method).
 *
 * Mirrors `b2TimeOfImpact` (distance.c:1140-1426). Port is VERBATIM —
 * do not reorder or simplify the numerical logic.
 *
 * @param input  TOI input (two proxies + sweeps + maxFraction).
 * @returns      TOI output (state + fraction + hit point/normal when Hit). */
export function timeOfImpact(input: TOIInput): TOIOutput {
  // distance.c:1147-1149
  const output: TOIOutput = {
    state: TOIState.Unknown,
    fraction: input.maxFraction,
    point: { x: 0, y: 0 },
    normal: { x: 0, y: 0 },
  };

  const sweepA = input.sweepA;
  const sweepB = input.sweepB;

  const proxyA = input.proxyA;
  const proxyB = input.proxyB;

  const tMax = input.maxFraction;

  // distance.c:1166-1169: target distance and tolerance
  const totalRadius = proxyA.radius + proxyB.radius;
  const LINEAR_SLOP = 0.005; // B2_LINEAR_SLOP (constants.h:30)
  const target = Math.max(LINEAR_SLOP, totalRadius - LINEAR_SLOP);
  const tolerance = 0.25 * LINEAR_SLOP;
  // B2_ASSERT(target > tolerance) (distance.c:1169)

  let t1 = 0;
  const K_MAX_ITERATIONS = 20; // distance.c:1172
  let distanceIterations = 0;

  // GJK warm-start cache (fresh per TOI call — distance.c:1176-1180)
  const cache: SimplexCache = { count: 0, indexA: [0, 0, 0], indexB: [0, 0, 0] };

  // distance.c:1187-1189
  let distanceOutput: DistanceOutput = {
    pointA: { x: 0, y: 0 },
    pointB: { x: 0, y: 0 },
    normal: { x: 0, y: 0 },
    distance: 0,
    iterations: 0,
    simplexCount: 0,
  };

  // ── Outer loop (distance.c:1184-1415) ───────────────────────────────────────
  // Progressively finds new separating axes. Terminates when axis is repeated.
  for (;;) {
    const distInput: DistanceInput = {
      proxyA,
      proxyB,
      transformA: getSweepTransform(sweepA, t1),
      transformB: getSweepTransform(sweepB, t1),
      useRadii: false,
    };
    distanceOutput = shapeDistance(distInput, cache);
    distanceIterations += 1;

    // distance.c:1212-1221: if shapes overlap, give up on CCD
    if (distanceOutput.distance <= 0) {
      output.state = TOIState.Overlapped;
      output.fraction = 0;
      break;
    }

    // distance.c:1223-1237: if already close enough, we have a hit
    if (distanceOutput.distance <= target + tolerance) {
      output.state = TOIState.Hit;
      // Averaged hit point (distance.c:1231-1235)
      const rA = proxyA.radius;
      const rB = proxyB.radius;
      const pA = {
        x: distanceOutput.pointA.x + rA * distanceOutput.normal.x,
        y: distanceOutput.pointA.y + rA * distanceOutput.normal.y,
      };
      const pB = {
        x: distanceOutput.pointB.x - rB * distanceOutput.normal.x,
        y: distanceOutput.pointB.y - rB * distanceOutput.normal.y,
      };
      output.point = { x: 0.5 * (pA.x + pB.x), y: 0.5 * (pA.y + pB.y) };
      output.normal = distanceOutput.normal;
      output.fraction = t1;
      break;
    }

    // distance.c:1240: initialize separating axis
    const fcn = _makeSeparationFunction(cache, proxyA, sweepA, proxyB, sweepB, t1);

    // ── Inner (push-back) loop (distance.c:1268-1393) ────────────────────────
    let done = false;
    let t2 = tMax;
    let pushBackIterations = 0;

    for (;;) {
      // distance.c:1274-1276: find deepest point at t2
      const { separation: s2, indexA, indexB } = _findMinSeparation(fcn, t2);

      // distance.c:1278-1289: separated at t2 → victory
      if (s2 > target + tolerance) {
        output.state = TOIState.Separated;
        output.fraction = tMax;
        done = true;
        break;
      }

      // distance.c:1291-1297: separation reached tolerance → advance t1
      if (s2 > target - tolerance) {
        t1 = t2;
        break;
      }

      // distance.c:1300: evaluate at t1
      const s1 = _evaluateSeparation(fcn, indexA, indexB, t1);

      // distance.c:1302-1313: initial overlap (root finder ran out of iters)
      if (s1 < target - tolerance) {
        output.state = TOIState.Failed;
        output.fraction = t1;
        done = true;
        break;
      }

      // distance.c:1315-1330: touching at t1
      if (s1 <= target + tolerance) {
        output.state = TOIState.Hit;
        const rA = proxyA.radius;
        const rB = proxyB.radius;
        const pA = {
          x: distanceOutput.pointA.x + rA * distanceOutput.normal.x,
          y: distanceOutput.pointA.y + rA * distanceOutput.normal.y,
        };
        const pB = {
          x: distanceOutput.pointB.x - rB * distanceOutput.normal.x,
          y: distanceOutput.pointB.y - rB * distanceOutput.normal.y,
        };
        output.point = { x: 0.5 * (pA.x + pB.x), y: 0.5 * (pA.y + pB.y) };
        output.normal = distanceOutput.normal;
        output.fraction = t1;
        done = true;
        break;
      }

      // distance.c:1332-1382: 1D root finder (bisection + false position)
      let rootIterationCount = 0;
      let a1 = t1;
      let a2 = t2;
      let s1r = s1; // "s1" in the root loop
      let s2r = s2; // "s2" in the root loop

      for (;;) {
        // distance.c:1338-1348: alternate bisection and false position
        let t: number;
        if (rootIterationCount & 1) {
          // False position to improve convergence
          t = a1 + ((target - s1r) * (a2 - a1)) / (s2r - s1r);
        } else {
          // Bisection to guarantee progress
          t = 0.5 * (a1 + a2);
        }
        rootIterationCount += 1;

        const s = _evaluateSeparation(fcn, indexA, indexB, t);

        // distance.c:1358-1364: reached tolerance → tentative t2
        if (Math.abs(s - target) < tolerance) {
          t2 = t;
          break;
        }

        // distance.c:1366-1376: bracket update
        if (s > target) {
          a1 = t;
          s1r = s;
        } else {
          a2 = t;
          s2r = s;
        }

        // distance.c:1378-1381: max root iterations
        if (rootIterationCount === 50) {
          break;
        }
      }

      pushBackIterations += 1;

      // distance.c:1388-1393: max push-back iterations (B2_MAX_POLYGON_VERTICES=8)
      if (pushBackIterations === MAX_POLYGON_VERTICES) {
        break;
      }
    }

    if (done) {
      break;
    }

    // distance.c:1400-1415: root finder got stuck (semi-victory = Failed)
    if (distanceIterations === K_MAX_ITERATIONS) {
      output.state = TOIState.Failed;
      const rA = proxyA.radius;
      const rB = proxyB.radius;
      const pA = {
        x: distanceOutput.pointA.x + rA * distanceOutput.normal.x,
        y: distanceOutput.pointA.y + rA * distanceOutput.normal.y,
      };
      const pB = {
        x: distanceOutput.pointB.x - rB * distanceOutput.normal.x,
        y: distanceOutput.pointB.y - rB * distanceOutput.normal.y,
      };
      output.point = { x: 0.5 * (pA.x + pB.x), y: 0.5 * (pA.y + pB.y) };
      output.normal = distanceOutput.normal;
      output.fraction = t1;
      break;
    }
  }

  return output;
}
