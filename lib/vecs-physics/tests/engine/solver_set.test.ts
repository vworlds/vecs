import type { Entity } from "@vworlds/vecs";
import { describe, expect, it } from "vitest";

import { BodyStorage, DYNAMIC_BODY, STATIC_BODY } from "../../src/engine/body.js";
import {
  AWAKE_SET,
  DISABLED_SET,
  STATIC_SET,
  createBaseSolverSets,
  createBody,
  destroyBody,
  transferBody,
} from "../../src/engine/solver_set.js";

// Storage never dereferences the owning entity, so a stub stands in for the
// solver-set bookkeeping tests. The body lifecycle system supplies a real entity.
const ENTITY = { eid: 1 } as unknown as Entity;

/** Create a body with the stub entity and a body type, defaulting to dynamic. */
function create(storage: BodyStorage, set: ReturnType<typeof createBaseSolverSets>[number]) {
  return createBody(storage, set, ENTITY, DYNAMIC_BODY);
}

describe("createBaseSolverSets", () => {
  it("creates the three fixed sets at their canonical indices", () => {
    const sets = createBaseSolverSets();
    expect(sets[STATIC_SET]!.setIndex).toBe(STATIC_SET);
    expect(sets[DISABLED_SET]!.setIndex).toBe(DISABLED_SET);
    expect(sets[AWAKE_SET]!.setIndex).toBe(AWAKE_SET);
  });
});

describe("createBody", () => {
  it("packs bodies densely and records their set + local index", () => {
    const storage = new BodyStorage();
    const sets = createBaseSolverSets();
    const awake = sets[AWAKE_SET]!;

    const a = create(storage, awake);
    const b = create(storage, awake);

    expect(storage.get(a.index)).toMatchObject({ setIndex: AWAKE_SET, localIndex: 0 });
    expect(storage.get(b.index)).toMatchObject({ setIndex: AWAKE_SET, localIndex: 1 });
    expect(awake.bodySims.map((s) => s.bodyId)).toEqual([a.index, b.index]);
  });

  it("records the owning entity and body type on the record", () => {
    const storage = new BodyStorage();
    const sets = createBaseSolverSets();

    const a = createBody(storage, sets[STATIC_SET]!, ENTITY, STATIC_BODY);
    const record = storage.get(a.index);
    expect(record.entity).toBe(ENTITY);
    expect(record.type).toBe(STATIC_BODY);
  });

  it("gives awake-set bodies a parallel state, but not static ones", () => {
    const storage = new BodyStorage();
    const sets = createBaseSolverSets();

    create(storage, sets[AWAKE_SET]!);
    expect(sets[AWAKE_SET]!.bodyStates).toHaveLength(1);

    create(storage, sets[STATIC_SET]!);
    expect(sets[STATIC_SET]!.bodyStates).toHaveLength(0);
  });
});

describe("transferBody", () => {
  it("is a no-op when source and target are the same set", () => {
    const storage = new BodyStorage();
    const sets = createBaseSolverSets();
    const awake = sets[AWAKE_SET]!;
    const a = create(storage, awake);

    transferBody(storage, awake, awake, storage.get(a.index));

    expect(awake.bodySims).toHaveLength(1);
    expect(awake.bodyStates).toHaveLength(1);
    expect(storage.get(a.index)).toMatchObject({ setIndex: AWAKE_SET, localIndex: 0 });
  });

  it("moves a body's sim object across sets and updates its set + index", () => {
    const storage = new BodyStorage();
    const sets = createBaseSolverSets();
    const awake = sets[AWAKE_SET]!;
    const disabled = sets[DISABLED_SET]!;

    const a = create(storage, awake);
    const sim = awake.bodySims[0]!;
    sim.transformX = 3.5; // tag the sim so we can prove the same object relocated

    transferBody(storage, disabled, awake, storage.get(a.index));

    expect(awake.bodySims).toHaveLength(0);
    expect(disabled.bodySims).toHaveLength(1);
    expect(disabled.bodySims[0]).toBe(sim); // moved by reference, not copied
    expect(disabled.bodySims[0]!.transformX).toBe(3.5);
    expect(storage.get(a.index)).toMatchObject({ setIndex: DISABLED_SET, localIndex: 0 });
  });

  it("preserves indices: swap-popping the source repairs the moved body", () => {
    const storage = new BodyStorage();
    const sets = createBaseSolverSets();
    const awake = sets[AWAKE_SET]!;
    const staticSet = sets[STATIC_SET]!;

    // Three bodies in the awake set: a@0, b@1, c@2.
    const a = create(storage, awake);
    const b = create(storage, awake);
    const c = create(storage, awake);

    // Transfer a (index 0, not the last): c swaps down into slot 0.
    transferBody(storage, staticSet, awake, storage.get(a.index));

    expect(storage.get(a.index)).toMatchObject({ setIndex: STATIC_SET, localIndex: 0 });
    // c moved into the vacated awake slot 0; its localIndex must follow.
    expect(storage.get(c.index)).toMatchObject({ setIndex: AWAKE_SET, localIndex: 0 });
    // b is untouched at slot 1.
    expect(storage.get(b.index)).toMatchObject({ setIndex: AWAKE_SET, localIndex: 1 });

    // The sim arrays still address the bodies their localIndex claims.
    expect(awake.bodySims[0]!.bodyId).toBe(c.index);
    expect(awake.bodySims[1]!.bodyId).toBe(b.index);
    expect(staticSet.bodySims[0]!.bodyId).toBe(a.index);
  });

  it("drops the body state when leaving the awake set", () => {
    const storage = new BodyStorage();
    const sets = createBaseSolverSets();
    const awake = sets[AWAKE_SET]!;
    const disabled = sets[DISABLED_SET]!;

    const a = create(storage, awake);
    const b = create(storage, awake);
    expect(awake.bodyStates).toHaveLength(2);

    transferBody(storage, disabled, awake, storage.get(a.index));

    // State array stays parallel to the sims after the swap-pop.
    expect(awake.bodyStates).toHaveLength(1);
    expect(awake.bodySims).toHaveLength(1);
    expect(awake.bodySims[0]!.bodyId).toBe(b.index);
    expect(disabled.bodyStates).toHaveLength(0);
  });

  it("creates a fresh identity state when entering the awake set", () => {
    const storage = new BodyStorage();
    const sets = createBaseSolverSets();
    const awake = sets[AWAKE_SET]!;
    const staticSet = sets[STATIC_SET]!;

    const a = create(storage, staticSet);
    expect(staticSet.bodyStates).toHaveLength(0);

    transferBody(storage, awake, staticSet, storage.get(a.index));

    expect(awake.bodyStates).toHaveLength(1);
    expect(awake.bodyStates[0]!.deltaRotCos).toBe(1);
    expect(storage.get(a.index)).toMatchObject({ setIndex: AWAKE_SET, localIndex: 0 });
  });

  it("round-trips a body through awake → static → disabled → awake", () => {
    const storage = new BodyStorage();
    const sets = createBaseSolverSets();
    const [staticSet, disabled, awake] = [sets[STATIC_SET]!, sets[DISABLED_SET]!, sets[AWAKE_SET]!];

    const a = create(storage, awake);
    transferBody(storage, staticSet, awake, storage.get(a.index));
    expect(storage.get(a.index).setIndex).toBe(STATIC_SET);
    transferBody(storage, disabled, staticSet, storage.get(a.index));
    expect(storage.get(a.index).setIndex).toBe(DISABLED_SET);
    transferBody(storage, awake, disabled, storage.get(a.index));

    expect(storage.get(a.index)).toMatchObject({ setIndex: AWAKE_SET, localIndex: 0 });
    expect(awake.bodySims).toHaveLength(1);
    expect(awake.bodyStates).toHaveLength(1);
    expect(staticSet.bodySims).toHaveLength(0);
    expect(disabled.bodySims).toHaveLength(0);
  });
});

describe("destroyBody", () => {
  it("removes the body, frees its handle, and repairs the swapped body", () => {
    const storage = new BodyStorage();
    const sets = createBaseSolverSets();
    const awake = sets[AWAKE_SET]!;

    const a = create(storage, awake);
    const b = create(storage, awake);

    destroyBody(storage, awake, a);

    // b swapped into a's slot; its localIndex follows.
    expect(storage.get(b.index)).toMatchObject({ setIndex: AWAKE_SET, localIndex: 0 });
    expect(awake.bodySims).toHaveLength(1);
    expect(awake.bodyStates).toHaveLength(1);
    expect(awake.bodySims[0]!.bodyId).toBe(b.index);

    // a's handle is now stale and its slot empty.
    expect(storage.idPool.isValid(a)).toBe(false);
    expect(() => storage.get(a.index)).toThrow();
  });
});
