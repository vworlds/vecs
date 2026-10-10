import { ClientWorld } from "@vworlds/vecs-client";
import { interpolatePosition } from "@vworlds/vecs-client";
import {
  Alpha,
  Arc,
  Depth,
  Ellipse,
  FillStyle,
  OpenPath,
  phaserNetworkComponents,
  Polygon,
  Position,
  Rectangle,
  Rotation,
  Scale,
  Size,
  Star,
  StrokeStyle,
  Text,
  Tint,
  Triangle,
} from "@vworlds/vecs-phaser";
import { describe, expect, it } from "vitest";

import { PhaserRenderModule } from "../src/index.js";
import { phaserInterpolators, rotationInterpolator } from "../src/sync.js";
import { createMockScene, type MockGameObject, type RecordedCall } from "./mock_phaser.js";

describe("PhaserRenderModule sync systems", () => {
  it("applies transform and style enter values to a new GameObject in the same tick", () => {
    const { scene, world } = setup();
    const entity = world.entity();

    entity.set(Position, { x: 1.5, y: -2 });
    entity.set(Rotation, { angle: Math.PI / 4 });
    entity.set(Scale, { x: 2, y: 3 });
    entity.set(Alpha, { value: 0.4 });
    entity.set(Depth, { value: 9 });
    entity.set(FillStyle, { color: 0xff0000, alpha: 0.75 });
    entity.set(StrokeStyle, { width: 5, color: 0x00ff00, alpha: 0.5 });
    entity.set(Arc, { radius: 0.5 });
    world.progress(0, 0);

    const obj = scene.created[0]!;
    expectCall(obj, "setPosition", [608, 512]);
    expectCall(obj, "setRotation", [-Math.PI / 4]);
    expectCall(obj, "setScale", [2, 3]);
    expectCall(obj, "setAlpha", [0.4]);
    expectCall(obj, "setDepth", [9]);
    expectCall(obj, "setFillStyle", [0xff0000, 0.75]);
    expectCall(obj, "setStrokeStyle", [5, 0x00ff00, 0.5]);
  });

  it("applies later transform and style updates to the stored GameObject", () => {
    const { scene, world } = setup();
    const entity = world.entity();

    entity.set(Arc, { radius: 0.5 });
    world.progress(0, 0);

    const obj = scene.created[0]!;
    obj.calls.length = 0;
    entity.set(Position, { x: -1, y: 1 });
    entity.set(FillStyle, { color: 0x123456, alpha: 0.25 });
    world.progress(1, 0);

    expectCall(obj, "setPosition", [448, 320]);
    expectCall(obj, "setFillStyle", [0x123456, 0.25]);
  });

  it("applies Tint enter values to a Text GameObject (Tint marker is on Text and Image, not shapes)", () => {
    const { scene, world } = setup();
    const entity = world.entity();

    entity.set(Text, { value: "tinted", fontSize: 16, color: 0xffffff });
    entity.set(Tint, { value: 0xff8800 } as Partial<Tint>);
    world.progress(0, 0);

    const obj = scene.created[0]!;
    expectCall(obj, "setTint", [0xff8800, 0xff8800, 0xff8800, 0xff8800]);
  });

  it("applies later Tint updates to the stored Text GameObject", () => {
    const { scene, world } = setup();
    const entity = world.entity();

    entity.set(Text, { value: "tinted", fontSize: 16, color: 0xffffff });
    entity.set(Tint, { value: 0xff8800 } as Partial<Tint>);
    world.progress(0, 0);

    const obj = scene.created[0]!;
    obj.calls.length = 0;
    entity.set(Tint, { value: 0x112233 } as Partial<Tint>);
    world.progress(1, 0);

    expectCall(obj, "setTint", [0x112233, 0x112233, 0x112233, 0x112233]);
  });
});

describe("OpenPath sync", () => {
  it("leaves a new Arc's stroke open in the same tick it is created", () => {
    const { scene, world } = setup();

    world
      .entity()
      .set(Arc, { radius: 0.5, endAngle: Math.PI })
      .set(StrokeStyle, { width: 2 })
      .add(OpenPath);
    world.progress(0, 0);

    expect(closePathCalls(scene.created[0]!)).toEqual([[false]]);
  });

  it("opens and recloses an existing Arc as OpenPath is added and removed", () => {
    const { scene, world } = setup();
    const entity = world.entity().set(Arc, { radius: 0.5, endAngle: Math.PI });
    world.progress(0, 0);
    const arc = scene.created[0]!;

    expect(closePathCalls(arc)).toEqual([]);

    entity.add(OpenPath);
    world.progress(1, 0);

    expect(closePathCalls(arc)).toEqual([[false]]);

    entity.remove(OpenPath);
    world.progress(2, 0);

    expect(closePathCalls(arc)).toEqual([[false], [true]]);
  });

  it("leaves a Polygon's stroke open so it draws as a polyline", () => {
    const { scene, world } = setup();

    world
      .entity()
      .set(Polygon, { points: [0, 0, 1, 0, 1, 1] })
      .add(OpenPath);
    world.progress(0, 0);

    expect(closePathCalls(scene.created[0]!)).toEqual([[false]]);
  });

  it("ignores OpenPath on shapes whose stroke Phaser always closes", () => {
    const { scene, world } = setup();

    world.entity().add(Star).add(OpenPath);
    world.entity().add(Ellipse).add(Size).add(OpenPath);
    world.entity().add(Rectangle).add(Size).add(OpenPath);
    world.entity().add(Triangle).add(OpenPath);
    world.progress(0, 0);

    expect(scene.created.map((obj) => obj.kind).sort()).toEqual([
      "ellipse",
      "rectangle",
      "star",
      "triangle",
    ]);
    for (const obj of scene.created) {
      expect(closePathCalls(obj)).toEqual([]);
    }
  });

  it("never recloses a GameObject that leaves with its renderable", () => {
    const { scene, world } = setup();
    const entity = world.entity().set(Arc, { radius: 0.5 }).add(OpenPath);
    world.progress(0, 0);
    const arc = scene.created[0]!;

    entity.remove(Arc);
    entity.set(Polygon, { points: [0, 0, 1, 0, 1, 1] });
    world.progress(1, 0);
    const polygon = scene.created[1]!;

    expect(arc.isDestroyed).toBe(true);
    expect(closePathCalls(arc)).toEqual([[false]]);
    expect(closePathCalls(polygon)).toEqual([[false]]);

    entity.destroy();
    world.progress(2, 0);

    expect(polygon.isDestroyed).toBe(true);
    expect(closePathCalls(polygon)).toEqual([[false]]);
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
  it("installs interpolatePosition on Position and rotationInterpolator on Rotation by default", () => {
    expect(phaserInterpolators()).toEqual([
      [Position, interpolatePosition],
      [Rotation, rotationInterpolator],
    ]);
  });

  it("still installs interpolatePosition when rotation interpolation is disabled", () => {
    expect(phaserInterpolators({ interpolateRotation: false })).toEqual([
      [Position, interpolatePosition],
    ]);
  });
});

function degrees(value: number): number {
  return (value * Math.PI) / 180;
}

function expectCall(obj: MockGameObject, method: string, args: readonly unknown[]): void {
  expect(obj.calls).toContainEqual({ method, args } satisfies RecordedCall);
}

function closePathCalls(obj: MockGameObject): unknown[][] {
  return obj.calls.filter((call) => call.method === "setClosePath").map((call) => [...call.args]);
}

function setup(): { scene: ReturnType<typeof createMockScene>; world: ClientWorld } {
  const world = new ClientWorld({ networkComponents: phaserNetworkComponents });
  const scene = createMockScene(1024, 768);
  world.module(PhaserRenderModule, { scene, pixelsPerMeter: 64 });
  return { scene, world };
}
