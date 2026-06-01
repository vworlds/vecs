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
 * Mirrors `b2ManifoldPoint`. The geometry fields (`clipPoint`/`anchorA`/
 * `anchorB`/`separation`/`id`) are produced by the narrow-phase manifold
 * functions; the remaining solver/warm-start fields are zeroed by those
 * functions and populated by the TGS solver (VP-17).
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

  // ── Solver / warm-start fields (mirror `b2ManifoldPoint`) ───────────────────
  /** Cached separation used for contact recycling. Solver/warm-start field. */
  baseSeparation: number;
  /** Accumulated impulse along the manifold normal. Solver/warm-start field. */
  normalImpulse: number;
  /** Accumulated friction (tangent) impulse. Solver/warm-start field. */
  tangentImpulse: number;
  /** Total normal impulse across sub-stepping + restitution; identifies
   * speculative points that interacted this step. Solver field. */
  totalNormalImpulse: number;
  /** Relative normal velocity pre-solve (for hit events). Solver field. */
  normalVelocity: number;
  /** Whether this point existed the previous step (warm-start). Solver field. */
  persisted: boolean;
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
  /** Angular impulse applied for rolling resistance. Solver/warm-start field. */
  rollingImpulse: number;
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

/** Allocate a zero manifold point. The solver/warm-start fields are zeroed
 * (numbers `0`, `persisted: false`), mirroring box2d's `(b2Manifold){ 0 }`. */
export function emptyManifoldPoint(): ManifoldPoint {
  return {
    clipPoint: { x: 0, y: 0 },
    anchorA: { x: 0, y: 0 },
    anchorB: { x: 0, y: 0 },
    separation: 0,
    id: 0,
    baseSeparation: 0,
    normalImpulse: 0,
    tangentImpulse: 0,
    totalNormalImpulse: 0,
    normalVelocity: 0,
    persisted: false,
  };
}

/** Allocate an empty (zero-point) manifold. */
export function emptyManifold(): Manifold {
  return {
    normal: { x: 0, y: 0 },
    rollingImpulse: 0,
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
// Transitional stub kept alive for surviving engine code; full deletion happens in M7-10.
