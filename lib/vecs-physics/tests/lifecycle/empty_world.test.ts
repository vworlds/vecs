// Ports box2d/test/test_world.c::EmptyWorld.
//
// Vecs worlds do not expose a stop hook; the v1 equivalent is install, start,
// and repeatedly progress an empty physics world without allocating bodies,
// contacts, islands, or sleeping solver sets.

import { World } from "@vworlds/vecs";
import { describe, expect, it } from "vitest";

import { installPhysics } from "../../src/index.js";
import { getPhysics } from "../../src/engine/state.js";

const STEP_MS = 1000 / 60;

describe("test_world.c::EmptyWorld", () => {
  it("steps an empty installed world without allocating engine records", () => {
    const world = new World();
    installPhysics(world);
    world.start();
    const state = getPhysics(world);

    expect(() => step(world, 32)).not.toThrow();

    expect(state.bodies.records.filter(Boolean)).toHaveLength(0);
    expect(state.shapes.records.filter(Boolean)).toHaveLength(0);
    expect(state.contacts.records.filter(Boolean)).toHaveLength(0);
    expect(state.islands.records.filter(Boolean)).toHaveLength(0);
    expect(state.graphContactSims).toHaveLength(0);
    expect(state.solverSets).toHaveLength(3);
    for (const set of state.solverSets) {
      expect(set.bodySims).toHaveLength(0);
      expect(set.bodyStates).toHaveLength(0);
      expect(set.contactSims).toHaveLength(0);
      expect(set.islandSims).toHaveLength(0);
    }
  });
});

function step(world: World, count: number): void {
  let now = 0;
  for (let i = 0; i < count; i++) {
    now += STEP_MS;
    world.progress(now, STEP_MS);
  }
}
