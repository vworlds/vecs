// `PhysicsShapePoseSync` (VP-11 commit 3): ShapePosition / ShapeRotation
// updates reflected on the WASM shape AABB.
//
// Note on Vecs update semantics: `update(Component, cb)` fires only when the
// component is MODIFIED (not when it is first added). So these tests set up
// ShapePosition/ShapeRotation at shape creation (lifecycle reads the initial
// value), then SET them again with new values to trigger the update callback.

import { World } from "@vworlds/vecs";
import { beforeEach, describe, expect, it } from "vitest";

import {
  Body,
  BodyType,
  Box,
  Circle,
  ShapePosition,
  ShapeRotation,
  PhysicsModule,
} from "../../src/index.js";
import { getPhysicsEngine, type b2ShapeId, type PhysicsEngine } from "../../src/adapter/engine.js";
import { SingleShape } from "../../src/shapes/components.js";

let world: World;
let engine: PhysicsEngine;

function makeBody(type: BodyType = BodyType.Static) {
  return world.entity().set(Body, { type });
}

function getShapeAABB(shapeEid: number) {
  const shapeId = world.getEntity(shapeEid)?.get(SingleShape)?._shapeId as b2ShapeId | undefined;
  if (shapeId === undefined || !engine.box2d.b2Shape_IsValid(shapeId)) {
    return undefined;
  }
  const aabb = engine.box2d.b2Shape_GetAABB(shapeId);
  const result = {
    minX: aabb.lowerBound.x,
    minY: aabb.lowerBound.y,
    maxX: aabb.upperBound.x,
    maxY: aabb.upperBound.y,
  };
  aabb.delete();
  return result;
}

beforeEach(() => {
  world = new World();
  world.module(PhysicsModule);
  engine = getPhysicsEngine(world);
});

describe("PhysicsShapePoseSync.update(ShapePosition)", () => {
  it("recomputes the world AABB after a position change", () => {
    const body = makeBody();
    const shape = world
      .entity()
      .childOf(body)
      .set(Box, { hx: 0.5, hy: 0.5 })
      .set(ShapePosition, { x: 0, y: 0 });
    world.progress(0, 16);

    // Initially at origin.
    const aabbBefore = getShapeAABB(shape.eid)!;
    const centerXBefore = (aabbBefore.minX + aabbBefore.maxX) / 2;
    expect(centerXBefore).toBeCloseTo(0, 1);

    shape.set(ShapePosition, { x: 10, y: 0 });
    world.progress(16, 16);

    // After position change: center should be near 10.
    const aabbAfter = getShapeAABB(shape.eid)!;
    const centerXAfter = (aabbAfter.minX + aabbAfter.maxX) / 2;
    expect(centerXAfter).toBeCloseTo(10, 1);
  });

  it("WASM shape AABB center moves to the new position", () => {
    const body = makeBody();
    const shape = world
      .entity()
      .childOf(body)
      .set(Box, { hx: 0.5, hy: 0.5 })
      .set(ShapePosition, { x: 0, y: 0 });
    world.progress(0, 16);

    shape.set(ShapePosition, { x: 5, y: 0 });
    world.progress(16, 16);

    const aabb = getShapeAABB(shape.eid)!;
    const centerX = (aabb.minX + aabb.maxX) / 2;
    expect(centerX).toBeCloseTo(5, 0);
  });
});

describe("PhysicsShapePoseSync.update(ShapeRotation)", () => {
  it("recomputes the world AABB after a rotation change", () => {
    const body = makeBody();
    const shape = world
      .entity()
      .childOf(body)
      .set(Box, { hx: 1, hy: 0.1 })
      .set(ShapeRotation, { angle: 0 });
    world.progress(0, 16);

    // Before rotation: wide box (~2 wide, ~0.2 tall).
    const aabbBefore = getShapeAABB(shape.eid)!;
    const widthBefore = aabbBefore.maxX - aabbBefore.minX;
    const heightBefore = aabbBefore.maxY - aabbBefore.minY;
    expect(widthBefore).toBeGreaterThan(heightBefore);

    shape.set(ShapeRotation, { angle: Math.PI / 2 });
    world.progress(16, 16);

    // After 90° rotation: narrow box (~0.2 wide, ~2 tall).
    const aabbAfter = getShapeAABB(shape.eid)!;
    const widthAfter = aabbAfter.maxX - aabbAfter.minX;
    const heightAfter = aabbAfter.maxY - aabbAfter.minY;
    expect(widthAfter).toBeLessThan(heightAfter);
  });
});

// ─── massDirty propagation ────────────────────────────────────────────────────

describe("PhysicsShapePoseSync marks body massDirty on local pose change", () => {
  it("ShapePosition change triggers mass recompute (center of mass moves with shape)", () => {
    const body = world.entity().set(Body, { type: BodyType.Dynamic });
    const shape = world
      .entity()
      .childOf(body)
      .set(Circle, { radius: 1 })
      .set(ShapePosition, { x: 0, y: 0 });
    world.progress(0, 16);

    // Mass should be non-zero.
    const bodyId = body.get(Body)!._bodyId!;
    const massBefore = engine.box2d.b2Body_GetMass(bodyId);
    expect(massBefore).toBeGreaterThan(0);

    // Move the circle to (10, 0). PhysicsShapePoseSync must mark massDirty so
    // PhysicsMassRecompute recomputes the center of mass.
    shape.set(ShapePosition, { x: 10, y: 0 });
    world.progress(16, 16);

    // After progress, dirtyMassBodies is cleared.
    expect(engine.dirtyMassBodies.size).toBe(0);
    // Mass hasn't changed — shape area is the same.
    expect(engine.box2d.b2Body_GetMass(bodyId)).toBeCloseTo(massBefore, 4);
    // But center of mass position should have shifted.
    const massData = engine.box2d.b2Body_GetMassData(bodyId);
    try {
      expect(massData.center.x).toBeCloseTo(10, 2);
    } finally {
      massData.delete();
    }
  });

  it("ShapeRotation change triggers mass recompute (dirtyMassBodies cleared after progress)", () => {
    const body = world.entity().set(Body, { type: BodyType.Dynamic });
    const shapeEntity = world
      .entity()
      .childOf(body)
      .set(Box, { hx: 0.5, hy: 0.5 })
      .set(ShapeRotation, { angle: 0 });
    world.progress(0, 16);

    // dirtyMassBodies is false after first progress (PhysicsMassRecompute cleared it).
    expect(engine.dirtyMassBodies.size).toBe(0);

    // Update rotation — must mark body dirty so the next progress recomputes.
    shapeEntity.set(ShapeRotation, { angle: Math.PI / 4 });
    world.progress(16, 16);

    // dirtyMassBodies cleared again by PhysicsMassRecompute.
    expect(engine.dirtyMassBodies.size).toBe(0);
  });
});
