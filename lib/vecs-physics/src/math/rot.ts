// Ported from box2d/include/box2d/math_functions.h (b2Rot section).
//
// A rotation is stored as a unit complex number { c = cos, s = sin } rather
// than a raw angle: rotating a point is then a complex multiply, far cheaper
// than a sin/cos per call. Box2D uses polynomial approximations for cos/sin
// (b2ComputeCosSin) and atan2 (b2Atan2) for speed and cross-platform bit
// determinism. vecs-physics targets a single platform (x64 Linux) and uses
// the standard library `Math.cos`/`Math.sin`/`Math.atan2`, which are both
// simpler and more accurate; the difference stays well within the tolerances
// Box2D's own tests allow.

import { PI } from "./constants.js";
import type { Vec2 } from "./vec2.js";

/** A 2D rotation as a unit complex number. */
export interface Rot {
  /** cosine */
  c: number;
  /** sine */
  s: number;
}

/** The identity rotation (angle 0). Treat as immutable. */
export const IDENTITY: Readonly<Rot> = { c: 1, s: 0 };

/** Make a rotation from an angle in radians. */
export function makeRot(radians: number): Rot {
  return { c: Math.cos(radians), s: Math.sin(radians) };
}

/** Make a rotation from a unit direction vector. */
export function makeRotFromUnitVector(unit: Vec2): Rot {
  return { c: unit.x, s: unit.y };
}

/** Normalize a rotation back to unit length; returns identity for a degenerate input. */
export function normalizeRot(q: Rot): Rot {
  const mag = Math.sqrt(q.c * q.c + q.s * q.s);
  const inv = mag > 0 ? 1 / mag : 0;
  return { c: q.c * inv, s: q.s * inv };
}

/** True when q is unit length within Box2D's tolerance. */
export function isNormalizedRot(q: Rot): boolean {
  const qq = q.c * q.c + q.s * q.s;
  return 1.0 - 0.0006 < qq && qq < 1.0 + 0.0006;
}

/**
 * Advance a rotation by a small angle and renormalize. This is the integrator
 * the solver uses each sub-step (a first-order complex-number update), not a
 * fresh `makeRot`.
 */
export function integrateRotation(q: Rot, deltaAngle: number): Rot {
  const c2 = q.c - deltaAngle * q.s;
  const s2 = q.s + deltaAngle * q.c;
  const mag = Math.sqrt(c2 * c2 + s2 * s2);
  const inv = mag > 0 ? 1 / mag : 0;
  return { c: c2 * inv, s: s2 * inv };
}

/** Inverse rotation (conjugate). */
export function invertRot(q: Rot): Rot {
  return { c: q.c, s: -q.s };
}

/** Normalized linear interpolation between two rotations. */
export function nlerp(q1: Rot, q2: Rot, t: number): Rot {
  const omt = 1 - t;
  return normalizeRot({ c: omt * q1.c + t * q2.c, s: omt * q1.s + t * q2.s });
}

/** Compose rotations: result = q * r. */
export function mulRot(q: Rot, r: Rot): Rot {
  return { c: q.c * r.c - q.s * r.s, s: q.s * r.c + q.c * r.s };
}

/** Compose with the inverse of a: result = a^-1 * b. */
export function invMulRot(a: Rot, b: Rot): Rot {
  return { c: a.c * b.c + a.s * b.s, s: a.c * b.s - a.s * b.c };
}

/** Angular velocity that carries q1 to q2 over a step of length 1/inv_h. */
export function computeAngularVelocity(q1: Rot, q2: Rot, invH: number): number {
  return invH * (q2.s * q1.c - q2.c * q1.s);
}

/** The rotation that takes unit vector v1 to unit vector v2. */
export function computeRotationBetweenUnitVectors(v1: Vec2, v2: Vec2): Rot {
  return normalizeRot({ c: v1.x * v2.x + v1.y * v2.y, s: v1.x * v2.y - v1.y * v2.x });
}

/** Rotate a vector by q. */
export function rotateVector(q: Rot, v: Vec2): Vec2 {
  return { x: q.c * v.x - q.s * v.y, y: q.s * v.x + q.c * v.y };
}

/** Rotate a vector by the inverse of q. */
export function invRotateVector(q: Rot, v: Vec2): Vec2 {
  return { x: q.c * v.x + q.s * v.y, y: -q.s * v.x + q.c * v.y };
}

/** Angle of q in radians, in [-pi, pi]. */
export function getAngle(q: Rot): number {
  return Math.atan2(q.s, q.c);
}

/** The rotation's local x axis. */
export function getXAxis(q: Rot): Vec2 {
  return { x: q.c, y: q.s };
}

/** The rotation's local y axis. */
export function getYAxis(q: Rot): Vec2 {
  return { x: -q.s, y: q.c };
}

/** Signed angle of b relative to a, in [-pi, pi]. */
export function relativeAngle(a: Rot, b: Rot): number {
  const s = a.c * b.s - a.s * b.c;
  const c = a.c * b.c + a.s * b.s;
  return Math.atan2(s, c);
}

/**
 * Fold any angle into [-pi, pi]. Box2D uses `remainderf`; we use the
 * round-to-nearest reduction, which also lands in [-pi, pi]. The two differ
 * only on which endpoint (±pi) is returned at exact odd multiples of pi —
 * physically the same angle.
 */
export function unwindAngle(radians: number): number {
  const twoPi = 2 * PI;
  return radians - twoPi * Math.round(radians / twoPi);
}
