import { Exclusive, ON_STORE, Traversable, type Entity } from "@vworlds/vecs";
import {
  DrawBy,
  DrawIn,
  phaserNetworkComponents,
  phaserRenderableComponents,
  Position as RenderPosition,
  Rectangle,
  Rotation as RenderRotation,
} from "@vworlds/vecs-phaser";
import { Position as PhysicsPosition, Rotation as PhysicsRotation } from "@vworlds/vecs-physics";
import { ServerWorld } from "@vworlds/vecs-server";
import { describe, expect, it } from "vitest";

import { PhaserServerModule } from "../src/index.js";

function createWorld(): ServerWorld {
  const world = new ServerWorld({ name: "test", networkComponents: phaserNetworkComponents });
  world.component(PhysicsPosition);
  world.component(PhysicsRotation);
  return world;
}

describe("PhaserServerModule exclusivity", () => {
  it("configures display relationships consistently with the client", () => {
    const world = createWorld();
    world.module(PhaserServerModule);

    expect(world.component(DrawIn).has(Exclusive)).toBe(true);
    expect(world.component(DrawBy).has(Exclusive)).toBe(true);
    expect(world.component(DrawBy).has(Traversable)).toBe(true);
  });

  it("removes an existing renderable when a second renderable is set", () => {
    const world = createWorld();
    world.module(PhaserServerModule);
    const entity = world.entity().add(Rectangle);

    entity.set(phaserRenderableComponents[0], { radius: 0.25 });

    expect(entity.has(Rectangle)).toBe(false);
    expect(entity.has(phaserRenderableComponents[0])).toBe(true);
  });
});

describe("PhaserServerModule pose sync", () => {
  it("copies physics position and rotation into render pose", () => {
    const world = createWorld();
    world.module(PhaserServerModule);
    const entity = world
      .entity()
      .set(RenderPosition, { x: 0, y: 0 })
      .set(RenderRotation, { angle: 0 })
      .set(PhysicsPosition, { x: 1.5, y: -2.25 })
      .set(PhysicsRotation, { angle: Math.PI / 3 });

    world.progress(0, 16);

    expect(entity.get(RenderPosition)).toMatchObject({ x: 1.5, y: -2.25 });
    expect(entity.get(RenderRotation)).toMatchObject({ angle: Math.PI / 3 });
  });

  it("copies existing physics pose when render pose is added later", () => {
    const world = createWorld();
    world.module(PhaserServerModule);
    const entity = world
      .entity()
      .set(PhysicsPosition, { x: 1.5, y: -2.25 })
      .set(PhysicsRotation, { angle: Math.PI / 3 });

    world.progress(0, 16);
    entity.set(RenderPosition, { x: 0, y: 0 }).set(RenderRotation, { angle: 0 });
    world.progress(16, 16);

    expect(entity.get(RenderPosition)).toMatchObject({ x: 1.5, y: -2.25 });
    expect(entity.get(RenderRotation)).toMatchObject({ angle: Math.PI / 3 });
  });

  it("does not create RenderPosition when entity lacks it", () => {
    const world = createWorld();
    world.module(PhaserServerModule);
    const entity = world.entity().set(PhysicsPosition, { x: 3, y: 4 });

    world.progress(0, 16);

    expect(entity.has(RenderPosition)).toBe(false);
  });

  it("does not create RenderRotation when entity lacks it", () => {
    const world = createWorld();
    world.module(PhaserServerModule);
    const entity = world.entity().set(PhysicsRotation, { angle: 0.75 });

    world.progress(0, 16);

    expect(entity.has(RenderRotation)).toBe(false);
  });

  it("only marks render pose modified when physics pose changes", () => {
    const world = createWorld();
    world.module(PhaserServerModule);

    let positionUpdates = 0;
    let rotationUpdates = 0;
    world
      .system("RenderPositionObserver")
      .with(RenderPosition)
      .phase(ON_STORE)
      .update(RenderPosition, () => {
        positionUpdates++;
      });
    world
      .system("RenderRotationObserver")
      .with(RenderRotation)
      .phase(ON_STORE)
      .update(RenderRotation, () => {
        rotationUpdates++;
      });

    const entity = world
      .entity()
      .set(RenderPosition, { x: 0, y: 0 })
      .set(RenderRotation, { angle: 0 })
      .set(PhysicsPosition, { x: 1, y: 2 })
      .set(PhysicsRotation, { angle: 0.5 });

    world.progress(0, 16);
    expect(entity.get(RenderPosition)).toMatchObject({ x: 1, y: 2 });
    expect(entity.get(RenderRotation)).toMatchObject({ angle: 0.5 });
    expect(positionUpdates).toBe(1);
    expect(rotationUpdates).toBe(1);

    world.progress(16, 16);
    expect(positionUpdates).toBe(1);
    expect(rotationUpdates).toBe(1);

    entity.set(PhysicsPosition, { x: 3, y: 4 }).set(PhysicsRotation, { angle: 1.25 });
    world.progress(32, 16);
    expect(entity.get(RenderPosition)).toMatchObject({ x: 3, y: 4 });
    expect(entity.get(RenderRotation)).toMatchObject({ angle: 1.25 });
    expect(positionUpdates).toBe(2);
    expect(rotationUpdates).toBe(2);
  });

  it("leaves render rotation untouched when physics rotation is absent", () => {
    const world = createWorld();
    world.module(PhaserServerModule);
    const entity = world
      .entity()
      .set(RenderPosition, { x: 0, y: 0 })
      .set(RenderRotation, { angle: 2.5 })
      .set(PhysicsPosition, { x: 1, y: 2 });

    world.progress(0, 16);

    expect(entity.get(RenderPosition)).toMatchObject({ x: 1, y: 2 });
    expect(entity.get(RenderRotation)).toMatchObject({ angle: 2.5 });
  });
});

describe("PhaserServerModule pose sync writes only on change", () => {
  type PoseCounts = { position: number; rotation: number };

  /** Count every `set` of the render pose, as the `set` hook observes it. */
  function watchRenderWrites(world: ServerWorld): PoseCounts {
    const writes: PoseCounts = { position: 0, rotation: 0 };
    world.component(RenderPosition).on("set", () => {
      writes.position++;
    });
    world.component(RenderRotation).on("set", () => {
      writes.rotation++;
    });
    return writes;
  }

  /** Count the `update` events physics pose modifications deliver to a system after the sync. */
  function observePhysicsPose(world: ServerWorld): PoseCounts {
    const updates: PoseCounts = { position: 0, rotation: 0 };
    world
      .system("PhysicsPositionObserver")
      .with(PhysicsPosition)
      .phase(ON_STORE)
      .update(PhysicsPosition, () => {
        updates.position++;
      });
    world
      .system("PhysicsRotationObserver")
      .with(PhysicsRotation)
      .phase(ON_STORE)
      .update(PhysicsRotation, () => {
        updates.rotation++;
      });
    return updates;
  }

  /** An entity whose render pose equals its physics pose, already past its entry frame. */
  function createSyncedEntity(world: ServerWorld): Entity {
    const entity = world
      .entity()
      .set(RenderPosition, { x: 3, y: 4 })
      .set(RenderRotation, { angle: 1.5 })
      .set(PhysicsPosition, { x: 3, y: 4 })
      .set(PhysicsRotation, { angle: 1.5 });
    world.progress(0, 16);
    return entity;
  }

  it("does not modify the render pose when the physics pose is set to the value it holds", () => {
    const world = createWorld();
    world.module(PhaserServerModule);
    const physicsUpdates = observePhysicsPose(world);
    const entity = createSyncedEntity(world);
    const writes = watchRenderWrites(world);
    const updatesBefore = { ...physicsUpdates };

    entity.set(PhysicsPosition, { x: 3, y: 4 }).set(PhysicsRotation, { angle: 1.5 });
    world.progress(16, 16);

    // Physics did modify its pose, and the sync system saw it, but the render pose held the value.
    expect(physicsUpdates.position - updatesBefore.position).toBe(1);
    expect(physicsUpdates.rotation - updatesBefore.rotation).toBe(1);
    expect(writes).toEqual({ position: 0, rotation: 0 });
    expect(entity.get(RenderPosition)).toMatchObject({ x: 3, y: 4 });
    expect(entity.get(RenderRotation)).toMatchObject({ angle: 1.5 });
  });

  it("still copies a changed physics pose over the render pose", () => {
    const world = createWorld();
    world.module(PhaserServerModule);
    const entity = createSyncedEntity(world);
    const writes = watchRenderWrites(world);

    entity.set(PhysicsPosition, { x: 5, y: 6 }).set(PhysicsRotation, { angle: 2.5 });
    world.progress(16, 16);

    expect(writes).toEqual({ position: 1, rotation: 1 });
    expect(entity.get(RenderPosition)).toMatchObject({ x: 5, y: 6 });
    expect(entity.get(RenderRotation)).toMatchObject({ angle: 2.5 });
  });

  it.each([
    { name: "x", position: { x: 9, y: 4 } },
    { name: "y", position: { x: 3, y: 9 } },
  ])("copies a physics position that differs only in $name", ({ position }) => {
    const world = createWorld();
    world.module(PhaserServerModule);
    const entity = createSyncedEntity(world);
    const writes = watchRenderWrites(world);

    entity.set(PhysicsPosition, position);
    world.progress(16, 16);

    expect(writes).toEqual({ position: 1, rotation: 0 });
    expect(entity.get(RenderPosition)).toMatchObject(position);
  });

  it("does not write on entry when the render pose already holds the physics pose", () => {
    const world = createWorld();
    world.module(PhaserServerModule);
    const entity = world
      .entity()
      .set(RenderPosition, { x: 3, y: 4 })
      .set(RenderRotation, { angle: 1.5 })
      .set(PhysicsPosition, { x: 3, y: 4 })
      .set(PhysicsRotation, { angle: 1.5 });
    const writes = watchRenderWrites(world);

    world.progress(0, 16);

    expect(writes).toEqual({ position: 0, rotation: 0 });
    expect(entity.get(RenderPosition)).toMatchObject({ x: 3, y: 4 });
    expect(entity.get(RenderRotation)).toMatchObject({ angle: 1.5 });
  });

  it("writes on entry when the render pose differs from the physics pose", () => {
    const world = createWorld();
    world.module(PhaserServerModule);
    const entity = world
      .entity()
      .set(RenderPosition, { x: 0, y: 0 })
      .set(RenderRotation, { angle: 0 })
      .set(PhysicsPosition, { x: 3, y: 4 })
      .set(PhysicsRotation, { angle: 1.5 });
    const writes = watchRenderWrites(world);

    world.progress(0, 16);

    expect(writes).toEqual({ position: 1, rotation: 1 });
    expect(entity.get(RenderPosition)).toMatchObject({ x: 3, y: 4 });
    expect(entity.get(RenderRotation)).toMatchObject({ angle: 1.5 });
  });

  it("decides entry writes for position and rotation independently", () => {
    const world = createWorld();
    world.module(PhaserServerModule);
    const entity = world
      .entity()
      .set(RenderPosition, { x: 3, y: 4 })
      .set(RenderRotation, { angle: 0 })
      .set(PhysicsPosition, { x: 3, y: 4 })
      .set(PhysicsRotation, { angle: 1.5 });
    const writes = watchRenderWrites(world);

    world.progress(0, 16);

    expect(writes).toEqual({ position: 0, rotation: 1 });
    expect(entity.get(RenderRotation)).toMatchObject({ angle: 1.5 });
  });
});
