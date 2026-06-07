// M3-motion-locks-not-wired regression tests.
//
// Verifies that MotionLocks and Body.allowFastRotation are correctly
// propagated into the WASM body and honored by the integrator.

import { World, type EID } from "@vworlds/vecs";
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
import { getPhysics, type PhysicsState } from "../../src/adapter/state.js";

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

function wasmBodyId(eid: EID) {
  const bodyId = state.bodyByEntityWasm.get(eid);
  if (bodyId === undefined) {
    throw new Error(`missing wasm body for entity ${eid}`);
  }
  return bodyId;
}

// ─── Flag seeding on enter ─────────────────────────────────────────────────────

describe("MotionLocks flag seeding on enter", () => {
  it("WASM body has linearX lock when x=true", () => {
    const e = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(MotionLocks, { x: true, y: false, rotation: false });
    step();

    const locks = state.box2d.b2Body_GetMotionLocks(wasmBodyId(e.eid));
    try {
      expect(locks.linearX).toBe(true);
      expect(locks.linearY).toBe(false);
      expect(locks.angularZ).toBe(false);
    } finally {
      locks.delete();
    }
  });

  it("WASM body has linearY lock when y=true", () => {
    const e = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(MotionLocks, { x: false, y: true, rotation: false });
    step();

    const locks = state.box2d.b2Body_GetMotionLocks(wasmBodyId(e.eid));
    try {
      expect(locks.linearY).toBe(true);
    } finally {
      locks.delete();
    }
  });

  it("WASM body has angularZ lock when rotation=true", () => {
    const e = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(MotionLocks, { x: false, y: false, rotation: true });
    step();

    const locks = state.box2d.b2Body_GetMotionLocks(wasmBodyId(e.eid));
    try {
      expect(locks.angularZ).toBe(true);
    } finally {
      locks.delete();
    }
  });

  it("does not set lock flags when MotionLocks is absent", () => {
    const e = world.entity().set(Body, { type: BodyType.Dynamic });
    step();

    const locks = state.box2d.b2Body_GetMotionLocks(wasmBodyId(e.eid));
    try {
      expect(locks.linearX).toBe(false);
      expect(locks.linearY).toBe(false);
      expect(locks.angularZ).toBe(false);
    } finally {
      locks.delete();
    }
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
    world.entity().childOf(e).set(Box, { hx: 1, hy: 1 });

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
    world.entity().childOf(e).set(Box, { hx: 1, hy: 1 });

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
    world.entity().childOf(e).set(Box, { hx: 1, hy: 1 });

    step(10);

    const v = e.get(AngularVelocity)!;
    // rotation is locked — omega must be 0.
    expect(v.value).toBeCloseTo(0, 3);
  });
});

// ─── MotionLocks update ────────────────────────────────────────────────────────

describe("MotionLocks update handler", () => {
  it("updating MotionLocks after enter sets the WASM lock flags", () => {
    const e = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(MotionLocks, { x: false, y: false, rotation: false }); // present at enter
    step();

    const bodyId = wasmBodyId(e.eid);
    const locksBefore = state.box2d.b2Body_GetMotionLocks(bodyId);
    try {
      expect(locksBefore.linearY).toBe(false);
    } finally {
      locksBefore.delete();
    }

    // Modify MotionLocks (second set = update → fires update handler).
    e.set(MotionLocks, { x: false, y: true, rotation: false });
    step();

    const locksAfter = state.box2d.b2Body_GetMotionLocks(bodyId);
    try {
      expect(locksAfter.linearY).toBe(true);
    } finally {
      locksAfter.delete();
    }
  });

  it("updating MotionLocks to unlock an axis clears the WASM flag", () => {
    const e = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(MotionLocks, { x: true, y: true, rotation: true });
    step();

    const bodyId = wasmBodyId(e.eid);
    const locksBefore = state.box2d.b2Body_GetMotionLocks(bodyId);
    try {
      expect(locksBefore.linearX).toBe(true);
    } finally {
      locksBefore.delete();
    }

    e.set(MotionLocks, { x: false, y: false, rotation: false });
    step();

    const locksAfter = state.box2d.b2Body_GetMotionLocks(bodyId);
    try {
      expect(locksAfter.linearX).toBe(false);
      expect(locksAfter.linearY).toBe(false);
      expect(locksAfter.angularZ).toBe(false);
    } finally {
      locksAfter.delete();
    }
  });
});

// ─── allowFastRotation ────────────────────────────────────────────────────────

describe("Body.allowFastRotation", () => {
  it("allowFastRotation can be toggled on a body", () => {
    // Note: b2Body_SetAllowFastRotation is not exposed in box2d3-wasm@5.2.0.
    // We verify the world does not crash when allowFastRotation is set in Body.
    const e = world.entity().set(Body, { type: BodyType.Dynamic, allowFastRotation: false });
    step();

    expect(state.box2d.b2Body_IsValid(wasmBodyId(e.eid))).toBe(true);

    e.set(Body, { type: BodyType.Dynamic, allowFastRotation: true });
    expect(() => step()).not.toThrow();
  });
});
