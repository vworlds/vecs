import { ClientWorld } from "@vworlds/vecs-client";
import { phaserNetworkComponents } from "@vworlds/vecs-phaser";
import { describe, expect, it, vi } from "vitest";

import { InputCaptureModule, LocalInput } from "../src/index.js";
import { createMockScene, MockKey } from "./mock_phaser.js";

const ACTIONS = { left: ["A", "LEFT"], right: ["D", "RIGHT"], fire: ["SPACE"] } as const;

describe("InputCaptureModule", () => {
  it("sends a zero payload when nothing is pressed", () => {
    const { scene, setInput, world } = setup();
    scene.input.activePointer.worldX = 512; // scene center → 0 m
    scene.input.activePointer.worldY = 384;

    world.progress(0, 0);

    expect(setInput).toHaveBeenCalledWith({ a: 0, px: 0, py: 0, pd: false });
  });

  it("packs pressed keys from any bound key of an action", () => {
    const { scene, setInput, world } = setup();
    (scene.input.keyboard.addKey("LEFT") as MockKey).isDown = true;
    (scene.input.keyboard.addKey("SPACE") as MockKey).isDown = true;

    world.progress(0, 0);

    expect(setInput).toHaveBeenCalledWith(expect.objectContaining({ a: 0b101 }));
  });

  it("converts the pointer to meters and mirrors everything into LocalInput", () => {
    const { scene, setInput, world } = setup();
    scene.input.activePointer.worldX = 512 + 64; // +1 m
    scene.input.activePointer.worldY = 384 - 128; // +2 m
    scene.input.activePointer.isDown = true;
    (scene.input.keyboard.addKey("D") as MockKey).isDown = true;

    world.progress(0, 0);

    expect(setInput).toHaveBeenCalledWith({ a: 0b010, px: 1, py: 2, pd: true });
    expect(world.get(LocalInput)).toMatchObject({
      mask: 0b010,
      pointerX: 1,
      pointerY: 2,
      pointerDown: true,
    });
  });

  it("omits pointer fields when pointer capture is disabled", () => {
    const world = new ClientWorld({ networkComponents: phaserNetworkComponents });
    const scene = createMockScene(1024, 768);
    const setInput = vi.spyOn(world, "setInput");
    world.module(InputCaptureModule, {
      scene,
      actions: ACTIONS,
      pointer: false,
      pixelsPerMeter: 64,
    });

    world.progress(0, 0);

    expect(setInput).toHaveBeenCalledWith({ a: 0 });
  });
});

function setup(): {
  scene: ReturnType<typeof createMockScene>;
  setInput: ReturnType<typeof vi.spyOn>;
  world: ClientWorld;
} {
  const world = new ClientWorld({ networkComponents: phaserNetworkComponents });
  const scene = createMockScene(1024, 768);
  const setInput = vi.spyOn(world, "setInput");
  world.module(InputCaptureModule, { scene, actions: ACTIONS, pixelsPerMeter: 64 });
  return { scene, setInput, world };
}
