// Tests for engine/shape.ts.
//
// Covers:
//   - ShapeType enum ordering (must match Box2D b2ShapeType: circle=0, capsule=1,
//     segment=2, polygon=3, chainSegment=4)
//   - ShapeStorage: allocate / get / free
//   - makeCircleShape / makeCapsuleShape / makeSegmentShape / makePolygonShape
//   - makeChainSegments: ghost vertex expansion and segment count

import { describe, expect, it } from "vitest";

import {
  ShapeType,
  ShapeStorage,
  makeCircleShape,
  makeCapsuleShape,
  makeSegmentShape,
  makePolygonShape,
  makeChainSegments,
} from "../../src/engine/shape.js";
import { IDENTITY } from "../../src/math/transform.js";

// ─── ShapeType ordering ──────────────────────────────────────────────────────

describe("ShapeType enum ordering (must match b2ShapeType)", () => {
  it("circle = 0", () => expect(ShapeType.Circle).toBe(0));
  it("capsule = 1", () => expect(ShapeType.Capsule).toBe(1));
  it("segment = 2", () => expect(ShapeType.Segment).toBe(2));
  it("polygon = 3", () => expect(ShapeType.Polygon).toBe(3));
  it("chainSegment = 4", () => expect(ShapeType.ChainSegment).toBe(4));
});

// ─── ShapeStorage ────────────────────────────────────────────────────────────

describe("ShapeStorage", () => {
  it("allocates a handle and returns the record by index", () => {
    const storage = new ShapeStorage();
    const handle = storage.idPool.allocate();
    const record = makeCircleShape(0.5, IDENTITY);
    storage.records[handle.index] = record;
    expect(storage.get(handle.index)).toBe(record);
  });

  it("throws for an empty slot", () => {
    const storage = new ShapeStorage();
    expect(() => storage.get(0)).toThrow(/no shape at index/);
  });

  it("idPool generation advances after free", () => {
    const storage = new ShapeStorage();
    const h1 = storage.idPool.allocate();
    const gen1 = h1.generation;
    storage.idPool.free(h1);
    const h2 = storage.idPool.allocate();
    expect(h2.index).toBe(h1.index);
    expect(h2.generation).toBe(gen1 + 1);
  });
});

// ─── makeCircleShape ─────────────────────────────────────────────────────────

describe("makeCircleShape", () => {
  it("produces type=Circle and correct AABB at identity", () => {
    const s = makeCircleShape(1, IDENTITY);
    expect(s.type).toBe(ShapeType.Circle);
    expect(s.geometry.kind).toBe("circle");
    // AABB for circle center=(0,0), radius=1 at identity → [-1,-1] to [1,1]
    expect(s.aabbMinX).toBeCloseTo(-1);
    expect(s.aabbMinY).toBeCloseTo(-1);
    expect(s.aabbMaxX).toBeCloseTo(1);
    expect(s.aabbMaxY).toBeCloseTo(1);
    expect(s.localCentroidX).toBeCloseTo(0);
    expect(s.localCentroidY).toBeCloseTo(0);
  });

  it("uses the local pose offset", () => {
    const xf = {
      p: { x: 2, y: 0 },
      q: { c: 1, s: 0 },
    };
    const s = makeCircleShape(1, xf);
    // center is at (2,0) in world; AABB = [1,-1] to [3,1]
    expect(s.aabbMinX).toBeCloseTo(1);
    expect(s.aabbMaxX).toBeCloseTo(3);
  });
});

// ─── makeCapsuleShape ────────────────────────────────────────────────────────

describe("makeCapsuleShape", () => {
  it("produces type=Capsule and correct AABB", () => {
    const s = makeCapsuleShape(-1, 0, 1, 0, 1, IDENTITY);
    expect(s.type).toBe(ShapeType.Capsule);
    expect(s.geometry.kind).toBe("capsule");
    expect(s.aabbMinX).toBeCloseTo(-2);
    expect(s.aabbMinY).toBeCloseTo(-1);
    expect(s.aabbMaxX).toBeCloseTo(2);
    expect(s.aabbMaxY).toBeCloseTo(1);
    // Centroid at midpoint of the two centers
    expect(s.localCentroidX).toBeCloseTo(0);
    expect(s.localCentroidY).toBeCloseTo(0);
  });
});

// ─── makeSegmentShape ────────────────────────────────────────────────────────

describe("makeSegmentShape", () => {
  it("produces type=Segment and correct AABB", () => {
    const s = makeSegmentShape(0, 1, 0, -1, IDENTITY);
    expect(s.type).toBe(ShapeType.Segment);
    expect(s.geometry.kind).toBe("segment");
    // Matches test_shape.c::ShapeAABBTest segment case
    expect(s.aabbMinX).toBeCloseTo(0);
    expect(s.aabbMinY).toBeCloseTo(-1);
    expect(s.aabbMaxX).toBeCloseTo(0);
    expect(s.aabbMaxY).toBeCloseTo(1);
  });
});

// ─── makePolygonShape ────────────────────────────────────────────────────────

describe("makePolygonShape", () => {
  it("produces type=Polygon for a box", () => {
    const pts = [
      { x: -1, y: -1 },
      { x: 1, y: -1 },
      { x: 1, y: 1 },
      { x: -1, y: 1 },
    ];
    const s = makePolygonShape(pts, 0, IDENTITY);
    expect(s.type).toBe(ShapeType.Polygon);
    expect(s.geometry.kind).toBe("polygon");
    expect(s.aabbMinX).toBeCloseTo(-1);
    expect(s.aabbMinY).toBeCloseTo(-1);
    expect(s.aabbMaxX).toBeCloseTo(1);
    expect(s.aabbMaxY).toBeCloseTo(1);
    expect(s.localCentroidX).toBeCloseTo(0);
    expect(s.localCentroidY).toBeCloseTo(0);
  });

  it("throws for more than 8 vertices", () => {
    const pts = Array.from({ length: 9 }, (_, i) => ({
      x: Math.cos((i * 2 * Math.PI) / 9),
      y: Math.sin((i * 2 * Math.PI) / 9),
    }));
    expect(() => makePolygonShape(pts, 0, IDENTITY)).toThrow(/vertices/i);
  });

  it("throws for collinear points (degenerate hull)", () => {
    // All points on the same line → hull fails → throws
    const pts = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
    ];
    expect(() => makePolygonShape(pts, 0, IDENTITY)).toThrow(/convex|hull/i);
  });
});

// ─── makeChainSegments ────────────────────────────────────────────────────────

describe("makeChainSegments", () => {
  // 4-point open chain → 3 segments (N-1 for open)
  it("open chain of 4 points produces 3 chainSegment shapes", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 1 },
      { x: 3, y: 0 },
    ];
    const shapes = makeChainSegments(pts, false, IDENTITY);
    expect(shapes.length).toBe(3);
    for (const s of shapes) {
      expect(s.type).toBe(ShapeType.ChainSegment);
      expect(s.geometry.kind).toBe("chainSegment");
    }
  });

  // Ghost vertices for open chain:
  // - first segment: ghost1 extends backwards from pts[0]
  // - last segment: ghost2 extends forwards from pts[N-1]
  it("open chain: first segment ghost1 and last segment ghost2 are set", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
    ];
    const shapes = makeChainSegments(pts, false, IDENTITY);
    const first = shapes[0]!.geometry;
    const last = shapes[shapes.length - 1]!.geometry;
    expect(first.kind).toBe("chainSegment");
    expect(last.kind).toBe("chainSegment");
    if (first.kind === "chainSegment" && last.kind === "chainSegment") {
      // ghost1 of first segment should be a reflection/extension backward
      expect(Number.isFinite(first.ghost1X)).toBe(true);
      expect(Number.isFinite(first.ghost1Y)).toBe(true);
      // ghost2 of last segment should be a reflection/extension forward
      expect(Number.isFinite(last.ghost2X)).toBe(true);
      expect(Number.isFinite(last.ghost2Y)).toBe(true);
    }
  });

  // 4-point loop chain → 4 segments (N for loop)
  it("loop chain of 4 points produces 4 chainSegment shapes", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ];
    const shapes = makeChainSegments(pts, true, IDENTITY);
    expect(shapes.length).toBe(4);
  });

  // Ghost vertices for loop: each segment's ghost1/ghost2 come from the
  // previous/next point in the loop.
  it("loop chain: ghost vertices use wraparound neighbours", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 2 },
      { x: 0, y: 2 },
    ];
    const shapes = makeChainSegments(pts, true, IDENTITY);
    // First segment: pts[0]→pts[1]; ghost1 = pts[3], ghost2 = pts[2]
    const first = shapes[0]!.geometry;
    if (first.kind === "chainSegment") {
      expect(first.ghost1X).toBeCloseTo(0);
      expect(first.ghost1Y).toBeCloseTo(2);
      expect(first.ghost2X).toBeCloseTo(2);
      expect(first.ghost2Y).toBeCloseTo(2);
    }
  });
});
