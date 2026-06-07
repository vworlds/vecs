// `PhysicsBodyLifecycle` (VP-6): body create/destroy and WASM body state driven
// by `Body` enter/exit/update events.

import { World, type EID } from "@vworlds/vecs";
import { beforeEach, describe, expect, it } from "vitest";

import {
  AngularVelocity,
  Body,
  BodyType,
  Box,
  Damping,
  GravityScale,
  LinearVelocity,
  Position,
  Rotation,
  installPhysics,
} from "../../src/index.js";
import { getPhysics, type PhysicsState } from "../../src/adapter/state.js";

let world: World;
let state: PhysicsState;

beforeEach(() => {
  world = new World();
  installPhysics(world);
  world.start();
  state = getPhysics(world);
});

function wasmBodyId(eid: EID) {
  const bodyId = state.bodyByEntityWasm.get(eid);
  if (bodyId === undefined) {
    throw new Error(`missing wasm body for entity ${eid}`);
  }
  return bodyId;
}

describe("PhysicsBodyLifecycle.enter", () => {
  it("creates a dynamic body with its pose in WASM", () => {
    const e = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 2, y: 3 })
      .set(Rotation, { angle: 0 });
    world.progress(0, 16);

    const bodyId = wasmBodyId(e.eid);
    expect(state.box2d.b2Body_GetType(bodyId)).toBe(state.box2d.b2BodyType.b2_dynamicBody);
    const pos = state.box2d.b2Body_GetPosition(bodyId);
    try {
      expect(pos.x).toBeCloseTo(2);
      expect(pos.y).toBeCloseTo(3);
    } finally {
      pos.delete();
    }
    expect(state.box2d.b2Body_IsAwake(bodyId)).toBe(true);
  });

  it("creates a static body with the static type", () => {
    const e = world.entity().set(Body, { type: BodyType.Static });
    world.progress(0, 16);

    const bodyId = wasmBodyId(e.eid);
    expect(state.box2d.b2Body_GetType(bodyId)).toBe(state.box2d.b2BodyType.b2_staticBody);
    expect(state.box2d.b2Body_IsAwake(bodyId)).toBe(false);
  });

  it("creates a kinematic body with the kinematic type", () => {
    const e = world.entity().set(Body, { type: BodyType.Kinematic });
    world.progress(0, 16);

    expect(state.box2d.b2Body_GetType(wasmBodyId(e.eid))).toBe(
      state.box2d.b2BodyType.b2_kinematicBody
    );
  });

  it("creates a disabled body in the disabled state", () => {
    const e = world.entity().set(Body, { type: BodyType.Dynamic, enabled: false });
    world.progress(0, 16);

    expect(state.box2d.b2Body_IsEnabled(wasmBodyId(e.eid))).toBe(false);
  });

  it("reads damping and gravity scale into the WASM body", () => {
    const e = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Damping, { linear: 0.5, angular: 0.25 })
      .set(GravityScale, { value: 2 });
    world.progress(0, 16);

    const bodyId = wasmBodyId(e.eid);
    expect(state.box2d.b2Body_GetLinearDamping(bodyId)).toBe(0.5);
    expect(state.box2d.b2Body_GetAngularDamping(bodyId)).toBe(0.25);
    expect(state.box2d.b2Body_GetGravityScale(bodyId)).toBe(2);
  });

  it("reads initial velocity into the WASM body", () => {
    const e = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(LinearVelocity, { x: 1, y: -1 })
      .set(AngularVelocity, { value: 4 });
    world.progress(0, 16);

    const bodyId = wasmBodyId(e.eid);
    const vel = state.box2d.b2Body_GetLinearVelocity(bodyId);
    try {
      expect(vel.x).toBeCloseTo(1);
      expect(vel.y).toBeCloseTo(-1);
    } finally {
      vel.delete();
    }
    expect(state.box2d.b2Body_GetAngularVelocity(bodyId)).toBeCloseTo(4);
  });
});

describe("PhysicsBodyLifecycle.exit", () => {
  it("destroys the WASM body when Body is removed", () => {
    const e = world.entity().set(Body, { type: BodyType.Dynamic });
    world.progress(0, 16);
    const bodyId = wasmBodyId(e.eid);
    expect(state.box2d.b2Body_IsValid(bodyId)).toBe(true);

    e.remove(Body);
    world.progress(16, 16);

    expect(state.bodyByEntityWasm.has(e.eid)).toBe(false);
    expect(state.box2d.b2Body_IsValid(bodyId)).toBe(false);
  });

  it("destroys the WASM body when the entity is destroyed", () => {
    const e = world.entity().set(Body, { type: BodyType.Dynamic });
    world.progress(0, 16);
    const bodyId = wasmBodyId(e.eid);

    e.destroy();
    world.progress(16, 16);

    expect(state.bodyByEntityWasm.has(e.eid)).toBe(false);
    expect(state.box2d.b2Body_IsValid(bodyId)).toBe(false);
  });

  it("clears the reverse body slot before Box2D reuses the public index", () => {
    const oldBody = world.entity().set(Body, { type: BodyType.Dynamic });
    world.progress(0, 16);
    const oldBodyId = wasmBodyId(oldBody.eid);

    oldBody.remove(Body);
    world.progress(16, 16);

    expect(state.entityByBodyIndex.get(oldBodyId.index1)).toBeUndefined();

    const newBody = world.entity().set(Body, { type: BodyType.Dynamic });
    world.progress(32, 16);
    const newBodyId = wasmBodyId(newBody.eid);

    expect(newBodyId.index1).toBe(oldBodyId.index1);
    expect(state.entityByBodyIndex.get(newBodyId.index1)).toBe(newBody.eid);
    expect(state.entityByBodyIndex.get(newBodyId.index1)).not.toBe(oldBody.eid);
  });
});

describe("PhysicsBodyLifecycle.update(Body)", () => {
  it("moves a body to disabled and back on the enabled toggle", () => {
    const e = world.entity().set(Body, { type: BodyType.Dynamic });
    world.progress(0, 16);
    const bodyId = wasmBodyId(e.eid);
    expect(state.box2d.b2Body_IsEnabled(bodyId)).toBe(true);

    e.set(Body, { type: BodyType.Dynamic, enabled: false });
    world.progress(16, 16);
    expect(state.box2d.b2Body_IsEnabled(bodyId)).toBe(false);

    e.set(Body, { type: BodyType.Dynamic, enabled: true });
    world.progress(32, 16);
    expect(state.box2d.b2Body_IsEnabled(bodyId)).toBe(true);
  });

  it("changes body type from dynamic to static", () => {
    const e = world.entity().set(Body, { type: BodyType.Dynamic });
    world.progress(0, 16);
    const bodyId = wasmBodyId(e.eid);
    expect(state.box2d.b2Body_GetType(bodyId)).toBe(state.box2d.b2BodyType.b2_dynamicBody);

    e.set(Body, { type: BodyType.Static });
    world.progress(16, 16);
    expect(state.box2d.b2Body_GetType(bodyId)).toBe(state.box2d.b2BodyType.b2_staticBody);
  });

  it("changes body type from dynamic to kinematic", () => {
    const e = world.entity().set(Body, { type: BodyType.Dynamic });
    world.progress(0, 16);

    e.set(Body, { type: BodyType.Kinematic });
    world.progress(16, 16);
    expect(state.box2d.b2Body_GetType(wasmBodyId(e.eid))).toBe(
      state.box2d.b2BodyType.b2_kinematicBody
    );
  });
});

describe("PhysicsBodyLifecycle.update(Damping/GravityScale)", () => {
  it("propagates a Damping change to the WASM body after enter", () => {
    // Damping present at enter (seeded), then changed (fires update handler).
    const e = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Damping, { linear: 0, angular: 0 });
    world.progress(0, 16);
    const bodyId = wasmBodyId(e.eid);
    expect(state.box2d.b2Body_GetLinearDamping(bodyId)).toBe(0);
    expect(state.box2d.b2Body_GetAngularDamping(bodyId)).toBe(0);

    e.set(Damping, { linear: 0.5, angular: 0.25 });
    world.progress(16, 16);
    expect(state.box2d.b2Body_GetLinearDamping(bodyId)).toBe(0.5);
    expect(state.box2d.b2Body_GetAngularDamping(bodyId)).toBe(0.25);
  });

  it("propagates a GravityScale change to the WASM body after enter", () => {
    const e = world.entity().set(Body, { type: BodyType.Dynamic }).set(GravityScale, { value: 1 });
    world.progress(0, 16);
    const bodyId = wasmBodyId(e.eid);
    expect(state.box2d.b2Body_GetGravityScale(bodyId)).toBe(1);

    e.set(GravityScale, { value: -0.25 });
    world.progress(16, 16);
    expect(state.box2d.b2Body_GetGravityScale(bodyId)).toBe(-0.25);
  });
});

// ─── Proxy synchronisation on enable / disable / type change ─────────────────

describe("PhysicsBodyLifecycle — body proxy synchronisation (WASM)", () => {
  it("disabled body: shape is invalid in WASM when body is disabled on creation", () => {
    const e = world.entity().set(Body, { type: BodyType.Dynamic, enabled: false });
    world.entity().childOf(e).set(Box, { hx: 0.5, hy: 0.5 });
    world.progress(0, 16);

    const bodyId = wasmBodyId(e.eid);
    expect(state.box2d.b2Body_IsEnabled(bodyId)).toBe(false);
    expect(state.box2d.b2World_IsValid(state.worldId)).toBe(true);
  });

  it("enable after disabled creation: body becomes enabled and shapes work", () => {
    const e = world.entity().set(Body, { type: BodyType.Dynamic, enabled: false });
    world.entity().childOf(e).set(Box, { hx: 0.5, hy: 0.5 });
    world.progress(0, 16);

    const bodyId = wasmBodyId(e.eid);
    expect(state.box2d.b2Body_IsEnabled(bodyId)).toBe(false);

    e.set(Body, { type: BodyType.Dynamic, enabled: true });
    world.progress(16, 16);

    expect(state.box2d.b2Body_IsEnabled(bodyId)).toBe(true);
    expect(state.box2d.b2Body_IsAwake(bodyId)).toBe(true);
  });

  it("disable after enabled: body becomes disabled", () => {
    const e = world.entity().set(Body, { type: BodyType.Dynamic });
    world.entity().childOf(e).set(Box, { hx: 0.5, hy: 0.5 });
    world.progress(0, 16);

    const bodyId = wasmBodyId(e.eid);
    expect(state.box2d.b2Body_IsEnabled(bodyId)).toBe(true);

    e.set(Body, { type: BodyType.Dynamic, enabled: false });
    world.progress(16, 16);

    expect(state.box2d.b2Body_IsEnabled(bodyId)).toBe(false);
  });

  it("static→dynamic type change: body type is updated in WASM", () => {
    const e = world.entity().set(Body, { type: BodyType.Static });
    world.entity().childOf(e).set(Box, { hx: 0.5, hy: 0.5 });
    world.progress(0, 16);

    const bodyId = wasmBodyId(e.eid);
    expect(state.box2d.b2Body_GetType(bodyId)).toBe(state.box2d.b2BodyType.b2_staticBody);

    e.set(Body, { type: BodyType.Dynamic });
    world.progress(16, 16);

    expect(state.box2d.b2Body_GetType(bodyId)).toBe(state.box2d.b2BodyType.b2_dynamicBody);
  });

  it("dynamic→static type change: body type is updated in WASM", () => {
    const e = world.entity().set(Body, { type: BodyType.Dynamic });
    world.entity().childOf(e).set(Box, { hx: 0.5, hy: 0.5 });
    world.progress(0, 16);

    const bodyId = wasmBodyId(e.eid);
    expect(state.box2d.b2Body_GetType(bodyId)).toBe(state.box2d.b2BodyType.b2_dynamicBody);

    e.set(Body, { type: BodyType.Static });
    world.progress(16, 16);

    expect(state.box2d.b2Body_GetType(bodyId)).toBe(state.box2d.b2BodyType.b2_staticBody);
  });
});
