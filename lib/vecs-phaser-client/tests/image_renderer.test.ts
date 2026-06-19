import type { Entity } from "@vworlds/vecs";
import { ClientWorld } from "@vworlds/vecs-client";
import { Image, Position, Size, phaserNetworkComponents } from "@vworlds/vecs-phaser";
import Phaser from "phaser";
import { describe, expect, it } from "vitest";

import * as m from "../src/markers.js";
import { PhaserRenderModule } from "../src/index.js";
import { createMockScene } from "./mock_phaser.js";

describe("VPH-64 image renderer", () => {
  it("creates, updates, sizes, and destroys images", () => {
    const { entity, scene, world } = setupRuntime();

    entity.set(Image, { texture: 42, frame: 3 });
    tick(world);

    const image = scene.created[0];
    expect(image.kind).toBe("image");
    expect(image.createArgs).toEqual([0, 0, "42", 3]);
    expect(image.calls).toContainEqual({ method: "setOrigin", args: [0.5] });
    expect(entity.get(Phaser.GameObjects.Image)).toBe(image);
    expect(entity.get(m.GameObject)).toBe(image);

    entity.set(Image, { texture: 7, frame: 11 });
    tick(world);

    expect(image.calls).toContainEqual({ method: "setTexture", args: ["7", 11] });

    entity.set(Size, { width: 2, height: 1 });
    tick(world);

    expect(image.calls).toContainEqual({ method: "setDisplaySize", args: [128, 64] });

    entity.remove(Size);
    tick(world);

    entity.set(Position, { x: 1, y: -2 });
    tick(world);

    expect(image.calls).toContainEqual({ method: "setPosition", args: [576, 512] });

    entity.remove(Image);
    tick(world);

    expect(image.destroyed).toBe(true);
    expect(entity.get(Phaser.GameObjects.Image)).toBeUndefined();
    expect(entity.get(m.GameObject)).toBeUndefined();
  });

  it("leaves native size when Size is absent", () => {
    const { scene, world } = setupRuntime();

    const e = world.entity().set(Image, { texture: 1, frame: 0 });
    tick(world);

    const image = scene.created[0];
    expect(image.calls.some((c) => c.method === "setDisplaySize")).toBe(false);

    e.remove(Image);
    tick(world);
  });
});

function setupRuntime(): {
  entity: Entity;
  scene: ReturnType<typeof createMockScene>;
  world: ClientWorld;
} {
  const world = new ClientWorld();
  phaserNetworkComponents.forEach((ComponentClass) => world.component(ComponentClass));
  const scene = createMockScene(1024, 768);
  world.module(PhaserRenderModule, { scene });
  return { entity: world.entity(), scene, world };
}

function tick(world: ClientWorld): void {
  world.progress(0, 16);
}
