import { describe, expect, it } from "vitest";

import {
  ZERO,
  abs,
  add,
  clamp,
  cross,
  crossSV,
  crossVS,
  distance,
  distanceSquared,
  dot,
  isNormalized,
  leftPerp,
  length,
  lengthSquared,
  lerp,
  max,
  min,
  mul,
  mulAdd,
  mulSV,
  mulSub,
  neg,
  normalize,
  rightPerp,
  sub,
  vec2,
} from "../../src/math/vec2.js";

describe("vec2", () => {
  it("adds and subtracts componentwise", () => {
    expect(add(vec2(1, 1), vec2(2, 2))).toEqual({ x: 3, y: 3 });
    expect(sub(ZERO, vec2(2, 2))).toEqual({ x: -2, y: -2 });
    expect(neg(vec2(3, -4))).toEqual({ x: -3, y: 4 });
  });

  it("scales and fuses multiply-add", () => {
    expect(mulSV(2, vec2(3, -1))).toEqual({ x: 6, y: -2 });
    expect(mul(vec2(2, 3), vec2(4, 5))).toEqual({ x: 8, y: 15 });
    expect(mulAdd(vec2(1, 1), 2, vec2(3, 4))).toEqual({ x: 7, y: 9 });
    expect(mulSub(vec2(1, 1), 2, vec2(3, 4))).toEqual({ x: -5, y: -7 });
    expect(lerp(vec2(0, 0), vec2(10, 20), 0.25)).toEqual({ x: 2.5, y: 5 });
  });

  it("computes dot and 2D cross products", () => {
    expect(dot(vec2(1, 2), vec2(3, 4))).toBe(11);
    expect(cross(vec2(1, 0), vec2(0, 1))).toBe(1);
    expect(cross(vec2(0, 1), vec2(1, 0))).toBe(-1);
  });

  it("builds perpendiculars consistent with the scalar crosses", () => {
    const v = vec2(2, 3);
    expect(leftPerp(v)).toEqual({ x: -3, y: 2 });
    expect(rightPerp(v)).toEqual({ x: 3, y: -2 });
    expect(crossSV(1, v)).toEqual(leftPerp(v));
    expect(crossVS(v, 1)).toEqual(rightPerp(v));
  });

  it("computes lengths and distances", () => {
    expect(length(vec2(3, 4))).toBe(5);
    expect(lengthSquared(vec2(3, 4))).toBe(25);
    expect(distance(vec2(1, 2), vec2(4, 6))).toBe(5);
    expect(distanceSquared(vec2(1, 2), vec2(4, 6))).toBe(25);
  });

  it("normalizes to unit length and reports zero for a zero vector", () => {
    const n = normalize(vec2(3, 4));
    expect(n.x).toBeCloseTo(0.6, 12);
    expect(n.y).toBeCloseTo(0.8, 12);
    expect(isNormalized(n)).toBe(true);
    expect(normalize(ZERO)).toEqual({ x: 0, y: 0 });
    expect(isNormalized(vec2(3, 4))).toBe(false);
  });

  it("clamps, mins, maxes, and takes absolute values componentwise", () => {
    expect(abs(vec2(-2, 3))).toEqual({ x: 2, y: 3 });
    expect(min(vec2(1, 5), vec2(3, 2))).toEqual({ x: 1, y: 2 });
    expect(max(vec2(1, 5), vec2(3, 2))).toEqual({ x: 3, y: 5 });
    expect(clamp(vec2(-1, 9), vec2(0, 0), vec2(5, 5))).toEqual({ x: 0, y: 5 });
  });
});
