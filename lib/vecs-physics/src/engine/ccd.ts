// Continuous Collision Detection (CCD) for bullets and fast bodies (VP-24).
//
// Ports box2d v3.2.0's single-threaded CCD path:
//   - b2ContinuousQueryCallback  (solver.c:181-376)
//   - b2SolveContinuous          (solver.c:379-541)
//
// The fast/bullet detection branch in b2FinalizeBodiesTask (solver.c:635-657)
// lives in engine/step.ts:finalizeBodies, which calls solveContinuous directly
// for fast non-bullet bodies and pushes bullet body indices onto
// state.bulletBodies for the post-solve bullet stage.
//
// The bullet stage call site (physics_world.c:1896-1968) is collapsed into a
// serial loop in engine/step.ts:engineStep, walking state.bulletBodies after
// solve() and gatherHitEvents(), then calling enlargeBulletProxies.
//
// Deferred (VP-24 scope boundary):
//   - Sensor TOI hits queue (b2TaskContext.sensorHits): kept as a no-op stub.
//     Box2D sensor.c:157-164 merges CCD sensor hits; vecs-physics sensors run
//     their own AABB-based overlap pass (engine/sensor.ts, VP-21c) which does
//     not need TOI precision for v1.
//   - Custom pre-solve / custom filter callbacks: absent in vecs-physics v1
//     (no b2PreSolveFcn). The branches at solver.c:360-365 are skipped.
//   - b2ShouldBodiesCollide (joint-based): no joints in v1; consistent with
//     collide.ts:88. Branches at solver.c:232-238 skipped.

import {
  DYNAMIC_BODY,
  ENLARGE_BOUNDS,
  HAD_TIME_OF_IMPACT,
  IS_BULLET,
  KINEMATIC_BODY,
  STATIC_BODY,
  type BodySim,
} from "./body.js";
import { makeProxy, makeSweep, timeOfImpact, type Sweep, type TOIInput } from "./distance.js";
import { computeAABB } from "./geometry.js";
import { shouldShapesCollide } from "./contact.js";
import { mulTransforms, type Transform } from "../math/transform.js";
import { SPECULATIVE_DISTANCE } from "../math/constants.js";
import { NULL_INDEX } from "../util/handle.js";
import type { PhysicsState } from "./state.js";
import type { InternalShape } from "./shape.js";

/** Fraction that scales `minExtent` to derive the "core" distance for the
 * chain-segment parallel-movement early-out and the fallback circle radius.
 * Mirrors `B2_CORE_FRACTION = 0.25f` (solver.c:178). */
const B2_CORE_FRACTION = 0.25;

/** All-pass mask bits for tree queries: accept any shape regardless of
 * category. Mirrors `B2_DEFAULT_MASK_BITS = UINT64_MAX` (types.h:15).
 * vecs-physics uses 32-bit category/mask fields (settled VP-3). */
const DEFAULT_MASK_BITS = 0xffffffff;

/** B2_LINEAR_SLOP constant used inside the chain parallel-movement early-out.
 * Mirrors `B2_LINEAR_SLOP = 0.005f * b2GetLengthUnitsPerMeter()` (constants.h:30). */
const LINEAR_SLOP = 0.005;

// ─── ContinuousContext (internal) ────────────────────────────────────────────

/** Mutable context threaded through the tree query callback.
 * Mirrors `b2ContinuousContext` (solver.c, anonymous struct near line 379). */
interface ContinuousContext {
  state: PhysicsState;
  fastBodySim: BodySim;
  /** The shape currently being swept (changes per shape in solveContinuous).
   * Same-shape skip uses `fastShape.shapeIndex` (VP-26 cached field). */
  fastShape: InternalShape;
  /** Fast shape's centroid at start of sweep (world space). */
  centroid1: { x: number; y: number };
  /** Fast shape's centroid at end of sweep (world space). */
  centroid2: { x: number; y: number };
  /** Sweep of the fast body (built once per solveContinuous call). */
  sweep: Sweep;
  /** Running minimum hit fraction (starts 1.0; decreases on solid hits). */
  fraction: number;
}

// ─── b2ContinuousQueryCallback ────────────────────────────────────────────────

/**
 * Tree query callback for the CCD sweep. For each candidate shape from the
 * BVH, applies the rejection rules and runs `b2TimeOfImpact` to compute the
 * earliest solid hit fraction. Updates `ctx.fraction` when a sooner hit is
 * found.
 *
 * Mirrors `b2ContinuousQueryCallback` (solver.c:181-376). Returns `true` to
 * continue the tree query (box2d: "return true; // Continue query").
 *
 * Deviations from box2d:
 * - **Sensor TOI hits** (solver.c:317-333): the sensorHits queue is skipped.
 *   See module header for rationale.
 * - **Custom pre-solve / custom filter** (solver.c:240-254, 360-365): absent
 *   in vecs-physics v1. Consistent with collide.ts:88.
 * - **b2ShouldBodiesCollide** (solver.c:232-238): no joints in v1; skipped.
 */
function _continuousQueryCallback(
  _proxyId: number,
  shapeIndex: number,
  ctx: ContinuousContext
): boolean {
  // Skip same shape (solver.c:193-196). Uses the cached shapeIndex field on
  // InternalShape (VP-26) so no O(n) scan is needed — direct field read.
  if (shapeIndex === ctx.fastShape.shapeIndex) {
    return true;
  }

  const { state } = ctx;
  const shape = state.shapes.records[shapeIndex];
  if (shape === undefined) {
    return true;
  }

  const fastShape = ctx.fastShape;
  const fastBodySim = ctx.fastBodySim;

  // Skip same body (solver.c:202-205).
  if (shape.bodyHandle.index === fastShape.bodyHandle.index) {
    return true;
  }

  // Sensor: skip entirely in the CCD solid-hit path (solver.c:207-212).
  // Sensor TOI hits queue is a no-op stub — see module header.
  if (shape.sensorIndex !== NULL_INDEX) {
    return true;
  }

  // Collision filter (solver.c:214-218).
  if (
    !shouldShapesCollide(
      {
        categoryBits: fastShape.categoryBits,
        maskBits: fastShape.maskBits,
        groupIndex: fastShape.groupIndex,
      },
      { categoryBits: shape.categoryBits, maskBits: shape.maskBits, groupIndex: shape.groupIndex }
    )
  ) {
    return true;
  }

  // Skip other bullets (solver.c:227-230).
  // Look up the other body's sim to read its flags.
  const otherRecord = state.bodies.records[shape.bodyHandle.index];
  if (otherRecord === undefined) {
    return true;
  }
  const otherSet = state.solverSets[otherRecord.setIndex];
  if (otherSet === undefined) {
    return true;
  }
  const otherBodySim = otherSet.bodySims[otherRecord.localIndex];
  if (otherBodySim === undefined) {
    return true;
  }
  if (otherBodySim.flags & IS_BULLET) {
    return true; // solver.c:227-230
  }

  // b2ShouldBodiesCollide (joints): skipped — no joints in v1. (solver.c:232-238)
  // Custom user filtering: skipped — not in v1. (solver.c:240-254)

  // ── Chain-segment parallel-movement early-out (solver.c:256-279) ───────────
  // Avoids spurious TOI hits when a fast body slides parallel to a chain edge.
  if (shape.geometry.kind === "chainSegment") {
    const g = shape.geometry;
    const bodyXf: Transform = {
      p: { x: otherBodySim.transformX, y: otherBodySim.transformY },
      q: { c: otherBodySim.cos, s: otherBodySim.sin },
    };
    const localXf: Transform = {
      p: { x: shape.localX, y: shape.localY },
      q: { c: shape.localCos, s: shape.localSin },
    };
    const worldXf = mulTransforms(bodyXf, localXf);
    // World-space endpoints of the chain segment (solver.c:260-262).
    const p1x = worldXf.p.x + worldXf.q.c * g.ax - worldXf.q.s * g.ay;
    const p1y = worldXf.p.y + worldXf.q.s * g.ax + worldXf.q.c * g.ay;
    const p2x = worldXf.p.x + worldXf.q.c * g.bx - worldXf.q.s * g.by;
    const p2y = worldXf.p.y + worldXf.q.s * g.bx + worldXf.q.c * g.by;
    // Edge vector e = p2 - p1 (solver.c:263-264).
    let ex = p2x - p1x;
    let ey = p2y - p1y;
    const length = Math.sqrt(ex * ex + ey * ey);
    if (length > LINEAR_SLOP) {
      ex /= length;
      ey /= length;
      // separation = cross(c - p1, e) = (c.x - p1.x)*e.y - (c.y - p1.y)*e.x
      // (solver.c:268-269)
      const c1 = ctx.centroid1;
      const separation1 = (c1.x - p1x) * ey - (c1.y - p1y) * ex;
      const c2 = ctx.centroid2;
      const separation2 = (c2.x - p1x) * ey - (c2.y - p1y) * ex;
      const coreDistance = B2_CORE_FRACTION * fastBodySim.minExtent;
      // Minimal clipping early-out (solver.c:274-278).
      if (
        separation1 < 0 ||
        (separation1 - separation2 < coreDistance && separation2 > coreDistance)
      ) {
        return true;
      }
    }
  }

  // ── TimeOfImpact (solver.c:309-371) ─────────────────────────────────────────
  const proxyA = _makeShapeDistanceProxy(shape);
  const proxyB = _makeShapeDistanceProxy(fastShape);

  // Sweep for shape A: the other body's motion across the same step.
  const sweepA = makeSweep(otherBodySim);

  const toiInput: TOIInput = {
    proxyA,
    proxyB,
    sweepA,
    sweepB: ctx.sweep,
    maxFraction: ctx.fraction,
  };

  const output = timeOfImpact(toiInput);

  // Solid-hit path (solver.c:337-371). Sensor path omitted (see header).
  let hitFraction = ctx.fraction;
  let didHit = false;

  if (output.fraction > 0 && output.fraction < ctx.fraction) {
    // solver.c:340-342: hit at fraction > 0
    hitFraction = output.fraction;
    didHit = true;
  } else if (output.fraction === 0) {
    // solver.c:345-358: fraction = 0 → fallback to small circle at centroid
    const centroid = _getShapeCentroid(fastShape);
    const extent = _computeShapeMinExtent(fastShape, centroid);
    const radius = B2_CORE_FRACTION * extent;
    const fallbackInput: TOIInput = {
      proxyA,
      proxyB: makeProxy([centroid], 1, radius),
      sweepA,
      sweepB: ctx.sweep,
      maxFraction: ctx.fraction,
    };
    const fallbackOutput = timeOfImpact(fallbackInput);
    if (fallbackOutput.fraction > 0 && fallbackOutput.fraction < ctx.fraction) {
      hitFraction = fallbackOutput.fraction;
      didHit = true;
    }
  }

  // Pre-solve callback: skipped — not in v1. (solver.c:360-365)

  if (didHit) {
    // solver.c:368-371: record hit
    fastBodySim.flags |= HAD_TIME_OF_IMPACT;
    ctx.fraction = hitFraction;
  }

  return true; // Continue query (solver.c:374)
}

// ─── solveContinuous (b2SolveContinuous) ─────────────────────────────────────

/**
 * Run the CCD sweep for one fast/bullet body at `bodySimIndex` in the awake
 * set. Sweeps each of the body's non-sensor shapes against the BVH trees,
 * finds the earliest hit fraction via `b2TimeOfImpact`, then interpolates the
 * body to that fraction and refits its shape AABBs.
 *
 * Called from:
 *   - `finalizeBodies` in `engine/step.ts` for fast non-bullet bodies.
 *   - The bullet stage in `engine/step.ts:engineStep` for bullet bodies.
 *
 * Mirrors `b2SolveContinuous` (solver.c:379-541).
 */
export function solveContinuous(state: PhysicsState, bodySimIndex: number): void {
  const awakeSet = state.solverSets[2]!; // AWAKE_SET = 2
  const fastBodySim = awakeSet.bodySims[bodySimIndex]!;
  // B2_ASSERT(fastBodySim.flags & b2_isFast) (solver.c:385)

  // Build sweep for the fast body (solver.c:387).
  const sweep = makeSweep(fastBodySim);

  // Transforms at sweep start (xf1) and end (xf2) (solver.c:389-395).
  const lc = sweep.localCenter;
  const xf1: Transform = {
    p: {
      x: sweep.c1.x - (sweep.q1.c * lc.x - sweep.q1.s * lc.y),
      y: sweep.c1.y - (sweep.q1.s * lc.x + sweep.q1.c * lc.y),
    },
    q: sweep.q1,
  };
  const xf2: Transform = {
    p: {
      x: sweep.c2.x - (sweep.q2.c * lc.x - sweep.q2.s * lc.y),
      y: sweep.c2.y - (sweep.q2.s * lc.x + sweep.q2.c * lc.y),
    },
    q: sweep.q2,
  };

  const isBullet = (fastBodySim.flags & IS_BULLET) !== 0; // solver.c:408

  const fastBodyRecord = state.bodies.records[fastBodySim.bodyId];
  if (fastBodyRecord === undefined) {
    return;
  }

  // Build ContinuousContext (solver.c:402-406).
  const ctx: ContinuousContext = {
    state,
    fastBodySim,
    fastShape: undefined as unknown as InternalShape, // set per-shape below
    centroid1: { x: 0, y: 0 },
    centroid2: { x: 0, y: 0 },
    sweep,
    fraction: 1.0,
  };

  // ── Per-shape sweep loop (solver.c:410-440) ──────────────────────────────────
  let shapeIndex = fastBodyRecord.shapeHead;
  while (shapeIndex !== NULL_INDEX) {
    const fastShape = state.shapes.get(shapeIndex);

    ctx.fastShape = fastShape;
    // fastShape.shapeIndex (VP-26 cached field) is used by _continuousQueryCallback
    // for the same-shape skip — no need to carry it separately in ctx.
    shapeIndex = fastShape.nextShape;

    // Shape's local transform → world space at start/end of sweep.
    const shapeLocalXf: Transform = {
      p: { x: fastShape.localX, y: fastShape.localY },
      q: { c: fastShape.localCos, s: fastShape.localSin },
    };
    const shapeXf1 = mulTransforms(xf1, shapeLocalXf);
    const shapeXf2 = mulTransforms(xf2, shapeLocalXf);

    // Centroid at start/end in world space (solver.c:417-418).
    // localCentroidX/Y is in shape-local space.
    const lcx = fastShape.localCentroidX;
    const lcy = fastShape.localCentroidY;
    ctx.centroid1 = {
      x: shapeXf1.p.x + shapeXf1.q.c * lcx - shapeXf1.q.s * lcy,
      y: shapeXf1.p.y + shapeXf1.q.s * lcx + shapeXf1.q.c * lcy,
    };
    ctx.centroid2 = {
      x: shapeXf2.p.x + shapeXf2.q.c * lcx - shapeXf2.q.s * lcy,
      y: shapeXf2.p.y + shapeXf2.q.s * lcx + shapeXf2.q.c * lcy,
    };

    // box1 = shape.aabb (tight, from finalize); box2 = aabb at xf2 (solver.c:420-421).
    const box1Minx = fastShape.aabbMinX;
    const box1Miny = fastShape.aabbMinY;
    const box1Maxx = fastShape.aabbMaxX;
    const box1Maxy = fastShape.aabbMaxY;
    const box2raw = computeAABB(fastShape.geometry, shapeXf2);

    // Store end-of-step AABB on shape (solver.c:424: fastShape->aabb = box2).
    const spec = SPECULATIVE_DISTANCE;
    fastShape.aabbMinX = box2raw.lowerBound.x - spec;
    fastShape.aabbMinY = box2raw.lowerBound.y - spec;
    fastShape.aabbMaxX = box2raw.upperBound.x + spec;
    fastShape.aabbMaxY = box2raw.upperBound.y + spec;

    // Skip sensor shapes from TOI query (solver.c:427-430: no CCD for sensors).
    if (fastShape.sensorIndex !== NULL_INDEX) {
      continue;
    }

    // Swept AABB = union(box1, box2) (solver.c:432).
    const sweptBox = {
      lowerBound: {
        x: Math.min(box1Minx, fastShape.aabbMinX),
        y: Math.min(box1Miny, fastShape.aabbMinY),
      },
      upperBound: {
        x: Math.max(box1Maxx, fastShape.aabbMaxX),
        y: Math.max(box1Maxy, fastShape.aabbMaxY),
      },
    };

    // Query static tree (solver.c:434).
    state.broadPhase.queryTree(STATIC_BODY, sweptBox, DEFAULT_MASK_BITS, (pid, si) =>
      _continuousQueryCallback(pid, si, ctx)
    );

    // Bullets also query kinematic + dynamic trees (solver.c:436-440).
    if (isBullet) {
      state.broadPhase.queryTree(KINEMATIC_BODY, sweptBox, DEFAULT_MASK_BITS, (pid, si) =>
        _continuousQueryCallback(pid, si, ctx)
      );
      state.broadPhase.queryTree(DYNAMIC_BODY, sweptBox, DEFAULT_MASK_BITS, (pid, si) =>
        _continuousQueryCallback(pid, si, ctx)
      );
    }
  }

  const specDist = SPECULATIVE_DISTANCE;

  if (ctx.fraction < 1.0) {
    // ── TOI hit: interpolate body to the hit fraction (solver.c:448-493) ──────
    const f = ctx.fraction;
    // q = nlerp(q1, q2, fraction) (solver.c:448)
    const omt = 1 - f;
    const qc = omt * sweep.q1.c + f * sweep.q2.c;
    const qs = omt * sweep.q1.s + f * sweep.q2.s;
    const qLen = Math.sqrt(qc * qc + qs * qs);
    const q = qLen > 0 ? { c: qc / qLen, s: qs / qLen } : { c: 1, s: 0 };
    // c = lerp(c1, c2, fraction) (solver.c:449)
    const cx = omt * sweep.c1.x + f * sweep.c2.x;
    const cy = omt * sweep.c1.y + f * sweep.c2.y;
    // origin = c - rotate(q, localCenter) (solver.c:450)
    const ox = cx - (q.c * lc.x - q.s * lc.y);
    const oy = cy - (q.s * lc.x + q.c * lc.y);

    // Advance body (solver.c:453-456).
    fastBodySim.transformX = ox;
    fastBodySim.transformY = oy;
    fastBodySim.cos = q.c;
    fastBodySim.sin = q.s;
    fastBodySim.centerX = cx;
    fastBodySim.centerY = cy;
    // Reset sweep baseline to the interpolated pose (solver.c:455-456).
    fastBodySim.rotation0Cos = q.c;
    fastBodySim.rotation0Sin = q.s;
    fastBodySim.center0X = cx;
    fastBodySim.center0Y = cy;

    // Update move event (solver.c:459-460):
    // In vecs-physics, bodyMoveEvents stores bodyId indices; the transform
    // is read from sim by PhysicsPoseSyncOut, so updating the sim is sufficient.

    // Refit shape AABBs at the interpolated transform (solver.c:466-493).
    const transform: Transform = { p: { x: ox, y: oy }, q };
    let refitIndex = fastBodyRecord.shapeHead;
    while (refitIndex !== NULL_INDEX) {
      const shape = state.shapes.get(refitIndex);
      refitIndex = shape.nextShape;

      // Recompute tight AABB at interpolated transform (solver.c:472-477).
      const shapeLocalXf2: Transform = {
        p: { x: shape.localX, y: shape.localY },
        q: { c: shape.localCos, s: shape.localSin },
      };
      const worldXfI = mulTransforms(transform, shapeLocalXf2);
      const aabbI = computeAABB(shape.geometry, worldXfI);
      shape.aabbMinX = aabbI.lowerBound.x - specDist;
      shape.aabbMinY = aabbI.lowerBound.y - specDist;
      shape.aabbMaxX = aabbI.upperBound.x + specDist;
      shape.aabbMaxY = aabbI.upperBound.y + specDist;

      // Enlarge fat AABB if tight escapes it (solver.c:479-490).
      if (
        !(
          shape.fatAabbMinX <= shape.aabbMinX &&
          shape.fatAabbMinY <= shape.aabbMinY &&
          shape.aabbMaxX <= shape.fatAabbMaxX &&
          shape.aabbMaxY <= shape.fatAabbMaxY
        )
      ) {
        const margin = shape.aabbMargin;
        shape.fatAabbMinX = shape.aabbMinX - margin;
        shape.fatAabbMinY = shape.aabbMinY - margin;
        shape.fatAabbMaxX = shape.aabbMaxX + margin;
        shape.fatAabbMaxY = shape.aabbMaxY + margin;
        // solver.c:489-490: shape->enlargedAABB = true; fastBodySim->flags |= b2_enlargeBounds
        shape.enlargedAABB = true;
        fastBodySim.flags |= ENLARGE_BOUNDS;
      }
    }
  } else {
    // ── No TOI hit: advance sweep baseline (solver.c:500-527) ─────────────────
    // solver.c:501-502
    fastBodySim.rotation0Cos = fastBodySim.cos;
    fastBodySim.rotation0Sin = fastBodySim.sin;
    fastBodySim.center0X = fastBodySim.centerX;
    fastBodySim.center0Y = fastBodySim.centerY;

    // shape.aabb already set per-shape above; check fat AABB (solver.c:512-526).
    let refitIndex = fastBodyRecord.shapeHead;
    while (refitIndex !== NULL_INDEX) {
      const shape = state.shapes.get(refitIndex);
      refitIndex = shape.nextShape;

      if (
        !(
          shape.fatAabbMinX <= shape.aabbMinX &&
          shape.fatAabbMinY <= shape.aabbMinY &&
          shape.aabbMaxX <= shape.fatAabbMaxX &&
          shape.aabbMaxY <= shape.fatAabbMaxY
        )
      ) {
        const margin = shape.aabbMargin;
        shape.fatAabbMinX = shape.aabbMinX - margin;
        shape.fatAabbMinY = shape.aabbMinY - margin;
        shape.fatAabbMaxX = shape.aabbMaxX + margin;
        shape.fatAabbMaxY = shape.aabbMaxY + margin;
        fastBodySim.flags |= ENLARGE_BOUNDS;
      }
    }
  }

  // Sensor TOI hits: no-op stub (solver.c:531-537 is deferred — see module header).
}

// ─── Bullet-body proxy enlarge pass ──────────────────────────────────────────

/**
 * After the bullet CCD stage, walk the bullet body indices and enlarge
 * broad-phase proxies for shapes marked with `enlargedAABB`.
 *
 * Mirrors the serial proxy-enlarge loop in `b2Solve` (physics_world.c:1917-1958):
 * for each bullet body with `ENLARGE_BOUNDS` set, walk its shapes and call
 * `enlargeProxy` for shapes that have `enlargedAABB = true`.
 *
 * Called by `engineStep` after the bullet-body solveContinuous loop.
 */
export function enlargeBulletProxies(state: PhysicsState, bulletBodies: readonly number[]): void {
  const awakeSet = state.solverSets[2]!; // AWAKE_SET = 2

  for (const simIndex of bulletBodies) {
    const bulletBodySim = awakeSet.bodySims[simIndex]!;
    if ((bulletBodySim.flags & ENLARGE_BOUNDS) === 0) {
      continue;
    }
    // Clear flag (physics_world.c:1929: bulletBodySim->flags &= ~b2_enlargeBounds).
    bulletBodySim.flags &= ~ENLARGE_BOUNDS;

    const bodyRecord = state.bodies.records[bulletBodySim.bodyId];
    if (bodyRecord === undefined) {
      continue;
    }

    let shapeIndex = bodyRecord.shapeHead;
    while (shapeIndex !== NULL_INDEX) {
      const shape = state.shapes.get(shapeIndex);
      shapeIndex = shape.nextShape;

      if (!shape.enlargedAABB) {
        continue; // physics_world.c:1939
      }
      // Clear flag (physics_world.c:1946: shape->enlargedAABB = false).
      shape.enlargedAABB = false;

      if (shape.proxyKey === -1) {
        continue;
      }

      // Enlarge the broad-phase proxy (physics_world.c:1955).
      state.broadPhase.enlargeProxy(shape.proxyKey, {
        lowerBound: { x: shape.fatAabbMinX, y: shape.fatAabbMinY },
        upperBound: { x: shape.fatAabbMaxX, y: shape.fatAabbMaxY },
      });
    }
  }
}

// ─── Private helpers ──────────────────────────────────────────────────────────

/** Build a {@link import("./distance.js").ShapeProxy} for GJK / TOI from an
 * {@link InternalShape}. Mirrors `b2MakeShapeDistanceProxy` (shape.c:1024-1045).
 * Duplicates the logic in `engine/sensor.ts:makeShapeDistanceProxy`; deferred
 * to a shared helper in a future refactor. */
function _makeShapeDistanceProxy(shape: InternalShape): ReturnType<typeof makeProxy> {
  const g = shape.geometry;
  switch (g.kind) {
    case "circle":
      return makeProxy([{ x: g.cx, y: g.cy }], 1, g.radius);
    case "capsule":
      return makeProxy(
        [
          { x: g.ax, y: g.ay },
          { x: g.bx, y: g.by },
        ],
        2,
        g.radius
      );
    case "segment":
      return makeProxy(
        [
          { x: g.ax, y: g.ay },
          { x: g.bx, y: g.by },
        ],
        2,
        0
      );
    case "chainSegment":
      return makeProxy(
        [
          { x: g.ax, y: g.ay },
          { x: g.bx, y: g.by },
        ],
        2,
        0
      );
    case "polygon": {
      const pts: Array<{ x: number; y: number }> = [];
      for (let i = 0; i < g.count; i++) {
        pts.push({ x: g.vertices[i * 2]!, y: g.vertices[i * 2 + 1]! });
      }
      return makeProxy(pts, g.count, g.radius);
    }
  }
}

/** Centroid of a shape in shape-local space.
 * Mirrors `b2GetShapeCentroid` (shape.c:677-694). */
function _getShapeCentroid(shape: InternalShape): { x: number; y: number } {
  const g = shape.geometry;
  switch (g.kind) {
    case "circle":
      return { x: g.cx, y: g.cy };
    case "capsule":
      return { x: 0.5 * (g.ax + g.bx), y: 0.5 * (g.ay + g.by) };
    case "polygon":
      return { x: g.centroidX, y: g.centroidY };
    case "segment":
      return { x: 0.5 * (g.ax + g.bx), y: 0.5 * (g.ay + g.by) };
    case "chainSegment":
      return { x: 0.5 * (g.ax + g.bx), y: 0.5 * (g.ay + g.by) };
  }
}

/** Minimum extent of a shape centred at `localCenter` (unused for now —
 * consistent with box2d's `b2ComputeShapeExtent` fallback path).
 * Mirrors `b2ComputeShapeExtent(...).minExtent` (shape.c:798-866).
 * Used for the zero-fraction fallback circle radius (solver.c:350). */
function _computeShapeMinExtent(
  shape: InternalShape,
  _localCenter: { x: number; y: number }
): number {
  const g = shape.geometry;
  switch (g.kind) {
    case "circle":
      return g.radius;
    case "capsule":
      return g.radius;
    case "polygon": {
      let minExtent = 1e38;
      for (let i = 0; i < g.count; i++) {
        const vx = g.vertices[i * 2]!;
        const vy = g.vertices[i * 2 + 1]!;
        const nx = g.normals[i * 2]!;
        const ny = g.normals[i * 2 + 1]!;
        // planeOffset = dot(normal, vertex - centroid) (shape.c:831)
        const planeOffset = nx * (vx - g.centroidX) + ny * (vy - g.centroidY);
        if (planeOffset < minExtent) {
          minExtent = planeOffset;
        }
      }
      return minExtent + g.radius;
    }
    case "segment":
    case "chainSegment":
      return 0;
  }
}
