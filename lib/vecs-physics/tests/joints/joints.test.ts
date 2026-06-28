// Joint tests. Each runs the full Vecs world pipeline (PhysicsModule →
// world.progress) and asserts observable body state, never internal handles.
//
// Cases:
//   Distance — rigid joint holds two anchors at `length`.
//   Revolute — pin holds a body's center; motor spins it; limit clamps the angle.
//   Weld     — rigidly fixes a dynamic body welded to a static one.
//   Filter   — disables collision between the two connected bodies.
//   Lifecycle — order-independent creation, cascade delete on body destroy.
//   Features  — motor added at runtime drives an already-created joint.

import { type Entity, World } from "@vworlds/vecs";
import { beforeEach, describe, expect, it } from "vitest";

import {
  AngularVelocity,
  Body,
  BodyType,
  Box,
  DistanceJoint,
  FilterJoint,
  JointBodyA,
  JointBodyB,
  JointFrame,
  JointLimit,
  JointMotor,
  PhysicsModule,
  Position,
  RevoluteJoint,
  Rotation,
  WeldJoint,
} from "../../src/index.js";

const DT = 1 / 60;
const STEP_MS = DT * 1000;

function makeWorld(gravityY = 0): World {
  const world = new World();
  world.module(PhysicsModule, { gravity: { x: 0, y: gravityY }, fixedTimeStep: DT });
  return world;
}

// Monotonically increasing clock so successive step() calls never rewind time
// (a body that has gone to sleep stays consistent across calls).
let clock = 0;
function step(world: World, n: number): void {
  for (let i = 0; i < n; i++) {
    clock += STEP_MS;
    world.progress(clock, STEP_MS);
  }
}

/** Dynamic body at (x, y) with a unit box (mass 1, inertia 1/6) and pose read-back. */
function dynamicBody(world: World, x: number, y: number): Entity {
  const body = world
    .entity()
    .set(Body, { type: BodyType.Dynamic })
    .set(Position, { x, y })
    .add(Rotation)
    .add(AngularVelocity);
  world.entity().childOf(body).set(Box, { hx: 0.5, hy: 0.5 });
  return body;
}

function staticBody(world: World, x: number, y: number): Entity {
  return world.entity().set(Body, { type: BodyType.Static }).set(Position, { x, y });
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

describe("DistanceJoint", () => {
  it("holds two anchors at the rigid length", () => {
    const world = makeWorld();
    const a = staticBody(world, 0, 0);
    const b = dynamicBody(world, 3, 0);

    world
      .entity()
      .set(JointBodyA, { target: a })
      .set(JointBodyB, { target: b })
      .set(DistanceJoint, { length: 2 });

    step(world, 180);

    expect(distance(b.get(Position)!, { x: 0, y: 0 })).toBeCloseTo(2, 1);
  });
});

describe("RevoluteJoint", () => {
  it("pins a body's center to a static anchor", () => {
    const world = makeWorld(-10);
    const a = staticBody(world, 0, 5);
    const b = dynamicBody(world, 0, 5);

    world.entity().set(JointBodyA, { target: a }).set(JointBodyB, { target: b }).add(RevoluteJoint);

    step(world, 180);

    const pos = b.get(Position)!;
    expect(pos.x).toBeCloseTo(0, 1);
    expect(pos.y).toBeCloseTo(5, 1);
  });

  it("motor drives the relative angular velocity toward the target speed", () => {
    const world = makeWorld();
    const a = staticBody(world, 0, 0);
    const b = dynamicBody(world, 0, 0);

    world
      .entity()
      .set(JointBodyA, { target: a })
      .set(JointBodyB, { target: b })
      .add(RevoluteJoint)
      .set(JointMotor, { targetSpeed: 5, maxForce: 1000 });

    step(world, 120);

    expect(b.get(AngularVelocity)!.value).toBeGreaterThan(4);
  });

  it("limit clamps the swing angle relative to the free pendulum", () => {
    const limited = makeWorld(-10);
    const a1 = staticBody(limited, 0, 5);
    const b1 = dynamicBody(limited, 1, 5);
    limited
      .entity()
      .set(JointBodyA, { target: a1 })
      .set(JointBodyB, { target: b1 })
      .add(RevoluteJoint)
      .set(JointFrame, {
        localAnchorA: { x: 0, y: 0 },
        localAnchorB: { x: -1, y: 0 },
        referenceAngle: 0,
      })
      .set(JointLimit, { lower: -0.2, upper: 0.2 });
    step(limited, 180);

    const free = makeWorld(-10);
    const a2 = staticBody(free, 0, 5);
    const b2 = dynamicBody(free, 1, 5);
    free
      .entity()
      .set(JointBodyA, { target: a2 })
      .set(JointBodyB, { target: b2 })
      .add(RevoluteJoint)
      .set(JointFrame, {
        localAnchorA: { x: 0, y: 0 },
        localAnchorB: { x: -1, y: 0 },
        referenceAngle: 0,
      });
    step(free, 180);

    expect(b1.get(Rotation)!.angle).toBeGreaterThan(-0.4); // clamped near the lower limit
    expect(b2.get(Rotation)!.angle).toBeLessThan(-0.8); // free pendulum swings down
  });
});

describe("WeldJoint", () => {
  it("rigidly fixes a dynamic body welded to a static one", () => {
    const world = makeWorld(-10);
    const a = staticBody(world, 0, 5);
    const b = dynamicBody(world, 1, 5);

    world
      .entity()
      .set(JointBodyA, { target: a })
      .set(JointBodyB, { target: b })
      .add(WeldJoint)
      .set(JointFrame, {
        localAnchorA: { x: 1, y: 0 },
        localAnchorB: { x: 0, y: 0 },
        referenceAngle: 0,
      });

    step(world, 180);

    const pos = b.get(Position)!;
    expect(pos.x).toBeCloseTo(1, 1);
    expect(pos.y).toBeCloseTo(5, 1);
    expect(b.get(Rotation)!.angle).toBeCloseTo(0, 1);
  });
});

describe("FilterJoint", () => {
  it("disables collision between the two connected bodies", () => {
    const world = makeWorld();
    const a = dynamicBody(world, 0, 0);
    const b = dynamicBody(world, 0.3, 0);
    world.entity().set(JointBodyA, { target: a }).set(JointBodyB, { target: b }).add(FilterJoint);

    step(world, 90);

    // No collision push: the overlapping boxes stay overlapping.
    expect(distance(a.get(Position)!, b.get(Position)!)).toBeLessThan(0.6);
  });

  it("without a filter joint the overlapping boxes push apart", () => {
    const world = makeWorld();
    const a = dynamicBody(world, 0, 0);
    const b = dynamicBody(world, 0.3, 0);

    step(world, 90);

    expect(distance(a.get(Position)!, b.get(Position)!)).toBeGreaterThan(0.8);
  });
});

describe("joint lifecycle", () => {
  it("forms regardless of body/joint creation order (relationship fan-out)", () => {
    const world = makeWorld();
    // Bodies exist as entities but gain `Body` only AFTER the joint is created.
    const a = world.entity();
    const b = world.entity();

    world
      .entity()
      .set(JointBodyA, { target: a })
      .set(JointBodyB, { target: b })
      .set(DistanceJoint, { length: 2 });

    a.set(Body, { type: BodyType.Static }).set(Position, { x: 0, y: 0 });
    b.set(Body, { type: BodyType.Dynamic }).set(Position, { x: 3, y: 0 });
    world.entity().childOf(b).set(Box, { hx: 0.5, hy: 0.5 });

    step(world, 180);

    expect(distance(b.get(Position)!, { x: 0, y: 0 })).toBeCloseTo(2, 1);
  });

  it("destroying a connected body detaches the joint but leaves the joint entity", () => {
    const world = makeWorld(-10);
    // A distance joint hangs B two meters straight below the static anchor A, so
    // B rests at (0, 8) while constrained.
    const a = staticBody(world, 0, 10);
    const b = dynamicBody(world, 0, 8);
    const joint = world
      .entity()
      .set(JointBodyA, { target: a })
      .set(JointBodyB, { target: b })
      .set(DistanceJoint, { length: 2 });

    step(world, 30);
    expect(b.get(Position)!.y).toBeCloseTo(8, 1); // held by the joint

    a.destroy();
    step(world, 60);

    // The joint entity survives (it is not cascade-deleted)...
    expect(joint.get(DistanceJoint)).toBeDefined();
    // ...but its Box2D constraint is gone, so B is no longer held up and falls.
    expect(b.get(Position)!.y).toBeLessThan(6);
  });

  it("destroying a shaped connected body tears down the joint safely", () => {
    const world = makeWorld();
    const a = staticBody(world, 0, 0);
    const b = dynamicBody(world, 3, 0);
    world
      .entity()
      .set(JointBodyA, { target: a })
      .set(JointBodyB, { target: b })
      .set(DistanceJoint, { length: 2 });

    step(world, 5);
    expect(() => {
      b.destroy();
      step(world, 5);
    }).not.toThrow();
    // The surviving anchor is unaffected.
    expect(a.get(Position)!.x).toBeCloseTo(0, 5);
  });
});

describe("joint features (runtime)", () => {
  let world: World;
  let joint: Entity;
  let b: Entity;

  beforeEach(() => {
    world = makeWorld();
    const a = staticBody(world, 0, 0);
    b = dynamicBody(world, 0, 0);
    joint = world
      .entity()
      .set(JointBodyA, { target: a })
      .set(JointBodyB, { target: b })
      .add(RevoluteJoint);
  });

  it("adding a motor after creation drives the existing joint", () => {
    step(world, 30);
    expect(Math.abs(b.get(AngularVelocity)!.value)).toBeLessThan(0.01);

    joint.set(JointMotor, { targetSpeed: 5, maxForce: 1000 });
    step(world, 120);

    expect(b.get(AngularVelocity)!.value).toBeGreaterThan(4);
  });
});
