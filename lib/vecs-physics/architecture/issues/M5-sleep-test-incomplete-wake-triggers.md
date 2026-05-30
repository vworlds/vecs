# M5-sleep-test-incomplete-wake-triggers

## Description

Several documented wake-trigger paths from the VP-23 sleep implementation lack corresponding test coverage, and one existing test is vacuous.

## Reasoning

VP-23 wired `wakeBody` calls into every setter/input path that box2d covers (`body.c:704/795/819/871/935/958/980/1011/1039/1068`). The `forces.ts`, `kinematic.ts`, `pose_sync_in.ts`, and `step.ts` files all contain wake calls. The test suite covers only a subset, leaving the following gaps:

### Missing tests

1. **`LinearVelocity` setter waking a sleeping body.** `pose_sync_in.ts:93-94` wakes when velocity is non-zero and body is asleep (`b2Body_SetLinearVelocity`, body.c:793-796). No test exercises this.

2. **`Torque` waking a sleeping body.** `forces.ts:95-96` mirrors `b2Body_ApplyTorque` (body.c:978-981). The Force wake path is tested; Torque's identical path is not.

3. **`AngularVelocity` setter waking a sleeping body.** `pose_sync_in.ts:114-115` mirrors `b2Body_SetAngularVelocity` (body.c:817-820). Not tested.

4. **End-to-end wake-on-touch** — the `"wake on touch"` test (sleep.test.ts:210) calls `state._wakeSolverSet` directly instead of creating a real contact between two bodies where one is sleeping. The actual `linkContact`→sleeping-wake path (island.ts→_wakeSolverSet hook) is never exercised through the physics pipeline.

5. **Destroying a sleeping body** — no test verifies that destroying a sleeping body entity properly releases the sleeping-set slot to the pool. A leak here would silently exhaust solver-set slots.

### Vacuous test

6. **"sleep does not destroy contacts"** (sleep.test.ts:526-557) — the test body has 0 contacts before and after sleep/wake, so it proves nothing about contact preservation. A meaningful test needs at least two bodies with a real contact.

## Impacted code

- `src/systems/pose_sync_in.ts` — LinearVelocity/AngularVelocity wake hooks
- `src/systems/forces.ts` — Torque wake hook  
- `src/engine/island.ts` — `linkContact` → `_wakeSolverSet` hook path
- `src/engine/sleep.ts` — sleeping-set pool leak on body destroy
- `tests/sleep/sleep.test.ts` — the test file

## Impacted features

- Sleep/wake correctness. Wake triggers that work by coincidence (e.g., because the body is also force-waked or gravity-awake) will look correct until an edge case hits them in isolation.

## Suggested fix

- Add tests for LinearVelocity, AngularVelocity, and Torque waking a sleeping body. Each follows the same pattern as the existing Force/Position/Rotation tests: put a body to sleep, apply the trigger with wake: true, verify it's in the awake set after the next step.
- Replace the vacuous "sleep does not destroy contacts" test with one that creates two touching bodies, lets them sleep, wakes one, and verifies the contact count is unchanged.
- Add a test: create a sleeping body, destroy its entity via `world.destroy()`, step once, verify the sleeping set slot was released (e.g., by creating a new body that reuses it, or by asserting `state.solverSets.length` decreases).
