import { describe, expect, it } from "vitest";

import {
  center,
  contains,
  extents,
  isValid,
  makeAABB,
  overlaps,
  perimeter,
  union,
  type AABB,
} from "../../src/math/aabb.js";
import { HUGE } from "../../src/math/constants.js";

const box = (lx: number, ly: number, ux: number, uy: number): AABB => ({
  lowerBound: { x: lx, y: ly },
  upperBound: { x: ux, y: uy },
});

describe("aabb", () => {
  it("reports containment (touching edges count as contained)", () => {
    expect(contains(box(0, 0, 10, 10), box(2, 2, 8, 8))).toBe(true);
    expect(contains(box(0, 0, 10, 10), box(0, 0, 10, 10))).toBe(true);
    expect(contains(box(0, 0, 10, 10), box(-1, 2, 8, 8))).toBe(false);
  });

  it("computes center, extents, and perimeter", () => {
    const a = box(-2, -4, 4, 6);
    expect(center(a)).toEqual({ x: 1, y: 1 });
    expect(extents(a)).toEqual({ x: 3, y: 5 });
    expect(perimeter(a)).toBe(2 * (6 + 10));
  });

  it("unions two boxes into the smallest enclosing box", () => {
    expect(union(box(0, 0, 2, 2), box(1, -1, 5, 1))).toEqual(box(0, -1, 5, 2));
  });

  it("detects overlap including edge contact", () => {
    expect(overlaps(box(0, 0, 2, 2), box(1, 1, 3, 3))).toBe(true);
    expect(overlaps(box(0, 0, 2, 2), box(2, 2, 4, 4))).toBe(true);
    expect(overlaps(box(0, 0, 2, 2), box(3, 3, 4, 4))).toBe(false);
  });

  it("builds a box over a point cloud expanded by a radius", () => {
    const a = makeAABB(
      [
        { x: -1, y: 0 },
        { x: 1, y: 2 },
        { x: 0, y: -3 },
      ],
      0.5
    );
    expect(a).toEqual(box(-1.5, -3.5, 1.5, 2.5));
  });

  it("validates well-formed and rejects inverted or out-of-range boxes", () => {
    expect(isValid(box(0, 0, 1, 1))).toBe(true);
    expect(isValid(box(0, 0, -1, 1))).toBe(false);
    expect(isValid(box(0, 0, 2 * HUGE, 1))).toBe(false);
    expect(isValid(box(0, 0, Number.NaN, 1))).toBe(false);
  });
});
