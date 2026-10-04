// `PhysicsModule` declares snapshot policies so a physics subtree can be moved
// between two physics worlds: declarative body/shape/joint data crosses, and
// every Box2D handle is reaped on the source and recreated on the destination.

import { ChildOf, World } from "@vworlds/vecs";
import { beforeEach, describe, expect, it } from "vitest";

import { getPhysicsEngine } from "../../src/adapter/engine.js";
import {
  Body,
  BodyType,
  Box,
  Chain,
  DistanceJoint,
  JointBodyA,
  JointBodyB,
  LinearVelocity,
  PhysicsModule,
  Position,
  Rotation,
  ShapePosition,
  ShapeRotation,
} from "../../src/index.js";

let source: World;
let destination: World;

beforeEach(() => {
  source = new World();
  source.module(PhysicsModule, { gravity: { x: 0, y: 0 } });
  destination = new World();
  destination.module(PhysicsModule, { gravity: { x: 0, y: 0 } });
});

/** Tick a world so its physics lifecycle systems run. */
function step(world: World, count = 1): void {
  for (let i = 0; i < count; i++) {
    world.progress((i + 1) * (1000 / 60), 1000 / 60);
  }
}

/** A dynamic body whose declarative pose has already been created in Box2D. */
function settledBody(world: World, x: number, y: number) {
  const entity = world.entity().set(Body, { type: BodyType.Dynamic }).set(Position, { x, y });
  step(world);
  expect(entity.get(Body)!._bodyId).toBeDefined();
  return entity;
}

describe("moveSubtree across two physics worlds", () => {
  it("moves a body with its declarative pose, rotation, and velocity", () => {
    const root = source
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 2, y: 3 })
      .set(Rotation, { angle: 0.5 })
      .set(LinearVelocity, { x: 1, y: -2 });

    const result = source.moveSubtree(root, destination);
    const moved = result.roots[0];

    expect(moved.world).toBe(destination);
    expect(moved.get(Body)!.type).toBe(BodyType.Dynamic);
    expect(moved.get(Position)).toMatchObject({ x: 2, y: 3 });
    expect(moved.get(Rotation)!.angle).toBe(0.5);
    expect(moved.get(LinearVelocity)).toMatchObject({ x: 1, y: -2 });
  });

  it("gives the destination body a fresh live handle", () => {
    const root = settledBody(source, 4, 5);
    const sourceBodyId = root.get(Body)!._bodyId!;

    const moved = source.moveSubtree(root, destination).roots[0];
    step(destination);

    const destinationBodyId = moved.get(Body)!._bodyId!;
    expect(destinationBodyId).toBeDefined();
    expect(destinationBodyId).not.toEqual(sourceBodyId);
    expect(getPhysicsEngine(destination).entityByBodyIndex.size).toBe(1);
  });

  it("reaps the source world's body and shape registrations", () => {
    const root = source.entity().set(Body, { type: BodyType.Dynamic });
    const shape = source.entity().childOf(root).set(Box, { hx: 1, hy: 1 });
    step(source);
    const engine = getPhysicsEngine(source);
    expect(engine.entityByBodyIndex.size).toBe(1);
    expect(engine.entityByShapeIndex.size).toBe(1);

    source.moveSubtree(root, destination);
    step(source);

    expect(engine.entityByBodyIndex.size).toBe(0);
    expect(engine.entityByShapeIndex.size).toBe(0);
    expect(engine.box2d.b2World_IsValid(engine.worldId)).toBe(true);
  });

  it("destroys the source entities", () => {
    const root = settledBody(source, 1, 1);
    const shape = source.entity().childOf(root).set(Box, { hx: 1, hy: 1 });

    source.moveSubtree(root, destination);

    expect(root.destroyed).toBe(true);
    expect(shape.destroyed).toBe(true);
    expect(source.getEntity(root.eid)).toBeUndefined();
  });

  it("moves a shape subtree and drops the Box2D shape handle", () => {
    const root = source.entity().set(Body, { type: BodyType.Dynamic });
    const shape = source
      .entity()
      .childOf(root)
      .set(Box, { hx: 2, hy: 3 })
      .set(Position, { x: 0, y: 1 });
    step(source);
    const sourceShapeId = shape.get(Box)!._shapeId!;
    expect(sourceShapeId).toBeDefined();

    const result = source.moveSubtree(root, destination);
    const movedShape = result.entities.get(shape.eid)!;

    expect(movedShape.get(Box)!.hx).toBe(2);
    expect(movedShape.get(Box)!.hy).toBe(3);
    expect(movedShape.get(Position)).toMatchObject({ x: 0, y: 1 });
    expect(movedShape.targets(ChildOf)).toHaveLength(1);
    expect(movedShape.targets(ChildOf)[0]).toBe(result.roots[0]);

    step(destination);
    const destinationShapeId = movedShape.get(Box)!._shapeId!;
    expect(destinationShapeId).toBeDefined();
    expect(destinationShapeId).not.toEqual(sourceShapeId);
  });

  it("moves a chain shape and drops its runtime segment indices", () => {
    const root = source.entity().set(Body, { type: BodyType.Dynamic });
    const chain = source
      .entity()
      .childOf(root)
      .set(Chain, {
        points: [
          { x: -1, y: 0 },
          { x: 1, y: 0 },
          { x: 1, y: 1 },
          { x: -1, y: 1 },
        ],
        loop: true,
      })
      .set(ShapePosition, { x: 0, y: 3 })
      .set(ShapeRotation, { angle: 0 });
    step(source, 5);
    expect(chain.get(Chain)!._chainId).toBeDefined();
    expect(chain.get(Chain)!._segmentIndices.length).toBeGreaterThan(0);

    const sourcePoints = chain.get(Chain)!.points;
    const moved = source.moveSubtree(root, destination).entities.get(chain.eid)!;

    expect(moved.get(Chain)!.points).toHaveLength(4);
    expect(moved.get(Chain)!.loop).toBe(true);
    expect(moved.get(Chain)!.points).not.toBe(sourcePoints);
    expect(moved.get(Chain)!.points[0]).not.toBe(sourcePoints[0]);
    expect(moved.get(Chain)!.points[1]).toMatchObject({ x: 1, y: 0 });
    expect(moved.get(ShapePosition)).toMatchObject({ x: 0, y: 3 });
    expect(moved.get(Chain)!._chainId).toBeUndefined();
    expect(moved.get(Chain)!._segmentIndices).toEqual([]);

    step(destination, 5);
    expect(moved.get(Chain)!._chainId).toBeDefined();
  });

  it("moves a joint and remaps both of its body edges", () => {
    const anchor = source.entity().set(Body, { type: BodyType.Static });
    const arm = source.entity().set(Body, { type: BodyType.Dynamic }).set(Position, { x: 3, y: 0 });
    const joint = source
      .entity()
      .add(JointBodyA, anchor)
      .add(JointBodyB, arm)
      .set(DistanceJoint, { length: 2 });
    step(source);
    expect(joint.get(DistanceJoint)!._jointId).toBeDefined();
    const sourceJointId = joint.get(DistanceJoint)!._jointId!;

    const result = source.moveSubtree([anchor, arm, joint], destination);
    const movedJoint = result.sourceToDestination.get(joint)!;

    expect(movedJoint.targets(JointBodyA)).toEqual([result.sourceToDestination.get(anchor)!]);
    expect(movedJoint.targets(JointBodyB)).toEqual([result.sourceToDestination.get(arm)!]);

    step(destination);
    expect(movedJoint.get(DistanceJoint)!.length).toBe(2);
    expect(movedJoint.get(DistanceJoint)!._jointId).toBeDefined();
    expect(movedJoint.get(DistanceJoint)!._jointId).not.toEqual(sourceJointId);
  });

  it("never attaches the source instance to the destination", () => {
    const root = settledBody(source, 1, 1);
    const sourceBody = root.get(Body)!;

    const moved = source.moveSubtree(root, destination).roots[0];

    expect(moved.get(Body)).not.toBe(sourceBody);
    expect(moved.get(Body)).toBeInstanceOf(Body);
  });

  it("leaves the source untouched for a restore-only transfer", () => {
    const root = settledBody(source, 2, 2);

    const result = source.restoreSubtree(destination, source.snapshotSubtree(root));

    expect(root.destroyed).toBe(false);
    expect(source.getEntity(root.eid)).toBe(root);
    expect(result.roots[0].world).toBe(destination);
    step(destination);
    expect(result.roots[0].get(Body)!._bodyId).toBeDefined();
  });

  it("keeps both worlds' physics state independent after a move", () => {
    const root = settledBody(source, 0, 5);

    const moved = source.moveSubtree(root, destination).roots[0];
    step(destination, 5);
    step(source, 5);

    expect(moved.get(Position)).toBeDefined();
    expect(getPhysicsEngine(source).entityByBodyIndex.size).toBe(0);
    expect(getPhysicsEngine(destination).entityByBodyIndex.size).toBe(1);
  });
});
