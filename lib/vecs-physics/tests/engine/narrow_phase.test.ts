// Tests for engine/narrow_phase.ts (VP-14).
//
// Strategy: assert that computeManifold routes each registered shape-type pair
// to the correct manifold function and produces the same result as calling the
// VP-13 collide* function directly. Both argument orderings are tested; the
// flipped order must produce the negated normal and swapped anchors but the
// same contact geometry.
//
// Configurations reuse VP-13's tested setups where handy.

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
  ShapeType,
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

// Build a unit circle InternalShape at given world transform.
function circleShape(xf: Transform = IDENTITY): InternalShape {
  return makeCircleShape(1, xf);
}

// Build a capsule InternalShape from (-0.5,0) to (0.5,0) with radius 0.25.
function capsuleShape(xf: Transform = IDENTITY): InternalShape {
  return makeCapsuleShape(-0.5, 0, 0.5, 0, 0.25, xf);
}

// Build a 1×1 box polygon InternalShape.
function boxShape(xf: Transform = IDENTITY): InternalShape {
  const pts = [
    { x: -1, y: -1 },
    { x: 1, y: -1 },
    { x: 1, y: 1 },
    { x: -1, y: 1 },
  ];
  return makePolygonShape(pts, 0, xf);
}

// Build a horizontal segment InternalShape at y=0.
function segmentShape(xf: Transform = IDENTITY): InternalShape {
  return makeSegmentShape(-1, 0, 1, 0, xf);
}

// Build a single chain segment InternalShape (just the first segment).
function chainSegShape(xf: Transform = IDENTITY): InternalShape {
  const pts = [
    { x: -2, y: 0 },
    { x: 2, y: 0 },
  ];
  return makeChainSegments(pts, false, xf)[0]!;
}

// ─── flip invariant helper ────────────────────────────────────────────────────

// Verify that computeManifold(B, xfB, A, xfA) produces the correct
// flip of computeManifold(A, xfA, B, xfB):
//   - same pointCount
//   - normal negated
//   - anchorA ↔ anchorB swapped
//   - same separation values (same geometry, different labelling)
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
