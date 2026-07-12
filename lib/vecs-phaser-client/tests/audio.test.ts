import { ClientWorld } from "@vworlds/vecs-client";
import { Music, phaserNetworkComponents, Sound } from "@vworlds/vecs-phaser";
import { describe, expect, it } from "vitest";

import { AudioModule } from "../src/index.js";
import { createMockScene } from "./mock_phaser.js";

describe("AudioModule", () => {
  it("plays a one-shot Sound on entry and again on every set", () => {
    const { scene, world } = setup();
    const entity = world.entity();

    entity.set(Sound, { asset: 9, volume: 0.5, rate: 1.25 });
    world.progress(0, 0);

    expect(scene.sound.played).toEqual([{ key: "9", config: { rate: 1.25, volume: 0.5 } }]);

    entity.set(Sound, { asset: 9, volume: 0.5, rate: 1.25 });
    world.progress(1, 0);

    expect(scene.sound.played).toHaveLength(2);
  });

  it("starts Music on entry and stops/destroys the playback on removal", () => {
    const { scene, world } = setup();
    const entity = world.entity();

    entity.set(Music, { asset: 4, volume: 0.8, loop: true });
    world.progress(0, 0);

    const playback = scene.sound.added[0]!;
    expect(playback.key).toBe("4");
    expect(playback.config).toEqual({ loop: true, volume: 0.8 });
    expect(playback.calls).toContainEqual({ method: "play", args: [] });

    entity.remove(Music);
    world.progress(1, 0);

    expect(playback.stopped).toBe(true);
    expect(playback.destroyed).toBe(true);
  });

  it("stops Music when the entity is destroyed (baseline reset path)", () => {
    const { scene, world } = setup();
    const entity = world.entity();

    entity.set(Music, { asset: 4 });
    world.progress(0, 0);

    entity.destroy();
    world.progress(1, 0);

    expect(scene.sound.added[0]!.stopped).toBe(true);
    expect(scene.sound.added[0]!.destroyed).toBe(true);
  });

  it("applies volume and loop changes to the live playback without restarting", () => {
    const { scene, world } = setup();
    const entity = world.entity();

    entity.set(Music, { asset: 4, volume: 1, loop: true });
    world.progress(0, 0);

    const playback = scene.sound.added[0]!;
    playback.calls.length = 0;
    entity.set(Music, { asset: 4, volume: 0.25, loop: false });
    world.progress(1, 0);

    expect(playback.calls).toContainEqual({ method: "setVolume", args: [0.25] });
    expect(playback.calls).toContainEqual({ method: "setLoop", args: [false] });
    expect(playback.calls.some((call) => call.method === "play")).toBe(false);
    expect(scene.sound.added).toHaveLength(1);
  });
});

function setup(): { scene: ReturnType<typeof createMockScene>; world: ClientWorld } {
  const world = new ClientWorld({ networkComponents: phaserNetworkComponents });
  const scene = createMockScene(1024, 768);
  world.module(AudioModule, { scene });
  return { scene, world };
}
