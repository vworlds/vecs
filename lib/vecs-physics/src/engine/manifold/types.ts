// Manifold types for VP-13 (narrow-phase collision results).
//
// Mirrors box2d/include/box2d/collision.h: b2ManifoldPoint, b2Manifold,
// B2_MAKE_ID macro, b2SimplexCache.
//
// Engine module boundary: no imports from components/ or systems/.

// ─── ManifoldPoint ───────────────────────────────────────────────────────────

/**
 * A single contact point inside a {@link Manifold}.
 *
 * Mirrors `b2ManifoldPoint`. The solver fields (normalImpulse, tangentImpulse,
 * etc.) are deferred to M3 when the TGS solver lands; only the geometry fields
 * relevant to manifold generation are included here.
 *
 * - `anchorA` — contact point relative to shape-A's body origin, world space.
 * - `anchorB` — contact point relative to shape-B's body origin, world space.
 * - `clipPoint` — world-space midpoint (debug only; lags on recycled contacts).
 * - `separation` — signed separation; negative means penetrating.
 * - `id` — stable 16-bit contact ID used for warm-starting across frames.
 */
export interface ManifoldPoint {
  clipPoint: { x: number; y: number };
  anchorA: { x: number; y: number };
  anchorB: { x: number; y: number };
  separation: number;
  id: number;
}

// ─── Manifold ─────────────────────────────────────────────────────────────────

/**
 * A contact manifold produced by a narrow-phase collision function.
 *
 * Mirrors `b2Manifold`. Up to 2 points in 2D. The normal points from shape A
 * to shape B in world space.
 */
export interface Manifold {
  /** Unit normal from A to B, world space. */
  normal: { x: number; y: number };
  /** 0, 1, or 2 contact points. */
  points: [ManifoldPoint, ManifoldPoint];
  /** Number of valid entries in `points`. */
  pointCount: number;
}

// ─── makeId ──────────────────────────────────────────────────────────────────

/**
 * Build a 16-bit contact ID from two 8-bit feature indices.
 *
 * Mirrors `B2_MAKE_ID(A, B)` in manifold.c:
 *   `(uint8_t)(A) << 8 | (uint8_t)(B)`
 *
 * The id is used for warm-starting: identical pairs on consecutive frames share
 * cached impulses. VP-14/M3 depend on this encoding.
 */
export function makeId(a: number, b: number): number {
  return ((a & 0xff) << 8) | (b & 0xff);
}

// ─── Manifold factory helpers ─────────────────────────────────────────────────

/** Allocate a zero manifold point. */
export function emptyManifoldPoint(): ManifoldPoint {
  return {
    clipPoint: { x: 0, y: 0 },
    anchorA: { x: 0, y: 0 },
    anchorB: { x: 0, y: 0 },
    separation: 0,
    id: 0,
  };
}

/** Allocate an empty (zero-point) manifold. */
export function emptyManifold(): Manifold {
  return {
    normal: { x: 0, y: 0 },
    points: [emptyManifoldPoint(), emptyManifoldPoint()],
    pointCount: 0,
  };
}

// ─── SimplexCache ─────────────────────────────────────────────────────────────

/**
 * Warm-start cache for the GJK simplex.
 *
 * Mirrors `b2SimplexCache`. Zero-initialize for the first call.
 */
export interface SimplexCache {
  /** Number of stored simplex points (0..3). */
  count: number;
  /** Cached simplex indices on shape A (up to 3 entries). */
  indexA: [number, number, number];
  /** Cached simplex indices on shape B (up to 3 entries). */
  indexB: [number, number, number];
}

/** Create a zero-initialized simplex cache. */
export function emptySimplexCache(): SimplexCache {
  return { count: 0, indexA: [0, 0, 0], indexB: [0, 0, 0] };
}
