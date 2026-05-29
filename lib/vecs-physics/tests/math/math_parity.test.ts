// Port of box2d/test/test_math.c::MathTest.
//
// Box2D asserts its polynomial cos/sin/atan2 approximations stay within a
// tolerance of the C standard library. vecs-physics uses Math.* directly, so
// those approximation-error assertions become trivially exact here; we keep
// the loops anyway because they also exercise our rotation, transform, and
// normalization algebra across a wide range of angles. The structural cases
// (transform composition, inverse round-trips, NLerp, relative angle) are the
// substantive checks and are reproduced faithfully.

import { describe, expect, it } from "vitest";

import { PI } from "../../src/math/constants.js";
import {
  computeRotationBetweenUnitVectors,
  getAngle,
  makeRot,
  nlerp,
  relativeAngle,
  rotateVector,
  unwindAngle,
  IDENTITY,
} from "../../src/math/rot.js";
import { mulTransforms, transformPoint, type Transform } from "../../src/math/transform.js";
import { normalize, vec2 } from "../../src/math/vec2.js";

describe("math parity (box2d MathTest)", () => {
  it("makeRot tracks cos/sin and unwindAngle stays in [-pi, pi]", () => {
    for (let t = -10; t < 10; t += 0.01) {
      const angle = PI * t;
      const r = makeRot(angle);
      expect(Math.abs(r.c - Math.cos(angle))).toBeLessThan(0.002);
      expect(Math.abs(r.s - Math.sin(angle))).toBeLessThan(0.002);

      const xn = unwindAngle(angle);
      expect(xn).toBeGreaterThanOrEqual(-PI - 1e-9);
      expect(xn).toBeLessThanOrEqual(PI + 1e-9);
    }
  });

  it("composes transforms consistently with sequential application", () => {
    const t1: Transform = { p: { x: -2, y: 3 }, q: makeRot(1) };
    const t2: Transform = { p: { x: 1, y: 0 }, q: makeRot(-2) };
    const two = vec2(2, 2);

    const composed = mulTransforms(t2, t1);
    const u = transformPoint(composed, two);
    const v = transformPoint(t2, transformPoint(t1, two));

    expect(u.x).toBeCloseTo(v.x, 12);
    expect(u.y).toBeCloseTo(v.y, 12);
  });

  it("computeRotationBetweenUnitVectors rotates one unit vector onto the other", () => {
    const v = normalize(vec2(0.2, -0.5));
    for (let y = -1; y <= 1; y += 0.05) {
      for (let x = -1; x <= 1; x += 0.05) {
        if (x === 0 && y === 0) {
          continue;
        }
        const u = normalize(vec2(x, y));
        const r = computeRotationBetweenUnitVectors(v, u);
        const w = rotateVector(r, v);
        expect(w.x).toBeCloseTo(u.x, 9);
        expect(w.y).toBeCloseTo(u.y, 9);
      }
    }
  });

  it("NLerp interpolates the angle within Box2D's 5-degree bound", () => {
    const q1 = IDENTITY;
    const q2 = makeRot(0.5 * PI);
    const n = 100;
    const tol = (5 * PI) / 180;
    for (let i = 0; i <= n; ++i) {
      const alpha = i / n;
      const angle = getAngle(nlerp(q1, q2, alpha));
      expect(Math.abs(alpha * 0.5 * PI - angle)).toBeLessThan(tol);
    }
  });

  it("relativeAngle agrees with the unwound angle difference", () => {
    const baseAngle = 0.75 * PI;
    const q1 = makeRot(baseAngle);
    const tol = (0.1 * PI) / 180;
    for (let t = -10; t < 10; t += 0.01) {
      const angle = PI * t;
      const q2 = makeRot(angle);
      const rel = relativeAngle(q1, q2);
      const unwound = unwindAngle(angle - baseAngle);
      expect(Math.abs(rel - unwound)).toBeLessThan(tol);
    }
  });
});
