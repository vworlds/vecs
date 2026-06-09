import type { System } from "@vworlds/vecs";
import { ClientWorld } from "@vworlds/vecs-client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RenderContext } from "../src/render_context.js";
import { PhaserVecsRuntime } from "../src/runtime.js";
import { createMockScene, MockGameObject } from "./mock_phaser.js";

interface FakeSystem {
  readonly disable: ReturnType<typeof vi.fn>;
  readonly enable: ReturnType<typeof vi.fn>;
}

const renderers = vi.hoisted(() => ({
  contexts: [] as unknown[],
  installRenderSystems: vi.fn(),
  systems: [] as unknown[],
}));

vi.mock("../src/renderers/index.js", () => ({
  installRenderSystems: renderers.installRenderSystems,
}));

describe("PhaserVecsRuntime lifecycle", () => {
  beforeEach(() => {
    renderers.contexts.length = 0;
    renderers.systems.length = 0;
    renderers.installRenderSystems.mockReset();
    renderers.installRenderSystems.mockImplementation((ctx: RenderContext) => {
      const system: FakeSystem = { disable: vi.fn(), enable: vi.fn() };
      renderers.contexts.push(ctx);
      renderers.systems.push(system);
      ctx.trackSystem(system as unknown as System);
    });
  });

  it("installs render systems with the runtime context", () => {
    const world = new ClientWorld();
    const scene = createMockScene(1000, 800);
    const runtime = new PhaserVecsRuntime({ world, scene, pixelsPerMeter: 50 });

    runtime.start();

    expect(renderers.installRenderSystems).toHaveBeenCalledTimes(1);
    const ctx = renderers.contexts[0] as RenderContext;
    expect(ctx.world).toBe(world);
    expect(ctx.scene).toBe(scene);
    expect(ctx.interpolateRotation).toBe(true);
    expect(ctx.coords.x(0)).toBe(500);
    expect(ctx.coords.y(0)).toBe(400);
  });

  it("returns mapped game objects through runtime and context accessors", () => {
    const runtime = new PhaserVecsRuntime({ world: new ClientWorld(), scene: createMockScene() });

    runtime.start();
    const ctx = renderers.contexts[0] as RenderContext;
    const obj = new MockGameObject();

    ctx.setGameObject(42, obj as unknown as Phaser.GameObjects.GameObject);
    expect(runtime.getGameObject(42)).toBe(obj);
    expect(ctx.getGameObject(42)).toBe(obj);

    ctx.deleteGameObject(42);
    expect(runtime.getGameObject(42)).toBeUndefined();
    expect(obj.destroyed).toBe(false);
  });

  it("destroys mapped game objects, clears the map, unsubscribes reset, and disables systems on stop", () => {
    const world = new ClientWorld();
    const runtime = new PhaserVecsRuntime({ world, scene: createMockScene() });

    runtime.start();
    const ctx = renderers.contexts[0] as RenderContext;
    const obj = new MockGameObject();
    ctx.setGameObject(7, obj as unknown as Phaser.GameObjects.GameObject);

    runtime.stop();

    expect(obj.destroyed).toBe(true);
    expect(runtime.getGameObject(7)).toBeUndefined();
    expect((renderers.systems[0] as FakeSystem).disable).toHaveBeenCalledTimes(1);

    const afterStop = new MockGameObject();
    ctx.setGameObject(8, afterStop as unknown as Phaser.GameObjects.GameObject);
    world.events.emit("reset", { initial: false, fromFrame: 1, toFrame: 2 });
    expect(runtime.getGameObject(8)).toBe(afterStop);
    expect(afterStop.destroyed).toBe(false);
  });

  it("destroys lingering mapped game objects and clears the map on reset", () => {
    const world = new ClientWorld();
    const runtime = new PhaserVecsRuntime({ world, scene: createMockScene() });

    runtime.start();
    const ctx = renderers.contexts[0] as RenderContext;
    const obj = new MockGameObject();
    ctx.setGameObject(11, obj as unknown as Phaser.GameObjects.GameObject);

    world.events.emit("reset", { initial: false, fromFrame: 3, toFrame: 4 });

    expect(obj.destroyed).toBe(true);
    expect(runtime.getGameObject(11)).toBeUndefined();
  });

  it("does not double-install systems across repeated start cycles", () => {
    const runtime = new PhaserVecsRuntime({ world: new ClientWorld(), scene: createMockScene() });

    runtime.start();
    runtime.start();
    runtime.stop();
    runtime.start();

    expect(renderers.installRenderSystems).toHaveBeenCalledTimes(1);
    expect(renderers.systems).toHaveLength(1);
    expect((renderers.systems[0] as FakeSystem).disable).toHaveBeenCalledTimes(1);
    expect((renderers.systems[0] as FakeSystem).enable).toHaveBeenCalledTimes(1);
  });
});
