// Ported from box2d/include/box2d/math_functions.h (b2Transform section).
// A transform is a rotation plus a translation: world = q * local + p.

import {
  invMulRot,
  invRotateVector,
  mulRot,
  rotateVector,
  type Rot,
  IDENTITY as ROT_IDENTITY,
} from "./rot.js";
import type { Vec2 } from "./vec2.js";

/** A rigid 2D transform: translation `p` and rotation `q`. */
export interface Transform {
  p: Vec2;
  q: Rot;
}

/** The identity transform. Treat as immutable. */
export const IDENTITY: Readonly<Transform> = { p: { x: 0, y: 0 }, q: ROT_IDENTITY };

/** Transform a local point into world space: q * p + t.p. */
export function transformPoint(t: Transform, p: Vec2): Vec2 {
  return {
    x: t.q.c * p.x - t.q.s * p.y + t.p.x,
    y: t.q.s * p.x + t.q.c * p.y + t.p.y,
  };
}

/** Transform a world point into local space (inverse of {@link transformPoint}). */
export function invTransformPoint(t: Transform, p: Vec2): Vec2 {
  const vx = p.x - t.p.x;
  const vy = p.y - t.p.y;
  return { x: t.q.c * vx + t.q.s * vy, y: -t.q.s * vx + t.q.c * vy };
}

/** Compose transforms: result maps a point through B then A. */
export function mulTransforms(a: Transform, b: Transform): Transform {
  const rotated = rotateVector(a.q, b.p);
  return {
    q: mulRot(a.q, b.q),
    p: { x: rotated.x + a.p.x, y: rotated.y + a.p.y },
  };
}

/** Compose with the inverse of A: result = A^-1 * B. */
export function invMulTransforms(a: Transform, b: Transform): Transform {
  return {
    q: invMulRot(a.q, b.q),
    p: invRotateVector(a.q, { x: b.p.x - a.p.x, y: b.p.y - a.p.y }),
  };
}
