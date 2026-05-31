// Ports box2d/test/test_world.c::EnableContactRecyclingTest.
//
// vecs-physics v1 disables distance-based contact recycling, but toggling
// Body.enabled must still destroy contacts on disable and recreate them on
// re-enable without leaks.

import { ChildOf, World } from "@vworlds/vecs";
import { describe, expect, it } from "vitest";

import { Body, BodyType, Box, Position, installPhysics } from "../../src/index.js";
import { DISABLED_SET } from "../../src/engine/solver_set.js";
import { getPhysics } from "../../src/engine/state.js";

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
    world.entity().set(ChildOf, { target: body }).set(Box, { width: 2, height: 2 });

    step(5);
    const bodyRecord = state.bodies.get(state.bodyByEntity.get(body.eid)!.index);
    const shapeIndex = bodyRecord.shapeHead;
    expect(liveContactCount(state)).toBeGreaterThan(0);

    body.set(Body, { type: BodyType.Dynamic, enabled: false });
    step(1);

    expect(bodyRecord.setIndex).toBe(DISABLED_SET);
    expect(state.shapes.get(shapeIndex).proxyKey).toBe(-1);
    expect(liveContactCount(state)).toBe(0);
    expect(state.graphContactSims).toHaveLength(0);
    expect(nonTouchingContactCount(state)).toBe(0);

    body.set(Body, { type: BodyType.Dynamic, enabled: true });
    step(1);

    expect(state.shapes.get(shapeIndex).proxyKey).toBeGreaterThanOrEqual(0);
    expect(liveContactCount(state)).toBeGreaterThan(0);
  });
});

function makeGround(world: World): void {
  const ground = world
    .entity()
    .set(Body, { type: BodyType.Static })
    .set(Position, { x: 0, y: -10 });
  world.entity().set(ChildOf, { target: ground }).set(Box, { width: 100, height: 20 });
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

function liveContactCount(state: ReturnType<typeof getPhysics>): number {
  return state.contacts.records.filter(Boolean).length;
}

function nonTouchingContactCount(state: ReturnType<typeof getPhysics>): number {
  return state.solverSets.reduce((count, set) => count + set.contactSims.length, 0);
}
