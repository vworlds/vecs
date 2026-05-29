// Tests for engine/geometry.ts.
//
// Box2D golden test ports:
//   - test_shape.c::ShapeAABBTest   (circle / polygon / segment AABB)
//   - test_shape.c::PointInShapeTest (circle / polygon point-in-shape)
//   - test_collision.c::AABBTest     (AABB isValid / overlaps / contains)
//
// Additional targeted tests:
//   - makeBox → polygon
//   - makePolygon (hull) + centroid
//   - computeHull / validateHull (reject >8 verts, non-convex)
//   - b2PointInCapsule

import { describe, expect, it } from "vitest";

import { IDENTITY } from "../../src/math/transform.js";
import {
  computeAABB,
  computeHull,
  makeBox,
  makePolygon,
  pointInCapsule,
  pointInCircle,
  pointInPolygon,
  validateHull,
} from "../../src/engine/geometry.js";
import { isValid, overlaps, contains } from "../../src/math/aabb.js";

// ─── helpers ────────────────────────────────────────────────────────────────

const EPSILON = 1e-6;

function near(a: number, b: number): boolean {
  return Math.abs(a - b) <= EPSILON;
}

// ─── ShapeAABBTest (port of test_shape.c::ShapeAABBTest) ────────────────────

describe("ShapeAABBTest — computeAABB (port of test_shape.c)", () => {
  // b2Circle circle = { { 1.0f, 0.0f }, 1.0f };
  // b2ComputeCircleAABB( &circle, b2Transform_identity ) →
  //   lower { 0, -1 }, upper { 2, 1 }
  it("circle at (1,0) radius 1 → AABB [0,-1] to [2,1]", () => {
    const aabb = computeAABB({ kind: "circle", cx: 1, cy: 0, radius: 1 }, IDENTITY);
    expect(near(aabb.lowerBound.x, 0)).toBe(true);
    expect(near(aabb.lowerBound.y, -1)).toBe(true);
    expect(near(aabb.upperBound.x, 2)).toBe(true);
    expect(near(aabb.upperBound.y, 1)).toBe(true);
  });

  // box = b2MakeBox(1,1) → vertices ±1 in each axis → AABB [-1,-1] to [1,1]
  it("unit box polygon → AABB [-1,-1] to [1,1]", () => {
    const box = makeBox(1, 1);
    const aabb = computeAABB(box, IDENTITY);
    expect(near(aabb.lowerBound.x, -1)).toBe(true);
    expect(near(aabb.lowerBound.y, -1)).toBe(true);
    expect(near(aabb.upperBound.x, 1)).toBe(true);
    expect(near(aabb.upperBound.y, 1)).toBe(true);
  });

  // b2Segment segment = { { 0,1 }, { 0,-1 } } → AABB [0,-1] to [0,1]
  it("vertical segment from (0,1) to (0,-1) → AABB [0,-1] to [0,1]", () => {
    const aabb = computeAABB({ kind: "segment", ax: 0, ay: 1, bx: 0, by: -1 }, IDENTITY);
    expect(near(aabb.lowerBound.x, 0)).toBe(true);
    expect(near(aabb.lowerBound.y, -1)).toBe(true);
    expect(near(aabb.upperBound.x, 0)).toBe(true);
    expect(near(aabb.upperBound.y, 1)).toBe(true);
  });

  // Capsule: centers (-1,0) and (1,0), radius 1
  // → AABB [-2,-1] to [2,1]
  it("horizontal capsule radius 1 → AABB [-2,-1] to [2,1]", () => {
    const aabb = computeAABB({ kind: "capsule", ax: -1, ay: 0, bx: 1, by: 0, radius: 1 }, IDENTITY);
    expect(near(aabb.lowerBound.x, -2)).toBe(true);
    expect(near(aabb.lowerBound.y, -1)).toBe(true);
    expect(near(aabb.upperBound.x, 2)).toBe(true);
    expect(near(aabb.upperBound.y, 1)).toBe(true);
  });
});

// ─── PointInShapeTest (port of test_shape.c::PointInShapeTest) ───────────────

describe("PointInShapeTest (port of test_shape.c)", () => {
  // circle = { center: (1,0), radius: 1 }
  // p1 = (0.5, 0.5) → hit, p2 = (4,-4) → miss
  it("pointInCircle: (0.5,0.5) in circle(1,0,r=1) → true", () => {
    expect(pointInCircle({ cx: 1, cy: 0, radius: 1 }, 0.5, 0.5)).toBe(true);
  });
  it("pointInCircle: (4,-4) in circle(1,0,r=1) → false", () => {
    expect(pointInCircle({ cx: 1, cy: 0, radius: 1 }, 4, -4)).toBe(false);
  });

  // box = MakeBox(1,1) → [-1,-1] to [1,1]
  // p1 = (0.5, 0.5) → hit, p2 = (4,-4) → miss
  it("pointInPolygon: (0.5,0.5) in unit box → true", () => {
    const box = makeBox(1, 1);
    expect(pointInPolygon(box, 0.5, 0.5)).toBe(true);
  });
  it("pointInPolygon: (4,-4) in unit box → false", () => {
    const box = makeBox(1, 1);
    expect(pointInPolygon(box, 4, -4)).toBe(false);
  });
});

// ─── AABBTest (port of test_collision.c::AABBTest) ───────────────────────────

describe("AABBTest (port of test_collision.c)", () => {
  // a.lowerBound = (-1,-1), a.upperBound = (-2,-2) → invalid (lower > upper)
  it("AABB with lower > upper is invalid", () => {
    expect(isValid({ lowerBound: { x: -1, y: -1 }, upperBound: { x: -2, y: -2 } })).toBe(false);
  });

  // a = [-1,-1] to [1,1] → valid
  it("AABB [-1,-1] to [1,1] is valid", () => {
    expect(isValid({ lowerBound: { x: -1, y: -1 }, upperBound: { x: 1, y: 1 } })).toBe(true);
  });

  // b = [2,2] to [4,4] → no overlap with a, a does not contain b
  it("non-overlapping AABBs: a=[−1,1]×[−1,1], b=[2,4]×[2,4]", () => {
    const a = { lowerBound: { x: -1, y: -1 }, upperBound: { x: 1, y: 1 } };
    const b = { lowerBound: { x: 2, y: 2 }, upperBound: { x: 4, y: 4 } };
    expect(overlaps(a, b)).toBe(false);
    expect(contains(a, b)).toBe(false);
  });
});

// ─── makeBox targeted tests ───────────────────────────────────────────────────

describe("makeBox", () => {
  it("produces a polygon with 4 vertices, zero centroid, zero radius", () => {
    const p = makeBox(2, 3);
    expect(p.kind).toBe("polygon");
    expect(p.count).toBe(4);
    expect(p.radius).toBe(0);
    expect(p.centroidX).toBeCloseTo(0);
    expect(p.centroidY).toBeCloseTo(0);
  });

  it("vertices span the correct extents", () => {
    const p = makeBox(1.5, 0.5);
    // Extract x and y coordinates from packed Float32Array
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < p.count; i++) {
      xs.push(p.vertices[i * 2]!);
      ys.push(p.vertices[i * 2 + 1]!);
    }
    expect(Math.min(...xs)).toBeCloseTo(-1.5);
    expect(Math.max(...xs)).toBeCloseTo(1.5);
    expect(Math.min(...ys)).toBeCloseTo(-0.5);
    expect(Math.max(...ys)).toBeCloseTo(0.5);
  });

  it("normals are unit length", () => {
    const p = makeBox(1, 1);
    for (let i = 0; i < p.count; i++) {
      const nx = p.normals[i * 2]!;
      const ny = p.normals[i * 2 + 1]!;
      const len = Math.sqrt(nx * nx + ny * ny);
      expect(len).toBeCloseTo(1, 5);
    }
  });
});

// ─── makePolygon + centroid ───────────────────────────────────────────────────

describe("makePolygon", () => {
  it("produces correct normals and centroid from a valid hull", () => {
    // Triangle: (0,0), (2,0), (1,2)
    const pts = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 1, y: 2 },
    ];
    const hull = computeHull(pts);
    expect(hull.count).toBe(3);
    const poly = makePolygon(hull, 0);
    expect(poly.count).toBe(3);
    // Centroid of equilateral-ish triangle: (1, 2/3)
    expect(poly.centroidX).toBeCloseTo(1);
    expect(poly.centroidY).toBeCloseTo(2 / 3);
  });
});

// ─── computeHull / validateHull ──────────────────────────────────────────────

describe("computeHull", () => {
  it("returns count=0 for fewer than 3 points", () => {
    const h = computeHull([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ]);
    expect(h.count).toBe(0);
  });

  it("returns count=0 for more than 8 points", () => {
    const pts = Array.from({ length: 9 }, (_, i) => ({
      x: Math.cos((i * 2 * Math.PI) / 9),
      y: Math.sin((i * 2 * Math.PI) / 9),
    }));
    const h = computeHull(pts);
    // Box2D clamps to B2_MAX_POLYGON_VERTICES=8 and computes the hull, but
    // passing 9 points exceeds the limit so the hull is empty.
    expect(h.count).toBe(0);
  });

  it("produces a valid hull from a convex set of 4 points", () => {
    const pts = [
      { x: -1, y: -1 },
      { x: 1, y: -1 },
      { x: 1, y: 1 },
      { x: -1, y: 1 },
    ];
    const h = computeHull(pts);
    expect(h.count).toBe(4);
    expect(validateHull(h)).toBe(true);
  });

  it("collinear points produce an empty hull", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ];
    const h = computeHull(pts);
    expect(h.count).toBe(0);
  });
});

describe("validateHull", () => {
  it("rejects a hull with fewer than 3 points", () => {
    expect(
      validateHull({
        count: 2,
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
        ],
      })
    ).toBe(false);
  });

  it("accepts the unit-box hull", () => {
    const pts = [
      { x: -1, y: -1 },
      { x: 1, y: -1 },
      { x: 1, y: 1 },
      { x: -1, y: 1 },
    ];
    const h = computeHull(pts);
    expect(validateHull(h)).toBe(true);
  });
});

// ─── pointInCapsule additional test ──────────────────────────────────────────

describe("pointInCapsule", () => {
  // capsule = { center1: (-1,0), center2: (1,0), radius: 1 }
  it("(0,0) is inside horizontal capsule", () => {
    expect(pointInCapsule({ ax: -1, ay: 0, bx: 1, by: 0, radius: 1 }, 0, 0)).toBe(true);
  });
  it("(0,1.5) is outside horizontal capsule with r=1", () => {
    expect(pointInCapsule({ ax: -1, ay: 0, bx: 1, by: 0, radius: 1 }, 0, 1.5)).toBe(false);
  });
  it("(2.5,0) is outside horizontal capsule (beyond end cap)", () => {
    expect(pointInCapsule({ ax: -1, ay: 0, bx: 1, by: 0, radius: 1 }, 2.5, 0)).toBe(false);
  });
  it("degenerate capsule (same endpoints) falls back to circle test", () => {
    expect(pointInCapsule({ ax: 0, ay: 0, bx: 0, by: 0, radius: 1 }, 0.5, 0.5)).toBe(true);
  });
});
