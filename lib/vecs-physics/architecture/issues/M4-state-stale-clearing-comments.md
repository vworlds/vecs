# M4: Stale event-array clearing comments in engine/state.ts

**Severity:** Low (documentation only — no runtime impact).

## What is wrong

The JSDoc comments on five event-array fields in `engine/state.ts` describe a
clearing strategy that is **no longer accurate** after the M4 clearing relocation
(ARCHITECT RESOLUTION, VP-21a). The arrays were originally cleared at the top of
`engineStep` (physics-step), but are now cleared at the end of
`PhysicsEvents.run` (physics-post) — and the comments were not updated.

Additionally, `shapeEntityByEid`'s JSDoc says it is "cleared by
PhysicsShapeLifecycle.exit", but the actual cleanup is lazy GC in
`PhysicsEvents.run`.

## Why it is wrong

The ARCHITECT RESOLUTION (PROGRESS.md VP-21a) moved clearing from `engineStep`
to `PhysicsEvents.run` so that events generated in physics-pre teardown
(lifecycle exit, `entity.destroy()`) survive until the publish. This was
implemented in VP-21b (commit `7bb0f77`) — `engine/step.ts:35-41` removes the
five clears and `systems/events.ts:199-203` adds them at end-of-run.

The JSDoc comments in `state.ts` still reference the old clearing location,
which will mislead future engineers reading only the field declarations.

The `shapeEntityByEid` field comment says it's cleared in exit, but
`systems/shape_lifecycle.ts:562-563` explicitly defers this to lazy GC in
`PhysicsEvents.run` to preserve `Entity` references for teardown end-events.

## Impacted code

`lib/vecs-physics/src/engine/state.ts`:

- **Lines 209–213:** `contactBeginEvents`/`contactEndEvents` doc block says
  "Cleared each step in `engineStep`".
- **Lines 218–219, 222–223:** individual "Cleared at the start of each step."
  comments on `contactBeginEvents`/`contactEndEvents`.
- **Lines 249, 255:** similar "Cleared at step start." comments on
  `sensorBeginEvents`/`sensorEndEvents`.
- **Lines 263–265, 276–277:** similar comments on `contactHitEvents` doc block
  and field — says "Cleared at the top of each `engineStep`" and "Cleared at
  step start."
- **Lines 195–198:** `shapeEntityByEid` doc block says "cleared by
  `PhysicsShapeLifecycle.exit`"; actual cleanup is lazy GC in `PhysicsEvents.run`
  (lines 213–217 of `systems/events.ts`).

## Impacted features

None — comments only. No runtime behaviour is affected. The code itself is
correct; the clearing relocation was fully implemented.

## How to reproduce

Read `engine/state.ts` JSDoc comments for the event arrays. Compare with the
actual clearing location in `systems/events.ts:199-203` and the clearing removed
from `engine/step.ts:35-41`.

## Possible fix

Update the five comment blocks to reference "cleared at the end of
`PhysicsEvents.run` (physics-post) after publishing" per the ARCHITECT
RESOLUTION. Update the `shapeEntityByEid` comment to say "entries are lazily
GC'd in `PhysicsEvents.run` (not in exit) to preserve Entity references for
teardown end-events."
