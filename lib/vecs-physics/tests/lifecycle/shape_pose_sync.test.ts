// `PhysicsShapePoseSync` (VP-11 commit 3): ShapePosition / ShapeRotation
// updates reflected on the internal shape record and the broad-phase AABB.
//
// Note on Vecs update semantics: `update(Component, cb)` fires only when the
// component is MODIFIED (not when it is first added). So these tests set up
// ShapePosition/ShapeRotation at shape creation (lifecycle reads the initial
// value), then SET them again with new values to trigger the update callback.

import { ChildOf, World } from "@vworlds/vecs";
import { beforeEach, describe, expect, it } from "vitest";

import {
  Body,
  BodyType,
  Box,
  Circle,
  ShapePosition,
  ShapeRotation,
  installPhysics,
} from "../../src/index.js";
import { getPhysics, type PhysicsState } from "../../src/engine/state.js";
import { AWAKE_SET } from "../../src/engine/solver_set.js";
import { SPECULATIVE_DISTANCE } from "../../src/math/constants.js";

let world: World;
let state: PhysicsState;

function makeBody(type: BodyType = BodyType.Static) {
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

describe("PhysicsShapePoseSync.update(ShapePosition)", () => {
  it("updates localX/Y on the shape record when ShapePosition is updated", () => {
    const body = makeBody();
    // Create with initial ShapePosition (lifecycle reads it at entry).
    const shape = world
      .entity()
      .set(ChildOf, { target: body })
      .add(Box)
      .set(ShapePosition, { x: 0, y: 0 });
    world.progress(0, 16);

    // UPDATE to new position.
    shape.set(ShapePosition, { x: 3, y: 4 });
    world.progress(16, 16);

    const rec = getShapeRecord(shape.eid)!;
    expect(rec.localX).toBeCloseTo(3);
    expect(rec.localY).toBeCloseTo(4);
  });

  it("recomputes the world AABB after a position change", () => {
    const body = makeBody();
    const shape = world
      .entity()
      .set(ChildOf, { target: body })
      .set(Box, { hx: 0.5, hy: 0.5 })
      .set(ShapePosition, { x: 0, y: 0 });
    world.progress(0, 16);

    // Initially at origin: aabb center ≈ 0, extended by SPECULATIVE_DISTANCE.
    let rec = getShapeRecord(shape.eid)!;
    expect(rec.aabbMinX).toBeCloseTo(-0.5 - SPECULATIVE_DISTANCE);
    expect(rec.aabbMaxX).toBeCloseTo(0.5 + SPECULATIVE_DISTANCE);

    shape.set(ShapePosition, { x: 10, y: 0 });
    world.progress(16, 16);

    rec = getShapeRecord(shape.eid)!;
    expect(rec.aabbMinX).toBeCloseTo(9.5 - SPECULATIVE_DISTANCE);
    expect(rec.aabbMaxX).toBeCloseTo(10.5 + SPECULATIVE_DISTANCE);
  });

  it("updates the fat AABB on the broad-phase proxy after position change", () => {
    const body = makeBody();
    const shape = world
      .entity()
      .set(ChildOf, { target: body })
      .set(Box, { hx: 0.5, hy: 0.5 })
      .set(ShapePosition, { x: 0, y: 0 });
    world.progress(0, 16);

    shape.set(ShapePosition, { x: 5, y: 0 });
    world.progress(16, 16);

    const rec = getShapeRecord(shape.eid)!;
    // Fat AABB center should be near 5 (offset by speculative/fat margin).
    expect((rec.fatAabbMinX + rec.fatAabbMaxX) / 2).toBeCloseTo(5, 0);
  });
});

describe("PhysicsShapePoseSync.update(ShapeRotation)", () => {
  it("updates localCos/Sin on the shape record when ShapeRotation is updated", () => {
    const body = makeBody();
    const shape = world
      .entity()
      .set(ChildOf, { target: body })
      .add(Box)
      .set(ShapeRotation, { angle: 0 });
    world.progress(0, 16);

    // UPDATE to 90°.
    shape.set(ShapeRotation, { angle: Math.PI / 2 });
    world.progress(16, 16);

    const rec = getShapeRecord(shape.eid)!;
    expect(rec.localCos).toBeCloseTo(0, 5);
    expect(rec.localSin).toBeCloseTo(1, 5);
  });

  it("recomputes the world AABB after a rotation change", () => {
    const body = makeBody();
    const shape = world
      .entity()
      .set(ChildOf, { target: body })
      .set(Box, { hx: 1, hy: 0.1 })
      .set(ShapeRotation, { angle: 0 });
    world.progress(0, 16);

    // Before rotation: wide box (2 wide, 0.2 tall) + speculative.
    let rec = getShapeRecord(shape.eid)!;
    const widthBefore = rec.aabbMaxX - rec.aabbMinX;
    expect(widthBefore).toBeCloseTo(2 + 2 * SPECULATIVE_DISTANCE, 1);

    shape.set(ShapeRotation, { angle: Math.PI / 2 });
    world.progress(16, 16);

    // After 90° rotation: narrow box (~0.2 wide, ~2 tall) + speculative.
    rec = getShapeRecord(shape.eid)!;
    expect(rec.aabbMaxX - rec.aabbMinX).toBeCloseTo(0.2 + 2 * SPECULATIVE_DISTANCE, 1);
    expect(rec.aabbMaxY - rec.aabbMinY).toBeCloseTo(2 + 2 * SPECULATIVE_DISTANCE, 1);
  });
});

// ─── massDirty propagation ────────────────────────────────────────────────────

describe("PhysicsShapePoseSync marks body massDirty on local pose change", () => {
  it("ShapePosition change triggers mass recompute (localCenterX moves with shape)", () => {
    // Dynamic body + circle at origin → localCenterX = 0 after first progress.
    const body = world.entity().set(Body, { type: BodyType.Dynamic });
    const shape = world
      .entity()
      .set(ChildOf, { target: body })
      .set(Circle, { radius: 1 })
      .set(ShapePosition, { x: 0, y: 0 });
    world.progress(0, 16);

    const bodyHandle = state.bodyByEntity.get(body.eid)!;
    const bodyRec = state.bodies.get(bodyHandle.index);
    const sim0 = state.solverSets[AWAKE_SET]!.bodySims[bodyRec.localIndex]!;
    expect(sim0.localCenterX).toBeCloseTo(0, 5);

    // Move the circle to (10, 0). PhysicsShapePoseSync must mark massDirty so
    // PhysicsMassRecompute recomputes the center of mass.
    shape.set(ShapePosition, { x: 10, y: 0 });
    world.progress(16, 16);

    // After progress, massDirty is cleared and localCenterX must equal 10.
    const sim1 = state.solverSets[AWAKE_SET]!.bodySims[bodyRec.localIndex]!;
    expect(sim1.localCenterX).toBeCloseTo(10, 4);
  });

  it("ShapeRotation change triggers mass recompute (massDirty cleared after progress)", () => {
    const body = world.entity().set(Body, { type: BodyType.Dynamic });
    const shapeEntity = world
      .entity()
      .set(ChildOf, { target: body })
      .set(Box, { hx: 0.5, hy: 0.5 })
      .set(ShapeRotation, { angle: 0 });
    world.progress(0, 16);

    const bodyHandle = state.bodyByEntity.get(body.eid)!;
    const bodyRec = state.bodies.get(bodyHandle.index);
    // massDirty is false after first progress (VP-12 cleared it).
    expect(bodyRec.massDirty).toBe(false);

    // Update rotation — must re-set massDirty so the next progress recomputes.
    shapeEntity.set(ShapeRotation, { angle: Math.PI / 4 });
    world.progress(16, 16);

    // massDirty cleared again by PhysicsMassRecompute.
    expect(bodyRec.massDirty).toBe(false);
  });
});
