// `PhysicsModule` declares snapshot policies so a physics subtree can be moved
// between two physics worlds: declarative body/shape/joint data crosses, and
// every Box2D handle is reaped on the source and recreated on the destination.

import { ChildOf, type Entity, World } from "@vworlds/vecs";
import { beforeEach, describe, expect, it } from "vitest";

import { getPhysicsEngine } from "../../src/adapter/engine.js";
import {
  Body,
  BodyType,
  Box,
  Chain,
  Circle,
  ContactEvents,
  DistanceJoint,
  FilterJoint,
  JointAngularSpring,
  JointBodyA,
  JointBodyB,
  JointFrame,
  JointLimit,
  JointLinearSpring,
  JointMotor,
  JointSettings,
  LinearVelocity,
  MotorJoint,
  PhysicsModule,
  Polygon,
  Position,
  PrismaticJoint,
  RevoluteJoint,
  Rotation,
  ShapePosition,
  ShapeRotation,
  WeldJoint,
  WheelJoint,
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

function expectPlainData(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(expectPlainData);
  } else if (typeof value === "object" && value !== null) {
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    Object.values(value).forEach(expectPlainData);
  }
}

type JointClass =
  | typeof RevoluteJoint
  | typeof DistanceJoint
  | typeof PrismaticJoint
  | typeof WheelJoint
  | typeof WeldJoint
  | typeof FilterJoint
  | typeof MotorJoint;

const jointCases: readonly { name: string; Class: JointClass }[] = [
  { name: "revolute", Class: RevoluteJoint },
  { name: "distance", Class: DistanceJoint },
  { name: "prismatic", Class: PrismaticJoint },
  { name: "wheel", Class: WheelJoint },
  { name: "weld", Class: WeldJoint },
  { name: "filter", Class: FilterJoint },
  { name: "motor", Class: MotorJoint },
];

function addApplicableJointFeatures(
  joint: Entity,
  Class: JointClass,
  vector: { x: number; y: number }
): void {
  joint
    .set(JointFrame, { localAnchorA: vector, localAnchorB: { x: -3, y: 4 }, referenceAngle: 0.5 })
    .set(JointSettings, { collideConnected: true });

  if (Class === RevoluteJoint) {
    joint
      .set(JointMotor, { targetSpeed: 1.5, maxForce: 2.5 })
      .set(JointLimit, { lower: -0.25, upper: 0.75 })
      .set(JointAngularSpring, { hertz: 3.5, dampingRatio: 0.6 });
  } else if (Class === DistanceJoint || Class === PrismaticJoint || Class === WheelJoint) {
    joint
      .set(JointMotor, { targetSpeed: 1.5, maxForce: 2.5 })
      .set(JointLimit, { lower: 0.25, upper: 1.75 })
      .set(JointLinearSpring, { hertz: 3.5, dampingRatio: 0.6 });
  } else if (Class === WeldJoint) {
    joint
      .set(JointLinearSpring, { hertz: 3.5, dampingRatio: 0.6 })
      .set(JointAngularSpring, { hertz: 4.5, dampingRatio: 0.7 });
  } else if (Class === MotorJoint) {
    joint.set(MotorJoint, {
      linearVelocity: vector,
      maxVelocityForce: 2.5,
      angularVelocity: 1.5,
      maxVelocityTorque: 3.5,
      linearHertz: 4.5,
      linearDampingRatio: 0.7,
      maxSpringForce: 5.5,
      angularHertz: 6.5,
      angularDampingRatio: 0.8,
      maxSpringTorque: 7.5,
    });
  }
}

function expectApplicableJointFeatures(destination: Entity, Class: JointClass): void {
  expect(destination.get(JointFrame)).toMatchObject({
    localAnchorA: { x: 1, y: 2 },
    localAnchorB: { x: -3, y: 4 },
    referenceAngle: 0.5,
  });
  expect(destination.get(JointSettings)).toMatchObject({ collideConnected: true });

  if (Class === RevoluteJoint) {
    expect(destination.get(JointMotor)).toMatchObject({ targetSpeed: 1.5, maxForce: 2.5 });
    expect(destination.get(JointLimit)).toMatchObject({ lower: -0.25, upper: 0.75 });
    expect(destination.get(JointAngularSpring)).toMatchObject({ hertz: 3.5, dampingRatio: 0.6 });
  } else if (Class === DistanceJoint || Class === PrismaticJoint || Class === WheelJoint) {
    expect(destination.get(JointMotor)).toMatchObject({ targetSpeed: 1.5, maxForce: 2.5 });
    expect(destination.get(JointLimit)).toMatchObject({ lower: 0.25, upper: 1.75 });
    expect(destination.get(JointLinearSpring)).toMatchObject({ hertz: 3.5, dampingRatio: 0.6 });
  } else if (Class === WeldJoint) {
    expect(destination.get(JointLinearSpring)).toMatchObject({ hertz: 3.5, dampingRatio: 0.6 });
    expect(destination.get(JointAngularSpring)).toMatchObject({ hertz: 4.5, dampingRatio: 0.7 });
  } else if (Class === MotorJoint) {
    expect(destination.get(MotorJoint)).toMatchObject({
      linearVelocity: { x: 1, y: 2 },
      maxVelocityForce: 2.5,
      angularVelocity: 1.5,
      maxVelocityTorque: 3.5,
      linearHertz: 4.5,
      linearDampingRatio: 0.7,
      maxSpringForce: 5.5,
      angularHertz: 6.5,
      angularDampingRatio: 0.8,
      maxSpringTorque: 7.5,
    });
  }
}

describe("joint snapshot policies", () => {
  it.each(jointCases)(
    "restores a live default $name constraint from a nested forest",
    ({ Class }) => {
      const root = source.entity();
      const bodyA = source.entity().childOf(root).set(Body, { type: BodyType.Static });
      const bodyB = source
        .entity()
        .childOf(bodyA)
        .set(Body, { type: BodyType.Dynamic })
        .set(Position, { x: 2, y: 0 });
      source.entity().childOf(bodyB).set(Circle, { radius: 0.5 });
      const joint = source
        .entity()
        .childOf(root)
        .add(JointBodyA, bodyA)
        .add(JointBodyB, bodyB)
        .add(Class);
      step(source);

      const sourceJoint = joint.get(Class)!;
      const sourceJointId = sourceJoint._jointId!;
      expect(sourceJointId).toBeDefined();

      const snapshot = source.snapshotSubtree(root);
      for (const record of snapshot.entities) {
        for (const component of [...record.components, ...record.relationships]) {
          expectPlainData(component.data);
        }
      }

      const result = source.moveSubtree(root, destination);
      const movedJoint = result.sourceToDestination.get(joint)!;
      step(destination);

      const destinationJoint = movedJoint.get(Class)!;
      expect(destinationJoint).toBeInstanceOf(Class);
      expect(destinationJoint).not.toBe(sourceJoint);
      expect(destinationJoint._jointId).toBeDefined();
      expect(destinationJoint._jointId).not.toBe(sourceJointId);
      expect(getPhysicsEngine(destination).box2d.b2Joint_IsValid(destinationJoint._jointId!)).toBe(
        true
      );
      if (Class === DistanceJoint) {
        const movedBodyB = result.sourceToDestination.get(bodyB)!;
        step(destination, 30);
        expect(movedBodyB.get(Position)!.x).toBeCloseTo(1, 1);
      }
    }
  );

  it.each(jointCases)("moves plain applicable $name joint features", ({ Class }) => {
    const root = source.entity();
    const bodyA = source.entity().childOf(root).set(Body, { type: BodyType.Static });
    const bodyB = source
      .entity()
      .childOf(bodyA)
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 2, y: 0 });
    source.entity().childOf(bodyB).set(Circle, { radius: 0.5 });
    const joint = source
      .entity()
      .childOf(root)
      .add(JointBodyA, bodyA)
      .add(JointBodyB, bodyB)
      .add(Class);
    const vector = { x: 1, y: 2 };
    addApplicableJointFeatures(joint, Class, vector);
    step(source);

    const sourceJoint = joint.get(Class)!;
    const result = source.moveSubtree(root, destination);
    const movedJoint = result.sourceToDestination.get(joint)!;
    step(destination);

    const destinationJoint = movedJoint.get(Class)!;
    const destinationFrame = movedJoint.get(JointFrame)!;
    expect(destinationJoint).not.toBe(sourceJoint);
    expect(destinationJoint._jointId).toBeDefined();
    expect(destinationJoint._jointId).not.toBe(sourceJoint._jointId);
    expect(getPhysicsEngine(destination).box2d.b2Joint_IsValid(destinationJoint._jointId!)).toBe(
      true
    );
    expect(destinationFrame.localAnchorA).toEqual({ x: 1, y: 2 });
    expect(destinationFrame.localAnchorA).not.toBe(vector);
    expectApplicableJointFeatures(movedJoint, Class);
  });

  it("rejects a Box2D vector in a custom physics component field", () => {
    const vector = new (getPhysicsEngine(source).box2d.b2Vec2)(1, 2);
    const joint = source.entity().set(MotorJoint, { linearVelocity: vector });

    try {
      expect(() => source.snapshotSubtree(joint)).toThrow(
        /MotorJoint\.linearVelocity holds a b2Vec2, which the physics CustomSnapshot policy cannot copy/
      );
    } finally {
      vector.delete();
    }
  });

  it("rejects a Box2D vector in a default joint frame field", () => {
    const vector = new (getPhysicsEngine(source).box2d.b2Vec2)(1, 2);
    const joint = source.entity().set(JointFrame, { localAnchorA: vector });

    try {
      expect(() => source.snapshotSubtree(joint)).toThrow(
        /JointFrame\.localAnchorA holds a b2Vec2, which the default ClonePublic policy cannot copy/
      );
    } finally {
      vector.delete();
    }
  });

  it("rejects a class instance nested in polygon vertices", () => {
    class P {
      x = 1;
      y = 2;
    }
    const polygon = source.entity().set(Polygon, { vertices: [new P()] });

    expect(() => source.snapshotSubtree(polygon)).toThrow(
      /Polygon\.vertices\[0\] holds a P, which the physics CustomSnapshot policy cannot copy/
    );
  });
});

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

  it("integrates the preserved velocity in the destination world", () => {
    const root = source
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0 })
      .set(LinearVelocity, { x: 4, y: 0 });
    step(source);

    const moved = source.moveSubtree(root, destination).roots[0];
    const start = { ...moved.get(Position)! };
    step(destination, 15); // 15 frames of 1/60 s.

    const end = moved.get(Position)!;
    expect(end.x).toBeCloseTo(start.x + 4 * (15 / 60), 2);
    expect(end.y).toBeCloseTo(start.y, 2);
  });

  it("produces contacts with destination-only bodies, never with source ones", () => {
    // A static ground that exists only in the destination world.
    const ground = destination
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 10, y: 0 });
    const groundShape = destination.entity().childOf(ground).set(Box, { hx: 4, hy: 0.5 });
    step(destination);

    // The ship falls onto that ground after the move.
    const ship = source
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 10, y: 6 })
      .set(LinearVelocity, { x: 0, y: -4 });
    const shipShape = source.entity().childOf(ship).set(Box, { hx: 1, hy: 1 }).add(ContactEvents);
    step(source);

    // The source world keeps a decoy in the ship's place, so the source's own
    // contact detection is demonstrably working at the moment of the move.
    const decoy = source
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 10, y: 6 });
    const decoyShape = source
      .entity()
      .childOf(decoy)
      .set(Box, { hx: 1, hy: 1 })
      .set(ContactEvents, {});
    // Contact buffers are per-step, so read them on the frame they fill.
    step(source);
    expect(decoyShape.get(ContactEvents)!.begin.length).toBeGreaterThan(0);

    const result = source.moveSubtree(ship, destination);
    const movedShape = result.entities.get(shipShape.eid)!;

    // The opt-in survives automatically, but reports from the source do not.
    expect(movedShape.get(ContactEvents)).toEqual(new ContactEvents());
    for (let i = 0; i < 200 && movedShape.get(ContactEvents)!.begin.length === 0; i++) {
      step(destination);
    }

    const begin = movedShape.get(ContactEvents)!.begin;
    expect(begin.length).toBeGreaterThan(0);
    expect(begin[0]!.other.world).toBe(destination);
    expect(begin[0]!.other.eid).toBe(groundShape.eid);
    expect(destination.getEntity(groundShape.eid)).toBeDefined();

    // The source world never reports a contact for the moved ship again: its
    // own pair stops touching, and the source entities are gone.
    const decoyContacts: number[] = [];
    for (let i = 0; i < 20; i++) {
      step(source);
      decoyContacts.push(...decoyShape.get(ContactEvents)!.begin.map((e) => e.other.eid));
    }
    expect(decoyContacts).toEqual([]);
    expect(shipShape.destroyed).toBe(true);
    expect(movedShape.world).toBe(destination);
    expect(decoyShape.world).toBe(source);
    expect(decoyShape.get(Box)).toBeDefined();
    expect(source.getEntity(groundShape.eid)).toBeUndefined();
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
