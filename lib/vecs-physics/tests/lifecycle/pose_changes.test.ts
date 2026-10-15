import { Phase, World, type Entity } from "@vworlds/vecs";
import { describe, expect, it } from "vitest";

import {
  AngularVelocity,
  Body,
  BodyType,
  Circle,
  LinearVelocity,
  PhysicsModule,
  Position,
  Rotation,
  Sleep,
  physics,
} from "../../src/index.js";

const dt = 1000 / 30;

function body(world: World, type = BodyType.Dynamic, awake = true): Entity {
  const entity = world
    .entity()
    .set(Body, { type })
    .set(Position, { x: 0, y: 0 })
    .add(Rotation)
    .set(Sleep, { awake });
  world.entity().childOf(entity).set(Circle, { radius: 0.5 });
  return entity;
}

describe("physics poseChanges", () => {
  it("reuses a post-step view, expires its entries on the next pose-out and clears it on disposal", () => {
    const world = new World();
    world.module(PhysicsModule, { gravity: { x: 0, y: 0 } });
    const queries = physics(world);
    const view = queries.poseChanges();
    expect(view).toEqual([]);
    const entity = body(world).set(LinearVelocity, { x: 1, y: 0 });
    world.progress(0, dt);
    expect(queries.poseChanges()).toBe(view);
    expect(view).toContain(entity);
    const saved = [...view];
    entity.destroy();
    world.progress(dt, dt);
    expect(view).toEqual([]);
    expect(saved).toContain(entity);
    const next = body(world);
    world.progress(dt * 2, dt);
    expect(view).toContain(next);
    world.dispose();
    expect(queries.poseChanges()).toBe(view);
    expect(view).toEqual([]);
  });

  it("filters non-Dynamic move events and publishes rotation-only Dynamic moves", () => {
    const world = new World();
    world.module(PhysicsModule, { gravity: { x: 0, y: 0 } });
    try {
      const fixed = body(world, BodyType.Static).set(Position, { x: -10, y: 0 });
      const kinematic = body(world, BodyType.Kinematic)
        .set(Position, { x: 10, y: 0 })
        .set(LinearVelocity, { x: 1, y: 0 });
      const spinning = body(world).set(AngularVelocity, { value: 1 });
      world.progress(0, dt);
      const before = { ...spinning.get(Position)! };
      world.progress(dt, dt);
      expect(physics(world).poseChanges()).toEqual([spinning]);
      expect(physics(world).poseChanges()).not.toContain(fixed);
      expect(physics(world).poseChanges()).not.toContain(kinematic);
      expect(spinning.get(Position)).toEqual(before);
      expect(spinning.get(Rotation)!.angle).not.toBe(0);
    } finally {
      world.dispose();
    }
  });

  it("includes the final sleep event even with an unchanged pose, then leaves the sleeper out", () => {
    const world = new World();
    world.module(PhysicsModule, { gravity: { x: 0, y: 0 } });
    try {
      const entity = body(world);
      world.progress(0, dt);
      const pose = { ...entity.get(Position)! };
      let frame = 1;
      while (physics(world).isAwake(entity) && frame < 90) {
        world.progress(frame++ * dt, dt);
      }
      expect(physics(world).isAwake(entity)).toBe(false);
      expect(entity.get(Position)).toEqual(pose);
      expect(physics(world).poseChanges()).toContain(entity);
      world.progress(frame * dt, dt);
      expect(physics(world).poseChanges()).not.toContain(entity);
    } finally {
      world.dispose();
    }
  });

  it("publishes sleeping and static application teleports after pose-in, not at the write site", () => {
    const world = new World();
    world.module(PhysicsModule, { gravity: { x: 0, y: 0 } });
    try {
      const sleeping = body(world, BodyType.Dynamic, false);
      const fixed = body(world, BodyType.Static);
      world.progress(0, dt);
      world.progress(dt, dt);
      const view = physics(world).poseChanges();
      expect(view).toEqual([]);
      sleeping.set(Position, { x: 10, y: 0 });
      fixed.set(Rotation, { angle: 1 });
      expect(view).toEqual([]);
      world.progress(dt * 2, dt);
      expect(view).toContain(sleeping);
      expect(view).toContain(fixed);
      world.progress(dt * 3, dt);
      expect(view).not.toContain(fixed);
    } finally {
      world.dispose();
    }
  });

  it("does not publish a move for an entity destroyed after stepping but before pose-out", () => {
    const world = new World();
    let entity: Entity;
    let destroy = false;
    world
      .system("destroy before export")
      .phase(world.entity("physics-post").add(Phase))
      .run(() => {
        if (destroy) {
          entity.destroy();
        }
      });
    world.module(PhysicsModule, { gravity: { x: 0, y: 0 } });
    try {
      entity = body(world).set(LinearVelocity, { x: 1, y: 0 });
      world.progress(0, dt);
      destroy = true;
      world.progress(dt, dt);
      expect(physics(world).poseChanges()).toEqual([]);
    } finally {
      world.dispose();
    }
  });
});
