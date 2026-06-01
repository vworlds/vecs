// VP-12 — DeferredMassFlagSyncTest: port of box2d/test/test_world.c::DeferredMassFlagSyncTest.
//
// Verifies box2d3-wasm auto-mass behaviour and the explicit dirtyMassBodies
// recompute path owned by PhysicsMassRecompute.
//
// Upstream source: box2d/test/test_world.c::DeferredMassFlagSyncTest

import { ChildOf, World } from "@vworlds/vecs";
import { beforeEach, describe, expect, it } from "vitest";

import { Body, BodyType, Circle, Sensor, installPhysics } from "../../src/index.js";
import { getPhysics } from "../../src/adapter/state.js";
import { PI } from "../../src/math/constants.js";

let world: World;

beforeEach(() => {
  world = new World();
  installPhysics(world);
  world.start();
});

// ─── Port of DeferredMassFlagSyncTest ─────────────────────────────────────────

describe("DeferredMassFlagSyncTest (golden from box2d/test/test_world.c)", () => {
  it("creates body, adds shape, and Box2D auto-computes mass", () => {
    const state = getPhysics(world);

    const bodyEnt = world.entity().set(Body, { type: BodyType.Dynamic });

    // Frame 1: body created, massDirty should be false (no shapes yet).
    world.progress(0, 16);
    const bodyId = state.bodyByEntityWasm.get(bodyEnt.eid)!;
    expect(bodyId).toBeDefined();
    expect(state.box2d.b2Body_GetMass(bodyId)).toBe(0);

    // Add a circle shape (r=0.5) as a child.
    world.entity().set(ChildOf, { target: bodyEnt }).set(Circle, { radius: 0.5 });

    // Frame 2: shape creation updates Box2D mass immediately.
    world.progress(16, 16);
    expect(state.dirtyMassBodies.size).toBe(0);
    const expectedMass = PI * 0.5 * 0.5; // density=1, radius=0.5
    // box2d3-wasm@5.2.0 baseline.
    expect(state.box2d.b2Body_GetMass(bodyId)).toBeCloseTo(expectedMass, 4);

    // Step again — no crash; mass remains recomputed.
    world.progress(32, 16);
    expect(state.box2d.b2Body_GetMass(bodyId)).toBeCloseTo(expectedMass, 4);
  });
});

// ─── Additional lifecycle tests ────────────────────────────────────────────────

describe("PhysicsMassRecompute", () => {
  it("clears dirtyMassBodies and writes mass after explicit recompute", () => {
    const state = getPhysics(world);
    const bodyEnt = world.entity().set(Body, { type: BodyType.Dynamic });
    const shapeEnt = world.entity().set(ChildOf, { target: bodyEnt }).set(Circle, { radius: 1 });

    world.progress(0, 16);
    const bodyId = state.bodyByEntityWasm.get(bodyEnt.eid)!;
    const shapeId = state.shapeByEntityWasm.get(shapeEnt.eid)!;
    expect(state.box2d.b2Body_GetMass(bodyId)).toBeCloseTo(PI, 6);

    state.box2d.b2Shape_SetDensity(shapeId, 5, false);
    expect(state.box2d.b2Body_GetMass(bodyId)).toBeCloseTo(PI, 6);

    state.dirtyMassBodies.add(bodyEnt.eid);
    world.progress(16, 16);

    expect(state.dirtyMassBodies.size).toBe(0);
    // Tight numeric baseline recorded from box2d3-wasm@5.2.0.
    expect(state.box2d.b2Body_GetMass(bodyId)).toBeCloseTo(15.707963943481445, 6);
  });

  it("does not explicitly recompute mass for body without dirtyMassBodies", () => {
    const state = getPhysics(world);
    const bodyEnt = world.entity().set(Body, { type: BodyType.Dynamic });
    const shapeEnt = world.entity().set(ChildOf, { target: bodyEnt }).set(Circle, { radius: 1 });

    world.progress(0, 16);
    const bodyId = state.bodyByEntityWasm.get(bodyEnt.eid)!;
    const shapeId = state.shapeByEntityWasm.get(shapeEnt.eid)!;

    const massAfterFrame1 = state.box2d.b2Body_GetMass(bodyId);
    state.box2d.b2Shape_SetDensity(shapeId, 5, false);

    world.progress(16, 16);

    expect(state.dirtyMassBodies.size).toBe(0);
    expect(state.box2d.b2Body_GetMass(bodyId)).toBeCloseTo(massAfterFrame1, 6);
  });

  it("static body: invMass stays 0 even with shapes", () => {
    const state = getPhysics(world);
    const bodyEnt = world.entity().set(Body, { type: BodyType.Static });
    world.entity().set(ChildOf, { target: bodyEnt }).set(Circle, { radius: 1 });

    world.progress(0, 16);
    const bodyId = state.bodyByEntityWasm.get(bodyEnt.eid)!;

    expect(state.box2d.b2Body_GetMass(bodyId)).toBe(0);
    expect(state.box2d.b2Body_GetRotationalInertia(bodyId)).toBe(0);
  });

  it("dynamic body with no shapes is never recomputed (massDirty stays false)", () => {
    const state = getPhysics(world);
    // Dynamic body with no shape children.
    const bodyEnt = world.entity().set(Body, { type: BodyType.Dynamic });

    world.progress(0, 16);
    const bodyId = state.bodyByEntityWasm.get(bodyEnt.eid)!;
    expect(state.dirtyMassBodies.size).toBe(0);
    expect(state.box2d.b2Body_GetMass(bodyId)).toBe(0);
  });

  it("removing a shape re-marks massDirty and triggers recompute on next step", () => {
    const state = getPhysics(world);
    const bodyEnt = world.entity().set(Body, { type: BodyType.Dynamic });
    const shapeEnt = world.entity().set(ChildOf, { target: bodyEnt }).set(Circle, { radius: 1 });

    // Frame 1: shape created, mass computed.
    world.progress(0, 16);
    const bodyId = state.bodyByEntityWasm.get(bodyEnt.eid)!;
    expect(state.box2d.b2Body_GetMass(bodyId)).toBeCloseTo(PI, 6);

    // Remove the shape entity.
    shapeEnt.destroy();

    // Frame 2: shape destroyed with updateBodyMass=true, so Box2D mass updates.
    world.progress(16, 16);
    expect(state.dirtyMassBodies.size).toBe(0);
    // No shapes left → massless dynamic → mass = 0 (box2d-faithful: a
    // massless dynamic body has infinite mass and does not fall; the
    // dynamic-body-without-density debug check flags the misconfiguration).
    expect(state.box2d.b2Body_GetMass(bodyId)).toBe(0);
  });

  it("dynamic body whose only shape is a sensor Circle gets finite mass (Box2D parity)", () => {
    // Box2D b2UpdateBodyMassData skips only density==0 shapes, not sensor shapes.
    // A sensor with default density 1 must contribute mass, CoM, and inertia.
    // Before this fix the port skipped sensors, giving invMass=0 (infinite mass).
    const state = getPhysics(world);
    const bodyEnt = world.entity().set(Body, { type: BodyType.Dynamic });
    world.entity().set(ChildOf, { target: bodyEnt }).set(Circle, { radius: 1 }).add(Sensor);

    world.progress(0, 16);

    const bodyId = state.bodyByEntityWasm.get(bodyEnt.eid)!;

    // box2d3-wasm@5.2.0 baseline: mass = density·π·r² = 1·π·1 = π.
    expect(state.box2d.b2Body_GetMass(bodyId)).toBeCloseTo(PI, 6);
    expect(state.box2d.b2Body_GetRotationalInertia(bodyId)).toBeGreaterThan(0);
  });
});
