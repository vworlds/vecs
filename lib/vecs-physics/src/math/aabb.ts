// Ported from box2d/include/box2d/math_functions.h (b2AABB section)
// and box2d/src/aabb.c (b2AABB_RayCast).
// Axis-aligned bounding box used by the broad phase and dynamic tree.

import { HUGE } from "./constants.js";
import type { Vec2 } from "./vec2.js";

/** An axis-aligned bounding box. */
export interface AABB {
  lowerBound: Vec2;
  upperBound: Vec2;
}

/** Segment cast result for {@link rayCastAABB}. Mirrors b2CastOutput. */
export interface AABBCastOutput {
  hit: boolean;
  fraction: number;
  normal: Vec2;
  point: Vec2;
}

const FLT_EPSILON = 1.1920929e-7;

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

/** Cast the segment p1 -> p2 against an AABB. Starts inside the box do not hit. */
export function rayCastAABB(a: AABB, p1: Vec2, p2: Vec2): AABBCastOutput {
  const output = emptyCastOutput();
  let tmin = -Number.MAX_VALUE;
  let tmax = Number.MAX_VALUE;
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const normal: Vec2 = { x: 0, y: 0 };

  if (Math.abs(dx) < FLT_EPSILON) {
    if (p1.x < a.lowerBound.x || a.upperBound.x < p1.x) {
      return output;
    }
  } else {
    const invD = 1 / dx;
    let t1 = (a.lowerBound.x - p1.x) * invD;
    let t2 = (a.upperBound.x - p1.x) * invD;
    let s = -1;

    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
      s = 1;
    }

    if (t1 > tmin) {
      normal.x = s;
      normal.y = 0;
      tmin = t1;
    }

    tmax = Math.min(tmax, t2);
    if (tmin > tmax) {
      return output;
    }
  }

  if (Math.abs(dy) < FLT_EPSILON) {
    if (p1.y < a.lowerBound.y || a.upperBound.y < p1.y) {
      return output;
    }
  } else {
    const invD = 1 / dy;
    let t1 = (a.lowerBound.y - p1.y) * invD;
    let t2 = (a.upperBound.y - p1.y) * invD;
    let s = -1;

    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
      s = 1;
    }

    if (t1 > tmin) {
      normal.x = 0;
      normal.y = s;
      tmin = t1;
    }

    tmax = Math.min(tmax, t2);
    if (tmin > tmax) {
      return output;
    }
  }

  if (tmin < 0 || 1 < tmin) {
    return output;
  }

  return {
    hit: true,
    fraction: tmin,
    normal,
    point: { x: p1.x + tmin * dx, y: p1.y + tmin * dy },
  };
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

function emptyCastOutput(): AABBCastOutput {
  return {
    hit: false,
    fraction: 0,
    normal: { x: 0, y: 0 },
    point: { x: 0, y: 0 },
  };
}
