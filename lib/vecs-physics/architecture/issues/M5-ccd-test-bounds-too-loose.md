# M5-ccd-test-bounds-too-loose

## Description

The CCD no-tunnel tests in `tests/ccd/ccd.test.ts` use position bounds that are far too loose to meaningfully verify that the body stopped at the wall face rather than partially tunnelled through it.

## Reasoning

A "no-tunnel" test must prove the body did not penetrate the wall. An assertion that passes when the body is anywhere left of `x = -1.0` does not distinguish "stopped at face" from "tunnelled partway and self-corrected" or "slid through but didn't go far".

### Specific occurrences

1. **Bullet no-tunnel** (line ~158): `expect(pos.x).toBeGreaterThan(-1.0)`. The wall body is a static Box 0.5×0.5 m placed so its left face is at `x ≈ -0.25`. The bullet is a Circle r=0.2, bullet=true, vx=-20. With CCD active the bullet should stop at `x ≈ -0.45` (face at -0.25 minus radius 0.2). A bound of -1.0 is ~4x too loose — it would pass even if the bullet overshot by half a metre.

2. **Fast non-bullet test** (line ~248): `expect(pos.x).toBeGreaterThan(-2.0)`. The wall left face is at `x ≈ -0.05`, the box is 0.5 wide, so its right face is at `x ≈ 0.5`. The body starts at `x ≈ 1.0` (offset just to right of wall) and moves left at `vx = -15`. With CCD active the box should stop with its right face at or before the wall left face (x ≈ -0.05). A bound of -2.0 is ~10x too loose.

## Impacted code

- `tests/ccd/ccd.test.ts` — `"bullet body does not tunnel through thin wall"` and `"fast non-bullet body avoids tunnelling"` tests.

## Impacted features

- CCD bullet/fast-body correctness. A regression that breaks CCD could go undetected by these tests.

## Reproduction

Run the tests as-is: both pass. But modify CCD to advance the body 0.5 m past the wall before restoring it — the tests would still pass because -0.75 > -1.0 and -0.55 > -2.0.

## Suggested fix

Replace the loose bounds with assertions that the body centre is at or before the wall face, accounting for the body's geometry:

For the bullet test, assert `pos.x` is between the wall face and an acceptable stopping margin — e.g. `expect(pos.x).toBeLessThanOrEqual(-0.25)` (wall left face) and `expect(pos.x).toBeGreaterThan(-0.55)` (wall face − bullet radius − tolerance). Even a single tighter bound like `expect(pos.x).toBeGreaterThan(-0.6)` would be a meaningful improvement.

For the fast non-bullet test, assert the box right face (centre.x + 0.5) ≤ wall left face — e.g. `expect(pos.x + 0.5).toBeLessThanOrEqual(-0.05 + 0.02)`.
