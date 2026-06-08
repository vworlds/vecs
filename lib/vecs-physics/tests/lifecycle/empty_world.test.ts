// Ports box2d/test/test_world.c::EmptyWorld.
//
// Vecs worlds do not expose a stop hook; the v1 equivalent is install, start,
// and repeatedly progress an empty physics world without allocating bodies,
// contacts, islands, or sleeping solver sets.

import { World } from "@vworlds/vecs";
import { describe, expect, it } from "vitest";

import { installPhysics } from "../../src/index.js";
import { getPhysics } from "../../src/adapter/state.js";

const STEP_MS = 1000 / 60;

describe("test_world.c::EmptyWorld", () => {
  it("steps an empty installed world without crashing", () => {
    const world = new World();
    installPhysics(world);
    const state = getPhysics(world);

    expect(() => step(world, 32)).not.toThrow();

    // No bodies or shapes were registered.
    expect(state.bodyByEntityWasm.size).toBe(0);
    expect(state.shapeByEntityWasm.size).toBe(0);
    expect(state.entityByBodyIndex.size).toBe(0);
    expect(state.entityByShapeIndex.size).toBe(0);
    // The WASM world is still valid after 32 empty steps.
    expect(state.box2d.b2World_IsValid(state.worldId)).toBe(true);
  });
});

function step(world: World, count: number): void {
  let now = 0;
  for (let i = 0; i < count; i++) {
    now += STEP_MS;
    world.progress(now, STEP_MS);
  }
}
