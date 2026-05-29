# Shape Pose Updates Do Not Dirty Body Mass

## What is wrong

`PhysicsShapePoseSync` updates a shape's local pose and broad-phase proxy when `ShapePosition` or `ShapeRotation` changes, but it does not mark the owning body `massDirty`.

Shape local pose is part of the body's mass model. Moving a child shape changes the body-local center of mass, inertia, and extents. Rotating a child shape can also change the body-local center of mass when the geometry centroid is not at the shape origin.

## Why it is wrong

M2's mass recompute path is gated entirely by `InternalBody.massDirty`. `PhysicsMassRecompute` only calls `updateBodyMassData` for bodies with that flag set, and `updateBodyMassData` reads `shape.localX`, `shape.localY`, `shape.localCos`, and `shape.localSin` when transforming per-shape mass data into body-local space.

The result is a stale mass cache after a local pose edit. The AABB moves, but `BodySim.localCenterX/Y`, `invInertia`, `minExtent`, and `maxExtent` remain based on the old shape pose.

## Impacted code

- `src/systems/shape_pose_sync.ts:121-132` updates single-shape local pose and proxy but does not dirty the body.
- `src/systems/shape_pose_sync.ts:150-163` does the same for chain segment shapes.
- `src/systems/mass_recompute.ts:31-50` only recomputes bodies already marked `massDirty`.
- `src/engine/mass.ts:481-485` uses the shape local pose to compute body-local centroids, so this flag matters for correctness.

## Impacted features

- Compound bodies with offset shapes.
- Runtime edits to `ShapePosition` and `ShapeRotation`.
- Future solver behavior, because impulses will be applied around a stale center of mass and stale inertia.
- Future sleep/CCD heuristics that depend on `minExtent` and `maxExtent`.

## How to reproduce

Add a test that creates a dynamic body with one circle child, progresses once, then moves the child with `ShapePosition` and progresses again:

1. Create a dynamic `Body` at the origin.
2. Create a child `Circle` with `radius: 1` and `ShapePosition { x: 0, y: 0 }`.
3. `world.progress(...)` and assert `sim.localCenterX === 0`.
4. Set `ShapePosition { x: 10, y: 0 }` on the child.
5. `world.progress(...)`.

Expected: `sim.localCenterX` is recomputed to `10`.

Current behavior: the shape record and AABB move, but `massDirty` was never set, so `sim.localCenterX` remains `0`.

## Possible solutions

Mark the owning body `massDirty` whenever a non-chain shape pose changes. For chain shapes this is harmless but not mass-relevant because chain segments have zero mass; still consider marking the parent dirty consistently for extents.

Add lifecycle tests that assert `ShapePosition` and `ShapeRotation` edits update `BodySim.localCenter*` or `maxExtent` after the next progress.
