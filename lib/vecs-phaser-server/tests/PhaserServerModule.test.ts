import { ON_STORE } from "@vworlds/vecs";
import {
  phaserNetworkComponents,
  phaserRenderableComponents,
  Position as RenderPosition,
  Rectangle,
  Rotation as RenderRotation,
} from "@vworlds/vecs-phaser";
import { Position as PhysicsPosition, Rotation as PhysicsRotation } from "@vworlds/vecs-physics";
import { Networked, ServerWorld } from "@vworlds/vecs-server";
import { describe, expect, it } from "vitest";

import { PhaserServerModule } from "../src/index.js";

function createWorld(): ServerWorld {
  const world = new ServerWorld({ name: "test", networkComponents: phaserNetworkComponents });
  world.component(PhysicsPosition);
  world.component(PhysicsRotation);
  return world;
}

describe("PhaserServerModule exclusivity", () => {
  it("removes an existing renderable when a second renderable is set", () => {
    const world = createWorld();
    world.module(PhaserServerModule);
    const entity = world.entity().set(Rectangle, { width: 4, height: 5 });

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
    expect(positionUpdates).toBe(2);
    expect(rotationUpdates).toBe(2);

    world.progress(16, 16);
    expect(positionUpdates).toBe(2);
    expect(rotationUpdates).toBe(2);

    entity.set(PhysicsPosition, { x: 3, y: 4 }).set(PhysicsRotation, { angle: 1.25 });
    world.progress(32, 16);
    expect(entity.get(RenderPosition)).toMatchObject({ x: 3, y: 4 });
    expect(entity.get(RenderRotation)).toMatchObject({ angle: 1.25 });
    expect(positionUpdates).toBe(3);
    expect(rotationUpdates).toBe(3);
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
