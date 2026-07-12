import { ClientWorld } from "@vworlds/vecs-client";
import { phaserNetworkComponents, Position, ScreenAnchor, Text } from "@vworlds/vecs-phaser";
import { describe, expect, it } from "vitest";

import { PhaserRenderModule } from "../src/index.js";
import { createMockScene, type MockGameObject, type RecordedCall } from "./mock_phaser.js";

describe("ScreenAnchorModule", () => {
  it("positions an anchored GameObject in screen pixels and pins it to the camera", () => {
    const { scene, world } = setup();
    const entity = world.entity();

    entity.set(Text, { value: "score" });
    entity.set(ScreenAnchor, { x: 0, y: 1, offsetX: 0.25, offsetY: -0.25 });
    world.progress(0, 0);

    const obj = scene.created[0]!;
    // x: 1024*0 + 64*0.25 = 16; y: 768*(1-1) - 64*(-0.25) = 16 (16px inset from top-left).
    expectCall(obj, "setPosition", [16, 16]);
    expectCall(obj, "setScrollFactor", [0]);
  });

  it("anchors to the bottom-right corner with math-convention y", () => {
    const { scene, world } = setup();
    const entity = world.entity();

    entity.set(Text, { value: "hud" });
    entity.set(ScreenAnchor, { x: 1, y: 0 });
    world.progress(0, 0);

    expectCall(scene.created[0]!, "setPosition", [1024, 768]);
  });

  it("re-lays out anchored entities when the canvas resizes", () => {
    const { scene, world } = setup();
    const entity = world.entity();

    entity.set(Text, { value: "hud" });
    entity.set(ScreenAnchor, { x: 0.5, y: 0.5 });
    world.progress(0, 0);

    const obj = scene.created[0]!;
    obj.calls.length = 0;
    scene.scale.width = 500;
    scene.scale.height = 300;
    world.progress(1, 0);
    world.progress(2, 0);

    expectCall(obj, "setPosition", [250, 150]);
  });

  it("does not world-position entities that carry ScreenAnchor", () => {
    const { scene, world } = setup();
    const entity = world.entity();

    entity.set(Text, { value: "hud" });
    entity.set(ScreenAnchor, { x: 0, y: 0 });
    entity.set(Position, { x: 1, y: 1 });
    world.progress(0, 0);

    const obj = scene.created[0]!;
    // phaser.sync.position (world coords 576/704 for 1,1) must not touch it.
    expect(obj.calls).not.toContainEqual({
      method: "setPosition",
      args: [576, 704],
    } satisfies RecordedCall);
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
