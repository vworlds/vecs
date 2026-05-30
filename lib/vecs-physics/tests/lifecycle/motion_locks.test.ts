// M3-motion-locks-not-wired regression tests.
//
// Verifies that MotionLocks and Body.allowFastRotation are correctly
// propagated into engine flags and honored by the integrator.

import { ChildOf, World } from "@vworlds/vecs";
import { beforeEach, describe, expect, it } from "vitest";

import {
  AngularVelocity,
  Body,
  BodyType,
  Box,
  LinearVelocity,
  MotionLocks,
  Position,
  installPhysics,
} from "../../src/index.js";
import {
  ALLOW_FAST_ROTATION,
  LOCK_ANGULAR_Z,
  LOCK_LINEAR_X,
  LOCK_LINEAR_Y,
} from "../../src/engine/body.js";
import { AWAKE_SET } from "../../src/engine/solver_set.js";
import { getPhysics, type PhysicsState } from "../../src/engine/state.js";

const STEP_MS = 1000 / 60;

let world: World;
let state: PhysicsState;
let now: number;

beforeEach(() => {
  world = new World();
  installPhysics(world, { gravity: { x: 0, y: -10 } });
  world.start();
  state = getPhysics(world);
  now = 0;
});

function step(n = 1): void {
  for (let i = 0; i < n; i++) {
    now += STEP_MS;
    world.progress(now, STEP_MS);
  }
}

// ─── Flag seeding on enter ─────────────────────────────────────────────────────

describe("MotionLocks flag seeding on enter", () => {
  it("sets LOCK_LINEAR_X on sim.flags and bodyState.flags when x=true", () => {
    const e = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(MotionLocks, { x: true, y: false, rotation: false });
    step();

    const handle = state.bodyByEntity.get(e.eid)!;
    const record = state.bodies.get(handle.index);
    const sim = state.solverSets[AWAKE_SET]!.bodySims[record.localIndex]!;
    const st = state.solverSets[AWAKE_SET]!.bodyStates[record.localIndex]!;
    expect(sim.flags & LOCK_LINEAR_X).toBe(LOCK_LINEAR_X);
    expect(st.flags & LOCK_LINEAR_X).toBe(LOCK_LINEAR_X);
  });

  it("sets LOCK_LINEAR_Y on sim.flags and bodyState.flags when y=true", () => {
    const e = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(MotionLocks, { x: false, y: true, rotation: false });
    step();

    const handle = state.bodyByEntity.get(e.eid)!;
    const record = state.bodies.get(handle.index);
    const sim = state.solverSets[AWAKE_SET]!.bodySims[record.localIndex]!;
    const st = state.solverSets[AWAKE_SET]!.bodyStates[record.localIndex]!;
    expect(sim.flags & LOCK_LINEAR_Y).toBe(LOCK_LINEAR_Y);
    expect(st.flags & LOCK_LINEAR_Y).toBe(LOCK_LINEAR_Y);
  });

  it("sets LOCK_ANGULAR_Z on sim.flags and bodyState.flags when rotation=true", () => {
    const e = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(MotionLocks, { x: false, y: false, rotation: true });
    step();

    const handle = state.bodyByEntity.get(e.eid)!;
    const record = state.bodies.get(handle.index);
    const sim = state.solverSets[AWAKE_SET]!.bodySims[record.localIndex]!;
    const st = state.solverSets[AWAKE_SET]!.bodyStates[record.localIndex]!;
    expect(sim.flags & LOCK_ANGULAR_Z).toBe(LOCK_ANGULAR_Z);
    expect(st.flags & LOCK_ANGULAR_Z).toBe(LOCK_ANGULAR_Z);
  });

  it("sets ALLOW_FAST_ROTATION on sim.flags when Body.allowFastRotation=true", () => {
    const e = world.entity().set(Body, { type: BodyType.Dynamic, allowFastRotation: true });
    step();

    const handle = state.bodyByEntity.get(e.eid)!;
    const record = state.bodies.get(handle.index);
    const sim = state.solverSets[AWAKE_SET]!.bodySims[record.localIndex]!;
    const st = state.solverSets[AWAKE_SET]!.bodyStates[record.localIndex]!;
    expect(sim.flags & ALLOW_FAST_ROTATION).toBe(ALLOW_FAST_ROTATION);
    expect(st.flags & ALLOW_FAST_ROTATION).toBe(ALLOW_FAST_ROTATION);
  });

  it("does not set lock flags when MotionLocks is absent", () => {
    const e = world.entity().set(Body, { type: BodyType.Dynamic });
    step();

    const handle = state.bodyByEntity.get(e.eid)!;
    const record = state.bodies.get(handle.index);
    const sim = state.solverSets[AWAKE_SET]!.bodySims[record.localIndex]!;
    expect(sim.flags & (LOCK_LINEAR_X | LOCK_LINEAR_Y | LOCK_ANGULAR_Z)).toBe(0);
  });
});

// ─── Integrator honours lock flags ────────────────────────────────────────────

describe("integrator honours MotionLocks", () => {
  it("y-lock: body does not move in Y despite gravity", () => {
    const e = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 5 })
      .set(LinearVelocity, { x: 0, y: 0 })
      .set(MotionLocks, { x: false, y: true, rotation: false });
    world.entity().set(ChildOf, { target: e }).set(Box, { width: 2, height: 2 });

    step(10);

    const v = e.get(LinearVelocity)!;
    // With y locked, vy must remain 0 despite gravity.
    expect(v.y).toBeCloseTo(0, 3);
    const p = e.get(Position)!;
    expect(p.y).toBeCloseTo(5, 1); // position unchanged
  });

  it("x-lock: body does not move in X even under a horizontal force", () => {
    const e = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 5 })
      .set(LinearVelocity, { x: 5, y: 0 }) // initial horizontal velocity
      .set(MotionLocks, { x: true, y: false, rotation: false });
    world.entity().set(ChildOf, { target: e }).set(Box, { width: 2, height: 2 });

    step(10);

    const v = e.get(LinearVelocity)!;
    // x is locked — velocity in x must be 0.
    expect(v.x).toBeCloseTo(0, 3);
  });

  it("rotation-lock: angular velocity stays 0", () => {
    const e = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 5 })
      .set(AngularVelocity, { value: 5 }) // initial angular velocity
      .set(MotionLocks, { x: false, y: false, rotation: true });
    world.entity().set(ChildOf, { target: e }).set(Box, { width: 2, height: 2 });

    step(10);

    const v = e.get(AngularVelocity)!;
    // rotation is locked — omega must be 0.
    expect(v.value).toBeCloseTo(0, 3);
  });
});

// ─── MotionLocks update ────────────────────────────────────────────────────────

describe("MotionLocks update handler", () => {
  it("updating MotionLocks after enter sets the flags (second set fires update)", () => {
    // When MotionLocks is present at creation, enter reads it.
    // Then updating it fires update(MotionLocks) which syncs the new bits.
    const e = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(MotionLocks, { x: false, y: false, rotation: false }); // present at enter
    step();

    const handle = state.bodyByEntity.get(e.eid)!;
    const record = state.bodies.get(handle.index);
    const sim = state.solverSets[AWAKE_SET]!.bodySims[record.localIndex]!;
    expect(sim.flags & LOCK_LINEAR_Y).toBe(0); // not locked yet

    // Modify MotionLocks (second set = update → fires update handler).
    e.set(MotionLocks, { x: false, y: true, rotation: false });
    step();

    expect(sim.flags & LOCK_LINEAR_Y).toBe(LOCK_LINEAR_Y);
    const st = state.solverSets[AWAKE_SET]!.bodyStates[record.localIndex]!;
    expect(st.flags & LOCK_LINEAR_Y).toBe(LOCK_LINEAR_Y);
  });

  it("updating MotionLocks to unlock an axis clears the flag", () => {
    const e = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(MotionLocks, { x: true, y: true, rotation: true });
    step();

    const handle = state.bodyByEntity.get(e.eid)!;
    const record = state.bodies.get(handle.index);
    const sim = state.solverSets[AWAKE_SET]!.bodySims[record.localIndex]!;
    expect(sim.flags & LOCK_LINEAR_X).toBe(LOCK_LINEAR_X);

    e.set(MotionLocks, { x: false, y: false, rotation: false });
    step();

    expect(sim.flags & (LOCK_LINEAR_X | LOCK_LINEAR_Y | LOCK_ANGULAR_Z)).toBe(0);
    const st = state.solverSets[AWAKE_SET]!.bodyStates[record.localIndex]!;
    expect(st.flags & (LOCK_LINEAR_X | LOCK_LINEAR_Y | LOCK_ANGULAR_Z)).toBe(0);
  });
});

// ─── allowFastRotation update ─────────────────────────────────────────────────

describe("Body.allowFastRotation update", () => {
  it("setting allowFastRotation=true on Body update sets the flag", () => {
    const e = world.entity().set(Body, { type: BodyType.Dynamic, allowFastRotation: false });
    step();

    const handle = state.bodyByEntity.get(e.eid)!;
    const record = state.bodies.get(handle.index);
    const sim = state.solverSets[AWAKE_SET]!.bodySims[record.localIndex]!;
    expect(sim.flags & ALLOW_FAST_ROTATION).toBe(0);

    e.set(Body, { type: BodyType.Dynamic, allowFastRotation: true });
    step();

    expect(sim.flags & ALLOW_FAST_ROTATION).toBe(ALLOW_FAST_ROTATION);
    const st = state.solverSets[AWAKE_SET]!.bodyStates[record.localIndex]!;
    expect(st.flags & ALLOW_FAST_ROTATION).toBe(ALLOW_FAST_ROTATION);
  });
});
