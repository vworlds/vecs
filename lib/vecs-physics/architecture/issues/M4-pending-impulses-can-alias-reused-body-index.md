# M4: Pending impulses can alias a reused body index after same-frame destroy/recreate

## What is wrong

`PhysicsImpulseAccumulate` stores pending impulses in `PhysicsState.pendingImpulses` keyed only by the internal body index. If the original body is destroyed before `engineStep` applies the accumulator, and another body reuses the freed body index in the same frame, the pending impulse can be applied to the new body.

The body `IdPool` has generations specifically to prevent this kind of stale-handle aliasing, but the impulse accumulator drops the generation and retains only `handle.index`.

## Why this is wrong

Impulses are user intent targeting the body that existed when the `Impulse` / `AngularImpulse` component was set. If that body is destroyed before the physics step, the impulse should be dropped, not redirected to an unrelated body that happened to reuse the same dense index.

Box2D validates handles/generations at API boundaries. The vecs-physics architecture likewise uses `(index, generation)` handles internally so destroyed-then-recreated objects do not alias old events. Pending impulses need the same stale-handle protection.

The bug is especially plausible because M4 moved impulse accumulation into synchronous `onSet` hooks. Those hooks run while Vecs commands drain, before the physics-pre lifecycle systems have necessarily processed body exits and new body enters. The accumulator can therefore contain a target body index whose lifetime changes before `engineStep` consumes it.

## Impacted code

- `src/systems/impulse_accumulate.ts`
  - `resolveBodyHandleIndex` returns only `handle.index`.
  - `state.pendingImpulses` is keyed by that raw index.
- `src/engine/state.ts`
  - `pendingImpulses` stores entries by body index, without generation.
- `src/engine/step.ts`
  - `applyPendingImpulses` checks whether `state.bodies.records[bodyIndex]` exists and is awake/dynamic, but cannot tell whether the record is the same generation that received the impulse.
- `src/util/id_pool.ts`
  - Freed indices are reused via a LIFO free list and generation is bumped on free, so same-frame index reuse is expected allocator behavior.

## Impacted features

- `Impulse` and `AngularImpulse` correctness during entity/body destruction.
- Determinism and isolation when users destroy and recreate physics bodies in the same frame.
- Any gameplay that uses impulse components on short-lived entities or shape-child impulse sources.

## How to reproduce

One focused regression should be enough:

1. Create dynamic body A with an `Impulse` targeting it.
2. In the same frame before physics-step, destroy body A and create dynamic body B.
3. Ensure the body id pool reuses A's internal index for B.
4. Step physics.
5. Observe B receives A's pending impulse even though B was not the target.

The same scenario applies when the impulse component lives on a child shape/source entity and resolves to body A at set time.

## Possible solutions

- Key `pendingImpulses` by full `BodyHandle` `(index, generation)` instead of raw index, or store the generation alongside the map entry.
- In `applyPendingImpulses`, validate the stored handle with `state.bodies.idPool.isValid(handle)` before applying.
- If multiple impulse sets target the same body generation, merge them under a stable key such as `${index}:${generation}` or store `{ handle, accumulator }` values in a map keyed by index and verify generation before merge/apply.
- Clear or discard pending impulses for a body during body destruction as a defensive backstop, but do not rely on that alone because same-frame command ordering can still make generation validation necessary.
