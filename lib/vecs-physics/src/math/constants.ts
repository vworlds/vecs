// Ported from box2d/include/box2d/constants.h and box2d/include/box2d/base.h.
// Box2D scales several tolerances by b2GetLengthUnitsPerMeter(); vecs-physics
// fixes the length unit at 1 meter, so each constant resolves to a concrete
// number here.

/** Pi, matching Box2D's `B2_PI`. */
export const PI = 3.14159265358979323846;

/**
 * Small length used as a collision and constraint tolerance — numerically
 * significant, visually insignificant. Box2D default: 0.5 cm.
 */
export const LINEAR_SLOP = 0.005;

/**
 * Maximum rotation of a body per sub-step. Prevents numerical problems.
 * Increasing this to >= 0.5*PI breaks continuous collision.
 */
export const MAX_ROTATION = 0.25 * PI;

/** Limited speculative collision distance; reduces jitter. Box2D default: 2 cm. */
export const SPECULATIVE_DISTANCE = 4.0 * LINEAR_SLOP;

/** Distance at which a touching contact is recycled. */
export const CONTACT_RECYCLE_DISTANCE = 10.0 * LINEAR_SLOP;

/** Cosine threshold (~11.5°) for contact recycling by angle. */
export const CONTACT_RECYCLE_COS_ANGLE = 0.98;

/** Fattens dynamic-tree AABBs so small moves do not trigger a refit. 5 cm. */
export const MAX_AABB_MARGIN = 0.05;

/** For small objects the AABB margin is limited to this fraction of the max extent. */
export const AABB_MARGIN_FRACTION = 0.125;

/** Time a body must be still before sleeping, in seconds. */
export const TIME_TO_SLEEP = 0.5;

/**
 * Bad-value sentinel. Positions beyond ~16 km lose precision, so 100 km is a
 * safe upper bound for validity checks.
 */
export const HUGE = 100000.0;
