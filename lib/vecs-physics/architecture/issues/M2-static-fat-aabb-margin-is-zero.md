# Static Shapes Get A Zero Fat-AABB Margin (Should Be speculativeDistance)

## What is wrong

When building the broad-phase fat AABB for a shape on a **static** body, the port
adds `0` margin beyond the speculative-padded tight AABB. Box2D adds
`speculativeDistance` for static shapes. The function's own docstring says the
Box2D rule ("Static bodies use only speculativeDistance for the fat margin") but
the code implements zero.

Net effect: a static shape's fat AABB exactly equals its tight AABB
(`geometry ± speculativeDistance`), whereas Box2D's static fat AABB is
`geometry ± 2·speculativeDistance`. The static proxies stored in the broad-phase
tree are one `speculativeDistance` too tight on every side.

## Why it is wrong

Box2D `b2UpdateShapeAABBs` (`box2d/src/shape.c`) computes the tight AABB, expands
it by `speculativeDistance`, then expands again by a per-type margin:

```c
b2AABB aabb = b2ComputeShapeAABB( shape, transform );
aabb.lowerBound.x -= speculativeDistance;   // ... (tight, +speculative)
shape->aabb = aabb;

// Smaller margin for static bodies. Cannot be zero due to TOI tolerance.
float margin = proxyType == b2_staticBody ? speculativeDistance : aabbMargin;
fatAABB.lowerBound.x = aabb.lowerBound.x - margin;   // ...
shape->fatAABB = fatAABB;
```

The static margin is `speculativeDistance`, **not** zero. The Box2D comment is
explicit: _"Cannot be zero due to TOI tolerance."_

The port instead computes `extra = bodyType === STATIC_BODY ? 0 : computeShapeMargin(...)`.
For static bodies that yields `extra = 0`, so `fatAabb* = aabb*` (the tight AABB).
The intent was apparently "static gets only the speculative margin," but the
speculative was already folded into the tight AABB, so the second
`speculativeDistance` Box2D adds is missing.

## Impacted code

- `src/systems/shape_lifecycle.ts:113-116` — docstring states the correct Box2D
  rule (static → speculativeDistance margin).
- `src/systems/shape_lifecycle.ts:132` — `const extra = bodyType === STATIC_BODY ? 0 : computeShapeMargin(...)`. Should be `speculativeDistance` for static, not `0`.
- `src/systems/shape_pose_sync.ts:93` — the same `? 0 :` expression, duplicated;
  must be fixed in both places.

## Impacted features

- Broad-phase pair generation against static geometry: candidate pairs with a
  dynamic body are produced when fat AABBs overlap, so a too-tight static fat AABB
  makes pairs appear (up to) one `speculativeDistance` later than in Box2D.
- M3 speculative contacts at rest against static ground/walls (the most common
  case): Box2D relies on the fat-AABB margin to keep the contact alive slightly
  before/through actual touch; the reduced margin shrinks that window.
- M4/CCD (bullet path) sweeps against static shapes — exactly the "TOI tolerance"
  the Box2D comment warns about.
- Box2D parity for any scene with dynamic bodies settling on static colliders.

The practical magnitude is small (`speculativeDistance = 4·LINEAR_SLOP ≈ 0.02 m`
at the default length unit) and is often masked because the _dynamic_ partner's
own `aabbMargin` is usually larger, but it is a real divergence and it
compounds with the two already-filed proxy issues (stale proxies on enable/type
change; proxies not refit on body transform).

## How to reproduce

1. Create a static `Body` with a child `Box { hx: 0.5, hy: 0.5 }` at the origin.
2. Progress once.
3. Read the stored fat AABB for that shape (`shape.fatAabbMaxX`) or
   `state.broadPhase.getAABB(shape.proxyKey)`.

Expected (Box2D): `fatAabbMaxX = 0.5 + 2·speculativeDistance`.

Current behavior: `fatAabbMaxX = 0.5 + speculativeDistance` (the tight AABB; the
second `speculativeDistance` is missing).

Compare against a dynamic body with the same box: its fat AABB correctly adds
`computeShapeMargin` beyond the speculative tight AABB, so the static/dynamic
asymmetry is visible side by side.

## Possible solutions

- In both `updateShapeAABBs` sites, use `speculativeDistance` (not `0`) as the
  static fat margin:
  `const extra = bodyType === STATIC_BODY ? SPECULATIVE_DISTANCE : computeShapeMargin(shape.geometry);`
- De-duplicate the fat-AABB construction: `shape_lifecycle.ts` and
  `shape_pose_sync.ts` carry the same margin logic and the same bug; extract one
  shared helper so the static-margin rule lives in a single place.
- Add a test asserting the static fat AABB equals the tight AABB expanded by
  `speculativeDistance`, and that static vs dynamic fat margins differ as Box2D
  specifies.
