import { describe, expect, it } from "vitest";

import { makeRot } from "../../src/math/rot.js";
import {
  IDENTITY,
  invMulTransforms,
  invTransformPoint,
  mulTransforms,
  transformPoint,
  type Transform,
} from "../../src/math/transform.js";

describe("transform", () => {
  it("treats identity as a no-op", () => {
    expect(transformPoint(IDENTITY, { x: 3, y: -2 })).toEqual({ x: 3, y: -2 });
  });

  it("round-trips a point through transformPoint/invTransformPoint", () => {
    // Mirrors box2d test_math.c: tolerance well within double precision.
    const t: Transform = { p: { x: -2, y: 3 }, q: makeRot(1) };
    const p = { x: 2, y: 2 };
    const back = invTransformPoint(t, transformPoint(t, p));
    expect(back.x).toBeCloseTo(p.x, 12);
    expect(back.y).toBeCloseTo(p.y, 12);
  });

  it("composes transforms so mulTransforms(b,a) equals applying a then b", () => {
    // Direct port of the b2MulTransforms case in test_math.c::MathTest.
    const t1: Transform = { p: { x: -2, y: 3 }, q: makeRot(1) };
    const t2: Transform = { p: { x: 1, y: 0 }, q: makeRot(-2) };
    const two = { x: 2, y: 2 };

    const composed = mulTransforms(t2, t1);
    const u = transformPoint(composed, two);
    const v = transformPoint(t2, transformPoint(t1, two));

    expect(u.x).toBeCloseTo(v.x, 12);
    expect(u.y).toBeCloseTo(v.y, 12);
  });

  it("invMulTransforms is the left inverse of mulTransforms", () => {
    const a: Transform = { p: { x: 5, y: -1 }, q: makeRot(0.6) };
    const b: Transform = { p: { x: 2, y: 4 }, q: makeRot(-0.9) };
    const recovered = invMulTransforms(a, mulTransforms(a, b));
    expect(recovered.p.x).toBeCloseTo(b.p.x, 12);
    expect(recovered.p.y).toBeCloseTo(b.p.y, 12);
    expect(recovered.q.c).toBeCloseTo(b.q.c, 12);
    expect(recovered.q.s).toBeCloseTo(b.q.s, 12);
  });
});
