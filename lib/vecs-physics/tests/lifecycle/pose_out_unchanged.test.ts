// PhysicsPoseSyncOut writes a pose component only when its value changed.
//
// Every write is a modification: it fires `set` hooks, routes `update` events to every watching
// system and, for a networked component, is replicated to every client that sees the entity.
// Box2D reports bit-identical values for a body that did not move or turn, so an awake body at
// rest or in straight flight must leave the components that did not change untouched.

import { World, type Entity } from "@vworlds/vecs";
import { beforeEach, describe, expect, it } from "vitest";

import {
  AngularVelocity,
  Body,
  BodyType,
  Box,
  Damping,
  LinearVelocity,
  PhysicsModule,
  Position,
  Rotation,
  Sleep,
} from "../../src/index.js";
import { getPhysicsEngine } from "../../src/adapter/engine.js";

const DT = 1 / 60;
const STEP_MS = DT * 1000;
/** Steps observed after the first one. */
const STEPS = 30;

type PoseWrites = {
  Position: number;
  Rotation: number;
  LinearVelocity: number;
  AngularVelocity: number;
};

let now: number;

beforeEach(() => {
  now = 0;
});

function createWorld(gravityY = 0): World {
  const world = new World();
  world.module(PhysicsModule, {
    gravity: { x: 0, y: gravityY },
    fixedTimeStep: DT,
    subSteps: 4,
  });
  return world;
}

function step(world: World, count = 1): void {
  for (let i = 0; i < count; i++) {
    now += STEP_MS;
    world.progress(now, STEP_MS);
  }
}

function addBox(world: World, body: Entity): void {
  world.entity().childOf(body).set(Box, { hx: 0.25, hy: 0.25 });
}

/** Count every `set` of the four pose components, as the `set` hook observes it. */
function watchPoseWrites(world: World): PoseWrites {
  const writes: PoseWrites = { Position: 0, Rotation: 0, LinearVelocity: 0, AngularVelocity: 0 };
  world.component(Position).on("set", () => {
    writes.Position++;
  });
  world.component(Rotation).on("set", () => {
    writes.Rotation++;
  });
  world.component(LinearVelocity).on("set", () => {
    writes.LinearVelocity++;
  });
  world.component(AngularVelocity).on("set", () => {
    writes.AngularVelocity++;
  });
  return writes;
}

function isAwake(world: World, body: Entity): boolean {
  const bodyId = body.get(Body)?._bodyId;
  if (bodyId === undefined) {
    throw new Error("missing wasm body");
  }
  return getPhysicsEngine(world).box2d.b2Body_IsAwake(bodyId);
}

describe("PhysicsPoseSyncOut skips unchanged components", () => {
  it("leaves Rotation and AngularVelocity alone for a body flying in a straight line", () => {
    const world = createWorld();
    const bullet = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0 })
      .set(Rotation, { angle: 0.3 })
      .set(LinearVelocity, { x: 4, y: 0 })
      .set(AngularVelocity, { value: 0 });
    addBox(world, bullet);
    const writes = watchPoseWrites(world);

    // The first step may snap the angle to the value Box2D derives from its rotation.
    step(world);
    const afterFirstStep = { ...writes };
    step(world, STEPS);

    expect(writes.Position).toBe(afterFirstStep.Position + STEPS);
    expect(writes.Rotation).toBe(afterFirstStep.Rotation);
    expect(writes.AngularVelocity).toBe(afterFirstStep.AngularVelocity);
    expect(writes.LinearVelocity).toBe(afterFirstStep.LinearVelocity);
  });

  it("leaves the whole pose of an awake body at rest alone", () => {
    const world = createWorld();
    const parked = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 1.7, y: -2.3 })
      .set(Rotation, { angle: 0.3 })
      .set(LinearVelocity, { x: 0, y: 0 })
      .set(AngularVelocity, { value: 0 })
      .set(Sleep, { enabled: false });
    addBox(world, parked);
    const writes = watchPoseWrites(world);

    step(world);
    const afterFirstStep = { ...writes };
    step(world, STEPS);

    // An awake body gets a move event every step, so a silent pose is not just a sleeping body.
    expect(isAwake(world, parked)).toBe(true);
    expect(writes).toEqual(afterFirstStep);
  });

  it("writes every changed component exactly once per step for a body that moves and turns", () => {
    const world = createWorld(-10);
    const tumbler = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 10 })
      .set(Rotation, { angle: 0 })
      .set(LinearVelocity, { x: 2, y: 0 })
      .set(AngularVelocity, { value: 3 })
      .set(Damping, { linear: 0, angular: 0.5 });
    addBox(world, tumbler);
    const writes = watchPoseWrites(world);

    for (let i = 1; i <= STEPS; i++) {
      step(world);
      // Gravity changes only the y part of LinearVelocity: one write for the component, not two.
      expect(writes).toEqual({ Position: i, Rotation: i, LinearVelocity: i, AngularVelocity: i });
    }
  });

  it("writes only Position and Rotation for a spinning body in free flight", () => {
    const world = createWorld();
    const spinner = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 10 })
      .set(Rotation, { angle: 0 })
      .set(LinearVelocity, { x: 2, y: 0 })
      .set(AngularVelocity, { value: 3 });
    addBox(world, spinner);
    const writes = watchPoseWrites(world);

    for (let i = 1; i <= STEPS; i++) {
      step(world);
      expect(writes).toEqual({ Position: i, Rotation: i, LinearVelocity: 0, AngularVelocity: 0 });
    }
  });

  it("writes AngularVelocity but not LinearVelocity while only the spin decays", () => {
    const world = createWorld();
    const spinner = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 10 })
      .set(Rotation, { angle: 0 })
      .set(LinearVelocity, { x: 2, y: 0 })
      .set(AngularVelocity, { value: 3 })
      .set(Damping, { linear: 0, angular: 0.5 });
    addBox(world, spinner);
    const writes = watchPoseWrites(world);

    for (let i = 1; i <= STEPS; i++) {
      step(world);
      expect(writes).toEqual({ Position: i, Rotation: i, LinearVelocity: 0, AngularVelocity: i });
    }
  });

  it("creates Position for a body that has none and adds no other pose component", () => {
    const world = createWorld();
    const drifter = world.entity().set(Body, { type: BodyType.Dynamic });
    addBox(world, drifter);
    drifter.set(LinearVelocity, { x: 1, y: 0 });

    step(world, 2);

    expect(drifter.get(Position)?.x).toBeCloseTo(2 * DT, 6);
    expect(drifter.get(Position)?.y).toBe(0);
    expect(drifter.has(Rotation)).toBe(false);
    expect(drifter.has(AngularVelocity)).toBe(false);
  });
});
