# M5 `finalizeBodies` drops `IS_SPEED_CAPPED` / `HAD_TIME_OF_IMPACT` instead of preserving them on `body.flags`

## What is wrong

`engine/step.ts::finalizeBodies` clears the transient flag set
(`IS_FAST | IS_SPEED_CAPPED | HAD_TIME_OF_IMPACT`) from `sim.flags` and
`state.flags` at the top of the per-body loop, but does NOT first copy
the speed-cap / TOI bits into `InternalBody.flags`. Box2d does that copy
explicitly so the body record retains a per-step record of these events
for debug draw, while the per-substep working flags on sim/state get
zeroed.

```ts
// src/engine/step.ts:334-340
// body->flags &= ~b2_bodyTransientFlags (covers IS_FAST, IS_SPEED_CAPPED,
// HAD_TIME_OF_IMPACT). sim->flags and state->flags are cleared identically.
sim.flags &= ~BODY_TRANSIENT_FLAGS;
st.flags  &= ~BODY_TRANSIENT_FLAGS;
```

Vendored box2d (`box2d/src/solver.c:622-626`):

```c
body->flags &= ~b2_bodyTransientFlags;
body->flags |= ( sim->flags  & ( b2_isSpeedCapped | b2_hadTimeOfImpact ) );
body->flags |= ( state->flags & ( b2_isSpeedCapped | b2_hadTimeOfImpact ) );
sim->flags  &= ~b2_bodyTransientFlags;
state->flags &= ~b2_bodyTransientFlags;
```

Two consequences in box2d's flow that are missing here:

1. `body->flags` is also cleared (vecs-physics never touches
   `body.flags` in finalize at all).
2. `body->flags` is then OR'd with `IS_SPEED_CAPPED | HAD_TIME_OF_IMPACT`
   from whichever of sim/state had them this step.

## Why it is wrong

The `body.ts` flag definitions explicitly call these bits "retained for
debug draw":

```ts
// src/engine/body.ts:38-41
/** Retained for debug draw: marks a body that triggered CCD this step.
 *  Mirrors `b2_isFast = 0x00000008` (body.h:26). Transient — cleared at the
 *  top of finalize via {@link BODY_TRANSIENT_FLAGS}. */
export const IS_FAST = 0x0008;
// ...same comment shape on HAD_TIME_OF_IMPACT (line 50-53).
```

But the implementation drops them on the floor every step — they are
written transiently to `sim.flags` during the CCD branch, then cleared
on the next finalize iteration with no propagation. There is no place a
debug-draw consumer can read them in vecs-physics, because the docstring
location (body.flags) never receives them.

This is a quiet doc/impl divergence: the parity claim and intent are
documented, the wiring isn't there. A future debug-draw layer added on
the strength of those comments would silently see no events.

## Impacted code

- `src/engine/step.ts::finalizeBodies` lines 334-340 — the clear block.
- `src/engine/body.ts` lines 38-41, 50-53 — the "retained for debug
  draw" docstrings on `IS_FAST` and `HAD_TIME_OF_IMPACT`.

## Impacted features

- Debug-draw / inspector layers that would query "did this body get its
  speed capped / hit a TOI this step?" via `InternalBody.flags`.
- Parity against any upstream box2d test that reads
  `body->flags & b2_isSpeedCapped` post-step.

## Possible solutions

- **A (parity, recommended):** Insert the two-line OR/clear pattern
  before the sim/state clears, matching box2d's order:
  ```ts
  body.flags &= ~BODY_TRANSIENT_FLAGS;
  body.flags |= (sim.flags  & (IS_SPEED_CAPPED | HAD_TIME_OF_IMPACT));
  body.flags |= (st.flags   & (IS_SPEED_CAPPED | HAD_TIME_OF_IMPACT));
  sim.flags  &= ~BODY_TRANSIENT_FLAGS;
  st.flags   &= ~BODY_TRANSIENT_FLAGS;
  ```
  Note `IS_FAST` is intentionally NOT propagated (box2d only carries
  `IS_SPEED_CAPPED | HAD_TIME_OF_IMPACT`).
- **B (drop the parity claim):** If v1 explicitly declines a debug-draw
  surface, rewrite the docstrings on `IS_FAST` /
  `HAD_TIME_OF_IMPACT` so they no longer say "retained for debug draw",
  and add a `Carried to v2` line. This avoids future agents wiring
  consumers against a non-existent guarantee.

Either path resolves the doc/impl mismatch.
