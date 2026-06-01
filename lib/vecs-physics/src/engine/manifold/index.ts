// Public re-exports for the engine/manifold module.
// VP-14 dispatch and M3 solver import from here.

export type { Manifold, ManifoldPoint, SimplexCache } from "./types.js";
export { makeId, emptyManifold, emptyManifoldPoint, emptySimplexCache } from "./types.js";

export { collideCircles } from "./circles.js";
export { collideCapsuleAndCircle } from "./circles.js";
export { collidePolygonAndCircle } from "./circles.js";

export { collidePolygons } from "./polygons.js";

export { collideCapsules } from "./capsules.js";
export { collideSegmentAndCapsule } from "./capsules.js";
export { collidePolygonAndCapsule } from "./capsules.js";

export { collideSegmentAndCircle } from "./segments.js";
export { collideSegmentAndPolygon } from "./segments.js";

export { collideChainSegmentAndCircle } from "./chain_segments.js";
export { collideChainSegmentAndCapsule } from "./chain_segments.js";
export { collideChainSegmentAndPolygon } from "./chain_segments.js";
