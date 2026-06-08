// Body type/enable bookkeeping regression tests.
//
// Verifies that runtime type and enabled changes correctly update the WASM body:
//   - Body type is reflected via b2Body_GetType
//   - Enabled state is reflected via b2Body_IsEnabled
//   - Mass recomputes correctly after type change (via b2Body_GetMass)
//   - Awake/sleep state is maintained across type changes

import { World, type EID } from "@vworlds/vecs";
import { beforeEach, describe, expect, it } from "vitest";

import { Body, BodyType, Box, Circle, Position, Sleep, PhysicsModule } from "../../src/index.js";
import { getPhysics, type PhysicsState } from "../../src/adapter/state.js";

const STEP_MS = 1000 / 60;

let world: World;
let state: PhysicsState;
let now: number;

beforeEach(() => {
  world = new World();
  world.module(PhysicsModule, { gravity: { x: 0, y: -10 } });
  state = getPhysics(world) as PhysicsState;
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

// ─── Body type synchronisation ────────────────────────────────────────────────

describe("WASM body type on type change", () => {
  it("static→dynamic: b2Body_GetType returns dynamic", () => {
    const e = world.entity().set(Body, { type: BodyType.Static });
    step();

    expect(state.box2d.b2Body_GetType(wasmBodyId(e.eid))).toBe(
      state.box2d.b2BodyType.b2_staticBody
    );

    e.set(Body, { type: BodyType.Dynamic });
    step();

    expect(state.box2d.b2Body_GetType(wasmBodyId(e.eid))).toBe(
      state.box2d.b2BodyType.b2_dynamicBody
    );
  });

  it("dynamic→static: b2Body_GetType returns static", () => {
    const e = world.entity().set(Body, { type: BodyType.Dynamic });
    step();

    expect(state.box2d.b2Body_GetType(wasmBodyId(e.eid))).toBe(
      state.box2d.b2BodyType.b2_dynamicBody
    );

    e.set(Body, { type: BodyType.Static });
    step();

    expect(state.box2d.b2Body_GetType(wasmBodyId(e.eid))).toBe(
      state.box2d.b2BodyType.b2_staticBody
    );
  });

  it("dynamic→kinematic: b2Body_GetType returns kinematic", () => {
    const e = world.entity().set(Body, { type: BodyType.Dynamic });
    step();

    e.set(Body, { type: BodyType.Kinematic });
    step();

    expect(state.box2d.b2Body_GetType(wasmBodyId(e.eid))).toBe(
      state.box2d.b2BodyType.b2_kinematicBody
    );
  });

  it("type change on disabled body does not crash", () => {
    const e = world.entity().set(Body, { type: BodyType.Static, enabled: false });
    step();

    expect(state.box2d.b2Body_IsEnabled(wasmBodyId(e.eid))).toBe(false);

    e.set(Body, { type: BodyType.Dynamic, enabled: false });
    expect(() => step()).not.toThrow();

    expect(state.box2d.b2Body_IsEnabled(wasmBodyId(e.eid))).toBe(false);
    expect(state.box2d.b2Body_GetType(wasmBodyId(e.eid))).toBe(
      state.box2d.b2BodyType.b2_dynamicBody
    );
  });
});

// ─── Mass recompute on type change ────────────────────────────────────────────

describe("mass recompute on type change", () => {
  it("static→dynamic: mass becomes non-zero from shapes", () => {
    const e = world.entity().set(Body, { type: BodyType.Static }).set(Position, { x: 0, y: 5 });
    world.entity().childOf(e).set(Box, { hx: 1, hy: 1 });

    step(); // static: mass is 0

    expect(state.box2d.b2Body_GetMass(wasmBodyId(e.eid))).toBe(0);

    // Change to dynamic. Mass recompute should trigger.
    e.set(Body, { type: BodyType.Dynamic });
    step();

    expect(state.box2d.b2Body_GetMass(wasmBodyId(e.eid))).toBeGreaterThan(0);
  });

  it("dynamic→static: mass becomes 0 (static infinite mass)", () => {
    const e = world.entity().set(Body, { type: BodyType.Dynamic }).set(Position, { x: 0, y: 5 });
    world.entity().childOf(e).set(Circle, { radius: 1 });

    step();

    expect(state.box2d.b2Body_GetMass(wasmBodyId(e.eid))).toBeGreaterThan(0);

    e.set(Body, { type: BodyType.Static });
    step();

    // Box2D: static bodies have mass 0.
    expect(state.box2d.b2Body_GetMass(wasmBodyId(e.eid))).toBe(0);
  });
});

// ─── Island membership (verified via WASM awake state) ───────────────────────

describe("WASM enabled/awake state on type/enable transitions", () => {
  it("static body is not awake by default", () => {
    const e = world.entity().set(Body, { type: BodyType.Static });
    step();

    // Static bodies are not awake in Box2D.
    expect(state.box2d.b2Body_IsAwake(wasmBodyId(e.eid))).toBe(false);
  });

  it("dynamic body is awake by default", () => {
    const e = world.entity().set(Body, { type: BodyType.Dynamic });
    step();

    expect(state.box2d.b2Body_IsAwake(wasmBodyId(e.eid))).toBe(true);
  });

  it("disabling a dynamic body: b2Body_IsEnabled returns false", () => {
    const e = world.entity().set(Body, { type: BodyType.Dynamic });
    step();

    e.set(Body, { type: BodyType.Dynamic, enabled: false });
    step();

    expect(state.box2d.b2Body_IsEnabled(wasmBodyId(e.eid))).toBe(false);
  });

  it("enabling a disabled body: b2Body_IsEnabled returns true", () => {
    const e = world.entity().set(Body, { type: BodyType.Dynamic, enabled: false });
    step();

    expect(state.box2d.b2Body_IsEnabled(wasmBodyId(e.eid))).toBe(false);

    e.set(Body, { type: BodyType.Dynamic, enabled: true });
    step();

    expect(state.box2d.b2Body_IsEnabled(wasmBodyId(e.eid))).toBe(true);
    expect(state.box2d.b2Body_IsAwake(wasmBodyId(e.eid))).toBe(true);
  });

  it("enabling a static disabled body stays not awake", () => {
    const e = world.entity().set(Body, { type: BodyType.Static, enabled: false });
    step();

    e.set(Body, { type: BodyType.Static, enabled: true });
    step();

    expect(state.box2d.b2Body_IsEnabled(wasmBodyId(e.eid))).toBe(true);
    expect(state.box2d.b2Body_IsAwake(wasmBodyId(e.eid))).toBe(false);
  });
});

// ─── Contact teardown on type/disable ─────────────────────────────────────────

describe("contact teardown on body type/disable changes", () => {
  function makeGround() {
    const g = world.entity().set(Body, { type: BodyType.Static }).set(Position, { x: 0, y: -10 });
    world.entity().childOf(g).set(Box, { hx: 50, hy: 10 });
  }

  it("disabling a shaped body updates the WASM body without crashing", () => {
    makeGround();
    const body = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0.5 });
    world.entity().childOf(body).set(Box, { hx: 1, hy: 1 });

    step(5); // create contacts

    // Disable — Box2D owns contact teardown internally after M7.
    body.set(Body, { type: BodyType.Dynamic, enabled: false });
    expect(() => step()).not.toThrow();
    const bodyId = state.bodyByEntityWasm.get(body.eid)!;
    expect(state.box2d.b2Body_IsEnabled(bodyId)).toBe(false);
  });

  it("changing body type on a shaped body updates the WASM body without crashing", () => {
    makeGround();
    const body = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0.5 });
    world.entity().childOf(body).set(Box, { hx: 1, hy: 1 });

    step(5);

    body.set(Body, { type: BodyType.Static });
    expect(() => step()).not.toThrow();
    const bodyId = state.bodyByEntityWasm.get(body.eid)!;
    expect(state.box2d.b2Body_GetType(bodyId)).toBe(state.box2d.b2BodyType.b2_staticBody);
  });
});

// ─── WASM sleep/type bookkeeping ───────────────────────────────────────────────

describe("WASM awake bookkeeping on type/enable transitions", () => {
  it("disabled bodies do not wake on input", () => {
    const e = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0 })
      .set(Sleep, { enabled: true, awake: false, threshold: 0.05 });

    step();
    expect(state.box2d.b2Body_IsAwake(wasmBodyId(e.eid))).toBe(false);

    e.set(Body, { type: BodyType.Dynamic, enabled: false });
    step();
    expect(state.box2d.b2Body_IsEnabled(wasmBodyId(e.eid))).toBe(false);

    e.set(Position, { x: 1, y: 0 });
    step();

    expect(state.box2d.b2Body_IsEnabled(wasmBodyId(e.eid))).toBe(false);
    expect(state.box2d.b2Body_IsAwake(wasmBodyId(e.eid))).toBe(false);
  });

  it("type swaps preserve the body awake state", () => {
    const e = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0 })
      .set(Sleep, { enabled: true, awake: false, threshold: 0.05 });

    step();
    expect(state.box2d.b2Body_IsAwake(wasmBodyId(e.eid))).toBe(false);

    e.set(Body, { type: BodyType.Static });
    step();

    expect(state.box2d.b2Body_GetType(wasmBodyId(e.eid))).toBe(
      state.box2d.b2BodyType.b2_staticBody
    );
    expect(state.box2d.b2Body_IsAwake(wasmBodyId(e.eid))).toBe(false);
  });
});
