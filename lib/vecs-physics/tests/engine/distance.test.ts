// Tests for engine/distance.ts
//
// Box2D golden test ports:
//   - test_distance.c::SegmentDistanceTest
//   - test_distance.c::ShapeDistanceTest
//
// Additional targeted tests:
//   - segmentDistance: degenerate cases (zero-length segments)
//   - segmentDistance: parallel segments
//   - shapeDistance: overlapping shapes (distance = 0)

import { describe, expect, it } from "vitest";
import { segmentDistance } from "../../src/engine/distance.js";
import { shapeDistance, makeProxy, emptySimplexCache } from "../../src/engine/distance.js";
import { IDENTITY } from "../../src/math/transform.js";

// ─── SegmentDistanceTest (port of test_distance.c::SegmentDistanceTest) ─────

describe("SegmentDistanceTest — port of test_distance.c", () => {
  it("vertical segment vs short horizontal segment", () => {
    // From test_distance.c:
    //   p1 = {-1, -1}, q1 = {-1, 1}   (vertical at x=-1)
    //   p2 = {2,   0}, q2 = {1,  0}   (horizontal at y=0, going left)
    const p1 = { x: -1, y: -1 };
    const q1 = { x: -1, y: 1 };
    const p2 = { x: 2, y: 0 };
    const q2 = { x: 1, y: 0 };

    const result = segmentDistance(p1, q1, p2, q2);

    expect(result.fraction1).toBeCloseTo(0.5, 5);
    expect(result.fraction2).toBeCloseTo(1.0, 5);
    expect(result.closest1.x).toBeCloseTo(-1, 5);
    expect(result.closest1.y).toBeCloseTo(0, 5);
    expect(result.closest2.x).toBeCloseTo(1, 5);
    expect(result.closest2.y).toBeCloseTo(0, 5);
    expect(result.distanceSquared).toBeCloseTo(4, 5);
  });
});

// ─── ShapeDistanceTest (port of test_distance.c::ShapeDistanceTest) ──────────

describe("ShapeDistanceTest — port of test_distance.c", () => {
  it("unit square vs vertical segment at x=2: distance = 1", () => {
    // proxyA: square with corners at ±1
    const vas = [
      { x: -1, y: -1 },
      { x: 1, y: -1 },
      { x: 1, y: 1 },
      { x: -1, y: 1 },
    ];
    // proxyB: segment at x=2
    const vbs = [
      { x: 2, y: -1 },
      { x: 2, y: 1 },
    ];

    const proxyA = makeProxy(vas, 4, 0);
    const proxyB = makeProxy(vbs, 2, 0);
    const cache = emptySimplexCache();

    const output = shapeDistance(
      {
        proxyA,
        proxyB,
        transformA: IDENTITY,
        transformB: IDENTITY,
        useRadii: false,
      },
      cache
    );

    expect(output.distance).toBeCloseTo(1, 4);
  });

  it("overlapping shapes → distance = 0", () => {
    // Two identical unit squares — overlap → distance = 0
    const vas = [
      { x: -1, y: -1 },
      { x: 1, y: -1 },
      { x: 1, y: 1 },
      { x: -1, y: 1 },
    ];
    const proxyA = makeProxy(vas, 4, 0);
    const proxyB = makeProxy(vas, 4, 0);
    const cache = emptySimplexCache();

    const output = shapeDistance(
      {
        proxyA,
        proxyB,
        transformA: IDENTITY,
        transformB: IDENTITY,
        useRadii: false,
      },
      cache
    );

    expect(output.distance).toBe(0);
  });
});

// ─── Additional segmentDistance tests ────────────────────────────────────────

describe("segmentDistance — additional", () => {
  it("coincident segments → distance = 0", () => {
    const p = { x: 0, y: 0 };
    const q = { x: 1, y: 0 };
    const result = segmentDistance(p, q, p, q);
    expect(result.distanceSquared).toBe(0);
  });

  it("parallel horizontal segments at y=0 and y=1", () => {
    const p1 = { x: 0, y: 0 };
    const q1 = { x: 1, y: 0 };
    const p2 = { x: 0, y: 1 };
    const q2 = { x: 1, y: 1 };
    const result = segmentDistance(p1, q1, p2, q2);
    expect(result.distanceSquared).toBeCloseTo(1, 5);
  });

  it("crossing segments at 90°: closest points are the intersection", () => {
    // horizontal  x∈[-1,1], y=0
    // vertical    x=0,  y∈[-1,1]
    const p1 = { x: -1, y: 0 };
    const q1 = { x: 1, y: 0 };
    const p2 = { x: 0, y: -1 };
    const q2 = { x: 0, y: 1 };
    const result = segmentDistance(p1, q1, p2, q2);
    // They cross at origin → distance = 0
    expect(result.distanceSquared).toBeCloseTo(0, 5);
  });

  it("degenerate: second segment is a point", () => {
    const p1 = { x: 0, y: 0 };
    const q1 = { x: 2, y: 0 };
    const p2 = { x: 1, y: 1 };
    const q2 = { x: 1, y: 1 }; // point
    const result = segmentDistance(p1, q1, p2, q2);
    // Closest point on segment is (1,0), distance = 1
    expect(result.distanceSquared).toBeCloseTo(1, 5);
    expect(result.closest1.x).toBeCloseTo(1, 5);
    expect(result.closest1.y).toBeCloseTo(0, 5);
  });
});
