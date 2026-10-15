import { Phase, World, type Entity } from "@vworlds/vecs";
import { describe, expect, it } from "vitest";

import {
  AngularVelocity,
  Body,
  BodyType,
  Circle,
  LinearVelocity,
  PhysicsModule,
  type PoseChanges,
  Position,
  Rotation,
  Sleep,
  physics,
} from "../../src/index.js";

const dt = 1000 / 30;

function ids(view: PoseChanges): number[] {
  return Array.from(view.eids.subarray(0, view.count));
}

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
  it("doubles eid capacity without losing teleports and exposes only the valid prefix", () => {
    const world = new World();
    world.module(PhysicsModule, { gravity: { x: 0, y: 0 } });
    try {
      const view = physics(world).poseChanges();
      const initial = view.eids;
      const entities = Array.from({ length: 130 }, () => body(world, BodyType.Static));
      world.progress(0, dt);
      expect(physics(world).poseChanges()).toBe(view);
      expect(view.eids).not.toBe(initial);
      expect(view.eids.length).toBeGreaterThanOrEqual(view.count);
      expect(Math.log2(view.eids.length) % 1).toBe(0);
      expect(new Set(ids(view))).toEqual(new Set(entities.map((entity) => entity.eid)));
      const grown = view.eids;
      world.progress(dt, dt);
      expect(view.eids).toBe(grown);
      expect(view.count).toBe(0);
      entities[0]!.set(Position, { x: 10, y: 0 });
      world.progress(dt * 2, dt);
      expect(view.eids).toBe(grown);
      expect(ids(view)).toEqual([entities[0]!.eid]);
    } finally {
      world.dispose();
    }
  });

  it("reuses a post-step view, expires its entries on the next pose-out and clears it on disposal", () => {
    const world = new World();
    world.module(PhysicsModule, { gravity: { x: 0, y: 0 } });
    const queries = physics(world);
    const view = queries.poseChanges();
    expect(view.count).toBe(0);
    expect(view.eids).toBeInstanceOf(Int32Array);
    const entity = body(world).set(LinearVelocity, { x: 1, y: 0 });
    world.progress(0, dt);
    expect(queries.poseChanges()).toBe(view);
    expect(ids(view)).toContain(entity.eid);
    const saved = ids(view);
    const buffer = view.eids;
    entity.destroy();
    world.progress(dt, dt);
    expect(view.count).toBe(0);
    expect(view.eids).toBe(buffer);
    expect(saved).toContain(entity.eid);
    const next = body(world);
    world.progress(dt * 2, dt);
    expect(ids(view)).toContain(next.eid);
    world.dispose();
    expect(queries.poseChanges()).toBe(view);
    expect(view.count).toBe(0);
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
      expect(ids(physics(world).poseChanges())).toEqual([spinning.eid]);
      expect(ids(physics(world).poseChanges())).not.toContain(fixed.eid);
      expect(ids(physics(world).poseChanges())).not.toContain(kinematic.eid);
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
      expect(ids(physics(world).poseChanges())).toContain(entity.eid);
      world.progress(frame * dt, dt);
      expect(ids(physics(world).poseChanges())).not.toContain(entity.eid);
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
      expect(view.count).toBe(0);
      sleeping.set(Position, { x: 10, y: 0 });
      fixed.set(Rotation, { angle: 1 });
      expect(view.count).toBe(0);
      world.progress(dt * 2, dt);
      expect(ids(view)).toContain(sleeping.eid);
      expect(ids(view)).toContain(fixed.eid);
      world.progress(dt * 3, dt);
      expect(ids(view)).not.toContain(fixed.eid);
    } finally {
      world.dispose();
    }
  });

  it.each(["destroy", "remove Body"])(
    "filters pending teleports and moves after %s before pose-out",
    (operation) => {
      const world = new World();
      let entity: Entity;
      let destroy = false;
      world
        .system("destroy before export")
        .phase(world.entity("physics-post").add(Phase))
        .run(() => {
          if (destroy) {
            if (operation === "destroy") {
              entity.destroy();
            } else {
              entity.remove(Body);
            }
          }
        });
      world.module(PhysicsModule, { gravity: { x: 0, y: 0 } });
      try {
        entity = body(world).set(LinearVelocity, { x: 1, y: 0 });
        world.progress(0, dt);
        entity.set(Position, { x: 10, y: 0 });
        destroy = true;
        world.progress(dt, dt);
        expect(physics(world).poseChanges().count).toBe(0);
      } finally {
        world.dispose();
      }
    }
  );
});
