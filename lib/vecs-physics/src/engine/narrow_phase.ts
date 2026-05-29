// Narrow-phase shape-type-pair dispatch table (VP-14).
//
// Ported from box2d/src/contact.c:
//   - b2InitializeContactRegisters / b2AddType  (dispatch registry)
//   - b2UpdateContact                            (collide fn selection + call)
//
// The registry mirrors box2d's s_registers[type1][type2] 5×5 table.
// Each registered entry records the canonical collide function and whether
// the entry is "primary" (argument order matches the collide fn) or "flipped"
// (arguments must be swapped before calling, and the resulting manifold must
// be flipped to restore the A→B normal convention).
//
// Transform convention:
//   computeManifold callers pass BODY world transforms (one per shape). The
//   function composes each shape's world transform internally from the body
//   transform and the shape-local pose stored on InternalShape
//   (localX/Y/Cos/Sin), then dispatches to the collide functions using those
//   composed transforms. After dispatch the returned anchors are converted from
//   shape-origin-relative to body-origin-relative by adding the world vector
//   from each body origin to its shape origin. VP-15/M3 passes body world
//   transforms directly.
//
// Engine module boundary: import only from math/, engine/manifold/*, engine/shape.ts.

import { mulTransforms, type Transform } from "../math/transform.js";

import {
  emptyManifold,
  type Manifold,
  type ManifoldPoint,
  type SimplexCache,
} from "./manifold/types.js";
import {
  collideCircles,
  collideCapsuleAndCircle,
  collidePolygonAndCircle,
  type CircleShape,
  type CapsuleShape as CirclesCapsuleShape,
  type PolygonShape as CirclesPolygonShape,
} from "./manifold/circles.js";
import { collidePolygons, type PolygonShape } from "./manifold/polygons.js";
import {
  collideCapsules,
  collideSegmentAndCapsule,
  collidePolygonAndCapsule,
  type CapsuleShape,
  type SegmentShape as CapsuleSegmentShape,
} from "./manifold/capsules.js";
import {
  collideSegmentAndCircle,
  collideSegmentAndPolygon,
  type SegmentShape,
} from "./manifold/segments.js";
import {
  collideChainSegmentAndCircle,
  collideChainSegmentAndCapsule,
  collideChainSegmentAndPolygon,
  type ChainSegmentShape,
} from "./manifold/chain_segments.js";

import { ShapeType, type InternalShape } from "./shape.js";
import type { GeometryUnion } from "./geometry.js";

// ─── Collide function signature ───────────────────────────────────────────────

// Mirrors b2ManifoldFcn: takes two geometries + world transforms + simplex
// cache and returns a Manifold. The geometry types are erased to `unknown`
// here; each dispatch entry casts appropriately.
type CollideFn = (
  geomA: unknown,
  xfA: Transform,
  geomB: unknown,
  xfB: Transform,
  cache: SimplexCache
) => Manifold;

// ─── ContactRegister ─────────────────────────────────────────────────────────

// Mirrors struct b2ContactRegister.
interface ContactRegister {
  /** The canonical collide function for this pair. */
  fn: CollideFn;
  /**
   * True when the registered argument order matches the canonical collide fn
   * (typeA is the "first" shape type for this fn). False when the pair is the
   * reverse: arguments must be swapped before calling fn, and the resulting
   * manifold must be flipped to restore the A→B normal.
   *
   * Mirrors b2ContactRegister.primary.
   */
  primary: boolean;
}

// ─── Registry (mirrors s_registers[b2_shapeTypeCount][b2_shapeTypeCount]) ────

// Indexed as _registry[typeA][typeB].
// undefined = no collide fn registered for this pair (e.g. segment–segment).
const _registry: Array<Array<ContactRegister | undefined>> = Array.from({ length: 5 }, () =>
  new Array<ContactRegister | undefined>(5).fill(undefined)
);

// Mirrors b2AddType: registers the canonical entry (primary=true) and the
// reverse entry (primary=false), sharing the same fn pointer.
function _addType(fn: CollideFn, type1: ShapeType, type2: ShapeType): void {
  _registry[type1]![type2] = { fn, primary: true };
  if (type1 !== type2) {
    _registry[type2]![type1] = { fn, primary: false };
  }
}

// ─── b2InitializeContactRegisters ────────────────────────────────────────────
//
// Mirrors the static initialiser in contact.c.
// Wraps each b2Collide* function so it accepts (unknown, xf, unknown, xf, cache)
// and delegates with the correct casts.

_addType(
  // b2CircleManifold
  (gA, xfA, gB, xfB, _cache) => collideCircles(gA as CircleShape, xfA, gB as CircleShape, xfB),
  ShapeType.Circle,
  ShapeType.Circle
);

_addType(
  // b2CapsuleAndCircleManifold
  (gA, xfA, gB, xfB, _cache) =>
    collideCapsuleAndCircle(gA as CirclesCapsuleShape, xfA, gB as CircleShape, xfB),
  ShapeType.Capsule,
  ShapeType.Circle
);

_addType(
  // b2CapsuleManifold
  (gA, xfA, gB, xfB, _cache) => collideCapsules(gA as CapsuleShape, xfA, gB as CapsuleShape, xfB),
  ShapeType.Capsule,
  ShapeType.Capsule
);

_addType(
  // b2PolygonAndCircleManifold
  (gA, xfA, gB, xfB, _cache) =>
    collidePolygonAndCircle(gA as CirclesPolygonShape, xfA, gB as CircleShape, xfB),
  ShapeType.Polygon,
  ShapeType.Circle
);

_addType(
  // b2PolygonAndCapsuleManifold
  (gA, xfA, gB, xfB, _cache) =>
    collidePolygonAndCapsule(gA as PolygonShape, xfA, gB as CapsuleShape, xfB),
  ShapeType.Polygon,
  ShapeType.Capsule
);

_addType(
  // b2PolygonManifold
  (gA, xfA, gB, xfB, _cache) => collidePolygons(gA as PolygonShape, xfA, gB as PolygonShape, xfB),
  ShapeType.Polygon,
  ShapeType.Polygon
);

_addType(
  // b2SegmentAndCircleManifold
  (gA, xfA, gB, xfB, _cache) =>
    collideSegmentAndCircle(gA as SegmentShape, xfA, gB as CircleShape, xfB),
  ShapeType.Segment,
  ShapeType.Circle
);

_addType(
  // b2SegmentAndCapsuleManifold
  (gA, xfA, gB, xfB, _cache) =>
    collideSegmentAndCapsule(gA as CapsuleSegmentShape, xfA, gB as CapsuleShape, xfB),
  ShapeType.Segment,
  ShapeType.Capsule
);

_addType(
  // b2SegmentAndPolygonManifold
  (gA, xfA, gB, xfB, _cache) =>
    collideSegmentAndPolygon(gA as SegmentShape, xfA, gB as PolygonShape, xfB),
  ShapeType.Segment,
  ShapeType.Polygon
);

_addType(
  // b2ChainSegmentAndCircleManifold
  (gA, xfA, gB, xfB, _cache) =>
    collideChainSegmentAndCircle(gA as ChainSegmentShape, xfA, gB as CircleShape, xfB),
  ShapeType.ChainSegment,
  ShapeType.Circle
);

_addType(
  // b2ChainSegmentAndCapsuleManifold
  (gA, xfA, gB, xfB, cache) =>
    collideChainSegmentAndCapsule(gA as ChainSegmentShape, xfA, gB as CapsuleShape, xfB, cache),
  ShapeType.ChainSegment,
  ShapeType.Capsule
);

_addType(
  // b2ChainSegmentAndPolygonManifold
  (gA, xfA, gB, xfB, cache) =>
    collideChainSegmentAndPolygon(gA as ChainSegmentShape, xfA, gB as PolygonShape, xfB, cache),
  ShapeType.ChainSegment,
  ShapeType.Polygon
);

// ─── Geometry extractor ───────────────────────────────────────────────────────

// Extract the raw geometry object from an InternalShape in the form expected
// by the collide functions. Each collide fn uses its own interface that is a
// subset of the corresponding GeometryUnion variant; plain destructuring works
// because the field names match.
function _geomOf(shape: InternalShape): GeometryUnion {
  return shape.geometry;
}

// ─── Manifold flip ────────────────────────────────────────────────────────────

// When the dispatch called fn(geomB, xfB, geomA, xfA) to produce a manifold
// whose normal points from B to A, we must flip it so the returned manifold's
// normal points from A to B — matching the caller's argument order.
//
// Flip semantics (mirrors b2UpdateContact's expectation after b2CreateContact
// swaps the order):
//   - normal  → negated
//   - each point: anchorA ↔ anchorB swapped (origin conventions swap too)
//   - separation, clipPoint, id: unchanged
function _flipManifold(m: Manifold): Manifold {
  const flipped: Manifold = {
    normal: { x: -m.normal.x, y: -m.normal.y },
    points: [_flipPoint(m.points[0]!), _flipPoint(m.points[1]!)],
    pointCount: m.pointCount,
  };
  return flipped;
}

function _flipPoint(p: ManifoldPoint): ManifoldPoint {
  return {
    clipPoint: { x: p.clipPoint.x, y: p.clipPoint.y },
    anchorA: { x: p.anchorB.x, y: p.anchorB.y },
    anchorB: { x: p.anchorA.x, y: p.anchorA.y },
    separation: p.separation,
    id: p.id,
  };
}

// ─── _shapeLocalXf ────────────────────────────────────────────────────────────

// Build the shape-local transform from the InternalShape's stored pose fields.
function _shapeLocalXf(shape: InternalShape): Transform {
  return {
    p: { x: shape.localX, y: shape.localY },
    q: { c: shape.localCos, s: shape.localSin },
  };
}

// ─── _addBodyOffset ───────────────────────────────────────────────────────────

// Shift every valid manifold point's anchor by the world vector from the body
// origin to the shape origin: anchorA += (shapeXf.p - bodyXf.p).
// This converts shape-origin-relative anchors to body-origin-relative anchors.
function _addBodyOffset(
  m: Manifold,
  levA: { x: number; y: number },
  levB: { x: number; y: number }
): void {
  for (let i = 0; i < m.pointCount; i++) {
    const mp = m.points[i]!;
    mp.anchorA = { x: mp.anchorA.x + levA.x, y: mp.anchorA.y + levA.y };
    mp.anchorB = { x: mp.anchorB.x + levB.x, y: mp.anchorB.y + levB.y };
  }
}

// ─── computeManifold ─────────────────────────────────────────────────────────

/**
 * Compute the contact manifold between two shapes.
 *
 * Mirrors the dispatch core of `b2UpdateContact` in contact.c, using the
 * registry built by `b2InitializeContactRegisters` / `b2AddType`.
 *
 * **Transform convention:** `bodyXfA` and `bodyXfB` are the BODY world
 * transforms for the bodies that own `shapeA` and `shapeB` respectively.
 * `computeManifold` composes each shape's world transform internally from the
 * body transform and the shape-local pose stored on {@link InternalShape}
 * (`localX`, `localY`, `localCos`, `localSin`), then dispatches to the collide
 * functions using those composed transforms.
 *
 * The returned manifold's `anchorA` / `anchorB` are relative to each shape's
 * **body origin** in world space (matching `b2ManifoldPoint.anchorA/B` and the
 * TGS solver's lever-arm convention). The `normal` always points from `shapeA`
 * to `shapeB` in world space, regardless of which canonical collide fn was
 * invoked. If the pair is not registered (e.g. segment–segment), returns an
 * empty manifold with `pointCount = 0`.
 *
 * @param shapeA   - First shape (caller's A side).
 * @param bodyXfA  - Body world transform for shapeA's owning body.
 * @param shapeB   - Second shape (caller's B side).
 * @param bodyXfB  - Body world transform for shapeB's owning body.
 * @param cache    - GJK simplex cache; zero-initialise for first call on a
 *                   contact. Passed through to chain-segment and distance fns.
 * @returns A {@link Manifold} with `normal` pointing from A→B and anchors
 *          relative to each shape's body origin. `pointCount=0` when the
 *          shapes are not touching or the pair is unregistered.
 */
export function computeManifold(
  shapeA: InternalShape,
  bodyXfA: Transform,
  shapeB: InternalShape,
  bodyXfB: Transform,
  cache: SimplexCache
): Manifold {
  const reg = _registry[shapeA.type]?.[shapeB.type];
  if (reg === undefined) {
    // No collide fn for this pair (e.g. segment–segment, chainSegment–chainSegment).
    return emptyManifold();
  }

  // Compose each shape's world transform: shapeXf = bodyXf * shapeLocalXf.
  const shapeXfA = mulTransforms(bodyXfA, _shapeLocalXf(shapeA));
  const shapeXfB = mulTransforms(bodyXfB, _shapeLocalXf(shapeB));

  // World vector from each body origin to its shape origin (the lever arm that
  // the collide fns are unaware of). Adding this to the returned anchors
  // converts shape-origin-relative anchors to body-origin-relative anchors.
  const levA = { x: shapeXfA.p.x - bodyXfA.p.x, y: shapeXfA.p.y - bodyXfA.p.y };
  const levB = { x: shapeXfB.p.x - bodyXfB.p.x, y: shapeXfB.p.y - bodyXfB.p.y };

  const geomA = _geomOf(shapeA);
  const geomB = _geomOf(shapeB);

  let m: Manifold;
  if (reg.primary) {
    // Canonical order: fn expects (A, B).
    m = reg.fn(geomA, shapeXfA, geomB, shapeXfB, cache);
    // anchorA is shape-A-origin-relative; anchorB is shape-B-origin-relative.
    _addBodyOffset(m, levA, levB);
  } else {
    // Flipped order: fn was registered for (B's type, A's type).
    // Call with swapped arguments — in this call the roles are: first arg =
    // shapeB (now "A" inside the collide fn), second arg = shapeA (now "B").
    // The returned manifold has anchorA relative to shapeB's origin and
    // anchorB relative to shapeA's origin.
    // _flipManifold swaps anchorA ↔ anchorB so the result is in caller (A,B)
    // order: anchorA relative to shapeA's origin, anchorB relative to
    // shapeB's origin.  Then _addBodyOffset applies the correct lever arm per
    // side.
    m = _flipManifold(reg.fn(geomB, shapeXfB, geomA, shapeXfA, cache));
    _addBodyOffset(m, levA, levB);
  }
  return m;
}
