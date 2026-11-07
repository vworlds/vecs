import { ClientWorld } from "@vworlds/vecs-client";
import { Arc, phaserNetworkComponents, Position } from "@vworlds/vecs-phaser";
import { describe, expect, it } from "vitest";

import { PhaserRenderModule } from "../../src/index.js";
import { createMockScene } from "../mock_phaser.js";

describe("PhaserRenderModule coordinate origin", () => {
  it("passes a custom origin and pixel scale to rendering and sync", () => {
    const world = new ClientWorld({ networkComponents: phaserNetworkComponents });
    const scene = createMockScene(1920, 1080);
    world.module(PhaserRenderModule, { scene, pixelsPerMeter: 32, origin: { x: 0, y: -10 } });
    world.entity().set(Arc, { radius: 2 }).set(Position, { x: 2, y: 3 });
    world.progress(0, 0);

    expect(scene.created[0]!.createArgs).toEqual([0, 0, 64, -0, -360, false]);
    expect(scene.created[0]!.calls).toContainEqual({ method: "setPosition", args: [64, -106] });
    world.dispose();
  });

  it("keeps stationary, updated and new objects aligned after a canvas resize", () => {
    const world = new ClientWorld({ networkComponents: phaserNetworkComponents });
    const scene = createMockScene(1920, 1080);
    world.module(PhaserRenderModule, { scene });
    world.entity().add(Arc).set(Position, { x: 0, y: 0 });
    const moving = world.entity().add(Arc).set(Position, { x: 1, y: 1 });
    world.progress(0, 0);
    const stationary = scene.created[0]!;
    expect(stationary.calls).toContainEqual({ method: "setPosition", args: [960, 540] });
    stationary.calls.length = 0;

    scene.scale.width = 2560;
    scene.scale.height = 1440;
    moving.set(Position, { x: 0, y: 0 });
    world.entity().add(Arc).set(Position, { x: 0, y: 0 });
    world.progress(1, 0);

    expect(stationary.calls.filter((call) => call.method === "setPosition")).toEqual([]);
    for (const obj of scene.created.slice(1)) {
      const calls = obj.calls.filter((call) => call.method === "setPosition");
      expect(calls[calls.length - 1]).toEqual({
        method: "setPosition",
        args: [960, 540],
      });
    }
    world.dispose();
  });
});
