// `PhysicsMaterialFilterSync` (VP-11 commit 2): material and filter updates
// reflected on the WASM shape.
//
// Note on Vecs update semantics: `update(Component, cb)` fires only when the
// component is MODIFIED (not when it is first added). So these tests set up the
// component at shape creation (lifecycle reads the initial value), then SET it
// again with a new value to trigger the update callback.

import { World, type EID } from "@vworlds/vecs";
import { beforeEach, describe, expect, it } from "vitest";

import {
  Body,
  BodyType,
  Box,
  Chain,
  Circle,
  CollisionFilter,
  Material,
  PhysicsModule,
} from "../../src/index.js";
import { getPhysics, type PhysicsState } from "../../src/adapter/state.js";

const PI = Math.PI;

let world: World;
let state: PhysicsState;

function makeBody(type: BodyType = BodyType.Dynamic) {
  return world.entity().set(Body, { type });
}

function getBodyMass(eid: EID): number {
  return state.box2d.b2Body_GetMass(state.bodyByEntityWasm.get(eid)!);
}

function getShapeMaterial(shapeEid: EID) {
  const shapeId = state.shapeByEntityWasm.get(shapeEid);
  if (shapeId === undefined) {
    return undefined;
  }
  const mat = state.box2d.b2Shape_GetSurfaceMaterial(shapeId);
  const result = {
    density: state.box2d.b2Shape_GetDensity(shapeId),
    friction: mat.friction,
    restitution: mat.restitution,
    rollingResistance: mat.rollingResistance,
    userMaterialId: Number(mat.userMaterialId),
  };
  mat.delete();
  return result;
}

function getShapeFilter(shapeEid: number) {
  const shapeId = state.shapeByEntityWasm.get(shapeEid);
  if (shapeId === undefined) {
    return undefined;
  }
  const filter = state.box2d.b2Shape_GetFilter(shapeId);
  const result = {
    categoryBits: filter.categoryBits,
    maskBits: filter.maskBits,
    groupIndex: filter.groupIndex,
  };
  filter.delete();
  return result;
}

function makeChainShape(body: ReturnType<typeof makeBody>) {
  return world
    .entity()
    .childOf(body)
    .set(Chain, {
      points: [
        { x: -1, y: 0 },
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 2, y: 0 },
      ],
      loop: false,
    });
}

beforeEach(() => {
  world = new World();
  world.module(PhysicsModule);
  state = getPhysics(world);
});

// ─── Material updates ─────────────────────────────────────────────────────────

describe("PhysicsMaterialFilterSync.update(Material)", () => {
  it("copies material fields to the WASM shape when Material is updated", () => {
    const body = makeBody();
    // Create shape with initial Material.
    const shape = world.entity().childOf(body).add(Box).set(Material, {
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

    // rollingResistance and userMaterialId changes trigger shape recreation (no WASM setters).
    const mat = getShapeMaterial(shape.eid)!;
    expect(mat.density).toBeCloseTo(3);
    expect(mat.friction).toBeCloseTo(0.2);
    expect(mat.restitution).toBeCloseTo(0.8);
    expect(mat.rollingResistance).toBeCloseTo(0.1);
    expect(mat.userMaterialId).toBe(42);
  });

  it("marks body massDirty when density changes on a dynamic body", () => {
    const body = makeBody(BodyType.Dynamic);
    const shape = world.entity().childOf(body).add(Box).set(Material, {
      density: 1,
      friction: 0.6,
      restitution: 0,
      rollingResistance: 0,
      tangentSpeed: 0,
      userMaterialId: 0,
    });
    world.progress(0, 16);

    // After frame 0, dirtyMassBodies should be clear.
    expect(state.dirtyMassBodies.size).toBe(0);

    // UPDATE with new density → b2Shape_SetDensity auto-recomputes mass.
    shape.set(Material, {
      density: 5,
      friction: 0.6,
      restitution: 0,
      rollingResistance: 0,
      tangentSpeed: 0,
      userMaterialId: 0,
    });
    world.progress(16, 16);

    expect(state.dirtyMassBodies.size).toBe(0);
    // box2d3-wasm@5.2.0 baseline: default Box area is 1, so mass = density 5.
    expect(getBodyMass(body.eid)).toBeCloseTo(5, 6);
  });

  it("does NOT recompute mass when only friction changes on a dynamic body", () => {
    const body = makeBody(BodyType.Dynamic);
    const shape = world.entity().childOf(body).set(Circle, { radius: 1 }).set(Material, {
      density: 1,
      friction: 0.3,
      restitution: 0,
      rollingResistance: 0,
      tangentSpeed: 0,
      userMaterialId: 0,
    });
    world.progress(0, 16);

    // box2d3-wasm@5.2.0 baseline: mass = density * pi * r^2.
    const massAfterFrame1 = getBodyMass(body.eid);
    expect(massAfterFrame1).toBeCloseTo(PI, 6);

    // Change only friction — density stays 1, so mass must not change.
    shape.set(Material, {
      density: 1,
      friction: 0.8,
      restitution: 0,
      rollingResistance: 0,
      tangentSpeed: 0,
      userMaterialId: 0,
    });

    world.progress(16, 16);

    expect(state.dirtyMassBodies.size).toBe(0);
    expect(getBodyMass(body.eid)).toBeCloseTo(massAfterFrame1, 6);
  });

  it("recomputes mass when density changes on a dynamic body (density 1 → 5)", () => {
    const body = makeBody(BodyType.Dynamic);
    const shape = world.entity().childOf(body).set(Circle, { radius: 1 }).set(Material, {
      density: 1,
      friction: 0.6,
      restitution: 0,
      rollingResistance: 0,
      tangentSpeed: 0,
      userMaterialId: 0,
    });
    world.progress(0, 16);

    expect(getBodyMass(body.eid)).toBeCloseTo(PI, 6);

    // Change density from 1 → 5.
    shape.set(Material, {
      density: 5,
      friction: 0.6,
      restitution: 0,
      rollingResistance: 0,
      tangentSpeed: 0,
      userMaterialId: 0,
    });
    world.progress(16, 16);

    // b2Shape_SetDensity(..., true) auto-recomputes mass in box2d3-wasm@5.2.0.
    expect(state.dirtyMassBodies.size).toBe(0);
    // Tight numeric baseline recorded from box2d3-wasm@5.2.0.
    expect(getBodyMass(body.eid)).toBeCloseTo(15.707963943481445, 6);
  });

  it("does NOT trigger mass recompute for Material changes on a static body", () => {
    const body = makeBody(BodyType.Static);
    const shape = world.entity().childOf(body).add(Box).set(Material, {
      density: 1,
      friction: 0.6,
      restitution: 0,
      rollingResistance: 0,
      tangentSpeed: 0,
      userMaterialId: 0,
    });
    world.progress(0, 16);

    expect(state.dirtyMassBodies.size).toBe(0);

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

    // Static bodies have mass 0 regardless of density.
    expect(getBodyMass(body.eid)).toBe(0);
    expect(state.dirtyMassBodies.size).toBe(0);
  });

  it("recreates a WASM chain when a setter-backed Material field changes", () => {
    const body = makeBody(BodyType.Static);
    const shape = makeChainShape(body).set(Material, {
      density: 1,
      friction: 0.6,
      restitution: 0,
      rollingResistance: 0,
      tangentSpeed: 0,
      userMaterialId: 0,
    });
    world.progress(0, 16);

    const oldChainId = state.chainByEntity.get(shape.eid)!;

    shape.set(Material, {
      density: 1,
      friction: 0.2,
      restitution: 0,
      rollingResistance: 0,
      tangentSpeed: 0,
      userMaterialId: 0,
    });
    world.progress(16, 16);

    const newChainId = state.chainByEntity.get(shape.eid)!;
    expect(state.box2d.b2Chain_IsValid(oldChainId)).toBe(false);
    expect(state.box2d.b2Chain_IsValid(newChainId)).toBe(true);
    expect(newChainId).not.toEqual(oldChainId);
  });
});

// ─── CollisionFilter updates ──────────────────────────────────────────────────

describe("PhysicsMaterialFilterSync.update(CollisionFilter)", () => {
  it("copies filter bits to the WASM shape when CollisionFilter is updated", () => {
    const body = makeBody();
    // Create shape with initial filter.
    const shape = world
      .entity()
      .childOf(body)
      .add(Box)
      .set(CollisionFilter, { categoryBits: 1, maskBits: 0xffffffff, groupIndex: 0 });
    world.progress(0, 16);

    // UPDATE with new filter values.
    shape.set(CollisionFilter, { categoryBits: 0x8, maskBits: 0xff, groupIndex: 2 });
    world.progress(16, 16);

    const filter = getShapeFilter(shape.eid)!;
    expect(filter.categoryBits).toBe(0x8);
    expect(filter.maskBits).toBe(0xff);
    expect(filter.groupIndex).toBe(2);
  });

  it("recreates a WASM chain when CollisionFilter changes", () => {
    const body = makeBody(BodyType.Static);
    const shape = makeChainShape(body).set(CollisionFilter, {
      categoryBits: 1,
      maskBits: 0xffffffff,
      groupIndex: 0,
    });
    world.progress(0, 16);

    const oldChainId = state.chainByEntity.get(shape.eid)!;

    shape.set(CollisionFilter, { categoryBits: 0x8, maskBits: 0xff, groupIndex: 2 });
    world.progress(16, 16);

    const newChainId = state.chainByEntity.get(shape.eid)!;
    expect(state.box2d.b2Chain_IsValid(oldChainId)).toBe(false);
    expect(state.box2d.b2Chain_IsValid(newChainId)).toBe(true);
    expect(newChainId).not.toEqual(oldChainId);
  });
});
