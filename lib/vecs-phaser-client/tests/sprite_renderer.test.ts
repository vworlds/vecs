import { ClientWorld } from "@vworlds/vecs-client";
import { Animation, phaserNetworkComponents, Size, Sprite } from "@vworlds/vecs-phaser";
import { describe, expect, it } from "vitest";

import { PhaserRenderModule } from "../src/index.js";
import { createMockScene, type MockGameObject, type RecordedCall } from "./mock_phaser.js";

describe("Sprite renderer", () => {
  it("creates a Phaser Sprite showing the static frame", () => {
    const { scene, world } = setup();
    const entity = world.entity();

    entity.set(Sprite, { texture: 3, frame: 7 });
    world.progress(0, 0);

    const obj = scene.created[0]!;
    expect(obj.kind).toBe("sprite");
    expect(obj.createArgs).toEqual([0, 0, "3", 7]);
    expectCall(obj, "setOrigin", [0.5]);
  });

  it("plays the tileset animation while Animation is present and restores the frame on removal", () => {
    const { scene, world } = setup();
    const entity = world.entity();

    entity.set(Sprite, { texture: 3, frame: 7 });
    entity.set(Animation, { tile: 5, speed: 2 });
    world.progress(0, 0);

    const obj = scene.created[0]!;
    expectCall(obj, "play", ["3:5", true]);
    expect(obj.anims.timeScale).toBe(2);

    obj.calls.length = 0;
    entity.remove(Animation);
    world.progress(1, 0);

    expectCall(obj, "stop", []);
    expectCall(obj, "setTexture", ["3", 7]);
  });

  it("switches animations when the tile retargets and adjusts speed without restarting", () => {
    const { scene, world } = setup();
    const entity = world.entity();

    entity.set(Sprite, { texture: 3, frame: 0 });
    entity.set(Animation, { tile: 5 });
    world.progress(0, 0);

    const obj = scene.created[0]!;
    obj.calls.length = 0;
    entity.set(Animation, { tile: 9, speed: 0.5 });
    world.progress(1, 0);

    expectCall(obj, "play", ["3:9", true]);
    expect(obj.anims.timeScale).toBe(0.5);
  });

  it("does not apply static texture updates while an animation is playing", () => {
    const { scene, world } = setup();
    const entity = world.entity();

    entity.set(Sprite, { texture: 3, frame: 0 });
    entity.set(Animation, { tile: 5 });
    world.progress(0, 0);

    const obj = scene.created[0]!;
    obj.calls.length = 0;
    entity.set(Sprite, { texture: 3, frame: 2 });
    world.progress(1, 0);

    expect(obj.calls.some((call) => call.method === "setTexture")).toBe(false);
  });

  it("applies Size through setDisplaySize like Image", () => {
    const { scene, world } = setup();
    const entity = world.entity();

    entity.set(Sprite, { texture: 1, frame: 0 });
    entity.set(Size, { width: 2, height: 1 });
    world.progress(0, 0);

    expectCall(scene.created[0]!, "setDisplaySize", [128, 64]);
  });

  it("destroys the Phaser Sprite when the Sprite component leaves", () => {
    const { scene, world } = setup();
    const entity = world.entity();

    entity.set(Sprite, { texture: 1, frame: 0 });
    world.progress(0, 0);

    const obj = scene.created[0]!;
    entity.remove(Sprite);
    world.progress(1, 0);

    expect(obj.destroyed).toBe(true);
  });
});

function expectCall(obj: MockGameObject, method: string, args: readonly unknown[]): void {
  expect(obj.calls).toContainEqual({ method, args } satisfies RecordedCall);
}

function setup(): { scene: ReturnType<typeof createMockScene>; world: ClientWorld } {
  const world = new ClientWorld({ networkComponents: phaserNetworkComponents });
  const scene = createMockScene(1024, 768);
  world.module(PhaserRenderModule, { scene, pixelsPerMeter: 64 });
  return { scene, world };
}
