import { ClientWorld } from "@vworlds/vecs-client";
import { Arc, phaserNetworkComponents, Position } from "@vworlds/vecs-phaser";
import { describe, expect, it } from "vitest";

import { PhaserRenderModule, VGameObject } from "../src/module.js";
import { createMockScene } from "./mock_phaser.js";

describe("PhaserRenderModule lifecycle", () => {
  it("registers VGameObject and creates render systems through world.module", () => {
    const world = new ClientWorld({ networkComponents: phaserNetworkComponents });
    const scene = createMockScene(1000, 800);

    const mod = world.module(PhaserRenderModule, { scene, pixelsPerMeter: 50 });

    expect(mod).toBeInstanceOf(PhaserRenderModule);
    expect(world.entity(VGameObject)).toBeDefined();
  });

  it("uses the default 64 pixels per meter when no scale is provided", () => {
    const world = new ClientWorld({ networkComponents: phaserNetworkComponents });
    const scene = createMockScene(1000, 800);
    world.module(PhaserRenderModule, { scene });
    const entity = world.entity();

    entity.set(Position, { x: 1, y: 1 });
    entity.set(Arc, { radius: 0.5 });
    world.progress(0, 0);

    const obj = scene.created[0]!;
    expect(obj.createArgs).toEqual([0, 0, 32, -0, -360, false]);
    expect(obj.calls).toContainEqual({ method: "setPosition", args: [564, 336] });
    expect(entity.get(VGameObject)?.obj).toBe(obj);
  });

  it("destroys the Phaser object when VGameObject is removed directly", () => {
    const world = new ClientWorld({ networkComponents: phaserNetworkComponents });
    const scene = createMockScene();
    world.module(PhaserRenderModule, { scene });
    const entity = world.entity();

    entity.set(Arc, { radius: 0.5 });
    world.progress(0, 0);

    const obj = scene.created[0]!;
    entity.remove(VGameObject);

    expect(obj.destroyed).toBe(true);
    expect(entity.get(VGameObject)).toBeUndefined();
  });
});
