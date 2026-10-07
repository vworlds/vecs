// Wake semantics of forces, torques and impulses (vworlds/vecs#215).
//
// A zero load is physically a no-op, so applying it can only ever wake a sleeping body. A game
// that keeps an idle `Force { x: 0, y: 0 }` on a ship, the thrust component written back to zero
// when the player lets go, would otherwise wake that ship before every step and never let it stay
// asleep. So PhysicsForceGather skips a zero Force or Torque, and PhysicsImpulseAccumulate drops a
// zero Impulse or AngularImpulse, or impulses that sum to exactly zero, without calling Box2D. A
// non-zero load keeps Box2D's `wake` semantics: `wake: true` wakes a sleeping body, `wake: false`
// leaves it asleep. To wake a body or keep it awake, the Sleep component is the tool.
//
// Every test runs the full pipeline against real Box2D (PhysicsModule → world.progress). Gravity
// is off, so a body with no load settles and falls asleep after Box2D's time-to-sleep (0.5 s, 30
// steps at 60 Hz). Tests let a body fall asleep on its own, then apply the load under test.
//
// Pattern for "known mass": a default 1x1 Box with density 1 gives mass = 1 and inertia = 1/6 on
// box2d3-wasm@5.2.0, so an impulse changes velocity by its own value (angular: times 6).
//
// Cases covered:
//   1. A zero Force or Torque never keeps a body awake, on the body or on a child source.
//   2. A zero Impulse or AngularImpulse, or impulses that sum to zero, never wake a sleeping body.
//   3. A zero impulse's `wake` flag does not leak into the `wake` of a non-zero impulse.
//   4. A non-zero Force or Torque wakes a sleeping body with `wake: true` and leaves it asleep
//      with `wake: false`, for any non-zero vector (unchanged).
//   5. A non-zero Impulse or AngularImpulse still applies and wakes the body when asked
//      (unchanged).
//   6. `Sleep { awake: true }` wakes a body that fell asleep, and `Sleep { enabled: false }` wakes
//      it and keeps it awake: the documented way to do what a zero load cannot.

import { type Entity, World } from "@vworlds/vecs";
import { describe, expect, it } from "vitest";

import { getPhysicsEngine } from "../../src/adapter/engine.js";
import {
  AngularImpulse,
  AngularVelocity,
  Body,
  BodyType,
  Box,
  Damping,
  Force,
  Impulse,
  LinearVelocity,
  PhysicsModule,
  Position,
  Sleep,
  Torque,
} from "../../src/index.js";

const DT = 1 / 60;
const STEP_MS = DT * 1000;

/** Upper bound for a body with no load to fall asleep. Box2D's time-to-sleep is 30 steps. */
const MAX_STEPS_TO_SLEEP = 120;

/** How long a body must stay asleep to count as staying asleep: 4x Box2D's time-to-sleep. */
const STAY_ASLEEP_STEPS = 120;

/** Non-zero `[x, y]` vectors: one non-zero component, both, and a tiny but non-zero magnitude. */
const NON_ZERO_VECTORS: [x: number, y: number][] = [
  [4, 0],
  [0, 4],
  [-3, -4],
  [0, 1e-6],
];

/** Non-zero scalars for torque and angular impulse: either sign, and a tiny magnitude. */
const NON_ZERO_SCALARS = [5, -5, 1e-6];

// ─── Helpers ──────────────────────────────────────────────────────────────────

type Scene = {
  readonly world: World;
  /** Advances the world by `count` fixed physics steps (default 1). */
  step(count?: number): void;
};

/** A world with no gravity, so a body with no load stays put and falls asleep. */
function makeScene(): Scene {
  const world = new World();
  world.module(PhysicsModule, { gravity: { x: 0, y: 0 }, fixedTimeStep: DT, subSteps: 1 });
  let now = 0;
  return {
    world,
    step(count = 1): void {
      for (let i = 0; i < count; i++) {
        now += STEP_MS;
        world.progress(now, STEP_MS);
      }
    },
  };
}

/** A dynamic unit box (mass 1) that reports its velocity back into the ECS. */
function addBody(world: World): Entity {
  const body = world
    .entity()
    .set(Position, { x: 0, y: 0 })
    .set(Body, { type: BodyType.Dynamic })
    .set(LinearVelocity, { x: 0, y: 0 })
    .set(AngularVelocity, { value: 0 });
  world.entity().childOf(body).set(Box, { hx: 0.5, hy: 0.5 });
  return body;
}

function isAwake(scene: Scene, body: Entity): boolean {
  const bodyId = body.get(Body)?._bodyId;
  if (bodyId === undefined) {
    throw new Error("missing wasm body");
  }
  return getPhysicsEngine(scene.world).box2d.b2Body_IsAwake(bodyId);
}

/** Steps until `body` is asleep and returns how many steps that took. Throws if it never sleeps. */
function stepUntilAsleep(scene: Scene, body: Entity): number {
  for (let steps = 1; steps <= MAX_STEPS_TO_SLEEP; steps++) {
    scene.step();
    if (!isAwake(scene, body)) {
      return steps;
    }
  }
  throw new Error(`body still awake after ${MAX_STEPS_TO_SLEEP} steps`);
}

/** Steps a body with no load until it sleeps: Box2D's own time-to-sleep, in steps. */
function stepsToSleepWithoutLoad(): number {
  const scene = makeScene();
  return stepUntilAsleep(scene, addBody(scene.world));
}

/** A dynamic body that fell asleep on its own, with no load attached. */
function addSleepingBody(scene: Scene): Entity {
  const body = addBody(scene.world);
  stepUntilAsleep(scene, body);
  return body;
}

/** Steps `STAY_ASLEEP_STEPS` times and asserts `body` is asleep after every one of them. */
function expectStaysAsleep(scene: Scene, body: Entity): void {
  for (let step = 1; step <= STAY_ASLEEP_STEPS; step++) {
    scene.step();
    expect(isAwake(scene, body), `awake after step ${step}`).toBe(false);
  }
}

// ─── 1. Zero forces and torques ───────────────────────────────────────────────

describe("PhysicsForceGather — zero loads never wake a body", () => {
  it("a body holding Force { x: 0, y: 0, wake: true } falls asleep and stays asleep", () => {
    const scene = makeScene();
    const body = addBody(scene.world).set(Force, { x: 0, y: 0, wake: true });

    expect(stepUntilAsleep(scene, body)).toBe(stepsToSleepWithoutLoad());
    expectStaysAsleep(scene, body);
  });

  it("a body holding Torque { value: 0, wake: true } falls asleep and stays asleep", () => {
    const scene = makeScene();
    const body = addBody(scene.world).set(Torque, { value: 0, wake: true });

    expect(stepUntilAsleep(scene, body)).toBe(stepsToSleepWithoutLoad());
    expectStaysAsleep(scene, body);
  });

  it("a zero Force added to a sleeping body does not wake it", () => {
    const scene = makeScene();
    const body = addSleepingBody(scene);

    body.set(Force, { x: 0, y: 0, wake: true });

    expectStaysAsleep(scene, body);
  });

  it("a zero Force or Torque on an immediate child of the body does not wake it", () => {
    const scene = makeScene();
    const body = addSleepingBody(scene);

    scene.world.entity().childOf(body).set(Force, { x: 0, y: 0, wake: true });
    scene.world.entity().childOf(body).set(Torque, { value: 0, wake: true });

    expectStaysAsleep(scene, body);
  });

  it("an idle zero Force beside a non-zero wake: false Force leaves a sleeping body asleep", () => {
    const scene = makeScene();
    const body = addSleepingBody(scene);

    scene.world.entity().childOf(body).set(Force, { x: 0, y: 0, wake: true });
    scene.world.entity().childOf(body).set(Force, { x: 4, y: 0, wake: false });

    expectStaysAsleep(scene, body);
  });

  it("a thrust Force written back to zero lets the body come to rest and sleep", () => {
    const scene = makeScene();
    // Drag brings the ship to rest once the thrust stops.
    const ship = addBody(scene.world)
      .set(Damping, { linear: 20, angular: 20 })
      .set(Force, { x: 4, y: 0, wake: true });

    scene.step(10);
    expect(isAwake(scene, ship)).toBe(true);
    expect(ship.get(LinearVelocity)!.x).toBeGreaterThan(0);

    // The player lets go: the same component is written back to zero while the body still moves.
    ship.set(Force, { x: 0, y: 0, wake: true });
    stepUntilAsleep(scene, ship);

    expectStaysAsleep(scene, ship);
  });
});

// ─── 2. Zero impulses ─────────────────────────────────────────────────────────

describe("PhysicsImpulseAccumulate — zero impulses never wake a body", () => {
  it("a zero Impulse does not wake a sleeping body", () => {
    const scene = makeScene();
    const body = addSleepingBody(scene);

    body.set(Impulse, { x: 0, y: 0, wake: true });

    expectStaysAsleep(scene, body);
  });

  it("a zero AngularImpulse does not wake a sleeping body", () => {
    const scene = makeScene();
    const body = addSleepingBody(scene);

    body.set(AngularImpulse, { value: 0, wake: true });

    expectStaysAsleep(scene, body);
  });

  it("a zero Impulse or AngularImpulse on an immediate child of the body does not wake it", () => {
    const scene = makeScene();
    const body = addSleepingBody(scene);

    scene.world.entity().childOf(body).set(Impulse, { x: 0, y: 0, wake: true });
    scene.world.entity().childOf(body).set(AngularImpulse, { value: 0, wake: true });

    expectStaysAsleep(scene, body);
  });

  it("two Impulses that sum to zero do not wake a sleeping body", () => {
    const scene = makeScene();
    const body = addSleepingBody(scene);

    body.set(Impulse, { x: 5, y: -2, wake: true });
    body.set(Impulse, { x: -5, y: 2, wake: true });

    expectStaysAsleep(scene, body);
  });

  it("two AngularImpulses that sum to zero do not wake a sleeping body", () => {
    const scene = makeScene();
    const body = addSleepingBody(scene);

    body.set(AngularImpulse, { value: 3, wake: true });
    body.set(AngularImpulse, { value: -3, wake: true });

    expectStaysAsleep(scene, body);
  });
});

// ─── 3. A zero impulse's wake flag does not leak ──────────────────────────────

describe("PhysicsImpulseAccumulate — a zero impulse's wake does not count", () => {
  it("a zero Impulse with wake: true does not wake the body for a wake: false Impulse", () => {
    const scene = makeScene();
    const body = addSleepingBody(scene);

    body.set(Impulse, { x: 0, y: 0, wake: true });
    body.set(Impulse, { x: 4, y: 0, wake: false });

    expectStaysAsleep(scene, body);
  });

  it("a zero AngularImpulse with wake: true does not wake the body for a wake: false one", () => {
    const scene = makeScene();
    const body = addSleepingBody(scene);

    body.set(AngularImpulse, { value: 0, wake: true });
    body.set(AngularImpulse, { value: 4, wake: false });

    expectStaysAsleep(scene, body);
  });
});

// ─── 4. Non-zero forces and torques are unchanged ─────────────────────────────

describe("PhysicsForceGather — non-zero loads keep Box2D's wake semantics", () => {
  it.each(NON_ZERO_VECTORS)("Force { x: %s, y: %s, wake: true } wakes a sleeping body", (x, y) => {
    const scene = makeScene();
    const body = addSleepingBody(scene);

    body.set(Force, { x, y, wake: true });
    scene.step();

    expect(isAwake(scene, body)).toBe(true);
  });

  it.each(NON_ZERO_VECTORS)(
    "Force { x: %s, y: %s, wake: false } leaves a sleeping body asleep",
    (x, y) => {
      const scene = makeScene();
      const body = addSleepingBody(scene);

      body.set(Force, { x, y, wake: false });

      expectStaysAsleep(scene, body);
    }
  );

  it.each(NON_ZERO_SCALARS)("Torque { value: %s, wake: true } wakes a sleeping body", (value) => {
    const scene = makeScene();
    const body = addSleepingBody(scene);

    body.set(Torque, { value, wake: true });
    scene.step();

    expect(isAwake(scene, body)).toBe(true);
  });

  it.each(NON_ZERO_SCALARS)(
    "Torque { value: %s, wake: false } leaves a sleeping body asleep",
    (value) => {
      const scene = makeScene();
      const body = addSleepingBody(scene);

      body.set(Torque, { value, wake: false });

      expectStaysAsleep(scene, body);
    }
  );

  it("a non-zero Force on a child source wakes the parent body", () => {
    const scene = makeScene();
    const body = addSleepingBody(scene);

    scene.world.entity().childOf(body).set(Force, { x: 4, y: 0, wake: true });
    scene.step();

    expect(isAwake(scene, body)).toBe(true);
  });
});

// ─── 5. Non-zero impulses are unchanged ───────────────────────────────────────

describe("PhysicsImpulseAccumulate — non-zero impulses keep Box2D's wake semantics", () => {
  it("a non-zero Impulse with wake: true wakes a sleeping body and still applies", () => {
    const scene = makeScene();
    const body = addSleepingBody(scene);

    body.set(Impulse, { x: 5, y: -2, wake: true });
    scene.step();

    expect(isAwake(scene, body)).toBe(true);
    expect(body.get(LinearVelocity)!.x).toBeCloseTo(5, 4);
    expect(body.get(LinearVelocity)!.y).toBeCloseTo(-2, 4);
  });

  it("a non-zero AngularImpulse with wake: true wakes a sleeping body and still applies", () => {
    const scene = makeScene();
    const body = addSleepingBody(scene);

    body.set(AngularImpulse, { value: 3, wake: true });
    scene.step();

    expect(isAwake(scene, body)).toBe(true);
    expect(body.get(AngularVelocity)!.value).toBeCloseTo(18, 4);
  });

  it.each(NON_ZERO_VECTORS)(
    "Impulse { x: %s, y: %s, wake: true } wakes a sleeping body",
    (x, y) => {
      const scene = makeScene();
      const body = addSleepingBody(scene);

      body.set(Impulse, { x, y, wake: true });
      scene.step();

      expect(isAwake(scene, body)).toBe(true);
    }
  );

  it.each(NON_ZERO_SCALARS)(
    "AngularImpulse { value: %s, wake: true } wakes a sleeping body",
    (value) => {
      const scene = makeScene();
      const body = addSleepingBody(scene);

      body.set(AngularImpulse, { value, wake: true });
      scene.step();

      expect(isAwake(scene, body)).toBe(true);
    }
  );

  it("impulses that only partly cancel still apply their net and wake the body", () => {
    const scene = makeScene();
    const body = addSleepingBody(scene);

    body.set(Impulse, { x: 5, y: 0, wake: true });
    body.set(Impulse, { x: -2, y: 0, wake: true });
    scene.step();

    expect(isAwake(scene, body)).toBe(true);
    expect(body.get(LinearVelocity)!.x).toBeCloseTo(3, 4);
  });

  it("impulses that cancel on one axis still apply the other axis and wake the body", () => {
    const scene = makeScene();
    const body = addSleepingBody(scene);

    body.set(Impulse, { x: 3, y: 0, wake: true });
    body.set(Impulse, { x: -3, y: 2, wake: true });
    scene.step();

    expect(isAwake(scene, body)).toBe(true);
    expect(body.get(LinearVelocity)!.x).toBeCloseTo(0, 4);
    expect(body.get(LinearVelocity)!.y).toBeCloseTo(2, 4);
  });

  it("any non-zero impulse asking to wake wakes the body, even beside a wake: false one", () => {
    const scene = makeScene();
    const body = addSleepingBody(scene);

    body.set(Impulse, { x: 4, y: 0, wake: false });
    body.set(Impulse, { x: 2, y: 0, wake: true });
    scene.step();

    expect(isAwake(scene, body)).toBe(true);
    expect(body.get(LinearVelocity)!.x).toBeCloseTo(6, 4);
  });

  it("a non-zero Impulse with wake: false leaves a sleeping body asleep", () => {
    const scene = makeScene();
    const body = addSleepingBody(scene);

    body.set(Impulse, { x: 5, y: 0, wake: false });

    expectStaysAsleep(scene, body);
  });

  it("a non-zero AngularImpulse with wake: false leaves a sleeping body asleep", () => {
    const scene = makeScene();
    const body = addSleepingBody(scene);

    body.set(AngularImpulse, { value: 3, wake: false });

    expectStaysAsleep(scene, body);
  });

  it("a non-zero Impulse applies to an awake body whatever its wake flag", () => {
    const scene = makeScene();
    const body = addBody(scene.world);
    scene.step();

    body.set(Impulse, { x: 5, y: 0, wake: false });
    scene.step();

    expect(isAwake(scene, body)).toBe(true);
    expect(body.get(LinearVelocity)!.x).toBeCloseTo(5, 4);
  });
});

// ─── 6. Sleep wakes a body or keeps it awake ──────────────────────────────────

describe("Sleep wakes a body or keeps it awake, which a zero load cannot", () => {
  it("Sleep { awake: true } wakes a body that fell asleep on its own", () => {
    const scene = makeScene();
    const body = addSleepingBody(scene);

    body.set(Sleep, { awake: true });
    scene.step();

    expect(isAwake(scene, body)).toBe(true);
  });

  it("Sleep { enabled: false } wakes a sleeping body and keeps it awake", () => {
    const scene = makeScene();
    const body = addSleepingBody(scene);

    body.set(Sleep, { enabled: false });

    for (let step = 1; step <= STAY_ASLEEP_STEPS; step++) {
      scene.step();
      expect(isAwake(scene, body), `asleep after step ${step}`).toBe(true);
    }
  });
});
