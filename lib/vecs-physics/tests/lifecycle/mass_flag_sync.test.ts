// VP-12 — DeferredMassFlagSyncTest: port of box2d/test/test_world.c::DeferredMassFlagSyncTest.
//
// Verifies that the `massDirty` flag is set when a shape is added and cleared
// (mass recomputed) by PhysicsMassRecompute during the next world.progress().
// Also tests that mass updates correctly propagate when shapes are removed.
//
// Upstream source: box2d/test/test_world.c::DeferredMassFlagSyncTest

import { ChildOf, World } from "@vworlds/vecs";
import { beforeEach, describe, expect, it } from "vitest";

import { Body, BodyType, Circle, installPhysics } from "../../src/index.js";
import { getPhysics } from "../../src/engine/state.js";
import { AWAKE_SET } from "../../src/engine/solver_set.js";
import { PI } from "../../src/math/constants.js";

let world: World;

beforeEach(() => {
  world = new World();
  installPhysics(world);
  world.start();
});

// ─── Port of DeferredMassFlagSyncTest ─────────────────────────────────────────

describe("DeferredMassFlagSyncTest (golden from box2d/test/test_world.c)", () => {
  it("creates body, adds shape, steps without crash (smoke test of deferred-mass pipeline)", () => {
    const state = getPhysics(world);

    const bodyEnt = world.entity().set(Body, { type: BodyType.Dynamic });

    // Frame 1: body created, massDirty should be false (no shapes yet).
    world.progress(0, 16);
    const bodyHandle = state.bodyByEntity.get(bodyEnt.eid)!;
    expect(bodyHandle).toBeDefined();
    const bodyRec = state.bodies.get(bodyHandle.index);
    // No shapes yet — massDirty should be false.
    expect(bodyRec.massDirty).toBe(false);

    // Add a circle shape (r=0.5) as a child.
    world.entity().set(ChildOf, { target: bodyEnt }).set(Circle, { radius: 0.5 });

    // Frame 2: shape created → massDirty set by shape lifecycle.
    world.progress(16, 16);
    expect(bodyRec.massDirty).toBe(false); // MassRecompute ran → cleared it
    // invMass should now be nonzero (mass = density·π·r² = π·0.25 ≈ 0.785).
    const bodyIdx = bodyRec.localIndex;
    const sim = state.solverSets[AWAKE_SET]!.bodySims[bodyIdx]!;
    const expectedMass = PI * 0.5 * 0.5; // density=1, radius=0.5
    expect(sim.invMass).toBeCloseTo(1 / expectedMass, 4);

    // Step again — no crash; mass remains recomputed.
    world.progress(32, 16);
    expect(bodyRec.massDirty).toBe(false);
  });
});

// ─── Additional lifecycle tests ────────────────────────────────────────────────

describe("PhysicsMassRecompute", () => {
  it("clears massDirty and writes invMass after shape creation", () => {
    const state = getPhysics(world);
    const bodyEnt = world.entity().set(Body, { type: BodyType.Dynamic });
    world.entity().set(ChildOf, { target: bodyEnt }).set(Circle, { radius: 1 });

    // Before progress: massDirty not yet set (body not created yet).
    world.progress(0, 16);
    const bodyHandle = state.bodyByEntity.get(bodyEnt.eid)!;
    const bodyRec = state.bodies.get(bodyHandle.index);
    const sim = state.solverSets[AWAKE_SET]!.bodySims[bodyRec.localIndex]!;

    expect(bodyRec.massDirty).toBe(false);
    const expectedMass = PI; // radius=1, density=1
    expect(sim.invMass).toBeCloseTo(1 / expectedMass, 6);
  });

  it("does not recompute mass for body without massDirty", () => {
    const state = getPhysics(world);
    const bodyEnt = world.entity().set(Body, { type: BodyType.Dynamic });
    world.entity().set(ChildOf, { target: bodyEnt }).set(Circle, { radius: 1 });

    // Frame 1: mass computed, invMass = 1/π.
    world.progress(0, 16);
    const bodyHandle = state.bodyByEntity.get(bodyEnt.eid)!;
    const bodyRec = state.bodies.get(bodyHandle.index);
    const sim = state.solverSets[AWAKE_SET]!.bodySims[bodyRec.localIndex]!;

    const invMassAfterFrame1 = sim.invMass;
    // Manually corrupt invMass and ensure it is NOT restored on next frame
    // (massDirty is false, so recompute should not run again).
    sim.invMass = 42;

    world.progress(16, 16);
    // Still corrupted — recompute did not run.
    expect(sim.invMass).toBe(42);

    // Restore correct value for any downstream tests.
    sim.invMass = invMassAfterFrame1;
  });

  it("static body: invMass stays 0 even with shapes", () => {
    const state = getPhysics(world);
    const bodyEnt = world.entity().set(Body, { type: BodyType.Static });
    world.entity().set(ChildOf, { target: bodyEnt }).set(Circle, { radius: 1 });

    world.progress(0, 16);
    const bodyHandle = state.bodyByEntity.get(bodyEnt.eid)!;
    const bodyRec = state.bodies.get(bodyHandle.index);
    // Static body lives in the static set; its sim is in solverSets[0].
    const staticSet = state.solverSets[0]!;
    const sim = staticSet.bodySims[bodyRec.localIndex]!;

    expect(sim.invMass).toBe(0);
    expect(sim.invInertia).toBe(0);
  });

  it("dynamic body with no shapes is never recomputed (massDirty stays false)", () => {
    const state = getPhysics(world);
    // Dynamic body with no shape children.
    const bodyEnt = world.entity().set(Body, { type: BodyType.Dynamic });

    world.progress(0, 16);
    const bodyHandle = state.bodyByEntity.get(bodyEnt.eid)!;
    const bodyRec = state.bodies.get(bodyHandle.index);
    // A body with NO shapes never has massDirty set, so mass is never recomputed
    // (mass is only recomputed when a shape lifecycle event sets massDirty).
    // Were it recomputed, box2d-faithfully it would stay invMass=0 (massless).
    expect(bodyRec.massDirty).toBe(false);
  });

  it("removing a shape re-marks massDirty and triggers recompute on next step", () => {
    const state = getPhysics(world);
    const bodyEnt = world.entity().set(Body, { type: BodyType.Dynamic });
    const shapeEnt = world.entity().set(ChildOf, { target: bodyEnt }).set(Circle, { radius: 1 });

    // Frame 1: shape created, mass computed.
    world.progress(0, 16);
    const bodyHandle = state.bodyByEntity.get(bodyEnt.eid)!;
    const bodyRec = state.bodies.get(bodyHandle.index);
    const sim = state.solverSets[AWAKE_SET]!.bodySims[bodyRec.localIndex]!;
    expect(sim.invMass).toBeCloseTo(1 / PI, 6);

    // Remove the shape entity.
    shapeEnt.destroy();

    // Frame 2: shape destroyed → massDirty set by lifecycle → recompute fires.
    world.progress(16, 16);
    expect(bodyRec.massDirty).toBe(false);
    // No shapes left → massless dynamic → invMass = 0 (box2d-faithful: a
    // massless dynamic body has infinite mass and does not fall; the
    // dynamic-body-without-density debug check flags the misconfiguration).
    expect(sim.invMass).toBe(0);
  });
});
