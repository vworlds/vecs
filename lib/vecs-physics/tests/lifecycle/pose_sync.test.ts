import { DependsOn, Entity, Phase, World } from "@vworlds/vecs";
import { beforeEach, describe, expect, it } from "vitest";

import {
  AngularVelocity,
  Body,
  BodyType,
  Box,
  LinearVelocity,
  Position,
  Rotation,
  PhysicsModule,
} from "../../src/index.js";
import { getPhysics, type PhysicsState } from "../../src/adapter/state.js";

let world: World;
let state: PhysicsState;

beforeEach(() => {
  world = new World();
  world.module(PhysicsModule, { gravity: { x: 0, y: 0 } });
  state = getPhysics(world) as PhysicsState;
});

function bodyId(entity: Entity): NonNullable<ReturnType<PhysicsState["bodyByEntityWasm"]["get"]>> {
  return state.bodyByEntityWasm.get(entity.eid)!;
}

function readBodyPosition(entity: Entity): { x: number; y: number } {
  const pos = state.box2d.b2Body_GetPosition(bodyId(entity));
  try {
    return { x: pos.x, y: pos.y };
  } finally {
    pos.delete();
  }
}

function readBodyRotation(entity: Entity): number {
  const rot = state.box2d.b2Body_GetRotation(bodyId(entity));
  try {
    return rot.GetAngle();
  } finally {
    rot.delete();
  }
}

function readLinearVelocity(entity: Entity): { x: number; y: number } {
  const velocity = state.box2d.b2Body_GetLinearVelocity(bodyId(entity));
  try {
    return { x: velocity.x, y: velocity.y };
  } finally {
    velocity.delete();
  }
}

function setWasmTransform(entity: Entity, x: number, y: number, angle = 0): void {
  const pos = new state.box2d.b2Vec2(x, y);
  const rot = state.box2d.b2MakeRot(angle);
  try {
    state.box2d.b2Body_SetTransform(bodyId(entity), pos, rot);
  } finally {
    rot.delete();
    pos.delete();
  }
}

function readShapeCenterX(shape: Entity): number {
  const shapeId = state.shapeByEntityWasm.get(shape.eid)!;
  const aabb = state.box2d.b2Shape_GetAABB(shapeId);
  try {
    return (aabb.lowerBound.x + aabb.upperBound.x) / 2;
  } finally {
    aabb.delete();
  }
}

describe("PhysicsPoseSyncIn (user -> engine)", () => {
  it("teleports the body origin when the user writes Position", () => {
    const entity = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0 });
    world.progress(0, 16);

    entity.set(Position, { x: 5, y: 6 });
    world.progress(16, 16);

    expect(readBodyPosition(entity)).toEqual({ x: 5, y: 6 });
  });

  it("teleports the body rotation when the user writes Rotation", () => {
    const entity = world.entity().set(Body, { type: BodyType.Dynamic }).set(Rotation, { angle: 0 });
    world.progress(0, 16);

    entity.set(Rotation, { angle: Math.PI / 2 });
    world.progress(16, 16);

    expect(readBodyRotation(entity)).toBeCloseTo(Math.PI / 2, 6);
  });

  it("applies user linear and angular velocity to the body", () => {
    const entity = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(LinearVelocity, { x: 0, y: 0 })
      .set(AngularVelocity, { value: 0 });
    world.progress(0, 16);

    entity.set(LinearVelocity, { x: 3, y: 4 });
    entity.set(AngularVelocity, { value: 7 });
    world.progress(16, 16);

    expect(readLinearVelocity(entity)).toEqual({ x: 3, y: 4 });
    expect(state.box2d.b2Body_GetAngularVelocity(bodyId(entity))).toBe(7);
  });

  it("does not throw for velocity writes on a static body", () => {
    const entity = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(LinearVelocity, { x: 0, y: 0 });
    world.progress(0, 16);

    entity.set(LinearVelocity, { x: 3, y: 4 });
    expect(() => world.progress(16, 16)).not.toThrow();
  });
});

describe("PhysicsPoseSyncOut (engine -> user)", () => {
  it("writes the simulated pose back to a dynamic body's components", () => {
    const entity = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0 });
    world.progress(0, 16);

    setWasmTransform(entity, 9, -1);
    world.progress(16, 16);

    expect(entity.get(Position)).toMatchObject({ x: 9, y: -1 });
  });

  it("does not write back a kinematic body's user-owned pose", () => {
    const entity = world
      .entity()
      .set(Body, { type: BodyType.Kinematic })
      .set(Position, { x: 0, y: 0 });
    world.progress(0, 16);

    setWasmTransform(entity, 9, 0);
    world.progress(16, 16);

    expect(entity.get(Position)!.x).toBe(0);
  });
});

describe("body transform updates attached shapes", () => {
  it("Position teleport moves the attached shape AABB without recreating the shape", () => {
    const body = world.entity().set(Body, { type: BodyType.Static }).set(Position, { x: 0, y: 0 });
    const shape = world.entity().childOf(body).set(Box, { hx: 0.5, hy: 0.5 });
    world.progress(0, 16);
    const shapeId = state.shapeByEntityWasm.get(shape.eid);

    body.set(Position, { x: 10, y: 0 });
    world.progress(16, 16);

    expect(state.shapeByEntityWasm.get(shape.eid)).toBe(shapeId);
    expect(readShapeCenterX(shape)).toBeCloseTo(10, 3);
  });
});

describe("pose-sync feedback suppression", () => {
  it("does not re-apply the engine's own write-back as a teleport", () => {
    const entity = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0 });
    world.progress(0, 16);

    setWasmTransform(entity, 7, 0);
    world.progress(16, 16);
    setWasmTransform(entity, 8, 0);
    world.progress(32, 16);

    expect(entity.get(Position)!.x).toBe(8);
  });

  it("delivers the engine write-back to a non-physics user system", () => {
    const userWorld = new World();
    userWorld.module(PhysicsModule, { gravity: { x: 0, y: 0 } });
    const render = userWorld
      .entity("render")
      .add(Phase)
      .set(DependsOn, { target: userWorld.entity("physics-post") });

    let lastSeenX: number | undefined;
    let count = 0;
    userWorld
      .system("UserRender")
      .with(Body)
      .phase(render)
      .update(Position, (_entity, position) => {
        lastSeenX = position.x;
        count++;
      });
    const userState = getPhysics(userWorld) as PhysicsState;
    const entity = userWorld
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0 });
    userWorld.progress(0, 16);

    const pos = new userState.box2d.b2Vec2(4, 0);
    const rot = userState.box2d.b2MakeRot(0);
    try {
      userState.box2d.b2Body_SetTransform(userState.bodyByEntityWasm.get(entity.eid)!, pos, rot);
    } finally {
      rot.delete();
      pos.delete();
    }
    count = 0;
    userWorld.progress(16, 16);

    expect(count).toBe(1);
    expect(lastSeenX).toBe(4);
  });
});
