# M5 `transferBody` does not clear CCD transient flags, diverging from `b2TransferBody`

## What is wrong

`engine/solver_set.ts::transferBody` does not clear the transient body
flags (`IS_FAST | IS_SPEED_CAPPED | HAD_TIME_OF_IMPACT`) when moving a
`BodySim` between solver sets, contrary to box2d. The in-code comment
still claims there is "nothing to clear in VP-5" — written before VP-24
introduced the flags it refers to.

```ts
// src/engine/solver_set.ts:183-185
// Box2D clears the transient sim flags (isFast | isSpeedCapped |
// hadTimeOfImpact) here. Those are set by the solver/CCD, which are not ported
// yet, so there is nothing to clear in VP-5.
```

Vendored box2d (`box2d/src/solver_set.c:522-526`):

```c
b2BodySim* targetSim = b2Array_Emplace( targetSet->bodySims );
memcpy( targetSim, sourceSim, sizeof( b2BodySim ) );

// Clear transient body flags
targetSim->flags &= ~(b2_isFast | b2_isSpeedCapped | b2_hadTimeOfImpact);
```

vecs-physics now defines and uses all three flags (`src/engine/body.ts`
exports `IS_FAST = 0x0008`, `IS_SPEED_CAPPED = 0x0020`,
`HAD_TIME_OF_IMPACT = 0x0040`, and `BODY_TRANSIENT_FLAGS = IS_FAST |
IS_SPEED_CAPPED | HAD_TIME_OF_IMPACT`), so the precondition behind the
"nothing to clear" comment no longer holds.

## Why it is wrong

Two distinct problems:

1. **Stale comment / parity drift.** The comment misleads any future
   agent reading transferBody: it implies VP-23/24 don't matter here
   because "those flags don't exist yet". They do exist. A reviewer
   running diff against box2d may conclude the divergence is
   intentional.

2. **Latent state leak across set transfers.** When a body crosses sets
   (dynamic↔kinematic, enable/disable, awake↔sleeping via
   `wakeSolverSet`/`trySleepIsland`), its transient CCD flags persist.
   In practice this is mostly benign because `finalizeBodies` clears
   `BODY_TRANSIENT_FLAGS` at the top of its per-body loop
   (`src/engine/step.ts:339`), but only for awake bodies. A body that
   wakes from sleep with `IS_FAST` still set (because that body was
   `IS_FAST` when it fell asleep) carries that flag through the rest of
   the wake step, where it is read by the refit branch in finalize
   (`step.ts:423`) to decide "fast bodies skip the normal refit".
   That branch skipping the refit on a stale `IS_FAST` flag misses the
   per-step proxy enlarge for a body that is not actually moving fast
   this step. Same logic applies to `HAD_TIME_OF_IMPACT`-conditional
   debug paths if added later.

## Reproducing

A direct unit test:

1. Set `sim.flags |= IS_FAST | IS_SPEED_CAPPED | HAD_TIME_OF_IMPACT` on a
   body in the awake set.
2. `transferBody(state.bodies, disabledSet, awakeSet, body)`.
3. Assert `disabledSet.bodySims[0].flags & BODY_TRANSIENT_FLAGS === 0` —
   currently FAILS (flags survive the move). Box2d clears them.

End-to-end repro using `trySleepIsland` is messier because
`finalizeBodies` runs once before sleep is decided, but the underlying
invariant is the same.

## Impacted code

- `src/engine/solver_set.ts::transferBody` — both the stale comment
  block (lines 183-186) and the missing flag-clear.
- All callers of `transferBody` (lifecycle stage 7, `wakeSolverSet`,
  `trySleepIsland`, `mergeSolverSets` — though merge uses `push`
  directly rather than `transferBody`).

## Impacted features

- Wake-from-sleep determinism on bodies that were `IS_FAST` when they
  fell asleep.
- Future debug-draw consumers that inspect `IS_SPEED_CAPPED` /
  `HAD_TIME_OF_IMPACT`.
- Parity against upstream box2d for any test that crosses sets and then
  reads `sim.flags`.

## Possible solutions

- Add `sim.flags &= ~BODY_TRANSIENT_FLAGS;` immediately after the
  `targetSet.bodySims.push(sim)` line in `transferBody`. Update the
  stale comment block to cite `solver_set.c:526` and drop the "nothing
  to clear in VP-5" claim.
- Add a regression test in `tests/engine/solver_set.test.ts` that pins
  the cleared-flag invariant across one transfer.
- While in this file, retire the M1-review `FOLLOW-UP` paragraph that
  begins "box2d seeds the new state's flags from `body->flags`,
  not the sim's. Equivalent today (both `0` until …)" — that premise
  is no longer true now that VP-23 added `InternalBody.flags`
  (ENABLE_SLEEP) and VP-24 added bullet/fast/etc. on `sim.flags`. Either
  the seeding logic needs revisiting (does ENABLE_SLEEP belong on
  bodyState? today it does not, and the seed path is correct by
  accident) or the comment should be replaced with the actual rationale.
