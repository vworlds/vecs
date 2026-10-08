// Joint tests. Each runs the full Vecs world pipeline (PhysicsModule →
// world.progress) and asserts observable body state, never internal handles.
//
// Cases:
//   Distance   — rigid joint holds two anchors at `length`.
//   Revolute   — pin holds a body's center; motor spins it; limit clamps the angle.
//   Prismatic  — locks translation perpendicular to the axis; motor and limit drive/bound the slide.
//   Wheel      — like prismatic but leaves rotation free; motor spins the wheel.
//   Weld       — rigidly fixes a dynamic body welded to a static one.
//   Filter     — disables collision between the two connected bodies.
//   Motor      — drives body B toward a target velocity and/or pose relative to body A.
//   Lifecycle  — order-independent creation; destroying a connected body destroys the joint entity.
//   Features   — motor added at runtime drives an already-created joint.

import { type Entity, World } from "@vworlds/vecs";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  LinearVelocity,
  MotorJoint,
  PhysicsModule,
  Position,
  PrismaticJoint,
  RevoluteJoint,
  Rotation,
  WeldJoint,
  WheelJoint,
  physics,
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

    world.entity().add(JointBodyA, a).add(JointBodyB, b).set(DistanceJoint, { length: 2 });

    step(world, 180);

    expect(distance(b.get(Position)!, { x: 0, y: 0 })).toBeCloseTo(2, 1);
  });
});

describe("RevoluteJoint", () => {
  it("pins a body's center to a static anchor", () => {
    const world = makeWorld(-10);
    const a = staticBody(world, 0, 5);
    const b = dynamicBody(world, 0, 5);

    world.entity().add(JointBodyA, a).add(JointBodyB, b).add(RevoluteJoint);

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
      .add(JointBodyA, a)
      .add(JointBodyB, b)
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
      .add(JointBodyA, a1)
      .add(JointBodyB, b1)
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
      .add(JointBodyA, a2)
      .add(JointBodyB, b2)
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

describe("PrismaticJoint", () => {
  it("locks translation perpendicular to the slide axis", () => {
    const world = makeWorld(-10);
    const a = staticBody(world, 0, 0);
    const b = dynamicBody(world, 2, 0);

    // Default JointFrame: axis is body A's local x-axis (referenceAngle 0), so
    // the slide line runs through both bodies' starting y. Gravity pulls along
    // y, perpendicular to the axis, so it should not move B at all.
    world.entity().add(JointBodyA, a).add(JointBodyB, b).add(PrismaticJoint);

    step(world, 90);

    expect(b.get(Position)!.y).toBeCloseTo(0, 1);
  });

  it("motor drives translation along the slide axis (m/s, force)", () => {
    const world = makeWorld();
    const a = staticBody(world, 0, 0);
    const b = dynamicBody(world, 2, 0);
    b.add(LinearVelocity);

    world
      .entity()
      .add(JointBodyA, a)
      .add(JointBodyB, b)
      .add(PrismaticJoint)
      .set(JointMotor, { targetSpeed: 5, maxForce: 1000 });

    step(world, 120);

    expect(b.get(LinearVelocity)!.x).toBeGreaterThan(4);
  });

  it("limit clamps the slide translation", () => {
    const world = makeWorld();
    const a = staticBody(world, 0, 0);
    // Translation is measured from body A's anchor, so start B coincident with
    // it (translation 0) — connected bodies never collide, so overlap is fine.
    const b = dynamicBody(world, 0, 0);

    world
      .entity()
      .add(JointBodyA, a)
      .add(JointBodyB, b)
      .add(PrismaticJoint)
      .set(JointMotor, { targetSpeed: 10, maxForce: 1000 })
      .set(JointLimit, { lower: 0, upper: 1 });

    step(world, 180);

    expect(b.get(Position)!.x).toBeLessThan(1.1);
    expect(b.get(Position)!.x).toBeGreaterThan(0.8);
  });
});

describe("WheelJoint", () => {
  it("leaves relative rotation free, unlike PrismaticJoint which locks it", () => {
    // `Rotation.angle` wraps to [-π, π], so compare `AngularVelocity` instead:
    // it stays free-spinning under `WheelJoint` but gets zeroed every step under
    // `PrismaticJoint`'s relative-angle lock.
    const wheeled = makeWorld();
    const wa = staticBody(wheeled, 0, 0);
    const wb = dynamicBody(wheeled, 2, 0);
    wb.set(AngularVelocity, { value: 5 });
    wheeled.entity().add(JointBodyA, wa).add(JointBodyB, wb).add(WheelJoint);

    const locked = makeWorld();
    const la = staticBody(locked, 0, 0);
    const lb = dynamicBody(locked, 2, 0);
    lb.set(AngularVelocity, { value: 5 });
    locked.entity().add(JointBodyA, la).add(JointBodyB, lb).add(PrismaticJoint);

    step(wheeled, 60);
    step(locked, 60);

    expect(wb.get(AngularVelocity)!.value).toBeCloseTo(5, 1); // spun freely
    expect(Math.abs(lb.get(AngularVelocity)!.value)).toBeLessThan(0.1); // locked
  });

  it("motor spins the wheel (rad/s, torque), like RevoluteJoint", () => {
    const world = makeWorld();
    const a = staticBody(world, 0, 0);
    const b = dynamicBody(world, 2, 0);

    world
      .entity()
      .add(JointBodyA, a)
      .add(JointBodyB, b)
      .add(WheelJoint)
      .set(JointMotor, { targetSpeed: 5, maxForce: 1000 });

    step(world, 120);

    expect(b.get(AngularVelocity)!.value).toBeGreaterThan(4);
  });
});

describe("WeldJoint", () => {
  it("rigidly fixes a dynamic body welded to a static one", () => {
    const world = makeWorld(-10);
    const a = staticBody(world, 0, 5);
    const b = dynamicBody(world, 1, 5);

    world
      .entity()
      .add(JointBodyA, a)
      .add(JointBodyB, b)
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
    world.entity().add(JointBodyA, a).add(JointBodyB, b).add(FilterJoint);

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

describe("MotorJoint", () => {
  it("drives body B toward the target linear velocity", () => {
    const world = makeWorld();
    const a = staticBody(world, 0, 0);
    const b = dynamicBody(world, 0, 0);
    b.add(LinearVelocity);

    world
      .entity()
      .add(JointBodyA, a)
      .add(JointBodyB, b)
      .set(MotorJoint, { linearVelocity: { x: 5, y: 0 }, maxVelocityForce: 1000 });

    step(world, 120);

    expect(b.get(LinearVelocity)!.x).toBeGreaterThan(4);
  });

  it("spring pulls body B toward the frame's target pose", () => {
    const world = makeWorld();
    const a = staticBody(world, 0, 5);
    const b = dynamicBody(world, 3, 5);

    world.entity().add(JointBodyA, a).add(JointBodyB, b).set(MotorJoint, {
      linearHertz: 2,
      linearDampingRatio: 1,
      maxSpringForce: 1000,
    });

    step(world, 180);

    expect(distance(b.get(Position)!, { x: 0, y: 5 })).toBeLessThan(0.5);
  });
});

describe("joint lifecycle", () => {
  it("forms regardless of body/joint creation order (relationship fan-out)", () => {
    const world = makeWorld();
    // Bodies exist as entities but gain `Body` only AFTER the joint is created.
    const a = world.entity();
    const b = world.entity();

    world.entity().add(JointBodyA, a).add(JointBodyB, b).set(DistanceJoint, { length: 2 });

    a.set(Body, { type: BodyType.Static }).set(Position, { x: 0, y: 0 });
    b.set(Body, { type: BodyType.Dynamic }).set(Position, { x: 3, y: 0 });
    world.entity().childOf(b).set(Box, { hx: 0.5, hy: 0.5 });

    step(world, 180);

    expect(distance(b.get(Position)!, { x: 0, y: 0 })).toBeCloseTo(2, 1);
  });

  it("destroying a shaped connected body tears down the joint safely", () => {
    const world = makeWorld();
    const a = staticBody(world, 0, 0);
    const b = dynamicBody(world, 3, 0);
    world.entity().add(JointBodyA, a).add(JointBodyB, b).set(DistanceJoint, { length: 2 });

    step(world, 5);
    expect(() => {
      b.destroy();
      step(world, 5);
    }).not.toThrow();
    // The surviving anchor is unaffected.
    expect(a.get(Position)!.x).toBeCloseTo(0, 5);
  });
});

/** Game state a game keeps on a joint entity of its own, next to the physics components. */
class RopeWear {
  strain = 0;
}

describe("destroying a connected body", () => {
  let world: World;
  let a: Entity;
  let b: Entity;
  let joint: Entity;

  // A static anchor A at (0, 10) with a dynamic bob B hanging two meters below it.
  beforeEach(() => {
    world = makeWorld(-10);
    a = staticBody(world, 0, 10);
    b = dynamicBody(world, 0, 8);
    joint = world.entity().add(JointBodyA, a).add(JointBodyB, b).set(DistanceJoint, { length: 2 });

    step(world, 30);
    expect(b.get(Position)!.y).toBeCloseTo(8, 1); // held up by the joint
    expect(physics(world).stats()).toMatchObject({ bodyCount: 2, jointCount: 1 });
  });

  it("destroying body A destroys the joint entity and frees body B", () => {
    a.destroy();

    expect(joint.destroyed).toBe(true);
    expect(() => step(world, 60)).not.toThrow();
    expect(b.destroyed).toBe(false);
    expect(b.get(Position)!.y).toBeLessThan(6); // nothing holds it up any more
    expect(physics(world).stats()).toMatchObject({ bodyCount: 1, jointCount: 0 });
  });

  it("destroying body B destroys the joint entity and leaves body A alive", () => {
    b.destroy();

    expect(joint.destroyed).toBe(true);
    expect(() => step(world, 60)).not.toThrow();
    expect(a.destroyed).toBe(false);
    expect(a.get(Position)).toMatchObject({ x: 0, y: 10 });
    expect(physics(world).stats()).toMatchObject({ bodyCount: 1, jointCount: 0 });
  });

  it("destroying both bodies in the same frame destroys the joint entity once", () => {
    a.destroy();
    b.destroy();

    expect(joint.destroyed).toBe(true);
    expect(() => step(world, 5)).not.toThrow();
    expect(physics(world).stats()).toMatchObject({ bodyCount: 0, jointCount: 0 });
  });

  it("destroying both bodies from a deferred block does the same", () => {
    world.defer(() => {
      b.destroy();
      a.destroy();
    });

    expect(joint.destroyed).toBe(true);
    expect(() => step(world, 5)).not.toThrow();
    expect(physics(world).stats()).toMatchObject({ bodyCount: 0, jointCount: 0 });
  });

  it("destroying a body destroys every joint connected to it", () => {
    const others = [staticBody(world, 3, 10), staticBody(world, -3, 10)];
    const filters = others.map((other) =>
      world.entity().add(JointBodyA, other).add(JointBodyB, b).add(FilterJoint)
    );
    step(world, 5);
    expect(physics(world).stats().jointCount).toBe(3);

    b.destroy();

    expect([joint, ...filters].map((j) => j.destroyed)).toEqual([true, true, true]);
    expect(others.map((other) => other.destroyed)).toEqual([false, false]);
    expect(() => step(world, 5)).not.toThrow();
    expect(physics(world).stats()).toMatchObject({ bodyCount: 3, jointCount: 0 });
  });

  it("destroying the joint entity directly leaves both bodies alive", () => {
    joint.destroy();

    expect(() => step(world, 60)).not.toThrow();
    expect(a.destroyed).toBe(false);
    expect(b.destroyed).toBe(false);
    expect(b.get(Position)!.y).toBeLessThan(6); // released
    expect(physics(world).stats()).toMatchObject({ bodyCount: 2, jointCount: 0 });
  });

  it("destroys the game state on the joint entity along with it", () => {
    const onRemove = vi.fn();
    world.component(RopeWear).on("remove", onRemove);
    joint.set(RopeWear, { strain: 3 });

    b.destroy();

    expect(joint.destroyed).toBe(true);
    expect(world.getEntity(joint.eid)).toBeUndefined();
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledWith(joint, expect.objectContaining({ strain: 3 }));
    expect(() => step(world, 5)).not.toThrow();
  });

  it("pointing a slot at another body first keeps the joint entity when the old body is destroyed", () => {
    const spare = staticBody(world, 0, 10);
    joint.add(JointBodyA, spare);

    a.destroy();
    step(world, 30);

    expect(joint.destroyed).toBe(false);
    expect(b.get(Position)!.y).toBeCloseTo(8, 1); // still held, now by the spare anchor
    expect(physics(world).stats()).toMatchObject({ bodyCount: 2, jointCount: 1 });
  });

  it("removing Body only detaches the constraint: the joint entity reforms with the body", () => {
    b.remove(Body);
    step(world, 5);

    expect(joint.destroyed).toBe(false);
    expect(physics(world).stats()).toMatchObject({ bodyCount: 1, jointCount: 0 });

    b.set(Body, { type: BodyType.Dynamic });
    step(world, 5);

    expect(physics(world).stats()).toMatchObject({ bodyCount: 2, jointCount: 1 });
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
    joint = world.entity().add(JointBodyA, a).add(JointBodyB, b).add(RevoluteJoint);
  });

  it("adding a motor after creation drives the existing joint", () => {
    step(world, 30);
    expect(Math.abs(b.get(AngularVelocity)!.value)).toBeLessThan(0.01);

    joint.set(JointMotor, { targetSpeed: 5, maxForce: 1000 });
    step(world, 120);

    expect(b.get(AngularVelocity)!.value).toBeGreaterThan(4);
  });

  it("adding a motor after creation drives an existing wheel joint", () => {
    const wheelWorld = makeWorld();
    const wheelA = staticBody(wheelWorld, 0, 0);
    const wheelB = dynamicBody(wheelWorld, 0, 0);
    const wheelJoint = wheelWorld
      .entity()
      .add(JointBodyA, wheelA)
      .add(JointBodyB, wheelB)
      .add(WheelJoint);

    step(wheelWorld, 30);
    expect(Math.abs(wheelB.get(AngularVelocity)!.value)).toBeLessThan(0.01);

    wheelJoint.set(JointMotor, { targetSpeed: 5, maxForce: 1000 });
    step(wheelWorld, 120);

    expect(wheelB.get(AngularVelocity)!.value).toBeGreaterThan(4);
  });
});
