import type { Entity } from "@vworlds/vecs";
import { describe, expect, it } from "vitest";

import {
  BODY_TRANSIENT_FLAGS,
  DYNAMIC_BODY,
  HAD_TIME_OF_IMPACT,
  IS_FAST,
  IS_SPEED_CAPPED,
  STATIC_BODY,
} from "../../src/engine/body.js";
import {
  AWAKE_SET,
  DISABLED_SET,
  STATIC_SET,
  createBody,
  destroyBody,
  transferBody,
  type SolverSet,
} from "../../src/engine/solver_set.js";
import { PhysicsState, type ResolvedPhysicsOptions } from "../../src/engine/state.js";

// Storage never dereferences the owning entity, so a stub stands in for the
// solver-set bookkeeping tests. The body lifecycle system supplies a real entity.
const ENTITY = { eid: 1 } as unknown as Entity;

const OPTIONS: ResolvedPhysicsOptions = {
  gravityX: 0,
  gravityY: -10,
  fixedTimeStep: 1 / 60,
  subSteps: 4,
  debug: false,
  restitutionThreshold: 1,
  hitEventThreshold: 10,
  contactHertz: 30,
  contactDampingRatio: 10,
  contactSpeed: 3,
  maximumLinearSpeed: 400,
  enableSleep: true,
  enableContinuous: true,
};

function makeState(): PhysicsState {
  return new PhysicsState(OPTIONS);
}

/** Create a body with the stub entity and a body type, defaulting to dynamic. */
function create(state: PhysicsState, set: SolverSet) {
  return createBody(state, set, ENTITY, DYNAMIC_BODY);
}

describe("createBaseSolverSets", () => {
  it("creates the three fixed sets at their canonical indices", () => {
    const { solverSets } = makeState();
    expect(solverSets[STATIC_SET]!.setIndex).toBe(STATIC_SET);
    expect(solverSets[DISABLED_SET]!.setIndex).toBe(DISABLED_SET);
    expect(solverSets[AWAKE_SET]!.setIndex).toBe(AWAKE_SET);
  });
});

describe("createBody", () => {
  it("packs bodies densely and records their set + local index", () => {
    const state = makeState();
    const awake = state.solverSets[AWAKE_SET]!;

    const a = create(state, awake);
    const b = create(state, awake);

    expect(state.bodies.get(a.index)).toMatchObject({ setIndex: AWAKE_SET, localIndex: 0 });
    expect(state.bodies.get(b.index)).toMatchObject({ setIndex: AWAKE_SET, localIndex: 1 });
    expect(awake.bodySims.map((s) => s.bodyId)).toEqual([a.index, b.index]);
  });

  it("records the owning entity and body type on the record", () => {
    const state = makeState();

    const a = createBody(state, state.solverSets[STATIC_SET]!, ENTITY, STATIC_BODY);
    const record = state.bodies.get(a.index);
    expect(record.entity).toBe(ENTITY);
    expect(record.type).toBe(STATIC_BODY);
  });

  it("gives awake-set bodies a parallel state, but not static ones", () => {
    const state = makeState();

    create(state, state.solverSets[AWAKE_SET]!);
    expect(state.solverSets[AWAKE_SET]!.bodyStates).toHaveLength(1);

    create(state, state.solverSets[STATIC_SET]!);
    expect(state.solverSets[STATIC_SET]!.bodyStates).toHaveLength(0);
  });
});

describe("transferBody", () => {
  it("is a no-op when source and target are the same set", () => {
    const state = makeState();
    const awake = state.solverSets[AWAKE_SET]!;
    const a = create(state, awake);

    transferBody(state.bodies, awake, awake, state.bodies.get(a.index));

    expect(awake.bodySims).toHaveLength(1);
    expect(awake.bodyStates).toHaveLength(1);
    expect(state.bodies.get(a.index)).toMatchObject({ setIndex: AWAKE_SET, localIndex: 0 });
  });

  it("moves a body's sim object across sets and updates its set + index", () => {
    const state = makeState();
    const awake = state.solverSets[AWAKE_SET]!;
    const disabled = state.solverSets[DISABLED_SET]!;

    const a = create(state, awake);
    const sim = awake.bodySims[0]!;
    sim.transformX = 3.5; // tag the sim so we can prove the same object relocated

    transferBody(state.bodies, disabled, awake, state.bodies.get(a.index));

    expect(awake.bodySims).toHaveLength(0);
    expect(disabled.bodySims).toHaveLength(1);
    expect(disabled.bodySims[0]).toBe(sim); // moved by reference, not copied
    expect(disabled.bodySims[0]!.transformX).toBe(3.5);
    expect(state.bodies.get(a.index)).toMatchObject({ setIndex: DISABLED_SET, localIndex: 0 });
  });

  it("preserves indices: swap-popping the source repairs the moved body", () => {
    const state = makeState();
    const awake = state.solverSets[AWAKE_SET]!;
    const staticSet = state.solverSets[STATIC_SET]!;

    // Three bodies in the awake set: a@0, b@1, c@2.
    const a = create(state, awake);
    const b = create(state, awake);
    const c = create(state, awake);

    // Transfer a (index 0, not the last): c swaps down into slot 0.
    transferBody(state.bodies, staticSet, awake, state.bodies.get(a.index));

    expect(state.bodies.get(a.index)).toMatchObject({ setIndex: STATIC_SET, localIndex: 0 });
    // c moved into the vacated awake slot 0; its localIndex must follow.
    expect(state.bodies.get(c.index)).toMatchObject({ setIndex: AWAKE_SET, localIndex: 0 });
    // b is untouched at slot 1.
    expect(state.bodies.get(b.index)).toMatchObject({ setIndex: AWAKE_SET, localIndex: 1 });

    // The sim arrays still address the bodies their localIndex claims.
    expect(awake.bodySims[0]!.bodyId).toBe(c.index);
    expect(awake.bodySims[1]!.bodyId).toBe(b.index);
    expect(staticSet.bodySims[0]!.bodyId).toBe(a.index);
  });

  it("drops the body state when leaving the awake set", () => {
    const state = makeState();
    const awake = state.solverSets[AWAKE_SET]!;
    const disabled = state.solverSets[DISABLED_SET]!;

    const a = create(state, awake);
    const b = create(state, awake);
    expect(awake.bodyStates).toHaveLength(2);

    transferBody(state.bodies, disabled, awake, state.bodies.get(a.index));

    // State array stays parallel to the sims after the swap-pop.
    expect(awake.bodyStates).toHaveLength(1);
    expect(awake.bodySims).toHaveLength(1);
    expect(awake.bodySims[0]!.bodyId).toBe(b.index);
    expect(disabled.bodyStates).toHaveLength(0);
  });

  it("creates a fresh identity state when entering the awake set", () => {
    const state = makeState();
    const awake = state.solverSets[AWAKE_SET]!;
    const staticSet = state.solverSets[STATIC_SET]!;

    const a = create(state, staticSet);
    expect(staticSet.bodyStates).toHaveLength(0);

    transferBody(state.bodies, awake, staticSet, state.bodies.get(a.index));

    expect(awake.bodyStates).toHaveLength(1);
    expect(awake.bodyStates[0]!.deltaRotCos).toBe(1);
    expect(state.bodies.get(a.index)).toMatchObject({ setIndex: AWAKE_SET, localIndex: 0 });
  });

  it("round-trips a body through awake → static → disabled → awake", () => {
    const state = makeState();
    const staticSet = state.solverSets[STATIC_SET]!;
    const disabled = state.solverSets[DISABLED_SET]!;
    const awake = state.solverSets[AWAKE_SET]!;

    const a = create(state, awake);
    transferBody(state.bodies, staticSet, awake, state.bodies.get(a.index));
    expect(state.bodies.get(a.index).setIndex).toBe(STATIC_SET);
    transferBody(state.bodies, disabled, staticSet, state.bodies.get(a.index));
    expect(state.bodies.get(a.index).setIndex).toBe(DISABLED_SET);
    transferBody(state.bodies, awake, disabled, state.bodies.get(a.index));

    expect(state.bodies.get(a.index)).toMatchObject({ setIndex: AWAKE_SET, localIndex: 0 });
    expect(awake.bodySims).toHaveLength(1);
    expect(awake.bodyStates).toHaveLength(1);
    expect(staticSet.bodySims).toHaveLength(0);
    expect(disabled.bodySims).toHaveLength(0);
  });

  it("clears CCD transient flags (IS_FAST | IS_SPEED_CAPPED | HAD_TIME_OF_IMPACT) on transfer — parity with b2TransferBody solver_set.c:526", () => {
    const state = makeState();
    const awake = state.solverSets[AWAKE_SET]!;
    const disabled = state.solverSets[DISABLED_SET]!;

    const a = create(state, awake);
    const sim = awake.bodySims[0]!;

    // Simulate flags that the solver/CCD sets within a step.
    sim.flags |= IS_FAST | IS_SPEED_CAPPED | HAD_TIME_OF_IMPACT;
    expect(sim.flags & BODY_TRANSIENT_FLAGS).not.toBe(0); // sanity: flags are set

    transferBody(state.bodies, disabled, awake, state.bodies.get(a.index));

    // The moved sim must have all transient flags cleared.
    expect(disabled.bodySims[0]!.flags & BODY_TRANSIENT_FLAGS).toBe(0);
  });
});

describe("destroyBody", () => {
  it("removes the body, frees its handle, and repairs the swapped body", () => {
    const state = makeState();
    const awake = state.solverSets[AWAKE_SET]!;

    const a = create(state, awake);
    const b = create(state, awake);

    destroyBody(state, awake, a);

    // b swapped into a's slot; its localIndex follows.
    expect(state.bodies.get(b.index)).toMatchObject({ setIndex: AWAKE_SET, localIndex: 0 });
    expect(awake.bodySims).toHaveLength(1);
    expect(awake.bodyStates).toHaveLength(1);
    expect(awake.bodySims[0]!.bodyId).toBe(b.index);

    // a's handle is now stale and its slot empty.
    expect(state.bodies.idPool.isValid(a)).toBe(false);
    expect(() => state.bodies.get(a.index)).toThrow();
  });
});
