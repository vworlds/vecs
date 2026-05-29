# Degenerate Segment And Capsule Shapes Are Accepted

## What is wrong

The port accepts zero-length or near-zero-length capsules, segments, and chain segments. Those geometries are invalid in Box2D and can produce `NaN` manifold data in this implementation.

## Why it is wrong

Box2D rejects these shapes at creation/update time:

- `box2d/src/shape.c:252-260` returns a null shape id for capsules whose endpoint distance is `<= B2_LINEAR_SLOP`.
- `box2d/src/shape.c:269-278` rejects degenerate segments.
- `box2d/src/shape.c:281-288` rejects degenerate chain segments.
- `box2d/src/shape.c:1495-1518` ignores invalid capsule updates.

The TypeScript port has no equivalent validation in either shape construction or geometry update paths. The narrow-phase code assumes valid geometry and divides by segment length in several places.

## Impacted code

- `src/systems/shape_lifecycle.ts:168-188` builds capsule shapes without endpoint-length validation.
- `src/systems/shape_lifecycle.ts:190-208` builds segment shapes without endpoint-length validation.
- `src/systems/shape_lifecycle.ts:591-615` updates capsule/segment geometry without validation.
- `src/engine/shape.ts:198-227` exposes `makeCapsuleShape` and `makeSegmentShape` without validation.
- `src/engine/shape.ts:280-341` expands chains without rejecting duplicate adjacent points.
- `src/engine/manifold/circles.ts:131-144` divides by `dot(e, e)` for capsule-circle and segment-circle paths.
- `src/engine/manifold/capsules.ts:96-118` divides by `dd1`/`dd2` in capsule-capsule paths.

## Impacted features

- User-authored zero-length capsules or segments.
- Chains with duplicate adjacent points.
- M3 contacts and solver state, because `NaN` anchors, separations, or normals can poison an island.
- Debug validation and parity tests for shape creation.

## How to reproduce

Capsule-circle path:

1. Create or directly call a capsule with `{ ax: 0, ay: 0, bx: 0, by: 0, radius: 1 }`.
2. Collide it with a circle near the same point.

Current behavior: `collideCapsuleAndCircle` reaches `s1 / dot(e, e)` where `e` is zero, producing `NaN` contact data.

Segment-circle path is the same because `collideSegmentAndCircle` reduces the segment to a zero-radius capsule.

## Possible solutions

Validate endpoint length against `LINEAR_SLOP * LINEAR_SLOP` at every public-to-engine geometry boundary:

- On shape creation, skip creating the invalid internal shape and optionally emit a debug warning.
- On geometry update, preserve the old valid shape if the new geometry is invalid, matching Box2D's setter behavior.
- During chain expansion, skip or reject duplicate adjacent points before producing internal chain segments.

Also add direct manifold tests that prove invalid geometries cannot reach the narrow phase, rather than trying to make every manifold function tolerate them defensively.
