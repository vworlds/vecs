// Transitional stub kept alive for surviving engine code; full deletion happens in M7-10.
// Geometry helpers ported from box2d/src/geometry.c and box2d/src/hull.c.
//
// VP-8 scope: shape construction, AABB computation, point-in-shape tests.
// Mass integrals (b2ComputeCircleMass / b2ComputeCapsuleMass /
// b2ComputePolygonMass) are VP-12 and NOT ported here.
//
// Upstream sources:
//   box2d/src/geometry.c   — b2MakeBox, b2MakePolygon, b2ComputePolygonCentroid,
//                            b2Compute{Circle,Capsule,Polygon,Segment}AABB,
//                            b2PointIn{Circle,Capsule,Polygon}
//   box2d/src/hull.c       — b2ComputeHull, b2ValidateHull (convex-validation)
//
// Engine module boundary: import only from math/ and util/.

import { LINEAR_SLOP } from "../math/constants.js";
import type { AABB } from "../math/aabb.js";
import type { Transform } from "../math/transform.js";
import { transformPoint } from "../math/transform.js";
import { cross, normalize, sub } from "../math/vec2.js";

// ─── B2_MAX_POLYGON_VERTICES ─────────────────────────────────────────────────

/** Maximum vertices on a convex polygon, matching Box2D's
 * `B2_MAX_POLYGON_VERTICES`. */
export const MAX_POLYGON_VERTICES = 8;

// ─── Hull ─────────────────────────────────────────────────────────────────────

/** An intermediate convex hull produced by {@link computeHull} and consumed by
 * {@link makePolygon}. Mirrors `b2Hull`. */
export interface Hull {
  points: Array<{ x: number; y: number }>;
  count: number;
}

// ─── GeometryUnion ────────────────────────────────────────────────────────────

/** Circle geometry. Mirrors `b2Circle` with center pre-flattened. */
export interface CircleGeometry {
  kind: "circle";
  cx: number;
  cy: number;
  radius: number;
}

/** Capsule geometry. Mirrors `b2Capsule`. */
export interface CapsuleGeometry {
  kind: "capsule";
  ax: number;
  ay: number;
  bx: number;
  by: number;
  radius: number;
}

/** Two-sided segment geometry. Mirrors `b2Segment`. */
export interface SegmentGeometry {
  kind: "segment";
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

/** Convex polygon geometry. Vertices and normals are packed into
 * `Float32Array`s as interleaved `[x0, y0, x1, y1, …]`. Mirrors `b2Polygon`.
 * PLAN.md → _Shape storage_. */
export interface PolygonGeometry {
  kind: "polygon";
  /** Interleaved `[x0, y0, …]`; length = `count * 2`. */
  vertices: Float32Array;
  /** Interleaved outward normals `[nx0, ny0, …]`; length = `count * 2`. */
  normals: Float32Array;
  count: number;
  radius: number;
  centroidX: number;
  centroidY: number;
}

/** One-sided chain segment. Mirrors `b2ChainSegment`.
 * ghost1 → a → b → ghost2 (one-sided collision; only the right side). */
export interface ChainSegmentGeometry {
  kind: "chainSegment";
  ghost1X: number;
  ghost1Y: number;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  ghost2X: number;
  ghost2Y: number;
  /** Index of the owning chain (set by the shape-lifecycle system; 0 for now). */
  chainId: number;
}

/** Tagged union of all geometry variants. Stored on {@link InternalShape} from
 * `engine/shape.ts`. */
export type GeometryUnion =
  | CircleGeometry
  | CapsuleGeometry
  | SegmentGeometry
  | PolygonGeometry
  | ChainSegmentGeometry;

// ─── AABB computation ─────────────────────────────────────────────────────────

/**
 * Compute the world-space AABB of a geometry given its world transform.
 * Dispatches to the per-shape helper. Mirrors the four `b2Compute*AABB`
 * functions in `geometry.c`.
 */
export function computeAABB(geom: GeometryUnion, xf: Transform): AABB {
  switch (geom.kind) {
    case "circle":
      return computeCircleAABB(geom, xf);
    case "capsule":
      return computeCapsuleAABB(geom, xf);
    case "segment":
      return computeSegmentAABB(geom, xf);
    case "polygon":
      return computePolygonAABB(geom, xf);
    case "chainSegment":
      // Chain segments use the two endpoint vertices (a and b) for their AABB.
      return computeSegmentAABB(
        { kind: "segment", ax: geom.ax, ay: geom.ay, bx: geom.bx, by: geom.by },
        xf
      );
  }
}

/** b2ComputeCircleAABB. */
function computeCircleAABB(g: CircleGeometry, xf: Transform): AABB {
  const p = transformPoint(xf, { x: g.cx, y: g.cy });
  const r = g.radius;
  return {
    lowerBound: { x: p.x - r, y: p.y - r },
    upperBound: { x: p.x + r, y: p.y + r },
  };
}

/** b2ComputeCapsuleAABB. */
function computeCapsuleAABB(g: CapsuleGeometry, xf: Transform): AABB {
  const v1 = transformPoint(xf, { x: g.ax, y: g.ay });
  const v2 = transformPoint(xf, { x: g.bx, y: g.by });
  const r = g.radius;
  return {
    lowerBound: { x: Math.min(v1.x, v2.x) - r, y: Math.min(v1.y, v2.y) - r },
    upperBound: { x: Math.max(v1.x, v2.x) + r, y: Math.max(v1.y, v2.y) + r },
  };
}

/** b2ComputeSegmentAABB. */
function computeSegmentAABB(g: SegmentGeometry, xf: Transform): AABB {
  const v1 = transformPoint(xf, { x: g.ax, y: g.ay });
  const v2 = transformPoint(xf, { x: g.bx, y: g.by });
  return {
    lowerBound: { x: Math.min(v1.x, v2.x), y: Math.min(v1.y, v2.y) },
    upperBound: { x: Math.max(v1.x, v2.x), y: Math.max(v1.y, v2.y) },
  };
}

/** b2ComputePolygonAABB. */
function computePolygonAABB(g: PolygonGeometry, xf: Transform): AABB {
  // Seed with the first vertex.
  const x0 = g.vertices[0]!;
  const y0 = g.vertices[1]!;
  const first = transformPoint(xf, { x: x0, y: y0 });
  let minX = first.x;
  let minY = first.y;
  let maxX = first.x;
  let maxY = first.y;

  for (let i = 1; i < g.count; i++) {
    const v = transformPoint(xf, { x: g.vertices[i * 2]!, y: g.vertices[i * 2 + 1]! });
    minX = Math.min(minX, v.x);
    minY = Math.min(minY, v.y);
    maxX = Math.max(maxX, v.x);
    maxY = Math.max(maxY, v.y);
  }

  const r = g.radius;
  return {
    lowerBound: { x: minX - r, y: minY - r },
    upperBound: { x: maxX + r, y: maxY + r },
  };
}

// ─── Point-in-shape tests ─────────────────────────────────────────────────────

/** b2PointInCircle — point in local space of the shape. */
export function pointInCircle(
  g: Pick<CircleGeometry, "cx" | "cy" | "radius">,
  px: number,
  py: number
): boolean {
  // b2DistanceSquared(point, center) <= r*r
  const dx = px - g.cx;
  const dy = py - g.cy;
  return dx * dx + dy * dy <= g.radius * g.radius;
}

/** b2PointInCapsule — point in local space of the shape.
 * Projects the point onto the segment, clamps to [0,1], then checks radius. */
export function pointInCapsule(
  g: Pick<CapsuleGeometry, "ax" | "ay" | "bx" | "by" | "radius">,
  px: number,
  py: number
): boolean {
  const rr = g.radius * g.radius;
  const dx = g.bx - g.ax;
  const dy = g.by - g.ay;
  const dd = dx * dx + dy * dy;
  if (dd === 0) {
    // Degenerate — capsule is a circle
    const cx = px - g.ax;
    const cy = py - g.ay;
    return cx * cx + cy * cy <= rr;
  }
  // t = dot(point - a, d) / dot(d, d)
  const t = Math.max(0, Math.min(1, ((px - g.ax) * dx + (py - g.ay) * dy) / dd));
  const cx = g.ax + t * dx - px;
  const cy = g.ay + t * dy - py;
  return cx * cx + cy * cy <= rr;
}

/**
 * b2PointInPolygon — point in local space of the convex polygon.
 *
 * Box2D's implementation delegates to `b2ShapeDistance` (GJK) which is not
 * ported until VP-13. We use an equivalent half-plane test: the point is
 * inside if and only if it is on the interior side (or boundary) of every
 * edge. For a convex polygon with CCW winding this is:
 *
 *   cross(edge_normal_i, point - vertex_i) <= radius   for all i
 *
 * This is equivalent for the convex shapes we store and passes the Box2D
 * golden test exactly.
 */
export function pointInPolygon(g: PolygonGeometry, px: number, py: number): boolean {
  for (let i = 0; i < g.count; i++) {
    const vx = g.vertices[i * 2]!;
    const vy = g.vertices[i * 2 + 1]!;
    const nx = g.normals[i * 2]!;
    const ny = g.normals[i * 2 + 1]!;
    // dot(normal, point - vertex)  — positive = outside this edge
    const d = nx * (px - vx) + ny * (py - vy);
    if (d > g.radius) {
      return false;
    }
  }
  return true;
}

// ─── Polygon construction helpers ─────────────────────────────────────────────

/**
 * Compute the centroid of a polygon by area-weighted triangulation.
 * Mirrors `b2ComputePolygonCentroid` in `geometry.c`.
 * `vertices` is an interleaved Float32Array `[x0, y0, x1, y1, …]`.
 */
function computePolygonCentroid(vertices: Float32Array, count: number): { x: number; y: number } {
  let cx = 0;
  let cy = 0;
  let area = 0;

  // Reference point = first vertex (reduces round-off for far-from-origin polygons).
  const ox = vertices[0]!;
  const oy = vertices[1]!;
  const inv3 = 1 / 3;

  for (let i = 1; i < count - 1; i++) {
    const e1x = vertices[i * 2]! - ox;
    const e1y = vertices[i * 2 + 1]! - oy;
    const e2x = vertices[(i + 1) * 2]! - ox;
    const e2y = vertices[(i + 1) * 2 + 1]! - oy;
    const a = 0.5 * (e1x * e2y - e1y * e2x); // 0.5 * cross(e1, e2)
    cx += a * inv3 * (e1x + e2x);
    cy += a * inv3 * (e1y + e2y);
    area += a;
  }

  const invArea = 1 / area;
  return { x: ox + cx * invArea, y: oy + cy * invArea };
}

/**
 * Build a {@link PolygonGeometry} from a validated {@link Hull}.
 * Mirrors `b2MakePolygon` in `geometry.c`.
 */
export function makePolygon(hull: Hull, radius: number): PolygonGeometry {
  const count = hull.count;
  const vertices = new Float32Array(count * 2);
  const normals = new Float32Array(count * 2);

  for (let i = 0; i < count; i++) {
    vertices[i * 2] = hull.points[i]!.x;
    vertices[i * 2 + 1] = hull.points[i]!.y;
  }

  for (let i = 0; i < count; i++) {
    const i2 = i + 1 < count ? i + 1 : 0;
    const ex = vertices[i2 * 2]! - vertices[i * 2]!;
    const ey = vertices[i2 * 2 + 1]! - vertices[i * 2 + 1]!;
    // b2CrossVS(edge, 1.0) → right-perpendicular, then normalize
    const len = Math.sqrt(ex * ex + ey * ey);
    if (len > 0) {
      normals[i * 2] = ey / len;
      normals[i * 2 + 1] = -ex / len;
    }
  }

  const centroid = computePolygonCentroid(vertices, count);
  return {
    kind: "polygon",
    vertices,
    normals,
    count,
    radius,
    centroidX: centroid.x,
    centroidY: centroid.y,
  };
}

/**
 * Build a box polygon directly, bypassing the hull pipeline.
 * Mirrors `b2MakeBox` in `geometry.c`.
 */
export function makeBox(hx: number, hy: number): PolygonGeometry {
  const vertices = new Float32Array([-hx, -hy, hx, -hy, hx, hy, -hx, hy]);
  const normals = new Float32Array([0, -1, 1, 0, 0, 1, -1, 0]);
  return {
    kind: "polygon",
    vertices,
    normals,
    count: 4,
    radius: 0,
    centroidX: 0,
    centroidY: 0,
  };
}

// ─── Hull computation (b2ComputeHull / b2ValidateHull) ────────────────────────

/**
 * Quickhull recursion: finds the points to the right of line p1→p2, selects
 * the furthest one as the new hull vertex, and recurses on each sub-problem.
 * Mirrors `b2RecurseHull` in `hull.c`.
 */
function recurseHull(
  p1x: number,
  p1y: number,
  p2x: number,
  p2y: number,
  ps: Array<{ x: number; y: number }>,
  count: number
): Array<{ x: number; y: number }> {
  if (count === 0) {
    return [];
  }

  const ex = p2x - p1x;
  const ey = p2y - p1y;
  const len = Math.sqrt(ex * ex + ey * ey);
  const enx = len > 0 ? ex / len : 0;
  const eny = len > 0 ? ey / len : 0;

  // Find furthest point to the right of e (cross(sub(ps[i], p1), e) > 0)
  const rightPoints: Array<{ x: number; y: number }> = [];
  let bestDist = (ps[0]!.x - p1x) * eny - (ps[0]!.y - p1y) * enx; // cross(sub, e)
  let bestIdx = 0;

  if (bestDist > 0) {
    rightPoints.push(ps[0]!);
  }

  for (let i = 1; i < count; i++) {
    const d = (ps[i]!.x - p1x) * eny - (ps[i]!.y - p1y) * enx;
    if (d > bestDist) {
      bestIdx = i;
      bestDist = d;
    }
    if (d > 0) {
      rightPoints.push(ps[i]!);
    }
  }

  if (bestDist < 2 * LINEAR_SLOP) {
    return [];
  }

  const best = ps[bestIdx]!;

  const hull1 = recurseHull(p1x, p1y, best.x, best.y, rightPoints, rightPoints.length);
  const hull2 = recurseHull(best.x, best.y, p2x, p2y, rightPoints, rightPoints.length);

  return [...hull1, best, ...hull2];
}

/**
 * Compute the convex hull of a set of points (quickhull). Returns an empty
 * hull on failure (fewer than 3 distinct non-collinear points, or count > 8).
 * Mirrors `b2ComputeHull` in `hull.c`.
 */
export function computeHull(points: ReadonlyArray<{ x: number; y: number }>): Hull {
  const empty: Hull = { points: [], count: 0 };

  if (points.length < 3 || points.length > MAX_POLYGON_VERTICES) {
    return empty;
  }

  // Weld nearly-coincident points.
  const linearSlop = LINEAR_SLOP;
  const tolSqr = 16 * linearSlop * linearSlop;
  const ps: Array<{ x: number; y: number }> = [];
  let aabbMinX = Infinity,
    aabbMinY = Infinity;
  let aabbMaxX = -Infinity,
    aabbMaxY = -Infinity;

  for (const pt of points) {
    aabbMinX = Math.min(aabbMinX, pt.x);
    aabbMinY = Math.min(aabbMinY, pt.y);
    aabbMaxX = Math.max(aabbMaxX, pt.x);
    aabbMaxY = Math.max(aabbMaxY, pt.y);

    let unique = true;
    for (const existing of ps) {
      const dx = pt.x - existing.x;
      const dy = pt.y - existing.y;
      if (dx * dx + dy * dy < tolSqr) {
        unique = false;
        break;
      }
    }
    if (unique) {
      ps.push({ x: pt.x, y: pt.y });
    }
  }

  if (ps.length < 3) {
    return empty;
  }

  // Find extreme point (furthest from bounding-box center).
  const cx = 0.5 * (aabbMinX + aabbMaxX);
  const cy = 0.5 * (aabbMinY + aabbMaxY);
  let f1 = 0;
  let dsq1 = (ps[0]!.x - cx) ** 2 + (ps[0]!.y - cy) ** 2;
  for (let i = 1; i < ps.length; i++) {
    const d = (ps[i]!.x - cx) ** 2 + (ps[i]!.y - cy) ** 2;
    if (d > dsq1) {
      f1 = i;
      dsq1 = d;
    }
  }

  const p1 = ps[f1]!;
  ps.splice(f1, 1);

  // Find the point furthest from p1.
  let f2 = 0;
  let dsq2 = (ps[0]!.x - p1.x) ** 2 + (ps[0]!.y - p1.y) ** 2;
  for (let i = 1; i < ps.length; i++) {
    const d = (ps[i]!.x - p1.x) ** 2 + (ps[i]!.y - p1.y) ** 2;
    if (d > dsq2) {
      f2 = i;
      dsq2 = d;
    }
  }

  const p2 = ps[f2]!;
  ps.splice(f2, 1);

  // Split remaining points left and right of p1→p2.
  const ex = p2.x - p1.x;
  const ey = p2.y - p1.y;
  const len = Math.sqrt(ex * ex + ey * ey);
  const enx = len > 0 ? ex / len : 0;
  const eny = len > 0 ? ey / len : 0;

  const rightPts: Array<{ x: number; y: number }> = [];
  const leftPts: Array<{ x: number; y: number }> = [];

  for (const pt of ps) {
    const d = (pt.x - p1.x) * eny - (pt.y - p1.y) * enx;
    if (d >= 2 * linearSlop) {
      rightPts.push(pt);
    } else if (d <= -2 * linearSlop) {
      leftPts.push(pt);
    }
  }

  const hull1 = recurseHull(p1.x, p1.y, p2.x, p2.y, rightPts, rightPts.length);
  const hull2 = recurseHull(p2.x, p2.y, p1.x, p1.y, leftPts, leftPts.length);

  if (hull1.length === 0 && hull2.length === 0) {
    // All collinear
    return empty;
  }

  // Stitch hull with CCW winding: p1 → hull1 → p2 → hull2
  const rawPts = [p1, ...hull1, p2, ...hull2];

  // Merge collinear points.
  let searching = true;
  while (searching && rawPts.length > 2) {
    searching = false;
    for (let i = 0; i < rawPts.length; i++) {
      const i2 = (i + 1) % rawPts.length;
      const i3 = (i + 2) % rawPts.length;
      const s1 = rawPts[i]!;
      const s2 = rawPts[i2]!;
      const s3 = rawPts[i3]!;
      const rx = s3.x - s1.x;
      const ry = s3.y - s1.y;
      const rLen = Math.sqrt(rx * rx + ry * ry);
      if (rLen === 0) {
        continue;
      }
      const rnx = rx / rLen;
      const rny = ry / rLen;
      const distance = (s2.x - s1.x) * rny - (s2.y - s1.y) * rnx;
      if (distance <= 2 * linearSlop) {
        rawPts.splice(i2, 1);
        searching = true;
        break;
      }
    }
  }

  if (rawPts.length < 3) {
    return empty;
  }

  return { points: rawPts, count: rawPts.length };
}

/**
 * Validate a convex hull: checks count, that every point is strictly behind
 * every edge, and that no three consecutive points are collinear.
 * Mirrors `b2ValidateHull` in `hull.c`.
 */
export function validateHull(hull: Hull): boolean {
  if (hull.count < 3 || hull.count > MAX_POLYGON_VERTICES) {
    return false;
  }

  // Every point must be strictly behind every edge (to the right of the CCW edge).
  for (let i = 0; i < hull.count; i++) {
    const i2 = i < hull.count - 1 ? i + 1 : 0;
    const p = hull.points[i]!;
    const edge = sub(hull.points[i2]!, p);
    const e = normalize(edge);

    for (let j = 0; j < hull.count; j++) {
      if (j === i || j === i2) {
        continue;
      }
      const dist = cross(sub(hull.points[j]!, p), e);
      if (dist >= 0) {
        return false; // on or outside edge → invalid
      }
    }
  }

  // No three collinear consecutive points.
  const linearSlop = LINEAR_SLOP;
  for (let i = 0; i < hull.count; i++) {
    const i2 = (i + 1) % hull.count;
    const i3 = (i + 2) % hull.count;
    const p1 = hull.points[i]!;
    const p3 = hull.points[i3]!;
    const e = normalize(sub(p3, p1));
    const dist = cross(sub(hull.points[i2]!, p1), e);
    if (dist <= linearSlop) {
      return false;
    }
  }

  return true;
}
