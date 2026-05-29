# Manifold Anchors Ignore Shape Local Offsets

## What is wrong

The narrow-phase functions return `anchorA` and `anchorB` relative to the shape origin when a shape has a non-identity `ShapePosition`, even though the manifold contract says anchors are relative to each shape's body origin.

This is hidden by the current tests because they use identity shape-local poses or pass transforms as if the shape origin and body origin are the same.

## Why it is wrong

`computeManifold` documents that callers pass fully composed world transforms: `bodyWorldTransform * shapeLocalTransform`. The collision functions then compute anchors with the Box2D formula:

```ts
mp.anchorA = rotateVector(xfA.q, contactPointA);
mp.anchorB = mp.anchorA + xfA.p - xfB.p;
```

That formula is correct in Box2D because Box2D stores shape geometry in body-local coordinates and `xfA` is the body transform. In this port, geometry is shape-local and `xfA` is the shape world transform. The local shape translation has moved into `xfA.p`, so `rotateVector(xfA.q, contactPointA)` omits the lever arm from the body origin to the shape origin.

For an offset child shape, the solver will receive lever arms that are too short by the shape-local offset.

## Impacted code

- `src/engine/manifold/types.ts:17-18` defines anchors as body-origin-relative.
- `src/engine/narrow_phase.ts:255-257` requires callers to pass composed shape world transforms.
- `src/engine/manifold/circles.ts:95-102` returns anchors relative to `xfA`/`xfB` origins.
- The same pattern appears in polygon, capsule, segment, and chain-segment manifold functions.
- `architecture/PROGRESS.md:323` records the M2 contract as body-origin-relative anchors.

## Impacted features

- Any shape using `ShapePosition` or `ShapeRotation` on a body.
- Compound bodies with offset fixtures.
- M3 contact solver angular response, because contact impulses use anchor lever arms.
- Warm starting and contact events/debug points for offset child shapes.

## How to reproduce

Add a narrow-phase test using an offset shape:

1. Body A is at the origin.
2. Shape A is a circle with `ShapePosition { x: 2, y: 0 }`.
3. Shape B touches it near world `{ x: 3, y: 0 }`.
4. Call `computeManifold` with the currently documented composed shape transforms.

Expected: `anchorA.x` includes the `+2` body-to-shape offset.

Current behavior: `anchorA.x` is computed relative to the shape origin and is missing that offset.

## Possible solutions

Pick one transform convention and make it consistent before M3 solver work:

- Keep geometry shape-local, but change narrow-phase output conversion to add the body-space shape-local offset to `anchorA`/`anchorB`. This likely requires passing both body transforms and shape local transforms, or deriving the body rotation from `shape.local*` and the composed transform.
- Alternatively, pre-bake geometry into body-local coordinates for manifold calls and pass body transforms exactly like Box2D does.

Add tests for non-identity `ShapePosition` and `ShapeRotation` across circle, polygon, and capsule contacts so the solver contract is pinned before impulses land.
