import { ClientWorld } from "@vworlds/vecs-client";
import { ParticleBurst, phaserNetworkComponents, Position } from "@vworlds/vecs-phaser";
import { describe, expect, it } from "vitest";

import { EffectsModule } from "../src/index.js";
import { createMockScene } from "./mock_phaser.js";

describe("EffectsModule", () => {
  it("explodes a burst at the entity's Position with frontier-converted config", () => {
    const { scene, world } = setup();
    const entity = world.entity();

    entity.set(Position, { x: 1, y: 2 });
    entity.set(ParticleBurst, {
      texture: 3,
      frame: 4,
      count: 24,
      speed: 2, // → 128 px/s max
      lifespanMs: 400,
      scale: 0.5,
      gravityY: -10, // math convention down → +640 px/s² in Phaser
      tint: 0xff8800,
    });
    world.progress(0, 0);

    expect(scene.emitters).toHaveLength(1);
    const emitter = scene.emitters[0]!;
    expect(emitter.x).toBe(576); // 512 + 64·1
    expect(emitter.y).toBe(256); // 384 − 64·2
    expect(emitter.key).toBe("3");
    expect(emitter.config).toMatchObject({
      emitting: false,
      frame: 4,
      gravityY: 640,
      lifespan: 400,
      scale: { start: 0.5, end: 0 },
      speed: { min: 64, max: 128 },
      tint: 0xff8800,
    });
    expect(emitter.exploded).toEqual([24]);
  });

  it("re-fires a burst on every set and disposes emitters after their lifespan", () => {
    const { scene, world } = setup();
    const entity = world.entity();

    entity.set(Position, { x: 0, y: 0 });
    entity.set(ParticleBurst, { texture: 1, count: 8, lifespanMs: 100 });
    world.progress(0, 0);
    entity.set(ParticleBurst, { texture: 1, count: 8, lifespanMs: 100 });
    world.progress(1, 0);

    expect(scene.emitters).toHaveLength(2);
    expect(scene.time.scheduled.map((entry) => entry.ms)).toEqual([100, 100]);

    scene.time.flush();
    expect(scene.emitters.every((emitter) => emitter.destroyed)).toBe(true);
  });

  it("does not fire without a Position", () => {
    const { scene, world } = setup();
    const entity = world.entity();

    entity.set(ParticleBurst, { texture: 1 });
    world.progress(0, 0);

    expect(scene.emitters).toHaveLength(0);
  });
});

function setup(): { scene: ReturnType<typeof createMockScene>; world: ClientWorld } {
  const world = new ClientWorld({ networkComponents: phaserNetworkComponents });
  const scene = createMockScene(1024, 768);
  world.module(EffectsModule, { scene, pixelsPerMeter: 64 });
  return { scene, world };
}
