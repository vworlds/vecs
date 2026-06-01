import { describe, expect, it } from "vitest";

import { PI } from "../../src/math/constants.js";
import {
  IDENTITY,
  computeAngularVelocity,
  getAngle,
  getXAxis,
  getYAxis,
  integrateRotation,
  invMulRot,
  invRotateVector,
  invertRot,
  isNormalizedRot,
  makeRot,
  mulRot,
  normalizeRot,
  rotateVector,
  unwindAngle,
} from "../../src/math/rot.js";

describe("rot", () => {
  it("round-trips angle through makeRot/getAngle", () => {
    for (const a of [0, 0.5, 1, -1, PI / 2, -PI / 2, 2.9, -2.9]) {
      expect(getAngle(makeRot(a))).toBeCloseTo(a, 12);
    }
  });

  it("rotates a vector and inverts the rotation", () => {
    const q = makeRot(PI / 2);
    const v = rotateVector(q, { x: 1, y: 0 });
    expect(v.x).toBeCloseTo(0, 12);
    expect(v.y).toBeCloseTo(1, 12);
    expect(invRotateVector(q, v)).toMatchObject({
      x: expect.closeTo(1, 12),
      y: expect.closeTo(0, 12),
    });
  });

  it("composes rotations and divides them out", () => {
    const a = makeRot(0.7);
    const b = makeRot(-0.3);
    expect(getAngle(mulRot(a, b))).toBeCloseTo(0.4, 12);
    expect(getAngle(invMulRot(a, b))).toBeCloseTo(-1.0, 12);
    expect(getAngle(invertRot(a))).toBeCloseTo(-0.7, 12);
  });

  it("exposes orthonormal axes", () => {
    const q = makeRot(PI / 2);
    expect(getXAxis(q)).toMatchObject({ x: expect.closeTo(0, 12), y: expect.closeTo(1, 12) });
    expect(getYAxis(q)).toMatchObject({ x: expect.closeTo(-1, 12), y: expect.closeTo(0, 12) });
  });

  it("integrateRotation matches a fresh makeRot for small steps and stays normalized", () => {
    const q = integrateRotation(makeRot(0.2), 0.01);
    expect(isNormalizedRot(q)).toBe(true);
    expect(getAngle(q)).toBeCloseTo(0.21, 4);
  });

  it("recovers angular velocity from two rotations", () => {
    const invH = 60;
    const q1 = makeRot(0.1);
    const q2 = integrateRotation(q1, 0.5 / invH);
    expect(computeAngularVelocity(q1, q2, invH)).toBeCloseTo(0.5, 3);
  });

  it("normalizes a denormal rotation and reports validity", () => {
    expect(isNormalizedRot({ c: 2, s: 0 })).toBe(false);
    const n = normalizeRot({ c: 2, s: 0 });
    expect(n).toEqual({ c: 1, s: 0 });
    expect(isNormalizedRot(IDENTITY)).toBe(true);
  });

  it("unwinds angles into [-pi, pi]", () => {
    for (let t = -10; t < 10; t += 0.1) {
      const xn = unwindAngle(PI * t);
      expect(xn).toBeGreaterThanOrEqual(-PI - 1e-9);
      expect(xn).toBeLessThanOrEqual(PI + 1e-9);
    }
    expect(unwindAngle(2 * PI + 0.3)).toBeCloseTo(0.3, 12);
  });
});
