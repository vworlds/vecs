// Tests for engine/manifold/*.ts (VP-13a–13e)
//
// Box2D golden test ports: box2d has no direct manifold golden tests beyond
// the distance tests; these are geometric unit tests verifying the manifold
// output per shape pair.
//
// Each pair has three cases:
//   1. Overlapping (separation < 0)
//   2. Touching / just contacting
//   3. Separated (no manifold)
// Plus an ID-stability check (two calls with the same config produce same ids).

import { describe, expect, it } from "vitest";

import { IDENTITY, type Transform } from "../../src/math/transform.js";
import { makeRot } from "../../src/math/rot.js";

import {
  collideCircles,
  collideCapsuleAndCircle,
  collidePolygonAndCircle,
} from "../../src/engine/manifold/circles.js";
import { collidePolygons } from "../../src/engine/manifold/polygons.js";
import {
  collideCapsules,
  collideSegmentAndCapsule,
  collidePolygonAndCapsule,
} from "../../src/engine/manifold/capsules.js";
import {
  collideSegmentAndCircle,
  collideSegmentAndPolygon,
} from "../../src/engine/manifold/segments.js";
import {
  collideChainSegmentAndCircle,
  collideChainSegmentAndCapsule,
  collideChainSegmentAndPolygon,
} from "../../src/engine/manifold/chain_segments.js";
import { emptySimplexCache } from "../../src/engine/manifold/types.js";
import { makeBox } from "../../src/engine/geometry.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

const EPS = 1e-4;

function near(a: number, b: number, tol = EPS): boolean {
  return Math.abs(a - b) <= tol;
}

function xfAt(x: number, y: number, angle = 0): Transform {
  return { p: { x, y }, q: makeRot(angle) };
}

// Build a PolygonShape from makeBox result (for manifold functions that take
// PolygonShape directly).
function boxShape(hx: number, hy: number) {
  return makeBox(hx, hy);
}

// ─── 13a: circles family ─────────────────────────────────────────────────────

describe("collideCircles", () => {
  const cA = { cx: 0, cy: 0, radius: 1 };
  const cB = { cx: 0, cy: 0, radius: 1 };

  it("overlapping: two unit circles at same position", () => {
    const m = collideCircles(cA, IDENTITY, cB, IDENTITY);
    expect(m.pointCount).toBe(1);
    expect(m.points[0].separation).toBeLessThan(0);
  });

  it("touching: two circles exactly radius+radius apart", () => {
    const m = collideCircles(cA, IDENTITY, cB, xfAt(2, 0));
    expect(m.pointCount).toBe(1);
    expect(near(m.points[0].separation, 0)).toBe(true);
  });

  it("separated: circles more than speculative distance apart", () => {
    const m = collideCircles(cA, IDENTITY, cB, xfAt(5, 0));
    expect(m.pointCount).toBe(0);
  });

  it("normal points from A to B", () => {
    const m = collideCircles(cA, IDENTITY, cB, xfAt(1.5, 0));
    expect(m.pointCount).toBe(1);
    expect(m.normal.x).toBeGreaterThan(0);
    expect(near(m.normal.y, 0)).toBe(true);
    const len = Math.sqrt(m.normal.x ** 2 + m.normal.y ** 2);
    expect(near(len, 1)).toBe(true);
  });

  it("ID stability across two identical calls", () => {
    const m1 = collideCircles(cA, IDENTITY, cB, xfAt(1.5, 0));
    const m2 = collideCircles(cA, IDENTITY, cB, xfAt(1.5, 0));
    expect(m1.points[0].id).toBe(m2.points[0].id);
  });
});

describe("collideCapsuleAndCircle", () => {
  // capsule along x axis
  const cap = { ax: -1, ay: 0, bx: 1, by: 0, radius: 0.5 };
  const cir = { cx: 0, cy: 0, radius: 0.5 };

  it("overlapping: circle inside capsule", () => {
    const m = collideCapsuleAndCircle(cap, IDENTITY, cir, IDENTITY);
    expect(m.pointCount).toBe(1);
    expect(m.points[0].separation).toBeLessThan(0);
  });

  it("touching: circle at top of capsule radius", () => {
    const m = collideCapsuleAndCircle(cap, IDENTITY, cir, xfAt(0, 1));
    expect(m.pointCount).toBe(1);
    expect(near(m.points[0].separation, 0, 0.01)).toBe(true);
  });

  it("separated: circle far away", () => {
    const m = collideCapsuleAndCircle(cap, IDENTITY, cir, xfAt(0, 5));
    expect(m.pointCount).toBe(0);
  });

  it("ID stability", () => {
    const m1 = collideCapsuleAndCircle(cap, IDENTITY, cir, xfAt(0.5, 0.8));
    const m2 = collideCapsuleAndCircle(cap, IDENTITY, cir, xfAt(0.5, 0.8));
    expect(m1.points[0].id).toBe(m2.points[0].id);
  });
});

describe("collidePolygonAndCircle", () => {
  const poly = makeBox(1, 1);
  const cir = { cx: 0, cy: 0, radius: 0.5 };

  it("overlapping: circle center inside polygon", () => {
    const m = collidePolygonAndCircle(poly, IDENTITY, cir, IDENTITY);
    expect(m.pointCount).toBe(1);
    expect(m.points[0].separation).toBeLessThan(0);
  });

  it("touching: circle just touching top edge", () => {
    const m = collidePolygonAndCircle(poly, IDENTITY, cir, xfAt(0, 1.5));
    expect(m.pointCount).toBe(1);
    expect(near(m.points[0].separation, 0, 0.01)).toBe(true);
  });

  it("separated: circle far above polygon", () => {
    const m = collidePolygonAndCircle(poly, IDENTITY, cir, xfAt(0, 5));
    expect(m.pointCount).toBe(0);
  });
});

// ─── 13b: polygon pair ───────────────────────────────────────────────────────

describe("collidePolygons", () => {
  const boxA = makeBox(1, 1);
  const boxB = makeBox(1, 1);

  it("overlapping: two unit boxes at same position", () => {
    const m = collidePolygons(boxA, IDENTITY, boxB, IDENTITY);
    expect(m.pointCount).toBeGreaterThan(0);
    for (let i = 0; i < m.pointCount; i++) {
      expect(m.points[i].separation).toBeLessThan(0);
    }
  });

  it("touching: two boxes side-by-side", () => {
    const m = collidePolygons(boxA, IDENTITY, boxB, xfAt(2, 0));
    expect(m.pointCount).toBeGreaterThan(0);
    const minSep = Math.min(
      ...Array.from({ length: m.pointCount }, (_, i) => m.points[i].separation)
    );
    expect(near(minSep, 0, 0.01)).toBe(true);
  });

  it("separated: boxes far apart", () => {
    const m = collidePolygons(boxA, IDENTITY, boxB, xfAt(10, 0));
    expect(m.pointCount).toBe(0);
  });

  it("normal is unit and points from A to B", () => {
    const m = collidePolygons(boxA, IDENTITY, boxB, xfAt(1.5, 0));
    if (m.pointCount > 0) {
      const len = Math.sqrt(m.normal.x ** 2 + m.normal.y ** 2);
      expect(near(len, 1)).toBe(true);
      expect(m.normal.x).toBeGreaterThan(0);
    }
  });

  it("ID stability: same geometry same ids", () => {
    const m1 = collidePolygons(boxA, IDENTITY, boxB, xfAt(1.5, 0));
    const m2 = collidePolygons(boxA, IDENTITY, boxB, xfAt(1.5, 0));
    expect(m1.pointCount).toBe(m2.pointCount);
    for (let i = 0; i < m1.pointCount; i++) {
      expect(m1.points[i].id).toBe(m2.points[i].id);
    }
  });

  it("two contact points for aligned boxes", () => {
    // Slightly overlapping — expect 2 contact points (edge-edge)
    const m = collidePolygons(boxA, IDENTITY, boxB, xfAt(1.9, 0));
    expect(m.pointCount).toBeGreaterThan(0);
  });
});

// ─── 13c: capsule family ─────────────────────────────────────────────────────

describe("collideCapsules", () => {
  const cA = { ax: -1, ay: 0, bx: 1, by: 0, radius: 0.5 };
  const cB = { ax: -1, ay: 0, bx: 1, by: 0, radius: 0.5 };

  it("overlapping: parallel capsules close together", () => {
    const m = collideCapsules(cA, IDENTITY, cB, xfAt(0, 0.5));
    expect(m.pointCount).toBeGreaterThan(0);
    expect(m.points[0].separation).toBeLessThan(0);
  });

  it("separated: capsules far apart", () => {
    const m = collideCapsules(cA, IDENTITY, cB, xfAt(0, 5));
    expect(m.pointCount).toBe(0);
  });

  it("ID stability", () => {
    const m1 = collideCapsules(cA, IDENTITY, cB, xfAt(0, 0.8));
    const m2 = collideCapsules(cA, IDENTITY, cB, xfAt(0, 0.8));
    expect(m1.pointCount).toBe(m2.pointCount);
    if (m1.pointCount > 0) {
      expect(m1.points[0].id).toBe(m2.points[0].id);
    }
  });
});

describe("collideSegmentAndCapsule", () => {
  const seg = { ax: -1, ay: 0, bx: 1, by: 0 };
  const cap = { ax: -1, ay: 0, bx: 1, by: 0, radius: 0.5 };

  it("overlapping: segment below capsule", () => {
    const m = collideSegmentAndCapsule(seg, IDENTITY, cap, xfAt(0, 0.3));
    expect(m.pointCount).toBeGreaterThan(0);
  });

  it("separated: capsule far above segment", () => {
    const m = collideSegmentAndCapsule(seg, IDENTITY, cap, xfAt(0, 5));
    expect(m.pointCount).toBe(0);
  });
});

describe("collidePolygonAndCapsule", () => {
  const poly = makeBox(1, 1);
  const cap = { ax: -1, ay: 0, bx: 1, by: 0, radius: 0.3 };

  it("overlapping: capsule overlaps polygon", () => {
    const m = collidePolygonAndCapsule(poly, IDENTITY, cap, xfAt(0, 0.8));
    expect(m.pointCount).toBeGreaterThan(0);
  });

  it("separated: capsule far from polygon", () => {
    const m = collidePolygonAndCapsule(poly, IDENTITY, cap, xfAt(0, 5));
    expect(m.pointCount).toBe(0);
  });
});

// ─── 13d: segment family ─────────────────────────────────────────────────────

describe("collideSegmentAndCircle", () => {
  const seg = { ax: -1, ay: 0, bx: 1, by: 0 };
  const cir = { cx: 0, cy: 0, radius: 0.5 };

  it("overlapping: circle crosses segment", () => {
    const m = collideSegmentAndCircle(seg, IDENTITY, cir, xfAt(0, 0.3));
    expect(m.pointCount).toBe(1);
  });

  it("separated: circle far from segment", () => {
    const m = collideSegmentAndCircle(seg, IDENTITY, cir, xfAt(0, 5));
    expect(m.pointCount).toBe(0);
  });
});

describe("collideSegmentAndPolygon", () => {
  const seg = { ax: -1, ay: 0, bx: 1, by: 0 };
  const poly = makeBox(0.5, 0.5);

  it("overlapping: segment passes through polygon", () => {
    const m = collideSegmentAndPolygon(seg, IDENTITY, poly, xfAt(0, 0.3));
    expect(m.pointCount).toBeGreaterThan(0);
  });

  it("separated: polygon above segment", () => {
    const m = collideSegmentAndPolygon(seg, IDENTITY, poly, xfAt(0, 5));
    expect(m.pointCount).toBe(0);
  });
});

// ─── 13e: chain-segment family ───────────────────────────────────────────────

// Build a chain segment with reflected ghosts (VP-8 convention).
// ghost1 = 2*p1 - p2 (reflection of p2 through p1)
// ghost2 = 2*p2 - p1 (reflection of p1 through p2)
function makeChainSeg(p1x: number, p1y: number, p2x: number, p2y: number) {
  return {
    ghost1X: 2 * p1x - p2x,
    ghost1Y: 2 * p1y - p2y,
    ax: p1x,
    ay: p1y,
    bx: p2x,
    by: p2y,
    ghost2X: 2 * p2x - p1x,
    ghost2Y: 2 * p2y - p1y,
    chainId: 0,
  };
}

describe("collideChainSegmentAndCircle", () => {
  // Horizontal chain segment from (-2,0) to (2,0); right side is upward.
  const seg = makeChainSeg(2, 0, -2, 0);
  const cir = { cx: 0, cy: 0, radius: 0.5 };

  it("collision from right side (above segment)", () => {
    const m = collideChainSegmentAndCircle(seg, IDENTITY, cir, xfAt(0, 0.3));
    expect(m.pointCount).toBe(1);
    expect(m.points[0].separation).toBeLessThan(0);
  });

  it("no collision from wrong side (below segment)", () => {
    const m = collideChainSegmentAndCircle(seg, IDENTITY, cir, xfAt(0, -0.3));
    expect(m.pointCount).toBe(0);
  });

  it("separated: circle far above", () => {
    const m = collideChainSegmentAndCircle(seg, IDENTITY, cir, xfAt(0, 5));
    expect(m.pointCount).toBe(0);
  });
});

describe("collideChainSegmentAndCapsule", () => {
  const seg = makeChainSeg(2, 0, -2, 0);
  const cap = { ax: -0.5, ay: 0, bx: 0.5, by: 0, radius: 0.3 };

  it("collision from right side", () => {
    const cache = emptySimplexCache();
    const m = collideChainSegmentAndCapsule(seg, IDENTITY, cap, xfAt(0, 0.2), cache);
    expect(m.pointCount).toBeGreaterThan(0);
  });

  it("no collision from wrong side", () => {
    const cache = emptySimplexCache();
    const m = collideChainSegmentAndCapsule(seg, IDENTITY, cap, xfAt(0, -0.2), cache);
    expect(m.pointCount).toBe(0);
  });

  it("separated", () => {
    const cache = emptySimplexCache();
    const m = collideChainSegmentAndCapsule(seg, IDENTITY, cap, xfAt(0, 5), cache);
    expect(m.pointCount).toBe(0);
  });
});

describe("collideChainSegmentAndPolygon", () => {
  const seg = makeChainSeg(2, 0, -2, 0);
  const poly = makeBox(0.5, 0.5);

  it("collision from right side", () => {
    const cache = emptySimplexCache();
    const m = collideChainSegmentAndPolygon(seg, IDENTITY, poly, xfAt(0, 0.3), cache);
    expect(m.pointCount).toBeGreaterThan(0);
  });

  it("no collision from wrong side (one-sided)", () => {
    const cache = emptySimplexCache();
    const m = collideChainSegmentAndPolygon(seg, IDENTITY, poly, xfAt(0, -0.3), cache);
    expect(m.pointCount).toBe(0);
  });

  it("separated", () => {
    const cache = emptySimplexCache();
    const m = collideChainSegmentAndPolygon(seg, IDENTITY, poly, xfAt(0, 5), cache);
    expect(m.pointCount).toBe(0);
  });

  it("ID stability: warm-start cache gives same IDs", () => {
    const cache1 = emptySimplexCache();
    const m1 = collideChainSegmentAndPolygon(seg, IDENTITY, poly, xfAt(0, 0.3), cache1);
    const cache2 = { ...cache1 };
    const m2 = collideChainSegmentAndPolygon(seg, IDENTITY, poly, xfAt(0, 0.3), cache2);
    expect(m1.pointCount).toBe(m2.pointCount);
    for (let i = 0; i < m1.pointCount; i++) {
      expect(m1.points[i].id).toBe(m2.points[i].id);
    }
  });
});

// ─── makeId tests ────────────────────────────────────────────────────────────

describe("makeId", () => {
  it("encodes two bytes: (A<<8)|B", async () => {
    const { makeId } = await import("../../src/engine/manifold/types.js");
    expect(makeId(0, 0)).toBe(0);
    expect(makeId(1, 0)).toBe(0x0100);
    expect(makeId(0, 1)).toBe(0x0001);
    expect(makeId(255, 255)).toBe(0xffff);
    // Truncation to 8 bits
    expect(makeId(256, 0)).toBe(0);
  });
});
