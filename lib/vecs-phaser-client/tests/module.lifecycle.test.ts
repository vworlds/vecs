import { ClientWorld } from "@vworlds/vecs-client";
import { Arc, phaserNetworkComponents, Position } from "@vworlds/vecs-phaser";
import Phaser from "phaser";
import { describe, expect, it } from "vitest";

import * as m from "../src/markers.js";
import { PhaserRenderModule } from "../src/index.js";
import { createMockScene } from "./mock_phaser.js";

describe("PhaserRenderModule lifecycle", () => {
  it("releases GameObjects once before destroying render infrastructure", () => {
    const world = new ClientWorld({ networkComponents: phaserNetworkComponents });
    const scene = createMockScene();
    const module = world.module(PhaserRenderModule, { scene });
    world.entity().set(Arc, { radius: 0.5 });
    world.progress(0, 0);
    const object = scene.created[0]!;
    world.dispose();
    world.dispose();
    expect(object.isDestroyed).toBe(true);
    expect(object.calls.filter((call) => call.method === "destroy")).toHaveLength(1);
    expect(module.destroyed).toBe(true);
    expect(world.entities.values()).toEqual([]);
  });

  it("registers internal Phaser aliases and creates render systems through world.module", () => {
    const world = new ClientWorld({ networkComponents: phaserNetworkComponents });
    const scene = createMockScene(1000, 800);

    const mod = world.module(PhaserRenderModule, { scene, pixelsPerMeter: 50 });

    expect(mod).toBeInstanceOf(PhaserRenderModule);
    expect(world.entity(m.GameObject)).toBeDefined();
    expect(world.entity(Phaser.GameObjects.Arc)).toBeDefined();
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
    expect(entity.get(Phaser.GameObjects.Arc)).toBe(obj);
    expect(entity.get(m.GameObject)).toBe(obj);
  });

  it("destroys the Phaser object when its concrete component is removed directly", () => {
    const world = new ClientWorld({ networkComponents: phaserNetworkComponents });
    const scene = createMockScene();
    world.module(PhaserRenderModule, { scene });
    const entity = world.entity();

    entity.set(Arc, { radius: 0.5 });
    world.progress(0, 0);

    const obj = scene.created[0]!;
    entity.remove(Phaser.GameObjects.Arc);

    expect(obj.isDestroyed).toBe(true);
    expect(entity.get(Phaser.GameObjects.Arc)).toBeUndefined();
    expect(entity.get(m.GameObject)).toBeUndefined();
  });
});
