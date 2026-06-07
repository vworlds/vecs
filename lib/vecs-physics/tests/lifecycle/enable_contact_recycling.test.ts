// Ports box2d/test/test_world.c::EnableContactRecyclingTest.
//
// vecs-physics v1 disables distance-based contact recycling, but toggling
// Body.enabled must still destroy contacts on disable and recreate them on
// re-enable without leaks.

import { World } from "@vworlds/vecs";
import { describe, expect, it } from "vitest";

import { Body, BodyType, Box, Position, installPhysics } from "../../src/index.js";
import { getPhysics } from "../../src/adapter/state.js";

const STEP_MS = 1000 / 60;

describe("test_world.c::EnableContactRecyclingTest", () => {
  it("destroys contacts on disable and recreates them on re-enable", () => {
    const world = new World();
    installPhysics(world, { gravity: { x: 0, y: -10 } });
    world.start();
    const state = getPhysics(world);
    const step = makeStepper(world);

    makeGround(world);
    const body = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0.5 });
    world.entity().childOf(body).set(Box, { hx: 1, hy: 1 });

    step(5);
    const bodyId = state.bodyByEntityWasm.get(body.eid)!;
    // Some contacts should have formed.
    expect(state.box2d.b2Body_IsValid(bodyId)).toBe(true);

    body.set(Body, { type: BodyType.Dynamic, enabled: false });
    step(1);

    // Body is now disabled in WASM.
    expect(state.box2d.b2Body_IsEnabled(bodyId)).toBe(false);
    // WASM world is still valid.
    expect(state.box2d.b2World_IsValid(state.worldId)).toBe(true);

    body.set(Body, { type: BodyType.Dynamic, enabled: true });
    step(1);

    // Body is re-enabled.
    expect(state.box2d.b2Body_IsEnabled(bodyId)).toBe(true);
    expect(state.box2d.b2World_IsValid(state.worldId)).toBe(true);
  });
});

function makeGround(world: World): void {
  const ground = world
    .entity()
    .set(Body, { type: BodyType.Static })
    .set(Position, { x: 0, y: -10 });
  world.entity().childOf(ground).set(Box, { hx: 50, hy: 10 });
}

function makeStepper(world: World): (count: number) => void {
  let now = 0;
  return (count) => {
    for (let i = 0; i < count; i++) {
      now += STEP_MS;
      world.progress(now, STEP_MS);
    }
  };
}
