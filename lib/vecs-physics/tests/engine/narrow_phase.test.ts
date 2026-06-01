// Tests for engine/narrow_phase.ts (VP-14 / M2 anchor fix).
//
// Strategy: assert that computeManifold routes each registered shape-type pair
// to the correct manifold function and produces the same result as calling the
// VP-13 collide* function directly. Both argument orderings are tested; the
// flipped order must produce the negated normal and swapped anchors but the
// same contact geometry.
//
// All helpers build shapes with identity local pose (localX=0, localY=0,
// localCos=1, localSin=0). In that case the body world transform equals the
// shape world transform, so callers pass the body world transform directly —
// exactly matching the new computeManifold contract.
//
// The "offset shape" section at the bottom pins the anchor-offset fix: shapes
// with non-identity local poses must return anchors relative to the body origin
// (not the shape origin).

import { describe, expect, it } from "vitest";

import { IDENTITY, type Transform } from "../../src/math/transform.js";
import { makeRot } from "../../src/math/rot.js";

import {
  collideCircles,
  collideCapsuleAndCircle,
  collidePolygonAndCircle,
} from "../../src/engine/manifold/circles.js";
import { collidePolygons } from "../../src/engine/manifold/polygons.js";
import { collideCapsules, collidePolygonAndCapsule } from "../../src/engine/manifold/capsules.js";
import { collideSegmentAndCircle } from "../../src/engine/manifold/segments.js";
import { collideChainSegmentAndPolygon } from "../../src/engine/manifold/chain_segments.js";
import { emptySimplexCache } from "../../src/engine/manifold/types.js";
import { makeBox } from "../../src/engine/geometry.js";

import { computeManifold } from "../../src/engine/narrow_phase.js";
import {
  makeCircleShape,
  makeCapsuleShape,
  makeSegmentShape,
  makePolygonShape,
  makeChainSegments,
  type InternalShape,
} from "../../src/engine/shape.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

const EPS = 1e-4;

function near(a: number, b: number, tol = EPS): boolean {
  return Math.abs(a - b) <= tol;
}

function xfAt(x: number, y: number, angle = 0): Transform {
  return { p: { x, y }, q: makeRot(angle) };
}

// Build a unit circle InternalShape with identity local pose.
// The caller passes the body world transform to computeManifold separately.
function circleShape(_xf: Transform = IDENTITY): InternalShape {
  return makeCircleShape(1, IDENTITY);
}

// Build a capsule InternalShape from (-0.5,0) to (0.5,0) with radius 0.25,
// identity local pose.
function capsuleShape(_xf: Transform = IDENTITY): InternalShape {
  return makeCapsuleShape(-0.5, 0, 0.5, 0, 0.25, IDENTITY);
}

// Build a 1×1 box polygon InternalShape with identity local pose.
function boxShape(_xf: Transform = IDENTITY): InternalShape {
  const pts = [
    { x: -1, y: -1 },
    { x: 1, y: -1 },
    { x: 1, y: 1 },
    { x: -1, y: 1 },
  ];
  return makePolygonShape(pts, 0, IDENTITY);
}

// Build a horizontal segment InternalShape at y=0, identity local pose.
function segmentShape(_xf: Transform = IDENTITY): InternalShape {
  return makeSegmentShape(-1, 0, 1, 0, IDENTITY);
}

// Build a single chain segment InternalShape (just the first segment),
// identity local pose.
function chainSegShape(_xf: Transform = IDENTITY): InternalShape {
  const pts = [
    { x: -2, y: 0 },
    { x: 2, y: 0 },
  ];
  return makeChainSegments(pts, false, IDENTITY)[0]!;
}

// ─── flip invariant helper ────────────────────────────────────────────────────

// Verify that computeManifold(B, bodyXfB, A, bodyXfA) produces the correct
// flip of computeManifold(A, bodyXfA, B, bodyXfB):
//   - same pointCount
//   - normal negated
//   - anchorA ↔ anchorB swapped
//   - same separation values (same geometry, different labelling)
// xfA/xfB are BODY world transforms (matching the new computeManifold contract).
function expectFlipConsistency(
  shapeA: InternalShape,
  xfA: Transform,
  shapeB: InternalShape,
  xfB: Transform
): void {
  const cache1 = emptySimplexCache();
  const cache2 = emptySimplexCache();

  const fwd = computeManifold(shapeA, xfA, shapeB, xfB, cache1);
  const rev = computeManifold(shapeB, xfB, shapeA, xfA, cache2);

  expect(rev.pointCount).toBe(fwd.pointCount);

  if (fwd.pointCount > 0) {
    // Normal must be negated
    expect(near(rev.normal.x, -fwd.normal.x)).toBe(true);
    expect(near(rev.normal.y, -fwd.normal.y)).toBe(true);

    // Each point: anchorA ↔ anchorB swapped; separation identical
    for (let i = 0; i < fwd.pointCount; i++) {
      const p = fwd.points[i]!;
      const q = rev.points[i]!;
      expect(near(q.anchorA.x, p.anchorB.x)).toBe(true);
      expect(near(q.anchorA.y, p.anchorB.y)).toBe(true);
      expect(near(q.anchorB.x, p.anchorA.x)).toBe(true);
      expect(near(q.anchorB.y, p.anchorA.y)).toBe(true);
      expect(near(q.separation, p.separation)).toBe(true);
    }
  }
}

// ─── circle–circle ───────────────────────────────────────────────────────────

describe("computeManifold: circle–circle", () => {
  const xfA = IDENTITY;
  const xfB = xfAt(1.5, 0); // overlapping (sum of radii = 2 > 1.5)

  it("routes to collideCircles and matches direct call", () => {
    const sA = circleShape(xfA);
    const sB = circleShape(xfB);
    const direct = collideCircles(
      { cx: 0, cy: 0, radius: 1 },
      xfA,
      { cx: 0, cy: 0, radius: 1 },
      xfB
    );
    const dispatched = computeManifold(sA, xfA, sB, xfB, emptySimplexCache());
    expect(dispatched.pointCount).toBe(direct.pointCount);
    expect(near(dispatched.normal.x, direct.normal.x)).toBe(true);
    expect(near(dispatched.normal.y, direct.normal.y)).toBe(true);
    expect(near(dispatched.points[0].separation, direct.points[0].separation)).toBe(true);
  });

  it("same pair, reversed order → negated normal + swapped anchors", () => {
    expectFlipConsistency(circleShape(xfA), xfA, circleShape(xfB), xfB);
  });

  it("separated circles → pointCount=0", () => {
    const sA = circleShape(IDENTITY);
    const sB = circleShape(xfAt(10, 0));
    const m = computeManifold(sA, IDENTITY, sB, xfAt(10, 0), emptySimplexCache());
    expect(m.pointCount).toBe(0);
  });
});

// ─── polygon–circle (both argument orders) ───────────────────────────────────

describe("computeManifold: polygon–circle", () => {
  // Box centered at origin, circle at (1.5, 0) — overlapping
  const xfPoly = IDENTITY;
  const xfCircle = xfAt(1.5, 0);

  it("polygon+circle order matches collidePolygonAndCircle", () => {
    const sPoly = boxShape(xfPoly);
    const sCirc = circleShape(xfCircle);
    const box = makeBox(1, 1);
    const direct = collidePolygonAndCircle(box, xfPoly, { cx: 0, cy: 0, radius: 1 }, xfCircle);
    const dispatched = computeManifold(sPoly, xfPoly, sCirc, xfCircle, emptySimplexCache());
    expect(dispatched.pointCount).toBe(direct.pointCount);
    expect(near(dispatched.normal.x, direct.normal.x)).toBe(true);
    expect(near(dispatched.normal.y, direct.normal.y)).toBe(true);
    expect(near(dispatched.points[0].separation, direct.points[0].separation)).toBe(true);
  });

  it("circle+polygon order (flipped) → negated normal + swapped anchors", () => {
    expectFlipConsistency(boxShape(xfPoly), xfPoly, circleShape(xfCircle), xfCircle);
  });

  it("separated → pointCount=0", () => {
    const sPoly = boxShape(IDENTITY);
    const sCirc = circleShape(xfAt(10, 0));
    const m = computeManifold(sPoly, IDENTITY, sCirc, xfAt(10, 0), emptySimplexCache());
    expect(m.pointCount).toBe(0);
  });
});

// ─── polygon–polygon ─────────────────────────────────────────────────────────

describe("computeManifold: polygon–polygon", () => {
  // Two overlapping 1×1 boxes
  const xfA = IDENTITY;
  const xfB = xfAt(1.5, 0);

  it("matches collidePolygons direct call", () => {
    const sA = boxShape(xfA);
    const sB = boxShape(xfB);
    const box = makeBox(1, 1);
    const direct = collidePolygons(box, xfA, box, xfB);
    const dispatched = computeManifold(sA, xfA, sB, xfB, emptySimplexCache());
    expect(dispatched.pointCount).toBe(direct.pointCount);
    expect(near(dispatched.normal.x, direct.normal.x)).toBe(true);
    expect(near(dispatched.normal.y, direct.normal.y)).toBe(true);
  });

  // polygon–polygon is a symmetric pair (primary=true in both call orders).
  // collidePolygons(B,A) ≠ flip(collidePolygons(A,B)) in general because the
  // SAT algorithm may choose different reference/incident edges. Both calls
  // still produce valid touching contacts; we verify pointCount is consistent
  // and separations are negative (penetrating) for both orderings.
  it("reversed order also produces a touching contact with negative separation", () => {
    const sA = boxShape(xfA);
    const sB = boxShape(xfB);
    const fwd = computeManifold(sA, xfA, sB, xfB, emptySimplexCache());
    const rev = computeManifold(sB, xfB, sA, xfA, emptySimplexCache());
    expect(fwd.pointCount).toBeGreaterThan(0);
    expect(rev.pointCount).toBeGreaterThan(0);
    for (let i = 0; i < fwd.pointCount; i++) {
      expect(fwd.points[i]!.separation).toBeLessThan(0);
    }
    for (let i = 0; i < rev.pointCount; i++) {
      expect(rev.points[i]!.separation).toBeLessThan(0);
    }
  });
});

// ─── capsule–polygon ─────────────────────────────────────────────────────────

describe("computeManifold: capsule–polygon", () => {
  // Capsule at y=0 overlapping box at y=0 (capsule endpoints at ±0.5, poly
  // is a 1×1 box; move poly slightly so there is penetration)
  const xfPoly = xfAt(1.2, 0); // box centred at 1.2; capsule reaches 0.5+0.25=0.75 < 1.2?
  // Actually capsule reaches x=0.5+0.25=0.75 on the right; box left edge at 1.2-1=-0.2
  // → overlapping
  const xfCap = IDENTITY;

  it("polygon+capsule order matches collidePolygonAndCapsule", () => {
    const sPoly = boxShape(xfPoly);
    const sCap = capsuleShape(xfCap);
    // build a PolygonShape-shaped makeBox for direct call
    const box = makeBox(1, 1);
    const capsGeom = { ax: -0.5, ay: 0, bx: 0.5, by: 0, radius: 0.25 };
    const direct = collidePolygonAndCapsule(box, xfPoly, capsGeom, xfCap);
    const dispatched = computeManifold(sPoly, xfPoly, sCap, xfCap, emptySimplexCache());
    expect(dispatched.pointCount).toBe(direct.pointCount);
    if (direct.pointCount > 0) {
      expect(near(dispatched.normal.x, direct.normal.x)).toBe(true);
      expect(near(dispatched.normal.y, direct.normal.y)).toBe(true);
    }
  });

  it("capsule+polygon order (flipped) → negated normal + swapped anchors", () => {
    expectFlipConsistency(boxShape(xfPoly), xfPoly, capsuleShape(xfCap), xfCap);
  });
});

// ─── capsule–capsule ──────────────────────────────────────────────────────────

describe("computeManifold: capsule–capsule", () => {
  // Two capsules offset 0.4 units (radii=0.25 each, sum=0.5 > 0.4 → overlapping)
  const xfA = IDENTITY;
  const xfB = xfAt(0, 0.4);

  it("matches collideCapsules direct call", () => {
    const sA = capsuleShape(xfA);
    const sB = capsuleShape(xfB);
    const geom = { ax: -0.5, ay: 0, bx: 0.5, by: 0, radius: 0.25 };
    const direct = collideCapsules(geom, xfA, geom, xfB);
    const dispatched = computeManifold(sA, xfA, sB, xfB, emptySimplexCache());
    expect(dispatched.pointCount).toBe(direct.pointCount);
    if (direct.pointCount > 0) {
      expect(near(dispatched.normal.x, direct.normal.x)).toBe(true);
      expect(near(dispatched.normal.y, direct.normal.y)).toBe(true);
    }
  });

  it("reversed order → negated normal + swapped anchors", () => {
    expectFlipConsistency(capsuleShape(xfA), xfA, capsuleShape(xfB), xfB);
  });
});

// ─── capsule–circle ───────────────────────────────────────────────────────────

describe("computeManifold: capsule–circle", () => {
  // Capsule at origin, circle at (0, 1.0) → overlapping (cap radius 0.25 + circle 1 = 1.25 > 1)
  const xfCap = IDENTITY;
  const xfCirc = xfAt(0, 1.0);

  it("capsule+circle matches collideCapsuleAndCircle", () => {
    const sCap = capsuleShape(xfCap);
    const sCirc = circleShape(xfCirc);
    const capGeom = { ax: -0.5, ay: 0, bx: 0.5, by: 0, radius: 0.25 };
    const direct = collideCapsuleAndCircle(capGeom, xfCap, { cx: 0, cy: 0, radius: 1 }, xfCirc);
    const dispatched = computeManifold(sCap, xfCap, sCirc, xfCirc, emptySimplexCache());
    expect(dispatched.pointCount).toBe(direct.pointCount);
    if (direct.pointCount > 0) {
      expect(near(dispatched.normal.x, direct.normal.x)).toBe(true);
      expect(near(dispatched.normal.y, direct.normal.y)).toBe(true);
      expect(near(dispatched.points[0].separation, direct.points[0].separation)).toBe(true);
    }
  });

  it("circle+capsule order (flipped) → negated normal + swapped anchors", () => {
    expectFlipConsistency(capsuleShape(xfCap), xfCap, circleShape(xfCirc), xfCirc);
  });
});

// ─── segment–circle ───────────────────────────────────────────────────────────

describe("computeManifold: segment–circle", () => {
  // Horizontal segment at y=0 from (-1,0) to (1,0); circle of radius 1 at y=0.8
  // separation = 0.8 - 1 = -0.2 (overlapping)
  const xfSeg = IDENTITY;
  const xfCirc = xfAt(0, 0.8);

  it("segment+circle matches collideSegmentAndCircle", () => {
    const sSeg = segmentShape(xfSeg);
    const sCirc = circleShape(xfCirc);
    const segGeom = { ax: -1, ay: 0, bx: 1, by: 0 };
    const direct = collideSegmentAndCircle(segGeom, xfSeg, { cx: 0, cy: 0, radius: 1 }, xfCirc);
    const dispatched = computeManifold(sSeg, xfSeg, sCirc, xfCirc, emptySimplexCache());
    expect(dispatched.pointCount).toBe(direct.pointCount);
    if (direct.pointCount > 0) {
      expect(near(dispatched.normal.x, direct.normal.x)).toBe(true);
      expect(near(dispatched.normal.y, direct.normal.y)).toBe(true);
      expect(near(dispatched.points[0].separation, direct.points[0].separation)).toBe(true);
    }
  });

  it("circle+segment order (flipped) → negated normal + swapped anchors", () => {
    expectFlipConsistency(segmentShape(xfSeg), xfSeg, circleShape(xfCirc), xfCirc);
  });
});

// ─── chainSegment–polygon ─────────────────────────────────────────────────────

describe("computeManifold: chainSegment–polygon", () => {
  // Horizontal chain segment at y=0; polygon (1×1 box) at y=0.8 (overlapping)
  const xfChain = IDENTITY;
  const xfPoly = xfAt(0, 0.8);

  it("chainSegment+polygon matches collideChainSegmentAndPolygon", () => {
    const sChain = chainSegShape(xfChain);
    const sPoly = boxShape(xfPoly);
    const box = makeBox(1, 1);
    const cache = emptySimplexCache();
    const chainGeom = {
      ghost1X: sChain.geometry.kind === "chainSegment" ? sChain.geometry.ghost1X : 0,
      ghost1Y: sChain.geometry.kind === "chainSegment" ? sChain.geometry.ghost1Y : 0,
      ax: sChain.geometry.kind === "chainSegment" ? sChain.geometry.ax : 0,
      ay: sChain.geometry.kind === "chainSegment" ? sChain.geometry.ay : 0,
      bx: sChain.geometry.kind === "chainSegment" ? sChain.geometry.bx : 0,
      by: sChain.geometry.kind === "chainSegment" ? sChain.geometry.by : 0,
      ghost2X: sChain.geometry.kind === "chainSegment" ? sChain.geometry.ghost2X : 0,
      ghost2Y: sChain.geometry.kind === "chainSegment" ? sChain.geometry.ghost2Y : 0,
      chainId: 0,
    };
    const direct = collideChainSegmentAndPolygon(chainGeom, xfChain, box, xfPoly, cache);
    const dispatched = computeManifold(sChain, xfChain, sPoly, xfPoly, emptySimplexCache());
    // Both should agree on whether contact exists
    expect(dispatched.pointCount).toBe(direct.pointCount);
    if (direct.pointCount > 0) {
      expect(near(dispatched.normal.x, direct.normal.x)).toBe(true);
      expect(near(dispatched.normal.y, direct.normal.y)).toBe(true);
    }
  });

  it("polygon+chainSegment order (flipped) → negated normal + swapped anchors", () => {
    expectFlipConsistency(chainSegShape(xfChain), xfChain, boxShape(xfPoly), xfPoly);
  });
});

// ─── unregistered pair (segment–segment) → pointCount=0 ─────────────────────

describe("computeManifold: unregistered pair", () => {
  it("segment–segment → pointCount=0 (no collide fn registered)", () => {
    const sA = segmentShape(IDENTITY);
    const sB = segmentShape(xfAt(0, 0.5));
    const m = computeManifold(sA, IDENTITY, sB, xfAt(0, 0.5), emptySimplexCache());
    expect(m.pointCount).toBe(0);
  });
});

// ─── offset shape anchors (M2 regression fix) ────────────────────────────────
//
// These tests verify that returned anchors are relative to each shape's BODY
// origin, not the shape origin. Before the fix, computeManifold used the
// composed shape world transform as if it were the body transform, so the
// lever arm from the body origin to the shape origin was missing from the
// anchor.
//
// Setup for each sub-test:
//   Body A: world origin (bodyXfA = IDENTITY)
//   Shape A: local offset (localX, localY, and optionally a local rotation)
//            so its world position = bodyXfA.p + rotated local offset
//   Body B: identity body transform (bodyXfB = IDENTITY, shape at identity)
//   Shape B: identity local pose, placed so the shapes just overlap

describe("computeManifold: offset shape anchors (M2 fix)", () => {
  // Build a circle shape whose local pose (within its body) is given by
  // `localXf`.  The body world transform is IDENTITY, so the shape world
  // position equals localXf.p.
  function offsetCircleShape(radius: number, localXf: Transform): InternalShape {
    // makeCircleShape seeds localX/Y/Cos/Sin from the supplied xf, which is
    // exactly the shape-local pose we want.
    return makeCircleShape(radius, localXf);
  }

  // Build a box polygon shape with identity local pose at the given world xf.
  function offsetBoxShape(halfExtent: number, localXf: Transform): InternalShape {
    const pts = [
      { x: -halfExtent, y: -halfExtent },
      { x: halfExtent, y: -halfExtent },
      { x: halfExtent, y: halfExtent },
      { x: -halfExtent, y: halfExtent },
    ];
    return makePolygonShape(pts, 0, localXf);
  }

  it("circle-A with localX=2 vs circle-B at world x=3: anchorA includes +2 body→shape offset", () => {
    // Shape A: circle radius=1, offset +2 on x in body-local space.
    // Body A is at world origin → shape A world center = (2, 0).
    // Shape B: circle radius=1, identity local pose; its body is at world (3, 0).
    //   → shapes just overlap (distance=1, sum of radii=2 → sep=-1).
    const localXfA: Transform = { p: { x: 2, y: 0 }, q: { c: 1, s: 0 } };
    const sA = offsetCircleShape(1, localXfA);

    const bodyXfB = xfAt(3, 0);
    const sB = circleShape(IDENTITY); // identity local pose; its world xf = bodyXfB

    const bodyXfA = IDENTITY; // body A is at world origin
    const m = computeManifold(sA, bodyXfA, sB, bodyXfB, emptySimplexCache());

    expect(m.pointCount).toBe(1);

    // anchorA must be body-A-origin-relative.  The contact point is near the
    // midpoint of the overlap, world ≈ (2.5, 0).  Body A is at (0,0), so
    // anchorA.x ≈ 2.5 (definitely > 2, and certainly not ≈ 0.5 which the
    // broken code would return).
    expect(m.points[0]!.anchorA.x).toBeGreaterThan(2);
    // anchorB must be body-B-origin-relative.  Body B is at (3,0); world
    // contact ≈ (2.5,0) → anchorB.x ≈ -0.5.
    expect(m.points[0]!.anchorB.x).toBeLessThan(0);
  });

  it("circle-A with localX=2 vs circle-B: anchorA.x is approximately 2.5 (midpoint in body frame)", () => {
    // Same setup; verify the numeric value more precisely.
    const localXfA: Transform = { p: { x: 2, y: 0 }, q: { c: 1, s: 0 } };
    const sA = offsetCircleShape(1, localXfA);
    const sB = circleShape(IDENTITY);
    const bodyXfB = xfAt(3, 0);

    const m = computeManifold(sA, IDENTITY, sB, bodyXfB, emptySimplexCache());

    expect(m.pointCount).toBe(1);
    // World contact midpoint ≈ (2.5, 0); body A at (0,0) → anchorA.x ≈ 2.5.
    expect(m.points[0]!.anchorA.x).toBeCloseTo(2.5, 1);
    // Body B at (3,0) → anchorB.x ≈ -0.5.
    expect(m.points[0]!.anchorB.x).toBeCloseTo(-0.5, 1);
  });

  it("circle-A with local rotation (π/4) and localX=2: anchorA accounts for rotated offset", () => {
    // Shape A local offset: rotate 45° then translate (2, 0) in body frame.
    // The shape-local pose is just a translation+rotation; geometry is still
    // a unit circle at (cx=0, cy=0).  Shape world center = rotate(π/4)*{2,0}
    // = (√2, √2) ≈ (1.414, 1.414).
    const angle = Math.PI / 4;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    // localXf: translate (2,0) in body-local space, with a 45° rotation.
    // mulTransforms(bodyXf=IDENTITY, localXf) = localXf, so shape world xf =
    // {p:{2*cos, 2*sin}, q:{cos,sin}}.
    const localXfA: Transform = { p: { x: 2 * cos, y: 2 * sin }, q: { c: cos, s: sin } };
    const sA = offsetCircleShape(1, localXfA);

    // Place circle B so it overlaps with circle A at world (√2, √2).
    // B is a unit circle; shift it by 2*(√2,√2)/|…| ≈ along the same direction
    // at distance 1.5 → well within the sum of radii (2).
    const d = Math.sqrt(2);
    const bodyXfB = xfAt(d + 1.5 * (d / (d * Math.sqrt(2))), 1.5 * (d / (d * Math.sqrt(2))));
    // Simpler: just put B at (√2 + 1, √2) so it definitely overlaps.
    const bodyXfB2 = xfAt(d + 1, d);
    const sB = circleShape(IDENTITY);

    const m = computeManifold(sA, IDENTITY, sB, bodyXfB2, emptySimplexCache());

    expect(m.pointCount).toBe(1);
    // anchorA must be body-A-origin-relative. Body A is at world (0,0);
    // shape A center is at world ≈ (1.414, 1.414).  Contact midpoint is
    // between (√2, √2) and (√2+1, √2), roughly (√2+0.5, √2).  So
    // anchorA.x ≈ √2+0.5 ≈ 1.9 — definitely > 1.
    expect(m.points[0]!.anchorA.x).toBeGreaterThan(1);
    expect(m.points[0]!.anchorA.y).toBeGreaterThan(1);
  });

  it("polygon-A with localX=3 vs circle-B at world x=4: anchorA includes +3 body→shape offset", () => {
    // Shape A: 1×1 box polygon with local offset +3 on x.
    // Body A is at world origin → shape A world center = (3, 0).
    // Shape B: unit circle with identity local pose at world (4.5, 0)
    //   → circle center at (4.5, 0), box right edge at 3+1=4,
    //   overlap = 4.5 - 1 - 4 = -0.5 (penetrating).
    const localXfA: Transform = { p: { x: 3, y: 0 }, q: { c: 1, s: 0 } };
    const sPoly = offsetBoxShape(1, localXfA);

    const bodyXfB = xfAt(4.5, 0);
    const sCirc = circleShape(IDENTITY);

    const m = computeManifold(sPoly, IDENTITY, sCirc, bodyXfB, emptySimplexCache());

    expect(m.pointCount).toBe(1);
    // Contact is at world ≈ (4, 0); body A at (0,0) → anchorA.x ≈ 4, which
    // is > 3 (the shape local offset) confirming the lever arm is included.
    expect(m.points[0]!.anchorA.x).toBeGreaterThan(3);
    // anchorB: body B at (4.5, 0); contact ≈ (4, 0) → anchorB.x ≈ -0.5.
    expect(m.points[0]!.anchorB.x).toBeLessThan(0);
  });

  it("circle-A with offset, reversed order: anchorA/anchorB swap correctly", () => {
    // Same as first test but with A and B swapped to exercise the flipped path.
    // Shape B (now passed as first arg) has identity local pose; body at (3,0).
    // Shape A (now passed as second arg) has localX=2 on body at world origin.
    const localXfA: Transform = { p: { x: 2, y: 0 }, q: { c: 1, s: 0 } };
    const sA = offsetCircleShape(1, localXfA);
    const sB = circleShape(IDENTITY);
    const bodyXfB = xfAt(3, 0);

    // fwd: A (offset) vs B (identity body at 3,0)
    const fwd = computeManifold(sA, IDENTITY, sB, bodyXfB, emptySimplexCache());
    // rev: B (identity body at 3,0) vs A (offset)
    const rev = computeManifold(sB, bodyXfB, sA, IDENTITY, emptySimplexCache());

    expect(fwd.pointCount).toBe(1);
    expect(rev.pointCount).toBe(1);

    // Normals must be negated
    expect(rev.normal.x).toBeCloseTo(-fwd.normal.x, 4);
    expect(rev.normal.y).toBeCloseTo(-fwd.normal.y, 4);

    // anchorA in rev = anchorB in fwd (both body-origin-relative)
    expect(rev.points[0]!.anchorA.x).toBeCloseTo(fwd.points[0]!.anchorB.x, 3);
    expect(rev.points[0]!.anchorA.y).toBeCloseTo(fwd.points[0]!.anchorB.y, 3);
    // anchorB in rev = anchorA in fwd
    expect(rev.points[0]!.anchorB.x).toBeCloseTo(fwd.points[0]!.anchorA.x, 3);
    expect(rev.points[0]!.anchorB.y).toBeCloseTo(fwd.points[0]!.anchorA.y, 3);
  });
});
