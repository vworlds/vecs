// Ports box2d/test/test_collision.c::AABBRayCastTest.

import { describe, expect, it } from "vitest";

import { rayCastAABB, type AABB, type AABBCastOutput } from "../../src/math/aabb.js";
import type { Vec2 } from "../../src/math/vec2.js";

const AABB: AABB = { lowerBound: { x: -1, y: -1 }, upperBound: { x: 1, y: 1 } };

describe("test_collision.c::AABBRayCastTest", () => {
  it("reports side, edge, corner, miss, inside, and degenerate segment cases", () => {
    expectHit(rayCastAABB(AABB, { x: -3, y: 0 }, { x: 3, y: 0 }), {
      fraction: 1 / 3,
      normal: { x: -1, y: 0 },
      point: { x: -1, y: 0 },
    });
    expectHit(rayCastAABB(AABB, { x: 3, y: 0 }, { x: -3, y: 0 }), {
      fraction: 1 / 3,
      normal: { x: 1, y: 0 },
      point: { x: 1, y: 0 },
    });
    expectHit(rayCastAABB(AABB, { x: 0, y: -3 }, { x: 0, y: 3 }), {
      fraction: 1 / 3,
      normal: { x: 0, y: -1 },
      point: { x: 0, y: -1 },
    });
    expectHit(rayCastAABB(AABB, { x: 0, y: 3 }, { x: 0, y: -3 }), {
      fraction: 1 / 3,
      normal: { x: 0, y: 1 },
      point: { x: 0, y: 1 },
    });

    expect(rayCastAABB(AABB, { x: -3, y: 2 }, { x: 3, y: 2 }).hit).toBe(false);
    expect(rayCastAABB(AABB, { x: 2, y: -3 }, { x: 2, y: 3 }).hit).toBe(false);
    expect(rayCastAABB(AABB, { x: 0, y: 0 }, { x: 2, y: 0 }).hit).toBe(false);

    const corner = rayCastAABB(AABB, { x: -2, y: -2 }, { x: 2, y: 2 });
    expect(corner.hit).toBe(true);
    expect(corner.fraction).toBeCloseTo(0.25, 7);
    expect(
      (corner.normal.x === -1 && corner.normal.y === 0) ||
        (corner.normal.x === 0 && corner.normal.y === -1)
    ).toBe(true);

    expect(rayCastAABB(AABB, { x: -2, y: 1.5 }, { x: 2, y: 1.5 }).hit).toBe(false);
    expectHit(rayCastAABB(AABB, { x: -2, y: 1 }, { x: 2, y: 1 }), {
      fraction: 0.25,
      normal: { x: -1, y: 0 },
    });
    expect(rayCastAABB(AABB, { x: -3, y: 0 }, { x: -2.5, y: 0 }).hit).toBe(false);
    expect(rayCastAABB(AABB, { x: 0, y: 0 }, { x: 0, y: 0 }).hit).toBe(false);
    expectHit(rayCastAABB(AABB, { x: -2, y: 0 }, { x: -1, y: 0 }), {
      fraction: 1,
      normal: { x: -1, y: 0 },
    });

    const offsetAABB: AABB = { lowerBound: { x: 2, y: 3 }, upperBound: { x: 4, y: 5 } };
    expectHit(rayCastAABB(offsetAABB, { x: 0, y: 4 }, { x: 6, y: 4 }), {
      fraction: 1 / 3,
      normal: { x: -1, y: 0 },
      point: { x: 2, y: 4 },
    });
  });
});

function expectHit(
  output: AABBCastOutput,
  expected: { fraction: number; normal: Vec2; point?: Vec2 }
): void {
  expect(output.hit).toBe(true);
  expect(output.fraction).toBeCloseTo(expected.fraction, 7);
  expect(output.normal.x).toBeCloseTo(expected.normal.x, 7);
  expect(output.normal.y).toBeCloseTo(expected.normal.y, 7);
  if (expected.point !== undefined) {
    expect(output.point.x).toBeCloseTo(expected.point.x, 7);
    expect(output.point.y).toBeCloseTo(expected.point.y, 7);
  }
}
