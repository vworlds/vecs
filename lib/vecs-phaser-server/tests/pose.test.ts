import { ON_UPDATE, POST_UPDATE } from "@vworlds/vecs";
import {
  phaserNetworkComponents,
  Position as RenderPosition,
  Rotation as RenderRotation,
} from "@vworlds/vecs-phaser";
import { Position as PhysicsPosition, Rotation as PhysicsRotation } from "@vworlds/vecs-physics";
import { ServerWorld } from "@vworlds/vecs-server";
import { describe, expect, it } from "vitest";

import { syncPhysicsPose } from "../src/index.js";

function createWorld(): ServerWorld {
  const world = new ServerWorld({ name: "test", networkComponents: phaserNetworkComponents });
  world.component(PhysicsPosition);
  world.component(PhysicsRotation);
  return world;
}

describe("syncPhysicsPose", () => {
  it("copies physics position and rotation into render pose", () => {
    const world = createWorld();
    syncPhysicsPose(world, { phase: ON_UPDATE });
    const entity = world
      .entity()
      .set(PhysicsPosition, { x: 1.5, y: -2.25 })
      .set(PhysicsRotation, { angle: Math.PI / 3 });

    world.progress(0, 16);

    expect(entity.get(RenderPosition)).toMatchObject({ x: 1.5, y: -2.25 });
    expect(entity.get(RenderRotation)).toMatchObject({ angle: Math.PI / 3 });
  });

  it("only marks render pose modified when physics pose changes", () => {
    const world = createWorld();
    syncPhysicsPose(world, { phase: ON_UPDATE });

    let positionUpdates = 0;
    let rotationUpdates = 0;
    world
      .system("RenderPositionObserver")
      .with(RenderPosition)
      .phase(POST_UPDATE)
      .update(RenderPosition, () => {
        positionUpdates++;
      });
    world
      .system("RenderRotationObserver")
      .with(RenderRotation)
      .phase(POST_UPDATE)
      .update(RenderRotation, () => {
        rotationUpdates++;
      });

    const entity = world
      .entity()
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
    syncPhysicsPose(world, { phase: ON_UPDATE });
    const entity = world
      .entity()
      .set(PhysicsPosition, { x: 1, y: 2 })
      .set(RenderRotation, { angle: 2.5 });

    world.progress(0, 16);

    expect(entity.get(RenderPosition)).toMatchObject({ x: 1, y: 2 });
    expect(entity.get(RenderRotation)).toMatchObject({ angle: 2.5 });
  });
});
