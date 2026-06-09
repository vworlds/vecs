import type { Entity } from "@vworlds/vecs";
import { ClientWorld } from "@vworlds/vecs-client";
import {
  Alpha,
  Depth,
  Ellipse,
  FillStyle,
  Position,
  Rotation,
  Scale,
  Star,
  StrokeStyle,
  Triangle,
  phaserNetworkComponents,
} from "@vworlds/vecs-phaser";
import { describe, expect, it } from "vitest";

import { PhaserVecsRuntime } from "../src/runtime.js";
import { createMockScene } from "./mock_phaser.js";

describe("VPH-23 renderers", () => {
  it("creates, updates, and destroys ellipses with CoordSpace-scaled dimensions", () => {
    const { entity, scene, runtime, world } = setupRuntime();

    entity.set(Position, { x: 1, y: -2 }).set(Ellipse, { width: 2, height: 0.5 });
    tick(world);

    const ellipse = scene.created[0];
    expect(ellipse.kind).toBe("ellipse");
    expect(ellipse.createArgs).toEqual([576, 512, 128, 32]);
    expect(runtime.getGameObject(entity.eid)).toBe(ellipse);

    entity.set(Ellipse, { width: 3, height: 1.25 });
    tick(world);

    expect(ellipse.calls).toContainEqual({ method: "setSize", args: [192, 80] });

    entity.remove(Ellipse);
    tick(world);

    expect(ellipse.destroyed).toBe(true);
    expect(runtime.getGameObject(entity.eid)).toBeUndefined();
  });

  it("creates, updates, and destroys stars with CoordSpace-scaled radii", () => {
    const { entity, scene, runtime, world } = setupRuntime();

    entity.set(Position, { x: -1, y: 1 }).set(Star, {
      points: 7,
      innerRadius: 0.25,
      outerRadius: 0.75,
    });
    tick(world);

    const star = scene.created[0];
    expect(star.kind).toBe("star");
    expect(star.createArgs).toEqual([448, 320, 7, 16, 48]);
    expect(runtime.getGameObject(entity.eid)).toBe(star);

    entity.set(Star, { points: 9, innerRadius: 0.5, outerRadius: 1.5 });
    tick(world);

    expect(star.calls).toContainEqual({ method: "setPoints", args: [9] });
    expect(star.calls).toContainEqual({ method: "setRadius", args: [32, 96] });

    entity.remove(Star);
    tick(world);

    expect(star.destroyed).toBe(true);
    expect(runtime.getGameObject(entity.eid)).toBeUndefined();
  });

  it("pins asymmetric triangle vertex-space origin to Position and rotates about it", () => {
    const { entity, scene, runtime, world } = setupRuntime();

    entity
      .set(Position, { x: 2, y: -1 })
      .set(Rotation, { angle: Math.PI / 3 })
      .set(Triangle, {
        x1: 0,
        y1: 0,
        x2: -0.5,
        y2: 0.25,
        x3: 1.25,
        y3: -0.75,
      });
    tick(world);

    const triangle = scene.created[0];
    expect(triangle.kind).toBe("triangle");
    expect(triangle.createArgs).toEqual([640, 448, 0, -0, -32, -16, 80, 48]);
    expect(triangle.calls).toContainEqual({ method: "setDisplayOrigin", args: [0, 0] });
    expect(triangle.calls).toContainEqual({ method: "setPosition", args: [640, 448] });
    expect(triangle.calls).toContainEqual({ method: "setRotation", args: [-Math.PI / 3] });
    expect(runtime.getGameObject(entity.eid)).toBe(triangle);

    entity.set(Triangle, {
      x1: 0.25,
      y1: -0.5,
      x2: -1,
      y2: 1,
      x3: 1.5,
      y3: 0.25,
    });
    tick(world);

    expect(triangle.calls).toContainEqual({ method: "setTo", args: [16, 32, -64, -64, 96, -16] });

    entity.remove(Triangle);
    tick(world);

    expect(triangle.destroyed).toBe(true);
    expect(runtime.getGameObject(entity.eid)).toBeUndefined();
  });

  it("initializes transform and style components present before a shape enters", () => {
    const { entity, scene, world } = setupRuntime();

    entity
      .set(Position, { x: 0.5, y: 0.25 })
      .set(Rotation, { angle: 0.75 })
      .set(Scale, { x: 2, y: 3 })
      .set(Alpha, { value: 0.4 })
      .set(Depth, { value: 12 })
      .set(FillStyle, { color: 0xff00aa, alpha: 0.7 })
      .set(StrokeStyle, { color: 0x001122, alpha: 0.5, width: 4 })
      .set(Ellipse, { width: 1, height: 1 });
    tick(world);

    const ellipse = scene.created[0];
    expect(ellipse.calls).toContainEqual({ method: "setPosition", args: [544, 368] });
    expect(ellipse.calls).toContainEqual({ method: "setRotation", args: [-0.75] });
    expect(ellipse.calls).toContainEqual({ method: "setScale", args: [2, 3] });
    expect(ellipse.calls).toContainEqual({ method: "setAlpha", args: [0.4] });
    expect(ellipse.calls).toContainEqual({ method: "setDepth", args: [12] });
    expect(ellipse.calls).toContainEqual({ method: "setFillStyle", args: [0xff00aa, 0.7] });
    expect(ellipse.calls).toContainEqual({ method: "setStrokeStyle", args: [4, 0x001122, 0.5] });
  });
});

function setupRuntime(): {
  entity: Entity;
  runtime: PhaserVecsRuntime;
  scene: ReturnType<typeof createMockScene>;
  world: ClientWorld;
} {
  const world = new ClientWorld();
  phaserNetworkComponents.forEach((ComponentClass) => world.component(ComponentClass));
  const scene = createMockScene(1024, 768);
  const runtime = new PhaserVecsRuntime({ world, scene });
  runtime.start();
  return { entity: world.entity(), runtime, scene, world };
}

function tick(world: ClientWorld): void {
  world.progress(0, 16);
}
