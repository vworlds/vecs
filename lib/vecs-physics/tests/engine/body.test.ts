import type { Entity } from "@vworlds/vecs";
import { describe, expect, it } from "vitest";

import { HUGE } from "../../src/math/constants.js";
import {
  BodyStorage,
  DYNAMIC_BODY,
  makeBodySim,
  makeIdentityBodyState,
  type InternalBody,
} from "../../src/engine/body.js";

const ENTITY = { eid: 1 } as unknown as Entity;

describe("makeBodySim", () => {
  it("returns a zeroed sim with identity rotation back-pointing at its body", () => {
    const sim = makeBodySim(7);
    expect(sim.bodyId).toBe(7);
    expect(sim.cos).toBe(1);
    expect(sim.sin).toBe(0);
    expect(sim.rotation0Cos).toBe(1);
    expect(sim.rotation0Sin).toBe(0);
    expect(sim.minExtent).toBe(HUGE);
    expect(sim.maxExtent).toBe(0);
    expect(sim.gravityScale).toBe(1);
    expect(sim.flags).toBe(0);
  });
});

describe("makeIdentityBodyState", () => {
  it("returns zero velocity with identity delta rotation, carrying flags", () => {
    const state = makeIdentityBodyState(0b101);
    expect(state.vx).toBe(0);
    expect(state.vy).toBe(0);
    expect(state.omega).toBe(0);
    expect(state.deltaRotCos).toBe(1);
    expect(state.deltaRotSin).toBe(0);
    expect(state.flags).toBe(0b101);
  });
});

describe("BodyStorage", () => {
  it("returns the live record for an occupied slot", () => {
    const storage = new BodyStorage();
    const handle = storage.idPool.allocate();
    const record: InternalBody = {
      entity: ENTITY,
      type: DYNAMIC_BODY,
      setIndex: 2,
      localIndex: 0,
      shapeHead: -1,
      shapeCount: 0,
      massDirty: false,
      headContactKey: -1,
      contactCount: 0,
      islandId: -1,
      islandIndex: -1,
    };
    storage.records[handle.index] = record;
    expect(storage.get(handle.index)).toBe(record);
  });

  it("throws when the slot is empty", () => {
    const storage = new BodyStorage();
    expect(() => storage.get(0)).toThrow(/no body at index 0/);
  });
});
