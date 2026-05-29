// Ported from box2d/include/box2d/math_functions.h (b2AABB section).
// Axis-aligned bounding box used by the broad phase and dynamic tree.

import { HUGE } from "./constants.js";
import type { Vec2 } from "./vec2.js";

/** An axis-aligned bounding box. */
export interface AABB {
  lowerBound: Vec2;
  upperBound: Vec2;
}

/** True when a fully contains b. */
export function contains(a: AABB, b: AABB): boolean {
  return (
    a.lowerBound.x <= b.lowerBound.x &&
    a.lowerBound.y <= b.lowerBound.y &&
    b.upperBound.x <= a.upperBound.x &&
    b.upperBound.y <= a.upperBound.y
  );
}

/** Center point of the box. */
export function center(a: AABB): Vec2 {
  return {
    x: 0.5 * (a.lowerBound.x + a.upperBound.x),
    y: 0.5 * (a.lowerBound.y + a.upperBound.y),
  };
}

/** Half-widths of the box. */
export function extents(a: AABB): Vec2 {
  return {
    x: 0.5 * (a.upperBound.x - a.lowerBound.x),
    y: 0.5 * (a.upperBound.y - a.lowerBound.y),
  };
}

/** Smallest box containing both a and b. */
export function union(a: AABB, b: AABB): AABB {
  return {
    lowerBound: {
      x: Math.min(a.lowerBound.x, b.lowerBound.x),
      y: Math.min(a.lowerBound.y, b.lowerBound.y),
    },
    upperBound: {
      x: Math.max(a.upperBound.x, b.upperBound.x),
      y: Math.max(a.upperBound.y, b.upperBound.y),
    },
  };
}

/** True when a and b intersect (touching counts as overlap). */
export function overlaps(a: AABB, b: AABB): boolean {
  return !(
    b.lowerBound.x > a.upperBound.x ||
    b.lowerBound.y > a.upperBound.y ||
    a.lowerBound.x > b.upperBound.x ||
    a.lowerBound.y > b.upperBound.y
  );
}

/** Perimeter (2 * (width + height)) — the cost metric for the tree's SAH. */
export function perimeter(a: AABB): number {
  const wx = a.upperBound.x - a.lowerBound.x;
  const wy = a.upperBound.y - a.lowerBound.y;
  return 2 * (wx + wy);
}

/** Bounding box over a point cloud, expanded by `radius`. */
export function makeAABB(points: readonly Vec2[], radius = 0): AABB {
  const first = points[0];
  let lowerX = first.x;
  let lowerY = first.y;
  let upperX = first.x;
  let upperY = first.y;
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    lowerX = Math.min(lowerX, p.x);
    lowerY = Math.min(lowerY, p.y);
    upperX = Math.max(upperX, p.x);
    upperY = Math.max(upperY, p.y);
  }
  return {
    lowerBound: { x: lowerX - radius, y: lowerY - radius },
    upperBound: { x: upperX + radius, y: upperY + radius },
  };
}

/** True when the box is well-formed: finite, with lower <= upper and within range. */
export function isValid(a: AABB): boolean {
  const dx = a.upperBound.x - a.lowerBound.x;
  const dy = a.upperBound.y - a.lowerBound.y;
  if (!(dx >= 0 && dy >= 0)) {
    return false;
  }
  return (
    Number.isFinite(a.lowerBound.x) &&
    Number.isFinite(a.lowerBound.y) &&
    Number.isFinite(a.upperBound.x) &&
    Number.isFinite(a.upperBound.y) &&
    Math.abs(a.lowerBound.x) < HUGE &&
    Math.abs(a.lowerBound.y) < HUGE &&
    Math.abs(a.upperBound.x) < HUGE &&
    Math.abs(a.upperBound.y) < HUGE
  );
}
