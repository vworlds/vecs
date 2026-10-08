// `physics(world).settings()`, `isAwake` and `bodyMotion`: the reads a peer needs to predict a body.

import { World } from "@vworlds/vecs";
import { beforeEach, describe, expect, it } from "vitest";

import {
  AngularVelocity,
  Body,
  BodyMotion,
  BodyType,
  Damping,
  GravityScale,
  LinearVelocity,
  PhysicsModule,
  Polygon,
  Position,
  physics,
} from "../../src/index.js";

const STEP_MS = 1000 / 60;

let world: World;
let now = 0;

function step(count = 1): void {
  for (let i = 0; i < count; i++) {
    world.progress(now, STEP_MS);
    now += STEP_MS;
  }
}

beforeEach(() => {
  world = new World();
  world.module(PhysicsModule, { gravity: { x: 0, y: 0 }, fixedTimeStep: 1 / 60, subSteps: 3 });
  now = 0;
});

describe("physics(world).settings()", () => {
  it("returns the settings the world was built with, defaults filled in", () => {
    expect(physics(world).settings()).toEqual({
      gravity: { x: 0, y: 0 },
      fixedTimeStep: 1 / 60,
      subSteps: 3,
      maximumLinearSpeed: 400,
    });
    expect(Object.isFrozen(physics(world).settings())).toBe(true);
  });
});

describe("physics(world).bodyMotion() and isAwake()", () => {
  it("reads a body's velocities, damping, center of mass, gravity scale and fast-rotation flag", () => {
    const body = world
      .entity()
      .set(Body, { type: BodyType.Dynamic, allowFastRotation: true })
      .set(Position, { x: 1, y: 2 })
      .set(LinearVelocity, { x: 3, y: -1 })
      .set(AngularVelocity, { value: 0.5 })
      .set(Damping, { linear: 0.25, angular: 0.125 })
      .set(GravityScale, { value: 0.5 });
    // A 2 x 1 rectangle from the origin: its center of mass is (1, 0.5).
    world
      .entity()
      .childOf(body)
      .set(Polygon, {
        vertices: [
          { x: 0, y: 0 },
          { x: 2, y: 0 },
          { x: 2, y: 1 },
          { x: 0, y: 1 },
        ],
      });
    step();

    const motion = new BodyMotion();
    expect(physics(world).bodyMotion(body, motion)).toBe(true);
    expect(physics(world).isAwake(body)).toBe(true);
    expect(motion.awake).toBe(true);
    expect(motion.vx).toBeCloseTo(3 / (1 + 0.25 / 60 / 3) ** 3, 5);
    expect(motion.w).toBeLessThan(0.5);
    expect(motion).toMatchObject({
      linearDamping: 0.25,
      angularDamping: 0.125,
      localCenterX: 1,
      localCenterY: 0.5,
      gravityScale: 0.5,
      allowFastRotation: true,
    });
  });

  it("reports a gravity scale of 0 for a kinematic body, and zero velocities once a body sleeps", () => {
    const kinematic = world
      .entity()
      .set(Body, { type: BodyType.Kinematic })
      .set(GravityScale, { value: 2 });
    const resting = world.entity().set(Body, { type: BodyType.Dynamic }).set(Position, { x: 9 });
    step();

    const motion = new BodyMotion();
    physics(world).bodyMotion(kinematic, motion);
    expect(motion.gravityScale).toBe(0);

    // Box2D puts a body that stays still for half a second to sleep.
    step(60);
    expect(physics(world).isAwake(resting)).toBe(false);
    expect(physics(world).bodyMotion(resting, motion)).toBe(true);
    expect(motion).toMatchObject({ awake: false, vx: 0, vy: 0, w: 0 });
  });

  it("answers for an entity without a body without touching the output", () => {
    const decoration = world.entity().set(Position, { x: 1, y: 1 });
    step();

    const motion = new BodyMotion();
    motion.vx = 7;
    expect(physics(world).isAwake(decoration)).toBe(false);
    expect(physics(world).bodyMotion(decoration, motion)).toBe(false);
    expect(motion.vx).toBe(7);
  });
});
