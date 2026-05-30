// Internal shape model. The engine-layer counterpart to the public geometry
// components (Box, Circle, Capsule, Segment, Polygon, Chain).
//
// VP-8 scope: type, geometry union, local pose, local centroid, world AABB.
// VP-11 scope: body linkage, material/filter/sensor fields, broad-phase proxy
//              fields (proxyKey, fatAabb*), shape linked-list on body.
// VP-12: no mass fields on InternalShape (mass lives on BodySim).
//
// Engine module boundary: import only from math/, util/, and sibling engine/.
//
// Upstream sources:
//   box2d/include/box2d/collision.h  — b2ShapeType enum, b2ChainSegment
//   box2d/src/geometry.c             — shape construction
//   box2d/src/hull.c                 — hull validation
//   box2d/src/shape.c                — b2CreateShape (proxy, linked-list, material)
//                                       b2ComputeShapeMargin, b2UpdateShapeAABBs

import type { AABB } from "../math/aabb.js";
import {
  AABB_MARGIN_FRACTION,
  LINEAR_SLOP,
  MAX_AABB_MARGIN,
  SPECULATIVE_DISTANCE,
} from "../math/constants.js";
import { mulTransforms, type Transform } from "../math/transform.js";
import { NULL_INDEX, type BodyHandle, type ShapeHandle } from "../util/handle.js";
import { IdPool } from "../util/id_pool.js";
import type { BroadPhase } from "./broad_phase.js";
import { type InternalBody, STATIC_BODY } from "./body.js";
import {
  computeAABB,
  computeHull,
  makeBox,
  makePolygon,
  validateHull,
  type ChainSegmentGeometry,
  type GeometryUnion,
  type PolygonGeometry,
  MAX_POLYGON_VERTICES,
} from "./geometry.js";

// Re-export GeometryUnion so callers can import it from here.
export type { GeometryUnion, PolygonGeometry, ChainSegmentGeometry };

// ─── AABB margin helpers (b2ComputeShapeMargin / b2UpdateShapeAABBs) ──────────
//
// Shared by PhysicsShapeLifecycle, PhysicsShapePoseSync, and PhysicsPoseSyncIn
// so the margin rule lives in exactly one place.
//
// Box2D rule (b2UpdateShapeAABBs in box2d/src/shape.c):
//   tight = computeAABB(geom, worldXf) ± speculativeDistance
//   fat   = tight ± (static ? speculativeDistance : aabbMargin)
// "Cannot be zero due to TOI tolerance."

/**
 * Compute the per-shape AABB motion margin. Mirrors `b2ComputeShapeMargin`.
 * Returns a value capped to {@link MAX_AABB_MARGIN}.
 */
export function computeShapeMargin(geom: GeometryUnion): number {
  let raw: number;
  switch (geom.kind) {
    case "circle":
      raw = geom.radius;
      break;
    case "capsule": {
      const dx = geom.bx - geom.ax;
      const dy = geom.by - geom.ay;
      raw = 0.5 * Math.sqrt(dx * dx + dy * dy) + geom.radius;
      break;
    }
    case "segment":
    case "chainSegment": {
      const dx = geom.bx - geom.ax;
      const dy = geom.by - geom.ay;
      raw = 0.5 * Math.sqrt(dx * dx + dy * dy);
      break;
    }
    case "polygon": {
      const cx = geom.centroidX;
      const cy = geom.centroidY;
      let maxSq = 0;
      for (let i = 0; i < geom.count; i++) {
        const vx = geom.vertices[i * 2]! - cx;
        const vy = geom.vertices[i * 2 + 1]! - cy;
        const sq = vx * vx + vy * vy;
        if (sq > maxSq) {
          maxSq = sq;
        }
      }
      raw = Math.sqrt(maxSq);
      break;
    }
  }
  return Math.min(MAX_AABB_MARGIN, AABB_MARGIN_FRACTION * raw);
}

/**
 * Compute and write the tight AABB and fat AABB on `shape` for the given world
 * transform and body type, mirroring `b2UpdateShapeAABBs`.
 *
 * Always resets BOTH the tight and the fat AABB. Use this for initial setup
 * and for teleport ("move") refits where the fat AABB must be recentred from
 * scratch. For per-step enlarge refits, use {@link refitBodyShapeProxies} with
 * `mode = "enlarge"`, which implements the fat-AABB hysteresis.
 *
 * Static bodies use `speculativeDistance` as the fat margin (not zero —
 * "Cannot be zero due to TOI tolerance"). Kinematic/dynamic bodies use
 * `computeShapeMargin` for the fat margin.
 *
 * Returns the fat AABB as an `{lowerBound, upperBound}` object suitable for
 * `BroadPhase.createProxy` / `moveProxy`.
 */
export function updateShapeAABBs(shape: InternalShape, worldXf: Transform, bodyType: number): AABB {
  const raw = computeAABB(shape.geometry, worldXf);
  const spec = SPECULATIVE_DISTANCE;

  // Tight AABB (geometry ± speculativeDistance).
  shape.aabbMinX = raw.lowerBound.x - spec;
  shape.aabbMinY = raw.lowerBound.y - spec;
  shape.aabbMaxX = raw.upperBound.x + spec;
  shape.aabbMaxY = raw.upperBound.y + spec;

  // Fat AABB: static → speculativeDistance extra; kinematic/dynamic → aabbMargin.
  const extra = bodyType === STATIC_BODY ? spec : shape.aabbMargin;
  shape.fatAabbMinX = shape.aabbMinX - extra;
  shape.fatAabbMinY = shape.aabbMinY - extra;
  shape.fatAabbMaxX = shape.aabbMaxX + extra;
  shape.fatAabbMaxY = shape.aabbMaxY + extra;

  return {
    lowerBound: { x: shape.fatAabbMinX, y: shape.fatAabbMinY },
    upperBound: { x: shape.fatAabbMaxX, y: shape.fatAabbMaxY },
  };
}

/**
 * Test whether the new tight AABB is still contained within the existing fat
 * AABB. When it is, no proxy move is needed. Mirrors the containment check in
 * `b2Body_SetTransform` (box2d/src/body.c).
 */
export function fatAabbContainsTight(shape: InternalShape): boolean {
  return (
    shape.fatAabbMinX <= shape.aabbMinX &&
    shape.fatAabbMinY <= shape.aabbMinY &&
    shape.aabbMaxX <= shape.fatAabbMaxX &&
    shape.aabbMaxY <= shape.fatAabbMaxY
  );
}

// ─── refitBodyShapeProxies (shared shape-AABB refit) ──────────────────────────
//
// The single refit rule, shared between the user-teleport path
// (`PhysicsPoseSyncIn`, box2d `b2Body_SetTransform`) and the per-step finalize
// (`finalizeBodies`, box2d `b2FinalizeBodiesTask`). Both walk the body's shape
// list, recompute each shape's tight world AABB, and — when the new tight AABB
// no longer fits inside the cached fat AABB — reset the fat AABB and update
// the broad-phase proxy.
//
// The proxy operation and fat-AABB reset strategy differ by caller:
//
//   "enlarge" (per-step finalize, b2FinalizeBodiesTask solver.c:686-732):
//     Box2D holds `shape->fatAABB` across steps and resets it only when the
//     freshly-computed tight AABB escapes it (solver.c:712-728):
//       if (!b2AABB_Contains(shape->fatAABB, aabb)) {
//         shape->fatAABB = {tight ± margin};
//         shape->enlargedAABB = true;         // mark for proxy enlarge
//       }
//     If contained, only the tight AABB is updated; the fat AABB and proxy
//     stay as-is. This is the fat-AABB hysteresis fix (M3 review → VP-26).
//
//   "move" (teleport, b2Body_SetTransform body.c:727-756):
//     The user explicitly moved the body, so both the tight and fat AABBs are
//     always recomputed from scratch and the proxy is always moved. No
//     hysteresis — the body's prior fat AABB is irrelevant.
//
// Shapes with no proxy (`proxyKey === -1`, on a disabled body) are skipped.

/** How the broad-phase proxy is updated when a shape's tight AABB outgrows its
 * fat AABB. See {@link refitBodyShapeProxies}. */
export type ProxyRefitMode = "move" | "enlarge";

/** Minimal view of a body's sim transform that the refit needs. */
interface RefitBodyView {
  transformX: number;
  transformY: number;
  cos: number;
  sin: number;
}

/**
 * Walk `body`'s shape list, recompute each shape's world tight AABB, and
 * update the broad-phase proxy when the tight AABB escapes the cached fat AABB.
 *
 * **"enlarge" mode (per-step finalize):** Implements box2d's fat-AABB
 * hysteresis (solver.c:712-728). If the new tight AABB fits inside the
 * existing `shape.fatAabb*`, only the tight AABB is updated — the fat AABB
 * and proxy stay unchanged. If the tight AABB escapes the fat AABB, the fat
 * is reset (tight ± `shape.aabbMargin`) and `enlargeProxy` is called.
 *
 * **"move" mode (teleport):** Always resets both tight and fat AABBs and
 * calls `moveProxy`. Mirrors `b2Body_SetTransform` (body.c:727-756), which
 * treats a user teleport as an unconditional recentre.
 *
 * Static bodies never enlarge (box2d asserts non-static in
 * `b2BroadPhase_EnlargeProxy`), but the containment check naturally skips
 * them since a static fat AABB never escapes unless teleported.
 */
export function refitBodyShapeProxies(
  shapes: ShapeStorage,
  broadPhase: BroadPhase,
  body: InternalBody,
  bodySim: RefitBodyView,
  mode: ProxyRefitMode
): void {
  const bodyXf: Transform = {
    p: { x: bodySim.transformX, y: bodySim.transformY },
    q: { c: bodySim.cos, s: bodySim.sin },
  };

  let shapeIndex = body.shapeHead;
  while (shapeIndex !== NULL_INDEX) {
    const shape = shapes.get(shapeIndex);
    shapeIndex = shape.nextShape;

    const localXf: Transform = {
      p: { x: shape.localX, y: shape.localY },
      q: { c: shape.localCos, s: shape.localSin },
    };
    const worldXf = mulTransforms(bodyXf, localXf);

    if (mode === "move") {
      // Teleport path (b2Body_SetTransform body.c:727-756): always reset both
      // tight and fat AABBs unconditionally, then move the proxy.
      // `updateShapeAABBs` writes both tight and fat (fat = tight ± margin).
      const fatAABB = updateShapeAABBs(shape, worldXf, body.type);
      if (shape.proxyKey === -1) {
        continue;
      }
      broadPhase.moveProxy(shape.proxyKey, fatAABB);
    } else {
      // Per-step enlarge path (b2FinalizeBodiesTask solver.c:703-728):
      // implement fat-AABB hysteresis — hold the fat AABB until the new
      // tight AABB escapes it; only then reset the fat and enlarge the proxy.
      //
      // Step 1: compute the new tight AABB and write it to shape.aabb*.
      // (Mirrors solver.c:705-710: aabb = b2ComputeShapeAABB + speculativeDistance.)
      const raw = computeAABB(shape.geometry, worldXf);
      const spec = SPECULATIVE_DISTANCE;
      shape.aabbMinX = raw.lowerBound.x - spec;
      shape.aabbMinY = raw.lowerBound.y - spec;
      shape.aabbMaxX = raw.upperBound.x + spec;
      shape.aabbMaxY = raw.upperBound.y + spec;

      if (shape.proxyKey === -1) {
        continue;
      }

      // Step 2: check if the new tight AABB still fits inside the existing fat
      // AABB (solver.c:712: b2AABB_Contains(shape->fatAABB, aabb)).
      if (
        shape.fatAabbMinX <= shape.aabbMinX &&
        shape.fatAabbMinY <= shape.aabbMinY &&
        shape.aabbMaxX <= shape.fatAabbMaxX &&
        shape.aabbMaxY <= shape.fatAabbMaxY
      ) {
        // Contained — fat AABB and proxy are unchanged. Only the tight AABB
        // (written above) is updated on the shape record. This is the hysteresis
        // — the proxy tree node keeps the larger cached fat AABB.
        continue;
      }

      // Step 3: tight escaped the fat — reset the fat AABB and enlarge the proxy.
      // (solver.c:716-727: fatAABB = {aabb ± margin}; shape->fatAABB = fatAABB;
      //  shape->enlargedAABB = true; b2SetBit(enlargedSimBitSet, simIndex).)
      const margin = body.type === STATIC_BODY ? spec : shape.aabbMargin;
      shape.fatAabbMinX = shape.aabbMinX - margin;
      shape.fatAabbMinY = shape.aabbMinY - margin;
      shape.fatAabbMaxX = shape.aabbMaxX + margin;
      shape.fatAabbMaxY = shape.aabbMaxY + margin;

      broadPhase.enlargeProxy(shape.proxyKey, {
        lowerBound: { x: shape.fatAabbMinX, y: shape.fatAabbMinY },
        upperBound: { x: shape.fatAabbMaxX, y: shape.fatAabbMaxY },
      });
    }
  }
}

// ─── ShapeType ────────────────────────────────────────────────────────────────

/**
 * Numeric shape type. Ordering matches `b2ShapeType` in Box2D:
 * circle=0, capsule=1, segment=2, polygon=3, chainSegment=4.
 * The narrow-phase dispatch table uses these values as row/column indices.
 */
export const enum ShapeType {
  Circle = 0,
  Capsule = 1,
  Segment = 2,
  Polygon = 3,
  ChainSegment = 4,
}

// ─── InternalShape ────────────────────────────────────────────────────────────

/**
 * Sparse, handle-indexed shape record. Populated incrementally across tickets:
 * VP-8 (geometry + pose + AABB), VP-11 (body linkage, material, filter,
 * sensor, proxy), VP-12 (mass lives on BodySim — nothing new here).
 *
 * Mirrors `b2Shape` from box2d/include/box2d/types.h, scoped to what the
 * engine needs through M2.
 */
export interface InternalShape {
  // ── Geometry & local pose ──────────────────────────────────────────────────
  type: ShapeType;
  geometry: GeometryUnion;

  /** Shape-local pose relative to the body origin. Set from
   * `ShapePosition` / `ShapeRotation`; default identity (0,0,1,0). */
  localX: number;
  localY: number;
  localCos: number;
  localSin: number;

  /** Centroid of the geometry in shape-local space (NOT body-local; the
   * local-pose transform is NOT applied). VP-12 mass/inertia applies it.
   * Mirrors `b2Shape.localCentroid`. */
  localCentroidX: number;
  localCentroidY: number;

  // ── Computed world AABB (tight, no fat margin) ────────────────────────────
  aabbMinX: number;
  aabbMinY: number;
  aabbMaxX: number;
  aabbMaxY: number;

  // ── Broad-phase proxy (VP-11) ─────────────────────────────────────────────
  /** Encoded proxy key `(proxyId << 2) | bodyType`. Mirrors `B2_PROXY_KEY`. */
  proxyKey: number;
  /** Fat (enlarged) AABB stored on the proxy for re-fit hysteresis.
   *  Mirrors `b2Shape.fatAABB` / box2d's `B2_AABB_MARGIN` enlargement. */
  fatAabbMinX: number;
  fatAabbMinY: number;
  fatAabbMaxX: number;
  fatAabbMaxY: number;

  // ── Body linkage (VP-11) ───────────────────────────────────────────────────
  /** Handle of the owning body. Mirrors `b2Shape.bodyId`. */
  bodyHandle: BodyHandle;
  /** The Vecs entity id (eid) this shape was created from. */
  entity: number;
  /** Previous shape in the body's intrusive linked list, or `NULL_INDEX`. */
  prevShape: number;
  /** Next shape in the body's intrusive linked list, or `NULL_INDEX`. */
  nextShape: number;

  // ── Material (VP-11) ──────────────────────────────────────────────────────
  /** Mass density (from `b2ShapeDef.density`). Default 1. */
  density: number;
  /** Coulomb friction coefficient. Default 0.6. */
  friction: number;
  /** Restitution coefficient. Default 0. */
  restitution: number;
  /** Rolling resistance. Default 0. */
  rollingResistance: number;
  /** Conveyor belt tangent speed. Default 0. */
  tangentSpeed: number;
  /** Opaque user material id. Default 0. */
  userMaterialId: number;

  // ── Collision filter (VP-11) ──────────────────────────────────────────────
  /** Category bitmask. Default 1. */
  categoryBits: number;
  /** Mask bitmask (which categories this shape collides with). Default 0xffffffff. */
  maskBits: number;
  /** Group index (negative = never collide, positive = always). Default 0. */
  groupIndex: number;

  // ── Sensor / event flags (VP-11) ──────────────────────────────────────────
  /** Whether this shape is a sensor (overlap-only, no collision response). */
  sensor: boolean;
  /** Opt-in to contact begin/end events. */
  enableContactEvents: boolean;
  /** Opt-in to hit events (fast contacts). */
  enableHitEvents: boolean;
  /** Opt-in to sensor overlap events. */
  enableSensorEvents: boolean;
  /** Index into PhysicsState.sensors (-1 until M3 sensor bookkeeping). */
  sensorIndex: number;

  // ── CCD proxy fields (VP-24) ───────────────────────────────────────────────
  /** Pre-computed fat-AABB motion margin (= `computeShapeMargin(geometry)`).
   * Cached once at shape creation so `solveContinuous` does not recompute it
   * on every TOI step. Mirrors `b2Shape.aabbMargin` (shape.h). */
  aabbMargin: number;
  /** Transient per-step flag: this shape's AABB was enlarged in `solveContinuous`
   * and its broad-phase proxy must be grown in the bullet-proxy-enlarge loop.
   * Mirrors `b2Shape.enlargedAABB` (shape.h). Cleared by the enlarge loop. */
  enlargedAABB: boolean;
}

// ─── ShapeStorage ─────────────────────────────────────────────────────────────

/**
 * Owns the sparse {@link InternalShape} table and the handle allocator.
 * Mirrors {@link BodyStorage} from `engine/body.ts`.
 */
export class ShapeStorage {
  /** Sparse, indexed by a {@link ShapeHandle}'s index; `undefined` = freed. */
  public readonly records: (InternalShape | undefined)[] = [];

  /** Allocates shape handle indices, stamping each with a generation. */
  public readonly idPool = new IdPool<ShapeHandle>();

  /** Live shape at a handle index. Throws if the slot is empty. */
  public get(index: number): InternalShape {
    const shape = this.records[index];
    if (shape === undefined) {
      throw new Error(`no shape at index ${index}`);
    }
    return shape;
  }
}

// ─── Per-shape constructors ────────────────────────────────────────────────────
//
// These take plain numbers (engine must not import components/) and a world
// transform (for the initial AABB computation). The local pose fields are
// seeded from the transform; VP-11 will override them from ShapePosition/
// ShapeRotation.

/** Build an {@link InternalShape} for a circle. */
export function makeCircleShape(radius: number, xf: Transform): InternalShape {
  const geom = { kind: "circle" as const, cx: 0, cy: 0, radius };
  const aabb = computeAABB(geom, xf);
  return makeShape(ShapeType.Circle, geom, xf, 0, 0, aabb);
}

/** Allocate a shape handle and store a fully-initialised `InternalShape`
 * record in {@link ShapeStorage}. Returns the handle so the caller can
 * store it on the body's linked list and `shapeByEntity`. This is the
 * storage-layer counterpart to box2d's `b2CreateShape` allocation block.
 *
 * All linked-list and body-linkage fields (`prevShape`, `nextShape`,
 * `bodyHandle`) are zeroed/sentinel here; the caller must set them after
 * this returns.
 */
export function createShape(storage: ShapeStorage, shape: InternalShape): ShapeHandle {
  const handle = storage.idPool.allocate();
  storage.records[handle.index] = shape;
  return handle;
}

/** Free a shape slot back to the pool. */
export function freeShape(storage: ShapeStorage, handle: ShapeHandle): void {
  storage.records[handle.index] = undefined;
  storage.idPool.free(handle);
}

/** Build an {@link InternalShape} for a capsule. */
export function makeCapsuleShape(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  radius: number,
  xf: Transform
): InternalShape {
  const geom = { kind: "capsule" as const, ax, ay, bx, by, radius };
  const aabb = computeAABB(geom, xf);
  // Centroid at midpoint of the two centers.
  const centX = 0.5 * (ax + bx);
  const centY = 0.5 * (ay + by);
  return makeShape(ShapeType.Capsule, geom, xf, centX, centY, aabb);
}

/** Build an {@link InternalShape} for a two-sided segment. */
export function makeSegmentShape(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  xf: Transform
): InternalShape {
  const geom = { kind: "segment" as const, ax, ay, bx, by };
  const aabb = computeAABB(geom, xf);
  const centX = 0.5 * (ax + bx);
  const centY = 0.5 * (ay + by);
  return makeShape(ShapeType.Segment, geom, xf, centX, centY, aabb);
}

/**
 * Build an {@link InternalShape} for a convex polygon from a user-supplied
 * vertex array.
 *
 * Validates convexity on construction (PLAN.md → _Component Model_: "validate
 * convexity on create not update"). Throws if:
 * - more than {@link MAX_POLYGON_VERTICES} vertices are supplied, or
 * - `b2ComputeHull` / `b2ValidateHull` reject the vertices as non-convex.
 */
export function makePolygonShape(
  pts: ReadonlyArray<{ x: number; y: number }>,
  radius: number,
  xf: Transform
): InternalShape {
  if (pts.length > MAX_POLYGON_VERTICES) {
    throw new Error(
      `Polygon has ${pts.length} vertices but the maximum is ${MAX_POLYGON_VERTICES}`
    );
  }

  const hull = computeHull(pts);
  if (hull.count < 3 || !validateHull(hull)) {
    throw new Error(
      `Polygon vertices do not form a valid convex hull (${pts.length} input points, hull count=${hull.count}). ` +
        "Check that points are not collinear and that the polygon is convex."
    );
  }

  const geom = makePolygon(hull, radius);
  const aabb = computeAABB(geom, xf);
  return makeShape(ShapeType.Polygon, geom, xf, geom.centroidX, geom.centroidY, aabb);
}

/**
 * Expand a chain of points into per-segment {@link InternalShape} records.
 *
 * One-sided collision: each segment's right side is the collision surface
 * (matching `b2ChainSegment`). Ghost vertices prevent internal collisions:
 * - Open chain: first segment's ghost1 reflects the direction before pts[0];
 *   last segment's ghost2 reflects the direction after pts[N-1].
 * - Loop chain: ghost1/ghost2 wrap around.
 *
 * The `chainId` field is 0; VP-11 will fill it in when linking chain shapes
 * to their owning body.
 *
 * @param points - At least 2 points (the chain generates `points.length - 1`
 *   segments for open chains, `points.length` for loops).
 * @param loop - Whether the chain closes back to the first point.
 * @param xf - World transform for AABB computation.
 */
export function makeChainSegments(
  points: ReadonlyArray<{ x: number; y: number }>,
  loop: boolean,
  xf: Transform
): InternalShape[] {
  const n = points.length;
  const segCount = loop ? n : n - 1;
  const result: InternalShape[] = [];

  for (let i = 0; i < segCount; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % n]!;

    // Skip degenerate adjacent points (mirrors b2CreateChainSegmentShape check
    // in box2d/src/shape.c: endpoint distance must exceed B2_LINEAR_SLOP).
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (dx * dx + dy * dy <= LINEAR_SLOP * LINEAR_SLOP) {
      continue;
    }

    // Ghost vertex before a (ghost1).
    let ghost1x: number;
    let ghost1y: number;
    if (loop) {
      const prev = points[(i - 1 + n) % n]!;
      ghost1x = prev.x;
      ghost1y = prev.y;
    } else if (i === 0) {
      // Reflect: ghost1 = a + (a - b) = 2a - b
      ghost1x = 2 * a.x - b.x;
      ghost1y = 2 * a.y - b.y;
    } else {
      ghost1x = points[i - 1]!.x;
      ghost1y = points[i - 1]!.y;
    }

    // Ghost vertex after b (ghost2).
    let ghost2x: number;
    let ghost2y: number;
    if (loop) {
      const next = points[(i + 2) % n]!;
      ghost2x = next.x;
      ghost2y = next.y;
    } else if (i === segCount - 1) {
      // Reflect: ghost2 = b + (b - a) = 2b - a
      ghost2x = 2 * b.x - a.x;
      ghost2y = 2 * b.y - a.y;
    } else {
      ghost2x = points[i + 2]!.x;
      ghost2y = points[i + 2]!.y;
    }

    const geom: ChainSegmentGeometry = {
      kind: "chainSegment",
      ghost1X: ghost1x,
      ghost1Y: ghost1y,
      ax: a.x,
      ay: a.y,
      bx: b.x,
      by: b.y,
      ghost2X: ghost2x,
      ghost2Y: ghost2y,
      chainId: 0,
    };

    const aabb = computeAABB(geom, xf);
    const centX = 0.5 * (a.x + b.x);
    const centY = 0.5 * (a.y + b.y);
    result.push(makeShape(ShapeType.ChainSegment, geom, xf, centX, centY, aabb));
  }

  return result;
}

// ─── Internal helper ──────────────────────────────────────────────────────────

/** Build an {@link InternalShape} from pre-computed parts. Local pose is seeded
 * from the supplied transform. VP-11's `createShape` (storage-layer) overwrites
 * the body-linkage, material, filter, proxy, and event fields after calling
 * one of the per-shape constructors. Sentinel values are used so the record is
 * always valid before those fields are set. */
function makeShape(
  type: ShapeType,
  geometry: GeometryUnion,
  xf: Transform,
  centX: number,
  centY: number,
  aabb: AABB
): InternalShape {
  // A placeholder BodyHandle that is overwritten by VP-11 before the shape is
  // exposed to any consumer. The generation 0 marks it as "not yet linked".
  const placeholderBodyHandle = { index: NULL_INDEX, generation: 0 } as unknown as BodyHandle;
  return {
    type,
    geometry,
    localX: xf.p.x,
    localY: xf.p.y,
    localCos: xf.q.c,
    localSin: xf.q.s,
    localCentroidX: centX,
    localCentroidY: centY,
    aabbMinX: aabb.lowerBound.x,
    aabbMinY: aabb.lowerBound.y,
    aabbMaxX: aabb.upperBound.x,
    aabbMaxY: aabb.upperBound.y,
    // Broad-phase proxy — filled by VP-11 lifecycle after createProxy.
    proxyKey: -1,
    fatAabbMinX: aabb.lowerBound.x,
    fatAabbMinY: aabb.lowerBound.y,
    fatAabbMaxX: aabb.upperBound.x,
    fatAabbMaxY: aabb.upperBound.y,
    // Body linkage — filled by VP-11 lifecycle after insertion.
    bodyHandle: placeholderBodyHandle,
    entity: 0,
    prevShape: NULL_INDEX,
    nextShape: NULL_INDEX,
    // Material — box2d defaults from b2DefaultShapeDef / b2DefaultSurfaceMaterial.
    density: 1,
    friction: 0.6,
    restitution: 0,
    rollingResistance: 0,
    tangentSpeed: 0,
    userMaterialId: 0,
    // Collision filter — box2d defaults from b2DefaultFilter.
    categoryBits: 1,
    maskBits: 0xffffffff,
    groupIndex: 0,
    // Sensor / events — all off by default.
    sensor: false,
    enableContactEvents: false,
    enableHitEvents: false,
    enableSensorEvents: false,
    sensorIndex: -1,
    // CCD fields (VP-24): aabbMargin pre-computed once; enlargedAABB is transient.
    aabbMargin: computeShapeMargin(geometry),
    enlargedAABB: false,
  };
}
