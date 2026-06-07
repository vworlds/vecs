// VP-19 tests: PhysicsForceGather, PhysicsImpulseAccumulate, PhysicsImpulseZero.
//
// Test-first (TDD) per project conventions. All tests run the full Vecs world
// pipeline: installPhysics → world.start → world.progress.
//
// Pattern for "known mass": attach a default 1x1 Box with density 1. On
// box2d3-wasm@5.2.0 this gives mass = 1 and inertia = 1/6.
//
// Cases covered:
//   1. Force persistence: Force(10,0) → body accelerates each step (F = m·a).
//   2. Force zeroed each step: removing Force stops acceleration.
//   3. Force on a child entity (immediate ChildOf parent has Body) applies.
//   4. Multiple child forces sum on the body.
//   5. Immediate-parent rule: Force on a grandchild of Body is ignored.
//   6. Torque persistence: Torque.value applied each step.
//   7. Impulse accumulation: 3 × set(Impulse,...) → summed velocity delta.
//   8. Silent impulse zeroing: Impulse is {x:0,y:0} after step, no update fired.
//   9. AngularImpulse accumulation + silent zero.

import { type Entity, World } from "@vworlds/vecs";
import { beforeEach, describe, expect, it } from "vitest";

import {
  AngularImpulse,
  AngularVelocity,
  Body,
  BodyType,
  Box,
  Force,
  Impulse,
  LinearVelocity,
  Position,
  Torque,
  installPhysics,
} from "../../src/index.js";

const DT = 1 / 60;
const STEP_MS = DT * 1000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Create a world with no gravity so force/impulse tests run clean. */
function makeWorld() {
  const world = new World();
  installPhysics(world, { gravity: { x: 0, y: 0 }, fixedTimeStep: DT, subSteps: 1 });
  world.start();
  return world;
}

/** Run `n` steps, returning the new `now` accumulator. */
function step(world: World, n: number, now: number): number {
  for (let i = 0; i < n; i++) {
    now += STEP_MS;
    world.progress(now, STEP_MS);
  }
  return now;
}

function attachUnitBox(world: World, body: Entity): void {
  world.entity().childOf(body).set(Box, { hx: 0.5, hy: 0.5 });
}

// ─── 1. Force persistence ─────────────────────────────────────────────────────

describe("PhysicsForceGather — force persistence", () => {
  it("Force(10,0) accelerates a dynamic body every step (a = F·invMass)", () => {
    const world = makeWorld();
    let now = 0;

    const e = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0 })
      .set(LinearVelocity, { x: 0, y: 0 });
    attachUnitBox(world, e);

    now = step(world, 1, now);

    // Add a force of 10 N in x.
    e.set(Force, { x: 10, y: 0 });

    // Step 1: v += F·invMass·dt = 10·1·(1/60)
    now = step(world, 1, now);
    const v1 = e.get(LinearVelocity)!;
    expect(v1.x).toBeCloseTo(10 * DT, 5);
    expect(v1.y).toBeCloseTo(0, 5);

    // Step 2: force re-accumulates (non-reactive, every step), so vx doubles.
    now = step(world, 1, now);
    const v2 = e.get(LinearVelocity)!;
    expect(v2.x).toBeCloseTo(2 * 10 * DT, 5);
  });

  it("removing Force stops acceleration", () => {
    const world = makeWorld();
    let now = 0;

    const e = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0 })
      .set(LinearVelocity, { x: 0, y: 0 });
    attachUnitBox(world, e);

    now = step(world, 1, now);

    e.set(Force, { x: 8, y: 0 });
    now = step(world, 1, now);
    const v1x = e.get(LinearVelocity)!.x;
    expect(v1x).toBeCloseTo(8 * DT, 5);

    // Remove Force: no more acceleration.
    e.remove(Force);
    now = step(world, 1, now);
    // Velocity should be unchanged (no damping, no gravity).
    expect(e.get(LinearVelocity)!.x).toBeCloseTo(v1x, 5);
  });
});

// ─── 2. Force on a child entity ───────────────────────────────────────────────

describe("PhysicsForceGather — force on child entity", () => {
  it("Force on an immediate child of a Body applies to the parent body", () => {
    const world = makeWorld();
    let now = 0;

    const bodyE = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0 })
      .set(LinearVelocity, { x: 0, y: 0 });
    attachUnitBox(world, bodyE);

    now = step(world, 1, now);

    // Force component lives on a child entity (not the body entity itself).
    const childE = world.entity().childOf(bodyE).set(Force, { x: 5, y: 0 });

    // The child force is resolved to the parent body each step.
    now = step(world, 1, now);
    const vx = bodyE.get(LinearVelocity)!.x;
    expect(vx).toBeCloseTo(5 * DT, 5);

    // Unused reference keeps TypeScript happy.
    void childE;
  });

  it("multiple child forces sum on the parent body", () => {
    const world = makeWorld();
    let now = 0;

    const bodyE = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0 })
      .set(LinearVelocity, { x: 0, y: 0 });
    attachUnitBox(world, bodyE);

    now = step(world, 1, now);

    // Two separate child entities each carrying a Force.
    world.entity().childOf(bodyE).set(Force, { x: 3, y: 0 });
    world.entity().childOf(bodyE).set(Force, { x: 7, y: 0 });

    now = step(world, 1, now);
    // 3 + 7 = 10 N → vx = 10·DT
    expect(bodyE.get(LinearVelocity)!.x).toBeCloseTo(10 * DT, 5);
  });
});

// ─── 3. Immediate-parent rule (grandchild ignored) ───────────────────────────

describe("PhysicsForceGather — immediate-parent rule", () => {
  it("Force on a grandchild of Body is ignored", () => {
    const world = makeWorld();
    let now = 0;

    // Hierarchy: bodyE → childE → grandchildE (Force here)
    const bodyE = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0 })
      .set(LinearVelocity, { x: 0, y: 0 });
    attachUnitBox(world, bodyE);

    const childE = world.entity().childOf(bodyE);
    world.entity().childOf(childE).set(Force, { x: 999, y: 0 });

    now = step(world, 1, now);
    now = step(world, 1, now);

    // The grandchild's Force should NOT be applied (only the immediate parent is consulted).
    expect(bodyE.get(LinearVelocity)!.x).toBeCloseTo(0, 5);
  });
});

// ─── 4. Torque persistence ────────────────────────────────────────────────────

describe("PhysicsForceGather — torque persistence", () => {
  it("Torque.value applied every step increases angular velocity", () => {
    const world = makeWorld();
    let now = 0;

    const e = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0 })
      .set(AngularVelocity, { value: 0 });
    attachUnitBox(world, e);

    now = step(world, 1, now);

    e.set(Torque, { value: 5 });
    now = step(world, 1, now);
    // box2d3-wasm@5.2.0: default 1x1 box has inertia 1/6, so invInertia = 6.
    expect(e.get(AngularVelocity)!.value).toBeCloseTo(5 * 6 * DT, 5);

    now = step(world, 1, now);
    expect(e.get(AngularVelocity)!.value).toBeCloseTo(2 * 5 * 6 * DT, 4);
  });
});

// ─── 5. Impulse accumulation ──────────────────────────────────────────────────

describe("PhysicsImpulseAccumulate — accumulation", () => {
  it("three set(Impulse,...) before a step sum their x into velocity", () => {
    const world = makeWorld();
    let now = 0;

    const e = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0 })
      .set(LinearVelocity, { x: 0, y: 0 });
    attachUnitBox(world, e);

    now = step(world, 1, now);

    // Three impulse sets BEFORE the next step: each set fires an update event.
    // The accumulate system sums them: total x = 1 + 2 + 3 = 6 N·s.
    e.set(Impulse, { x: 1, y: 0 });
    e.set(Impulse, { x: 2, y: 0 });
    e.set(Impulse, { x: 3, y: 0 });

    // Step applies: vx += invMass * 6 = 1 * 6 = 6.
    now = step(world, 1, now);
    const vx = e.get(LinearVelocity)!.x;
    expect(vx).toBeCloseTo(6, 5);
  });

  it("Impulse on an immediate child of a Body applies to the parent body", () => {
    const world = makeWorld();
    let now = 0;

    const bodyE = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0 })
      .set(LinearVelocity, { x: 0, y: 0 });
    attachUnitBox(world, bodyE);

    now = step(world, 1, now);

    // Impulse on a child entity.
    const childE = world.entity().childOf(bodyE).set(Impulse, { x: 5, y: 0 });

    now = step(world, 1, now);
    expect(bodyE.get(LinearVelocity)!.x).toBeCloseTo(5, 5);

    void childE;
  });
});

// ─── 6. Silent impulse zeroing ────────────────────────────────────────────────

describe("PhysicsImpulseZero — silent zero", () => {
  it("Impulse is zeroed after the step without firing a modified event", () => {
    // Watcher must be registered BEFORE world.start().
    const world = new World();
    installPhysics(world, { gravity: { x: 0, y: 0 }, fixedTimeStep: DT, subSteps: 1 });

    // Track how many times a watcher observes Impulse modified.
    let modifiedCount = 0;
    // The watcher tracks entities that have Impulse. Entry-time initialization
    // fires the callback when an entity first gets Impulse (counting the
    // user's `set`). Direct property writes in PhysicsImpulseZero do NOT
    // trigger `modified`, so the watcher sees only the user sets, not the zero.
    world
      .system("ImpulseWatcher")
      .with({ any: [Impulse] })
      .update(Impulse, () => {
        modifiedCount++;
      });

    world.start();
    let now = 0;

    const e = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0 })
      .set(LinearVelocity, { x: 0, y: 0 });
    attachUnitBox(world, e);

    now = step(world, 1, now);

    // Set an impulse — this fires one update event (the set itself).
    e.set(Impulse, { x: 10, y: 0 });

    // Step: accumulate → apply → zero (silent).
    now = step(world, 1, now);

    // The watcher should have seen exactly ONE event: the user's set(Impulse).
    // The silent zero in PhysicsImpulseZero does NOT fire modified.
    expect(modifiedCount).toBe(1);

    // After the step the Impulse component is zero.
    const imp = e.get(Impulse)!;
    expect(imp.x).toBe(0);
    expect(imp.y).toBe(0);

    // In subsequent steps the watcher sees nothing new (no more sets).
    modifiedCount = 0;
    now = step(world, 1, now);
    expect(modifiedCount).toBe(0);
  });

  it("AngularImpulse is accumulated and zeroed silently", () => {
    // Watcher must be registered BEFORE world.start().
    const world = new World();
    installPhysics(world, { gravity: { x: 0, y: 0 }, fixedTimeStep: DT, subSteps: 1 });

    let modifiedCount = 0;
    world
      .system("AngImpulseWatcher")
      .with({ any: [AngularImpulse] })
      .update(AngularImpulse, () => {
        modifiedCount++;
      });

    world.start();
    let now = 0;

    const e = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0 })
      .set(AngularVelocity, { value: 0 });
    attachUnitBox(world, e);

    now = step(world, 1, now);

    // Two sets before the step: total = 3 + 4 = 7 N·m·s.
    e.set(AngularImpulse, { value: 3 });
    e.set(AngularImpulse, { value: 4 });

    now = step(world, 1, now);

    // box2d3-wasm@5.2.0: default 1x1 box has inertia 1/6, so invInertia = 6.
    expect(e.get(AngularVelocity)!.value).toBeCloseTo(42, 5);

    // Watcher saw the two user sets, not the silent zero.
    expect(modifiedCount).toBe(2);

    const ai = e.get(AngularImpulse)!;
    expect(ai.value).toBe(0);

    // No further events next step.
    modifiedCount = 0;
    now = step(world, 1, now);
    expect(modifiedCount).toBe(0);
  });
});

// ─── Removed-target rejection ─────────────────────────────────────────────────

describe("PhysicsImpulseAccumulate — removed target guard", () => {
  it("drops a pending impulse when its target body is removed before drain", () => {
    const world = makeWorld();
    let now = 0;

    const e = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0 })
      .set(LinearVelocity, { x: 0, y: 0 });
    attachUnitBox(world, e);

    now = step(world, 1, now);
    e.set(Impulse, { x: 100, y: 0 });
    e.remove(Body);

    expect(() => {
      now = step(world, 1, now);
    }).not.toThrow();

    expect(e.get(Impulse)!.x).toBe(0);
  });

  it("applies a pending impulse while its target body is still alive", () => {
    const world = makeWorld();
    let now = 0;

    const e = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0 })
      .set(LinearVelocity, { x: 0, y: 0 });
    attachUnitBox(world, e);

    now = step(world, 1, now);
    e.set(Impulse, { x: 100, y: 0 });

    now = step(world, 1, now);

    expect(e.get(LinearVelocity)!.x).toBeCloseTo(100, 5);
  });
});
