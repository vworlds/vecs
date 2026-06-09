import type { System } from "@vworlds/vecs";
import { ClientWorld } from "@vworlds/vecs-client";
import {
  Alpha,
  Depth,
  FillStyle,
  phaserNetworkComponents,
  Position,
  Rotation,
  Scale,
  StrokeStyle,
} from "@vworlds/vecs-phaser";
import { describe, expect, it } from "vitest";

import { CoordSpace } from "../src/coord_space.js";
import type { RenderContext } from "../src/render_context.js";
import { installRenderSystems } from "../src/renderers/index.js";
import { installSyncSystems, phaserInterpolators, rotationInterpolator } from "../src/sync.js";
import { createMockScene, MockGameObject, type RecordedCall } from "./mock_phaser.js";

describe("installSyncSystems", () => {
  it("applies transform and style updates to the mapped GameObject", () => {
    const { ctx, obj, tick, world } = setupSyncContext();
    const entity = world.entity();
    ctx.setGameObject(entity.eid, obj as unknown as Phaser.GameObjects.GameObject);

    entity.set(Position, { x: 1.5, y: -2 });
    entity.set(Rotation, { angle: Math.PI / 4 });
    entity.set(Scale, { x: 2, y: 3 });
    entity.set(Alpha, { value: 0.4 });
    entity.set(Depth, { value: 9 });
    entity.set(FillStyle, { color: 0xff0000, alpha: 0.75 });
    entity.set(StrokeStyle, { width: 5, color: 0x00ff00, alpha: 0.5 });
    tick();

    expectCall(obj, "setPosition", [ctx.coords.x(1.5), ctx.coords.y(-2)]);
    expectCall(obj, "setRotation", [ctx.coords.rot(Math.PI / 4)]);
    expectCall(obj, "setScale", [2, 3]);
    expectCall(obj, "setAlpha", [0.4]);
    expectCall(obj, "setDepth", [9]);
    expectCall(obj, "setFillStyle", [0xff0000, 0.75]);
    expectCall(obj, "setStrokeStyle", [5, 0x00ff00, 0.5]);
  });

  it("safely no-ops when an updated entity has no mapped GameObject", () => {
    const { tick, world } = setupSyncContext();

    world.entity().set(Position, { x: 1, y: 2 });

    expect(() => tick()).not.toThrow();
  });

  it("tracks all installed sync systems", () => {
    const { systems } = setupSyncContext();

    expect(systems).toHaveLength(7);
  });
});

describe("installRenderSystems", () => {
  it("wires shared sync systems into the renderer installer", () => {
    const { systems } = setupRenderContext();

    // installRenderSystems installs the 7 shared sync systems plus whatever
    // shape renderers are wired in; assert the sync systems are present without
    // coupling to the renderer count (which grows as shape renderers land).
    expect(systems.length).toBeGreaterThanOrEqual(7);
  });
});

describe("rotationInterpolator", () => {
  it("lerps Rotation over the shortest arc without mutating inputs", () => {
    const source = new Rotation();
    const target = new Rotation();
    source.angle = degrees(350);
    target.angle = degrees(10);

    const result = rotationInterpolator(source, target, 0.5);

    expect(result).toBeInstanceOf(Rotation);
    expect(result).not.toBe(source);
    expect(result).not.toBe(target);
    expect((result as Rotation).angle).toBeCloseTo(0);
    expect(source.angle).toBeCloseTo(degrees(350));
    expect(target.angle).toBeCloseTo(degrees(10));
  });

  it("returns fresh Rotation instances with exact endpoint angles", () => {
    const source = new Rotation();
    const target = new Rotation();
    source.angle = -0.5;
    target.angle = 0.5;

    const atSource = rotationInterpolator(source, target, 0);
    const atTarget = rotationInterpolator(source, target, 1);

    expect(atSource).toBeInstanceOf(Rotation);
    expect(atTarget).toBeInstanceOf(Rotation);
    expect(atSource).not.toBe(source);
    expect(atTarget).not.toBe(target);
    expect((atSource as Rotation).angle).toBe(source.angle);
    expect((atTarget as Rotation).angle).toBe(target.angle);
  });
});

describe("phaserInterpolators", () => {
  it("includes the derived Rotation type id by default", () => {
    expect(phaserNetworkComponents.indexOf(Rotation) + 1).toBe(2);
    expect(phaserInterpolators()).toEqual([[2, rotationInterpolator]]);
  });

  it("returns no interpolators when rotation interpolation is disabled", () => {
    expect(phaserInterpolators({ interpolateRotation: false })).toEqual([]);
  });
});

function degrees(value: number): number {
  return (value * Math.PI) / 180;
}

function expectCall(obj: MockGameObject, method: string, args: readonly unknown[]): void {
  expect(obj.calls).toContainEqual({ method, args } satisfies RecordedCall);
}

function setupRenderContext(): { ctx: RenderContext; systems: System[]; world: ClientWorld } {
  const world = new ClientWorld({ networkComponents: phaserNetworkComponents });
  const scene = createMockScene(1024, 768);
  const gameObjects = new Map<number, Phaser.GameObjects.GameObject>();
  const systems: System[] = [];
  const ctx: RenderContext = {
    world,
    scene,
    coords: new CoordSpace(scene, 64),
    interpolateRotation: true,
    getGameObject: (eid) => gameObjects.get(eid),
    setGameObject: (eid, obj) => {
      gameObjects.set(eid, obj);
    },
    deleteGameObject: (eid) => {
      gameObjects.delete(eid);
    },
    trackSystem: (system) => systems.push(system),
  };
  installRenderSystems(ctx);
  return { ctx, systems, world };
}

function setupSyncContext(): {
  ctx: RenderContext;
  obj: MockGameObject;
  systems: System[];
  tick: () => void;
  world: ClientWorld;
} {
  const { ctx, systems, world } = setupRenderContextBase();
  installSyncSystems(ctx);
  const obj = new MockGameObject();
  return {
    ctx,
    obj,
    systems,
    tick: () => {
      world.progress(0, 0);
      world.progress(0, 0);
    },
    world,
  };
}

function setupRenderContextBase(): { ctx: RenderContext; systems: System[]; world: ClientWorld } {
  const world = new ClientWorld({ networkComponents: phaserNetworkComponents });
  const scene = createMockScene(1024, 768);
  const gameObjects = new Map<number, Phaser.GameObjects.GameObject>();
  const systems: System[] = [];
  const ctx: RenderContext = {
    world,
    scene,
    coords: new CoordSpace(scene, 64),
    interpolateRotation: true,
    getGameObject: (eid) => gameObjects.get(eid),
    setGameObject: (eid, obj) => {
      gameObjects.set(eid, obj);
    },
    deleteGameObject: (eid) => {
      gameObjects.delete(eid);
    },
    trackSystem: (system) => systems.push(system),
  };
  return { ctx, systems, world };
}
