// Mass integrals and body mass recomputation.
//
// Ports:
//   b2ComputeCircleMass   — box2d/src/geometry.c:220–231
//   b2ComputeCapsuleMass  — box2d/src/geometry.c:234–270
//   b2ComputePolygonMass  — box2d/src/geometry.c:273–398
//   b2UpdateBodyMassData  — box2d/src/body.c:515–647
//   b2ComputeShapeMass    — box2d/src/shape.c:783–796
//   b2ComputeShapeExtent  — box2d/src/shape.c:798–861
//
// Engine module boundary: import only from math/, util/, engine/{geometry,shape,body}.
//
// Cross-ticket contract (VP-8/VP-12 interface):
//   InternalShape.localCentroid{X,Y} is the centroid in the *geometry's* local
//   frame (local pose NOT applied). Before accumulating mass data this module
//   transforms each shape's geometry-local centroid by the shape's local pose
//   (localX/Y + localCos/Sin) to get the body-local centroid that is then used
//   in the parallel-axis theorem. The rotational inertia returned by the per-
//   shape integrals is about the geometry's origin; after mapping the centroid
//   to body-local space the same parallel-axis shift is applied when combining.

import { PI, HUGE } from "../math/constants.js";
import { NULL_INDEX } from "../util/handle.js";
import {
  DYNAMIC_BODY,
  KINEMATIC_BODY,
  STATIC_BODY,
  type InternalBody,
  type BodySim,
} from "./body.js";
import { ShapeType, type InternalShape } from "./shape.js";
import type { CircleGeometry, CapsuleGeometry, PolygonGeometry } from "./geometry.js";

// ─── MassData ─────────────────────────────────────────────────────────────────

/** Per-shape mass properties. Mirrors `b2MassData`.
 * `rotationalInertia` is about the geometry origin (not the centroid). */
export interface MassData {
  mass: number;
  centerX: number;
  centerY: number;
  rotationalInertia: number;
}

// ─── b2ComputeCircleMass ──────────────────────────────────────────────────────

/**
 * Compute mass, center, and rotational inertia for a circle.
 * Mirrors `b2ComputeCircleMass` in geometry.c.
 *
 * `rotationalInertia` is about the geometry origin (same as center for a circle
 * centered at `cx,cy`).  The parallel-axis theorem must be applied by the caller
 * when the center does not coincide with the body's CoM.
 */
export function computeCircleMass(geom: CircleGeometry, density: number): MassData {
  const rr = geom.radius * geom.radius;
  const mass = density * PI * rr;
  return {
    mass,
    centerX: geom.cx,
    centerY: geom.cy,
    // Inertia about the circle's own center.
    rotationalInertia: mass * 0.5 * rr,
  };
}

// ─── b2ComputeCapsuleMass ─────────────────────────────────────────────────────

/**
 * Compute mass, center, and rotational inertia for a capsule.
 * Mirrors `b2ComputeCapsuleMass` in geometry.c.
 *
 * The formula combines a central rectangle with two semi-circles at the ends,
 * then applies the parallel-axis theorem twice for the half-circle offsets.
 * `rotationalInertia` is about the geometry origin (midpoint of `center1/center2`).
 */
export function computeCapsuleMass(geom: CapsuleGeometry, density: number): MassData {
  const radius = geom.radius;
  const rr = radius * radius;
  const dx = geom.bx - geom.ax;
  const dy = geom.by - geom.ay;
  const length = Math.sqrt(dx * dx + dy * dy);
  const ll = length * length;

  const circleMass = density * PI * rr;
  const boxMass = density * 2 * radius * length;
  const mass = circleMass + boxMass;
  const centerX = 0.5 * (geom.ax + geom.bx);
  const centerY = 0.5 * (geom.ay + geom.by);

  // Half-circle centroid distance from its flat face:
  //   lc = 4r / (3π)
  const lc = (4 * radius) / (3 * PI);
  // Half length of the rectangular portion:
  const h = 0.5 * length;

  // Two offset half-circles add up to a full circle. Each half is offset by h
  // from the midpoint. Parallel-axis twice:
  //   I_semi = m_semi * (0.5*r² + h² + 2*h*lc)
  //   (one for each cap; both halves combined = full circle contribution)
  const circleInertia = circleMass * (0.5 * rr + h * h + 2 * h * lc);
  // Rectangle: I = m*(4r² + l²) / 12
  const boxInertia = (boxMass * (4 * rr + ll)) / 12;
  const rotationalInertia = circleInertia + boxInertia;

  return { mass, centerX, centerY, rotationalInertia };
}

// ─── b2ComputePolygonMass ─────────────────────────────────────────────────────

/**
 * Compute mass, center, and rotational inertia for a convex polygon.
 * Mirrors `b2ComputePolygonMass` in geometry.c.
 *
 * For a degenerate 1-vertex polygon delegates to circle mass; for a 2-vertex
 * polygon delegates to capsule mass (matching box2d's fallbacks).
 * Non-zero `radius` is approximated by outward-pushing the vertices by
 * `sqrt(2) * radius` along the bisector normals (box2d's approximation).
 *
 * The returned `rotationalInertia` is about the first vertex used as the
 * reference origin, then shifted to the centroid inside this function (box2d
 * does the same); it is therefore about the polygon centroid, not the origin.
 * The body accumulator must apply the parallel-axis theorem to shift it to the
 * body CoM.
 */
export function computePolygonMass(geom: PolygonGeometry, density: number): MassData {
  const count = geom.count;

  if (count === 1) {
    // Degenerate: single vertex treated as a circle.
    const vx = geom.vertices[0]!;
    const vy = geom.vertices[1]!;
    return computeCircleMass({ kind: "circle", cx: vx, cy: vy, radius: geom.radius }, density);
  }

  if (count === 2) {
    // Degenerate: two vertices treated as a capsule.
    return computeCapsuleMass(
      {
        kind: "capsule",
        ax: geom.vertices[0]!,
        ay: geom.vertices[1]!,
        bx: geom.vertices[2]!,
        by: geom.vertices[3]!,
        radius: geom.radius,
      },
      density
    );
  }

  // Build working vertex array. Rounded polygons push vertices outward.
  const vs: number[] = new Array(count * 2);
  const radius = geom.radius;
  if (radius > 0) {
    const SQRT2 = 1.412;
    for (let i = 0; i < count; i++) {
      // j is the previous index (wraps).
      const j = i === 0 ? count - 1 : i - 1;
      const n1x = geom.normals[j * 2]!;
      const n1y = geom.normals[j * 2 + 1]!;
      const n2x = geom.normals[i * 2]!;
      const n2y = geom.normals[i * 2 + 1]!;
      // mid = normalize(n1 + n2)
      let mx = n1x + n2x;
      let my = n1y + n2y;
      const ml = Math.sqrt(mx * mx + my * my);
      if (ml > 0) {
        mx /= ml;
        my /= ml;
      }
      vs[i * 2] = geom.vertices[i * 2]! + SQRT2 * radius * mx;
      vs[i * 2 + 1] = geom.vertices[i * 2 + 1]! + SQRT2 * radius * my;
    }
  } else {
    for (let i = 0; i < count; i++) {
      vs[i * 2] = geom.vertices[i * 2]!;
      vs[i * 2 + 1] = geom.vertices[i * 2 + 1]!;
    }
  }

  // Reference point = first vertex (reduces round-off for far-from-origin shapes).
  const rx = vs[0]!;
  const ry = vs[1]!;

  let centerX = 0;
  let centerY = 0;
  let area = 0;
  let rotI = 0;

  const inv3 = 1 / 3;

  for (let i = 1; i < count - 1; i++) {
    const e1x = vs[i * 2]! - rx;
    const e1y = vs[i * 2 + 1]! - ry;
    const e2x = vs[(i + 1) * 2]! - rx;
    const e2y = vs[(i + 1) * 2 + 1]! - ry;

    const D = e1x * e2y - e1y * e2x; // cross(e1, e2)
    const triArea = 0.5 * D;
    area += triArea;

    // Area-weighted centroid contribution (relative to r).
    centerX += triArea * inv3 * (e1x + e2x);
    centerY += triArea * inv3 * (e1y + e2y);

    // Inertia integral:
    //   intx2 = ex1² + ex1·ex2 + ex2²
    //   inty2 = ey1² + ey1·ey2 + ey2²
    const intx2 = e1x * e1x + e2x * e1x + e2x * e2x;
    const inty2 = e1y * e1y + e2y * e1y + e2y * e2y;
    rotI += 0.25 * inv3 * D * (intx2 + inty2);
  }

  const mass = density * area;

  // Center of mass (relative to r), then shift back.
  const invArea = 1 / area;
  centerX *= invArea;
  centerY *= invArea;
  const massData_cx = rx + centerX;
  const massData_cy = ry + centerY;

  // Inertia: relative to the reference origin (r), then shift to centroid.
  //   I_centroid = I_origin - mass * dot(center_offset, center_offset)
  const rotationalInertia = density * rotI - mass * (centerX * centerX + centerY * centerY);

  return {
    mass,
    centerX: massData_cx,
    centerY: massData_cy,
    rotationalInertia,
  };
}

// ─── Per-shape mass dispatch ──────────────────────────────────────────────────

/**
 * Compute mass data for a single `InternalShape`, returning the mass with
 * center in *geometry-local* space (the shape's own origin, NOT body-local).
 *
 * Mirrors `b2ComputeShapeMass` in shape.c (dispatch by type).
 * Sensors and zero-density shapes return a zeroed `MassData`.
 * Segment and chain-segment shapes have no area and return zero.
 */
function computeShapeMassGeomLocal(shape: InternalShape): MassData {
  if (shape.sensor || shape.density === 0) {
    return { mass: 0, centerX: 0, centerY: 0, rotationalInertia: 0 };
  }
  const g = shape.geometry;
  switch (shape.type) {
    case ShapeType.Circle:
      return computeCircleMass(g as CircleGeometry, shape.density);
    case ShapeType.Capsule:
      return computeCapsuleMass(g as CapsuleGeometry, shape.density);
    case ShapeType.Polygon:
      return computePolygonMass(g as PolygonGeometry, shape.density);
    case ShapeType.Segment:
    case ShapeType.ChainSegment:
      // Segments have no area — they contribute zero mass.
      return { mass: 0, centerX: 0, centerY: 0, rotationalInertia: 0 };
  }
}

// ─── Shape extent computation ─────────────────────────────────────────────────

/** Mirrors `b2ShapeExtent`. */
interface ShapeExtent {
  minExtent: number;
  maxExtent: number;
}

/**
 * Compute the min/max extent of `shape` relative to a body-local reference
 * point `lcx/lcy`.  Mirrors `b2ComputeShapeExtent` in shape.c.
 *
 * `minExtent` ≈ the minimum collision radius (used to detect thin shapes).
 * `maxExtent` ≈ the maximum reach from the body CoM (used for sleeping/CCD).
 *
 * The shape's geometry is in the *shape's* local frame; the local pose is NOT
 * applied here.  Box2D does not apply the local pose either — it stores
 * geometry already in the body-local frame.  Since our port keeps geometry in
 * shape-local space we apply the local-pose offset to the two relevant centres
 * before computing distances.
 */
function computeShapeExtent(shape: InternalShape, lcx: number, lcy: number): ShapeExtent {
  // Helper: transform a geometry-local point to body-local space.
  const toBodyLocal = (gx: number, gy: number): [number, number] => {
    const bx = shape.localCos * gx - shape.localSin * gy + shape.localX;
    const by = shape.localSin * gx + shape.localCos * gy + shape.localY;
    return [bx, by];
  };

  const g = shape.geometry;
  switch (shape.type) {
    case ShapeType.Circle: {
      const cg = g as CircleGeometry;
      const [cbx, cby] = toBodyLocal(cg.cx, cg.cy);
      const dx = cbx - lcx;
      const dy = cby - lcy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      return {
        minExtent: cg.radius,
        maxExtent: dist + cg.radius,
      };
    }
    case ShapeType.Capsule: {
      const cg = g as CapsuleGeometry;
      const [ax, ay] = toBodyLocal(cg.ax, cg.ay);
      const [bx, by] = toBodyLocal(cg.bx, cg.by);
      const dx1 = ax - lcx;
      const dy1 = ay - lcy;
      const dx2 = bx - lcx;
      const dy2 = by - lcy;
      const maxDistSq = Math.max(dx1 * dx1 + dy1 * dy1, dx2 * dx2 + dy2 * dy2);
      return {
        minExtent: cg.radius,
        maxExtent: Math.sqrt(maxDistSq) + cg.radius,
      };
    }
    case ShapeType.Polygon: {
      const pg = g as PolygonGeometry;
      let minExt = HUGE;
      let maxDistSq = 0;
      // For the polygon extent, minExtent is the minimum distance from the
      // polygon centroid to each face (= the in-radius, roughly).  Box2D
      // computes this as dot(normal_i, vertex_i - centroid) for each face.
      // The centroid in body space is the geometry centroid through local pose.
      const [centBx, centBy] = toBodyLocal(pg.centroidX, pg.centroidY);
      for (let i = 0; i < pg.count; i++) {
        const vgx = pg.vertices[i * 2]!;
        const vgy = pg.vertices[i * 2 + 1]!;
        const [vbx, vby] = toBodyLocal(vgx, vgy);
        const nx = pg.normals[i * 2]!;
        const ny = pg.normals[i * 2 + 1]!;
        // plane offset: dot(normal, vertex - centroid) — all in body space.
        // Since the local rotation is rigid the normal in body space is:
        //   nbx = cos*nx - sin*ny,  nby = sin*nx + cos*ny
        const nbx = shape.localCos * nx - shape.localSin * ny;
        const nby = shape.localSin * nx + shape.localCos * ny;
        const planeOff = nbx * (vbx - centBx) + nby * (vby - centBy);
        if (planeOff < minExt) {
          minExt = planeOff;
        }

        const dx = vbx - lcx;
        const dy = vby - lcy;
        const dsq = dx * dx + dy * dy;
        if (dsq > maxDistSq) {
          maxDistSq = dsq;
        }
      }
      return {
        minExtent: minExt + pg.radius,
        maxExtent: Math.sqrt(maxDistSq) + pg.radius,
      };
    }
    case ShapeType.Segment: {
      const sg = g as { ax: number; ay: number; bx: number; by: number };
      const [ax, ay] = toBodyLocal(sg.ax, sg.ay);
      const [bx, by] = toBodyLocal(sg.bx, sg.by);
      const dx1 = ax - lcx;
      const dy1 = ay - lcy;
      const dx2 = bx - lcx;
      const dy2 = by - lcy;
      const maxDistSq = Math.max(dx1 * dx1 + dy1 * dy1, dx2 * dx2 + dy2 * dy2);
      return { minExtent: 0, maxExtent: Math.sqrt(maxDistSq) };
    }
    case ShapeType.ChainSegment: {
      const cs = g as { ax: number; ay: number; bx: number; by: number };
      const [ax, ay] = toBodyLocal(cs.ax, cs.ay);
      const [bx, by] = toBodyLocal(cs.bx, cs.by);
      const dx1 = ax - lcx;
      const dy1 = ay - lcy;
      const dx2 = bx - lcx;
      const dy2 = by - lcy;
      const maxDistSq = Math.max(dx1 * dx1 + dy1 * dy1, dx2 * dx2 + dy2 * dy2);
      return { minExtent: 0, maxExtent: Math.sqrt(maxDistSq) };
    }
  }
}

// ─── b2UpdateBodyMassData ─────────────────────────────────────────────────────

/**
 * Recompute mass properties for `body` and write them into `sim`.
 * Mirrors `b2UpdateBodyMassData` in body.c.
 *
 * `getShape(index)` resolves a shape-linked-list index to its `InternalShape`.
 * The caller (the recompute system) supplies the shapes storage lookup.
 *
 * Cross-ticket contract:
 *   Each shape's `localCentroid{X,Y}` is in the *geometry's* local frame (the
 *   local pose is NOT baked in — VP-8 settled this).  Before combining masses
 *   this function transforms the centroid by the shape's local pose
 *   (localX/Y + localCos/Sin) to get the body-local centroid.  The
 *   `rotationalInertia` returned by `computeShapeMassGeomLocal` is about the
 *   geometry origin; the parallel-axis theorem is applied with the offset
 *   `(body-local centroid − body CoM)` to shift it to the body CoM.
 *
 * Faithful to box2d: a dynamic body whose accumulated mass is zero keeps
 * `mass=0, invMass=0` (infinite mass — it will not fall). `b2UpdateBodyMassData`
 * (body.c) does NOT default it to mass 1; the `dynamic-body-without-density`
 * debug check is what flags the misconfiguration. (An earlier VP-7 note claimed
 * box2d defaults such a body to mass 1 — that is wrong; verified against source.)
 *
 * Deviation from box2d:
 *   - Velocity adjustment for CoM shift (box2d lines 629–633) is omitted —
 *     no `BodyState` lookup is threaded through here; the delta is negligible
 *     on the first mass computation and will be wired if sleep/CoM-drift
 *     correction is needed in a later milestone.
 */
export function updateBodyMassData(
  body: InternalBody,
  sim: BodySim,
  getShape: (index: number) => InternalShape
): void {
  // Clear dirty flag first (box2d: body->flags &= ~b2_dirtyMass).
  body.massDirty = false;

  // Reset accumulated fields.
  sim.invMass = 0;
  sim.invInertia = 0;
  sim.localCenterX = 0;
  sim.localCenterY = 0;
  sim.minExtent = HUGE;
  sim.maxExtent = 0;

  // Static and kinematic bodies have zero mass.
  if (body.type === STATIC_BODY || body.type === KINEMATIC_BODY) {
    // For static bodies: center = transform.p (no local center offset).
    sim.centerX = sim.transformX;
    sim.centerY = sim.transformY;

    // Kinematic bodies still need extents for sleeping.
    if (body.type === KINEMATIC_BODY) {
      let shapeIdx = body.shapeHead;
      while (shapeIdx !== NULL_INDEX) {
        const s = getShape(shapeIdx);
        const ext = computeShapeExtent(s, 0, 0);
        if (ext.minExtent < sim.minExtent) {
          sim.minExtent = ext.minExtent;
        }
        if (ext.maxExtent > sim.maxExtent) {
          sim.maxExtent = ext.maxExtent;
        }
        shapeIdx = s.nextShape;
      }
    }
    return;
  }

  // Dynamic body: accumulate mass over all non-sensor, non-zero-density shapes.
  // Pass 1: sum mass and mass-weighted centroid contributions.
  const massDataArr: Array<{
    mass: number;
    centerX: number; // body-local centroid
    centerY: number;
    rotI: number; // inertia about the shape centroid (box2d b2Compute*Mass convention)
  }> = [];

  let totalMass = 0;
  let wcx = 0; // sum of mass_i * center_i_body_local_x
  let wcy = 0;

  let shapeIdx = body.shapeHead;
  while (shapeIdx !== NULL_INDEX) {
    const s = getShape(shapeIdx);
    shapeIdx = s.nextShape;

    if (s.sensor || s.density === 0) {
      massDataArr.push({ mass: 0, centerX: 0, centerY: 0, rotI: 0 });
      continue;
    }

    const geomMd = computeShapeMassGeomLocal(s);
    if (geomMd.mass === 0) {
      massDataArr.push({ mass: 0, centerX: 0, centerY: 0, rotI: 0 });
      continue;
    }

    // Transform the geometry-local centroid to body-local space by applying
    // the shape's local pose (localX/Y + localCos/Sin).
    // body_local_centroid = localRot * geomCentroid + localTranslation
    const bodyLocalCx = s.localCos * geomMd.centerX - s.localSin * geomMd.centerY + s.localX;
    const bodyLocalCy = s.localSin * geomMd.centerX + s.localCos * geomMd.centerY + s.localY;

    totalMass += geomMd.mass;
    wcx += geomMd.mass * bodyLocalCx;
    wcy += geomMd.mass * bodyLocalCy;

    massDataArr.push({
      mass: geomMd.mass,
      centerX: bodyLocalCx,
      centerY: bodyLocalCy,
      rotI: geomMd.rotationalInertia,
    });
  }

  // Compute center of mass.
  let localCx = 0;
  let localCy = 0;
  if (totalMass > 0) {
    sim.invMass = 1 / totalMass;
    localCx = wcx * sim.invMass;
    localCy = wcy * sim.invMass;
  } else {
    // Faithful to box2d: a massless dynamic body keeps invMass=0 (infinite
    // mass). localCenter stays (0,0). The dynamic-body-without-density debug
    // check flags this; we do not silently assign unit mass.
    sim.invMass = 0;
  }

  // Pass 2: accumulate rotational inertia about the body CoM via parallel-axis.
  let totalInertia = 0;
  for (const md of massDataArr) {
    if (md.mass === 0) {
      continue;
    }
    // rotI is about the shape's own centroid (box2d's b2Compute*Mass returns
    // inertia about the center of mass). 2D centroidal inertia is invariant
    // under the shape's local-pose rotation, so no rotation term is needed —
    // only the parallel-axis shift to the body CoM:
    //   I_bodyCoM += rotI + mass * |centroid_bodyLocal − CoM|²
    // (matches b2UpdateBodyMassData's offset = localCenter − massData.center).
    const offX = md.centerX - localCx;
    const offY = md.centerY - localCy;
    totalInertia += md.rotI + md.mass * (offX * offX + offY * offY);
  }

  if (totalInertia > 0) {
    sim.invInertia = 1 / totalInertia;
  } else {
    sim.invInertia = 0;
  }

  // Write local center and recompute world-space center.
  sim.localCenterX = localCx;
  sim.localCenterY = localCy;
  // center = transformPoint(transform, localCenter)
  sim.centerX = sim.cos * localCx - sim.sin * localCy + sim.transformX;
  sim.centerY = sim.sin * localCx + sim.cos * localCy + sim.transformY;

  // Compute body extents relative to the new CoM.
  shapeIdx = body.shapeHead;
  while (shapeIdx !== NULL_INDEX) {
    const s = getShape(shapeIdx);
    const ext = computeShapeExtent(s, localCx, localCy);
    if (ext.minExtent < sim.minExtent) {
      sim.minExtent = ext.minExtent;
    }
    if (ext.maxExtent > sim.maxExtent) {
      sim.maxExtent = ext.maxExtent;
    }
    shapeIdx = s.nextShape;
  }
}
