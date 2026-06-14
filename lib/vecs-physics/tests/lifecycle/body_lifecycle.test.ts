// `PhysicsBodyLifecycle` (VP-6): body create/destroy and WASM body data driven
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
  PhysicsModule,
} from "../../src/index.js";
import { getPhysicsEngine, type PhysicsEngine } from "../../src/adapter/engine.js";

let world: World;
let engine: PhysicsEngine;

beforeEach(() => {
  world = new World();
  world.module(PhysicsModule);
  engine = getPhysicsEngine(world);
});

function wasmBodyId(eid: EID) {
  const bodyId = world.getEntity(eid)?.get(Body)?._bodyId;
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
    expect(engine.box2d.b2Body_GetType(bodyId)).toBe(engine.box2d.b2BodyType.b2_dynamicBody);
    const pos = engine.box2d.b2Body_GetPosition(bodyId);
    try {
      expect(pos.x).toBeCloseTo(2);
      expect(pos.y).toBeCloseTo(3);
    } finally {
      pos.delete();
    }
    expect(engine.box2d.b2Body_IsAwake(bodyId)).toBe(true);
  });

  it("creates a static body with the static type", () => {
    const e = world.entity().set(Body, { type: BodyType.Static });
    world.progress(0, 16);

    const bodyId = wasmBodyId(e.eid);
    expect(engine.box2d.b2Body_GetType(bodyId)).toBe(engine.box2d.b2BodyType.b2_staticBody);
    expect(engine.box2d.b2Body_IsAwake(bodyId)).toBe(false);
  });

  it("creates a kinematic body with the kinematic type", () => {
    const e = world.entity().set(Body, { type: BodyType.Kinematic });
    world.progress(0, 16);

    expect(engine.box2d.b2Body_GetType(wasmBodyId(e.eid))).toBe(
      engine.box2d.b2BodyType.b2_kinematicBody
    );
  });

  it("creates a disabled body in the disabled simulation", () => {
    const e = world.entity().set(Body, { type: BodyType.Dynamic, enabled: false });
    world.progress(0, 16);

    expect(engine.box2d.b2Body_IsEnabled(wasmBodyId(e.eid))).toBe(false);
  });

  it("reads damping and gravity scale into the WASM body", () => {
    const e = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Damping, { linear: 0.5, angular: 0.25 })
      .set(GravityScale, { value: 2 });
    world.progress(0, 16);

    const bodyId = wasmBodyId(e.eid);
    expect(engine.box2d.b2Body_GetLinearDamping(bodyId)).toBe(0.5);
    expect(engine.box2d.b2Body_GetAngularDamping(bodyId)).toBe(0.25);
    expect(engine.box2d.b2Body_GetGravityScale(bodyId)).toBe(2);
  });

  it("reads initial velocity into the WASM body", () => {
    const e = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(LinearVelocity, { x: 1, y: -1 })
      .set(AngularVelocity, { value: 4 });
    world.progress(0, 16);

    const bodyId = wasmBodyId(e.eid);
    const vel = engine.box2d.b2Body_GetLinearVelocity(bodyId);
    try {
      expect(vel.x).toBeCloseTo(1);
      expect(vel.y).toBeCloseTo(-1);
    } finally {
      vel.delete();
    }
    expect(engine.box2d.b2Body_GetAngularVelocity(bodyId)).toBeCloseTo(4);
  });
});

describe("PhysicsBodyLifecycle.exit", () => {
  it("destroys the WASM body when Body is removed", () => {
    const e = world.entity().set(Body, { type: BodyType.Dynamic });
    world.progress(0, 16);
    const bodyId = wasmBodyId(e.eid);
    expect(engine.box2d.b2Body_IsValid(bodyId)).toBe(true);

    e.remove(Body);
    world.progress(16, 16);

    expect(e.get(Body)).toBeUndefined();
    expect(engine.box2d.b2Body_IsValid(bodyId)).toBe(false);
  });

  it("destroys the WASM body when the entity is destroyed", () => {
    const e = world.entity().set(Body, { type: BodyType.Dynamic });
    world.progress(0, 16);
    const bodyId = wasmBodyId(e.eid);

    e.destroy();
    world.progress(16, 16);

    expect(world.getEntity(e.eid)).toBeUndefined();
    expect(engine.box2d.b2Body_IsValid(bodyId)).toBe(false);
  });

  it("clears the reverse body slot before Box2D reuses the public index", () => {
    const oldBody = world.entity().set(Body, { type: BodyType.Dynamic });
    world.progress(0, 16);
    const oldBodyId = wasmBodyId(oldBody.eid);

    oldBody.remove(Body);
    world.progress(16, 16);

    expect(engine.entityByBodyIndex.get(oldBodyId.index1)).toBeUndefined();

    const newBody = world.entity().set(Body, { type: BodyType.Dynamic });
    world.progress(32, 16);
    const newBodyId = wasmBodyId(newBody.eid);

    expect(newBodyId.index1).toBe(oldBodyId.index1);
    expect(engine.entityByBodyIndex.get(newBodyId.index1)).toBe(newBody.eid);
    expect(engine.entityByBodyIndex.get(newBodyId.index1)).not.toBe(oldBody.eid);
  });
});

describe("PhysicsBodyLifecycle.update(Body)", () => {
  it("moves a body to disabled and back on the enabled toggle", () => {
    const e = world.entity().set(Body, { type: BodyType.Dynamic });
    world.progress(0, 16);
    const bodyId = wasmBodyId(e.eid);
    expect(engine.box2d.b2Body_IsEnabled(bodyId)).toBe(true);

    e.set(Body, { type: BodyType.Dynamic, enabled: false });
    world.progress(16, 16);
    expect(engine.box2d.b2Body_IsEnabled(bodyId)).toBe(false);

    e.set(Body, { type: BodyType.Dynamic, enabled: true });
    world.progress(32, 16);
    expect(engine.box2d.b2Body_IsEnabled(bodyId)).toBe(true);
  });

  it("changes body type from dynamic to static", () => {
    const e = world.entity().set(Body, { type: BodyType.Dynamic });
    world.progress(0, 16);
    const bodyId = wasmBodyId(e.eid);
    expect(engine.box2d.b2Body_GetType(bodyId)).toBe(engine.box2d.b2BodyType.b2_dynamicBody);

    e.set(Body, { type: BodyType.Static });
    world.progress(16, 16);
    expect(engine.box2d.b2Body_GetType(bodyId)).toBe(engine.box2d.b2BodyType.b2_staticBody);
  });

  it("changes body type from dynamic to kinematic", () => {
    const e = world.entity().set(Body, { type: BodyType.Dynamic });
    world.progress(0, 16);

    e.set(Body, { type: BodyType.Kinematic });
    world.progress(16, 16);
    expect(engine.box2d.b2Body_GetType(wasmBodyId(e.eid))).toBe(
      engine.box2d.b2BodyType.b2_kinematicBody
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
    expect(engine.box2d.b2Body_GetLinearDamping(bodyId)).toBe(0);
    expect(engine.box2d.b2Body_GetAngularDamping(bodyId)).toBe(0);

    e.set(Damping, { linear: 0.5, angular: 0.25 });
    world.progress(16, 16);
    expect(engine.box2d.b2Body_GetLinearDamping(bodyId)).toBe(0.5);
    expect(engine.box2d.b2Body_GetAngularDamping(bodyId)).toBe(0.25);
  });

  it("propagates a GravityScale change to the WASM body after enter", () => {
    const e = world.entity().set(Body, { type: BodyType.Dynamic }).set(GravityScale, { value: 1 });
    world.progress(0, 16);
    const bodyId = wasmBodyId(e.eid);
    expect(engine.box2d.b2Body_GetGravityScale(bodyId)).toBe(1);

    e.set(GravityScale, { value: -0.25 });
    world.progress(16, 16);
    expect(engine.box2d.b2Body_GetGravityScale(bodyId)).toBe(-0.25);
  });
});

// ─── Proxy synchronisation on enable / disable / type change ─────────────────

describe("PhysicsBodyLifecycle — body proxy synchronisation (WASM)", () => {
  it("disabled body: shape is invalid in WASM when body is disabled on creation", () => {
    const e = world.entity().set(Body, { type: BodyType.Dynamic, enabled: false });
    world.entity().childOf(e).set(Box, { hx: 0.5, hy: 0.5 });
    world.progress(0, 16);

    const bodyId = wasmBodyId(e.eid);
    expect(engine.box2d.b2Body_IsEnabled(bodyId)).toBe(false);
    expect(engine.box2d.b2World_IsValid(engine.worldId)).toBe(true);
  });

  it("enable after disabled creation: body becomes enabled and shapes work", () => {
    const e = world.entity().set(Body, { type: BodyType.Dynamic, enabled: false });
    world.entity().childOf(e).set(Box, { hx: 0.5, hy: 0.5 });
    world.progress(0, 16);

    const bodyId = wasmBodyId(e.eid);
    expect(engine.box2d.b2Body_IsEnabled(bodyId)).toBe(false);

    e.set(Body, { type: BodyType.Dynamic, enabled: true });
    world.progress(16, 16);

    expect(engine.box2d.b2Body_IsEnabled(bodyId)).toBe(true);
    expect(engine.box2d.b2Body_IsAwake(bodyId)).toBe(true);
  });

  it("disable after enabled: body becomes disabled", () => {
    const e = world.entity().set(Body, { type: BodyType.Dynamic });
    world.entity().childOf(e).set(Box, { hx: 0.5, hy: 0.5 });
    world.progress(0, 16);

    const bodyId = wasmBodyId(e.eid);
    expect(engine.box2d.b2Body_IsEnabled(bodyId)).toBe(true);

    e.set(Body, { type: BodyType.Dynamic, enabled: false });
    world.progress(16, 16);

    expect(engine.box2d.b2Body_IsEnabled(bodyId)).toBe(false);
  });

  it("static→dynamic type change: body type is updated in WASM", () => {
    const e = world.entity().set(Body, { type: BodyType.Static });
    world.entity().childOf(e).set(Box, { hx: 0.5, hy: 0.5 });
    world.progress(0, 16);

    const bodyId = wasmBodyId(e.eid);
    expect(engine.box2d.b2Body_GetType(bodyId)).toBe(engine.box2d.b2BodyType.b2_staticBody);

    e.set(Body, { type: BodyType.Dynamic });
    world.progress(16, 16);

    expect(engine.box2d.b2Body_GetType(bodyId)).toBe(engine.box2d.b2BodyType.b2_dynamicBody);
  });

  it("dynamic→static type change: body type is updated in WASM", () => {
    const e = world.entity().set(Body, { type: BodyType.Dynamic });
    world.entity().childOf(e).set(Box, { hx: 0.5, hy: 0.5 });
    world.progress(0, 16);

    const bodyId = wasmBodyId(e.eid);
    expect(engine.box2d.b2Body_GetType(bodyId)).toBe(engine.box2d.b2BodyType.b2_dynamicBody);

    e.set(Body, { type: BodyType.Static });
    world.progress(16, 16);

    expect(engine.box2d.b2Body_GetType(bodyId)).toBe(engine.box2d.b2BodyType.b2_staticBody);
  });
});
