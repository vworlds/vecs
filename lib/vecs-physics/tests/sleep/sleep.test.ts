import { World, type EID } from "@vworlds/vecs";
import { describe, expect, it } from "vitest";

import { Body, BodyType, Box, Position, Sleep, installPhysics } from "../../src/index.js";
import { getPhysics, type b2BodyId, type PhysicsState } from "../../src/adapter/state.js";

const DT = 1 / 60;
const STEP_MS = DT * 1000;

function makeWorld(enableSleep = true): World {
  const world = new World();
  installPhysics(world, {
    gravity: { x: 0, y: 0 },
    fixedTimeStep: DT,
    subSteps: 1,
    enableSleep,
  });
  world.start();
  return world;
}

function step(world: World, count: number): void {
  let now = 0;
  for (let i = 0; i < count; i++) {
    now += STEP_MS;
    world.progress(now, STEP_MS);
  }
}

function createDynamicBox(world: World, sleep?: Partial<Sleep>) {
  const body = world.entity().set(Position, { x: 0, y: 0 }).set(Body, { type: BodyType.Dynamic });
  if (sleep !== undefined) {
    body.set(Sleep, sleep);
  }
  world.entity().childOf(body).set(Box, { width: 1, height: 1 });
  return body;
}

function getBodyId(world: World, eid: EID): b2BodyId {
  const state = getPhysics(world) as PhysicsState;
  const bodyId = state.bodyByEntityWasm.get(eid);
  if (bodyId === undefined) {
    throw new Error("missing wasm body");
  }
  return bodyId;
}

function isAwake(world: World, eid: EID): boolean {
  const state = getPhysics(world) as PhysicsState;
  return state.box2d.b2Body_IsAwake(getBodyId(world, eid));
}

function isSleepEnabled(world: World, eid: EID): boolean {
  const state = getPhysics(world) as PhysicsState;
  return state.box2d.b2Body_IsSleepEnabled(getBodyId(world, eid));
}

function sleepThreshold(world: World, eid: EID): number {
  const state = getPhysics(world) as PhysicsState;
  return state.box2d.b2Body_GetSleepThreshold(getBodyId(world, eid));
}

describe("WASM sleep configuration", () => {
  it("uses Sleep.enabled=false at body creation", () => {
    const world = makeWorld();
    const body = createDynamicBox(world, { enabled: false, awake: true, threshold: 0.05 });

    step(world, 120);

    expect(isSleepEnabled(world, body.eid)).toBe(false);
    expect(isAwake(world, body.eid)).toBe(true);
  });

  it("uses Sleep.awake=false at body creation", () => {
    const world = makeWorld();
    const body = createDynamicBox(world, { enabled: true, awake: false, threshold: 0.05 });

    step(world, 1);

    expect(isSleepEnabled(world, body.eid)).toBe(true);
    expect(isAwake(world, body.eid)).toBe(false);
  });

  it("propagates Sleep component updates to the Box2D body", () => {
    const world = makeWorld();
    const body = createDynamicBox(world, { enabled: false, awake: true, threshold: 0.5 });

    step(world, 1);
    expect(isSleepEnabled(world, body.eid)).toBe(false);
    expect(isAwake(world, body.eid)).toBe(true);
    expect(sleepThreshold(world, body.eid)).toBeCloseTo(0.5, 6);

    body.set(Sleep, { enabled: true, awake: false, threshold: 0.25 });
    step(world, 1);

    expect(isSleepEnabled(world, body.eid)).toBe(true);
    expect(isAwake(world, body.eid)).toBe(false);
    expect(sleepThreshold(world, body.eid)).toBeCloseTo(0.25, 6);
  });

  it("wakes a sleeping body when Sleep.awake changes to true", () => {
    const world = makeWorld();
    const body = createDynamicBox(world, { enabled: true, awake: false, threshold: 0.05 });

    step(world, 1);
    expect(isAwake(world, body.eid)).toBe(false);

    body.set(Sleep, { enabled: true, awake: true, threshold: 0.05 });
    step(world, 1);

    expect(isAwake(world, body.eid)).toBe(true);
  });

  it("honours installPhysics enableSleep=false at the world level", () => {
    const world = makeWorld(false);
    const body = createDynamicBox(world, { enabled: true, awake: true, threshold: 0.05 });

    step(world, 120);

    expect(isSleepEnabled(world, body.eid)).toBe(true);
    expect(isAwake(world, body.eid)).toBe(true);
  });

  it("sleeps an idle dynamic body after the box2d3-wasm settle window", () => {
    const world = makeWorld();
    const body = createDynamicBox(world, { enabled: true, awake: true, threshold: 0.05 });

    let stepsToSleep = 0;
    do {
      step(world, 1);
      stepsToSleep += 1;
    } while (stepsToSleep < 120 && isAwake(world, body.eid));

    // Baseline recorded against box2d3-wasm 5.2.0.
    expect(stepsToSleep).toBe(30);
    expect(isAwake(world, body.eid)).toBe(false);
  });
});
