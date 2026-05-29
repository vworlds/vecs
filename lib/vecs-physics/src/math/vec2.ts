// Ported from box2d/include/box2d/math_functions.h (b2Vec2 section).
// Pure functions over a plain { x, y } shape. The hot solver inlines scalar
// math instead of calling these; this module is the readable reference
// vocabulary used by setup, mass, broad-phase, and manifold code.

/** A 2D vector. Matches the public `Vec2` shape used by `Polygon` / `Chain`. */
export interface Vec2 {
  x: number;
  y: number;
}

/** The zero vector. Treat as immutable; never mutate a shared constant. */
export const ZERO: Readonly<Vec2> = { x: 0, y: 0 };

/** Construct a vector. */
export function vec2(x: number, y: number): Vec2 {
  return { x, y };
}

/** a + b */
export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

/** a - b */
export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

/** -a */
export function neg(a: Vec2): Vec2 {
  return { x: -a.x, y: -a.y };
}

/** Component-wise a * b. */
export function mul(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x * b.x, y: a.y * b.y };
}

/** s * v */
export function mulSV(s: number, v: Vec2): Vec2 {
  return { x: s * v.x, y: s * v.y };
}

/** a + s * b */
export function mulAdd(a: Vec2, s: number, b: Vec2): Vec2 {
  return { x: a.x + s * b.x, y: a.y + s * b.y };
}

/** a - s * b */
export function mulSub(a: Vec2, s: number, b: Vec2): Vec2 {
  return { x: a.x - s * b.x, y: a.y - s * b.y };
}

/** Linear interpolation from a to b by t. */
export function lerp(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: (1 - t) * a.x + t * b.x, y: (1 - t) * a.y + t * b.y };
}

/** Dot product. */
export function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

/** 2D scalar cross product (z component of the 3D cross). */
export function cross(a: Vec2, b: Vec2): number {
  return a.x * b.y - a.y * b.x;
}

/** Cross of a vector and a scalar: { s*v.y, -s*v.x }. */
export function crossVS(v: Vec2, s: number): Vec2 {
  return { x: s * v.y, y: -s * v.x };
}

/** Cross of a scalar and a vector: { -s*v.y, s*v.x }. */
export function crossSV(s: number, v: Vec2): Vec2 {
  return { x: -s * v.y, y: s * v.x };
}

/** Left perpendicular: { -v.y, v.x }. */
export function leftPerp(v: Vec2): Vec2 {
  return { x: -v.y, y: v.x };
}

/** Right perpendicular: { v.y, -v.x }. */
export function rightPerp(v: Vec2): Vec2 {
  return { x: v.y, y: -v.x };
}

/** Component-wise absolute value. */
export function abs(a: Vec2): Vec2 {
  return { x: Math.abs(a.x), y: Math.abs(a.y) };
}

/** Component-wise minimum. */
export function min(a: Vec2, b: Vec2): Vec2 {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) };
}

/** Component-wise maximum. */
export function max(a: Vec2, b: Vec2): Vec2 {
  return { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) };
}

/** Component-wise clamp of v into [lower, upper]. */
export function clamp(v: Vec2, lower: Vec2, upper: Vec2): Vec2 {
  return {
    x: Math.min(Math.max(v.x, lower.x), upper.x),
    y: Math.min(Math.max(v.y, lower.y), upper.y),
  };
}

/** Euclidean length. */
export function length(v: Vec2): number {
  return Math.sqrt(v.x * v.x + v.y * v.y);
}

/** Squared length (no sqrt). */
export function lengthSquared(v: Vec2): number {
  return v.x * v.x + v.y * v.y;
}

/** Distance between a and b. */
export function distance(a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Squared distance between a and b. */
export function distanceSquared(a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return dx * dx + dy * dy;
}

/** Unit vector in the direction of v; returns zero for a zero-length input. */
export function normalize(v: Vec2): Vec2 {
  const len = Math.sqrt(v.x * v.x + v.y * v.y);
  if (len < Number.EPSILON) {
    return { x: 0, y: 0 };
  }
  const inv = 1 / len;
  return { x: inv * v.x, y: inv * v.y };
}

/** True when v is unit length within a small tolerance. */
export function isNormalized(v: Vec2): boolean {
  return Math.abs(1 - (v.x * v.x + v.y * v.y)) < 100 * Number.EPSILON;
}
