# Body Transform Changes Do Not Refit Shape Proxies

## What is wrong

When a body transform changes after its shapes have been created, the attached shapes' cached world AABBs and broad-phase proxies are not updated.

This happens for user teleports through `Position` or `Rotation`, and it will also happen for simulated movement from `engineStep`. The body moves, but each child shape stays in the broad-phase tree at its old world AABB.

## Why it is wrong

M2 explicitly stores shape AABBs and proxies in world space using `computeAABB(geom, mul(bodyWorldTransform, shapeLocalTransform))`. That cache must be refreshed whenever the body world transform changes, not only when the shape-local transform changes.

Box2D does this on both transform writes and solver movement. `box2d/src/body.c:727-752` walks every shape in `b2Body_SetTransform`, recomputes the shape AABB, and moves the broad-phase proxy when the fat AABB no longer contains the new tight AABB. The solver refit path also enlarges moved shape proxies before broad-phase pair generation.

The current port only refreshes AABBs in shape lifecycle/shape-pose paths.

## Impacted code

- `src/systems/pose_sync_in.ts:30-46` writes body transforms for `Position` and `Rotation` updates but does not walk child shapes or move proxies.
- `src/engine/step.ts:131-172` finalizes moved awake bodies and emits `bodyMoveEvents`, but no M2 code consumes those move events to refit child shape AABBs/proxies.
- `src/systems/shape_lifecycle.ts:512-523` computes the correct world AABB at creation only.
- `src/systems/shape_pose_sync.ts:126-132` recomputes AABBs for shape-local pose changes only.

## Impacted features

- User teleports of any body with shapes.
- Gravity/integrator movement of dynamic bodies once contacts are wired.
- M3 broad-phase pair creation, because stale proxies will query the wrong location.
- Contact persistence and events, because contacts may be created, retained, or missed based on old AABBs.

## How to reproduce

Add a lifecycle test:

1. Create a static body at `{ x: 0, y: 0 }` with a child `Box`.
2. Progress once and assert the shape AABB center is `0`.
3. Set the body's `Position` to `{ x: 10, y: 0 }`.
4. Progress again.

Expected: the shape AABB and broad-phase proxy center move to `10`.

Current behavior: the body `BodySim.transformX` moves to `10`, but the shape AABB/proxy remain centered at `0`.

The dynamic-body variant is the same: seed a dynamic body with positive mass, let gravity move it, then inspect its child shape AABB. It remains at the creation transform.

## Possible solutions

Introduce a shared helper that refits all shapes attached to a body from the current `BodySim` transform and each shape's local pose. Call it from:

- `PhysicsPoseSyncIn` after accepted teleports.
- The step/finalization path for body ids in `bodyMoveEvents`, before M3 broad-phase pair creation.

Use Box2D's containment check to avoid unnecessary `moveProxy` calls when the tight AABB still fits inside the existing fat AABB.
