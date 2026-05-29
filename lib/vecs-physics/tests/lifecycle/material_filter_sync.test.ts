// `PhysicsMaterialFilterSync` (VP-11 commit 2): material and filter updates
// reflected on the internal shape record.
//
// Note on Vecs update semantics: `update(Component, cb)` fires only when the
// component is MODIFIED (not when it is first added). So these tests set up the
// component at shape creation (lifecycle reads the initial value), then SET it
// again with a new value to trigger the update callback.

import { ChildOf, World } from "@vworlds/vecs";
import { beforeEach, describe, expect, it } from "vitest";

import { Body, BodyType, Box, CollisionFilter, Material, installPhysics } from "../../src/index.js";
import { getPhysics, type PhysicsState } from "../../src/engine/state.js";

let world: World;
let state: PhysicsState;

function makeBody(type: BodyType = BodyType.Dynamic) {
  return world.entity().set(Body, { type });
}

function getShapeRecord(eid: number) {
  const handle = state.shapeByEntity.get(eid);
  if (handle === undefined) {
    return undefined;
  }
  return state.shapes.get(handle.index);
}

beforeEach(() => {
  world = new World();
  installPhysics(world);
  world.start();
  state = getPhysics(world);
});

// ─── Material updates ─────────────────────────────────────────────────────────

describe("PhysicsMaterialFilterSync.update(Material)", () => {
  it("copies material fields to the internal shape when Material is updated", () => {
    const body = makeBody();
    // Create shape with initial Material (lifecycle reads density=1 initially).
    const shape = world.entity().set(ChildOf, { target: body }).add(Box).set(Material, {
      density: 1,
      friction: 0.6,
      restitution: 0,
      rollingResistance: 0,
      tangentSpeed: 0,
      userMaterialId: 0,
    });
    world.progress(0, 16);

    // Now UPDATE Material with new values (this fires the update callback).
    shape.set(Material, {
      density: 3,
      friction: 0.2,
      restitution: 0.8,
      rollingResistance: 0.1,
      tangentSpeed: 0,
      userMaterialId: 42,
    });
    world.progress(16, 16);

    const rec = getShapeRecord(shape.eid)!;
    expect(rec.density).toBeCloseTo(3);
    expect(rec.friction).toBeCloseTo(0.2);
    expect(rec.restitution).toBeCloseTo(0.8);
    expect(rec.rollingResistance).toBeCloseTo(0.1);
    expect(rec.userMaterialId).toBe(42);
  });

  it("marks body massDirty when density changes on a dynamic body", () => {
    const body = makeBody(BodyType.Dynamic);
    const shape = world.entity().set(ChildOf, { target: body }).add(Box).set(Material, {
      density: 1,
      friction: 0.6,
      restitution: 0,
      rollingResistance: 0,
      tangentSpeed: 0,
      userMaterialId: 0,
    });
    world.progress(0, 16);

    const bodyHandle = state.bodyByEntity.get(body.eid)!;
    const bodyRec = state.bodies.get(bodyHandle.index);
    // After frame 0, massDirty is already false (VP-12 mass recompute cleared it).

    // UPDATE with new density → marks dirty, then VP-12 clears it in the same frame.
    shape.set(Material, {
      density: 5,
      friction: 0.6,
      restitution: 0,
      rollingResistance: 0,
      tangentSpeed: 0,
      userMaterialId: 0,
    });
    world.progress(16, 16);

    // VP-12: PhysicsMassRecompute ran and cleared massDirty; mass was updated.
    expect(bodyRec.massDirty).toBe(false);
    // Verify mass was recomputed with new density: mass = 5 * (box area)
    const sim = state.solverSets[bodyRec.setIndex]!.bodySims[bodyRec.localIndex]!;
    // Default Box is 1×1 (half-extents 0.5, 0.5) → area=1, mass=5*1=5
    expect(sim.invMass).toBeCloseTo(1 / 5, 6);
  });

  it("does NOT mark massDirty for Material changes on a static body", () => {
    const body = makeBody(BodyType.Static);
    const shape = world.entity().set(ChildOf, { target: body }).add(Box).set(Material, {
      density: 1,
      friction: 0.6,
      restitution: 0,
      rollingResistance: 0,
      tangentSpeed: 0,
      userMaterialId: 0,
    });
    world.progress(0, 16);

    const bodyHandle = state.bodyByEntity.get(body.eid)!;
    state.bodies.get(bodyHandle.index).massDirty = false;

    // Update density on a static body — static bodies don't participate in mass.
    shape.set(Material, {
      density: 5,
      friction: 0.6,
      restitution: 0,
      rollingResistance: 0,
      tangentSpeed: 0,
      userMaterialId: 0,
    });
    world.progress(16, 16);

    expect(state.bodies.get(bodyHandle.index).massDirty).toBe(false);
  });
});

// ─── CollisionFilter updates ──────────────────────────────────────────────────

describe("PhysicsMaterialFilterSync.update(CollisionFilter)", () => {
  it("copies filter bits to the internal shape when CollisionFilter is updated", () => {
    const body = makeBody();
    // Create shape with initial filter.
    const shape = world
      .entity()
      .set(ChildOf, { target: body })
      .add(Box)
      .set(CollisionFilter, { categoryBits: 1, maskBits: 0xffffffff, groupIndex: 0 });
    world.progress(0, 16);

    // UPDATE with new filter values.
    shape.set(CollisionFilter, { categoryBits: 0x8, maskBits: 0xff, groupIndex: 2 });
    world.progress(16, 16);

    const rec = getShapeRecord(shape.eid)!;
    expect(rec.categoryBits).toBe(0x8);
    expect(rec.maskBits).toBe(0xff);
    expect(rec.groupIndex).toBe(2);
  });
});
