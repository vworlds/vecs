import { ClientWorld } from "@vworlds/vecs-client";
import {
  Alpha,
  Arc,
  Depth,
  FillStyle,
  Line,
  Polygon,
  Position,
  Rectangle,
  Rotation,
  Scale,
  StrokeStyle,
  Text,
  TextAlign,
  phaserNetworkComponents,
} from "@vworlds/vecs-phaser";
import { describe, expect, it } from "vitest";

import { PhaserVecsRuntime } from "../src/runtime.js";
import { createMockScene, type MockGameObject } from "./mock_phaser.js";

function setup() {
  const world = new ClientWorld({ networkComponents: phaserNetworkComponents });
  const scene = createMockScene(1024, 768);
  const runtime = new PhaserVecsRuntime({ world, scene, pixelsPerMeter: 64 });
  runtime.start();
  return { runtime, scene, world };
}

function methods(obj: MockGameObject, method: string): readonly (readonly unknown[])[] {
  return obj.calls.filter((call) => call.method === method).map((call) => call.args);
}

describe("set A renderers", () => {
  it("creates, updates, and destroys arcs with CoordSpace geometry", () => {
    const { runtime, scene, world } = setup();
    const entity = world.entity();
    entity.set(Position, { x: 1, y: 2 });
    entity.set(FillStyle, { alpha: 0.75, color: 0xff0000 });
    entity.set(Arc, { endAngle: Math.PI, iterations: 0.02, radius: 0.5, startAngle: Math.PI / 2 });

    world.progress(0, 0);

    const obj = scene.created[0]!;
    expect(obj.kind).toBe("arc");
    expect(obj.createArgs).toEqual([0, 0, 32, -90, -180, false]);
    expect(runtime.getGameObject(entity.eid)).toBe(obj);
    expect(methods(obj, "setPosition")).toContainEqual([576, 256]);
    expect(methods(obj, "setFillStyle")).toContainEqual([0xff0000, 0.75]);
    expect(methods(obj, "setIterations")).toContainEqual([0.02]);

    obj.calls.length = 0;
    entity.set(Arc, { endAngle: Math.PI / 2, iterations: 0.05, radius: 0.25, startAngle: 0 });
    world.progress(1, 0);

    expect(methods(obj, "setRadius")).toEqual([[16]]);
    expect(methods(obj, "setStartAngle")).toEqual([[-0, false]]);
    expect(methods(obj, "setEndAngle")).toEqual([[-90, false]]);
    expect(methods(obj, "setIterations")).toEqual([[0.05]]);

    entity.remove(Arc);
    world.progress(2, 0);

    expect(obj.destroyed).toBe(true);
    expect(runtime.getGameObject(entity.eid)).toBeUndefined();
  });

  it("initializes centered primitives from pre-present transform and style components", () => {
    const { scene, world } = setup();
    const entity = world.entity();
    entity.set(Position, { x: -1, y: -2 });
    entity.set(Rotation, { angle: Math.PI / 4 });
    entity.set(Scale, { x: 2, y: 3 });
    entity.set(Alpha, { value: 0.5 });
    entity.set(Depth, { value: 9 });
    entity.set(FillStyle, { alpha: 0.25, color: 0x00ff00 });
    entity.set(StrokeStyle, { alpha: 0.8, color: 0x0000ff, width: 6 });
    entity.set(Rectangle, { height: 0.5, width: 2 });

    world.progress(0, 0);

    const obj = scene.created[0]!;
    expect(obj.createArgs).toEqual([0, 0, 128, 32]);
    expect(methods(obj, "setPosition")).toContainEqual([448, 512]);
    expect(methods(obj, "setRotation")).toContainEqual([-Math.PI / 4]);
    expect(methods(obj, "setScale")).toContainEqual([2, 3]);
    expect(methods(obj, "setAlpha")).toContainEqual([0.5]);
    expect(methods(obj, "setDepth")).toContainEqual([9]);
    expect(methods(obj, "setFillStyle")).toContainEqual([0x00ff00, 0.25]);
    expect(methods(obj, "setStrokeStyle")).toContainEqual([6, 0x0000ff, 0.8]);
  });

  it("updates rectangle geometry with pixel sizes", () => {
    const { scene, world } = setup();
    const entity = world.entity();
    entity.set(Rectangle, { height: 1, width: 1 });
    world.progress(0, 0);

    const obj = scene.created[0]!;
    obj.calls.length = 0;
    entity.set(Rectangle, { height: 0.25, width: 0.5 });
    world.progress(1, 0);

    expect(methods(obj, "setSize")).toEqual([[32, 16]]);
  });

  it("uses scaled and flipped relative points for polygons and pins vertex origin to Position", () => {
    const { scene, world } = setup();
    const entity = world.entity();
    entity.set(Position, { x: 1, y: -1 });
    entity.set(Rotation, { angle: Math.PI / 2 });
    entity.set(Polygon, { points: [-1, -0.5, 2, 1, 0.5, -1] });

    world.progress(0, 0);

    const obj = scene.created[0]!;
    expect(obj.kind).toBe("polygon");
    expect(obj.createArgs).toEqual([0, 0, [-64, 32, 128, -64, 32, 64]]);
    expect(methods(obj, "setPosition")).toContainEqual([576, 448]);
    expect(methods(obj, "setOrigin")).toContainEqual([0, 0]);
    expect(methods(obj, "setRotation")).toContainEqual([-Math.PI / 2]);

    obj.calls.length = 0;
    entity.set(Polygon, { points: [-0.5, 0.5, 1, -0.25, 0, -1] });
    world.progress(1, 0);

    expect(methods(obj, "setTo")).toEqual([[[-32, -32, 64, 16, 0, 64]]]);
    expect(methods(obj, "setOrigin")).toEqual([[0, 0]]);
    expect(methods(obj, "setPosition")).toEqual([]);
  });

  it("pins line vertex origin to Position without drifting on rotation", () => {
    const { scene, world } = setup();
    const entity = world.entity();
    entity.set(Position, { x: -0.5, y: 0.5 });
    entity.set(Rotation, { angle: Math.PI });
    entity.set(Line, { x1: -1, x2: 2, y1: -0.25, y2: 0.75 });

    world.progress(0, 0);

    const obj = scene.created[0]!;
    expect(obj.kind).toBe("line");
    expect(obj.createArgs).toEqual([0, 0, -64, 16, 128, -48]);
    expect(methods(obj, "setPosition")).toContainEqual([480, 352]);
    expect(methods(obj, "setOrigin")).toContainEqual([0, 0]);
    expect(methods(obj, "setRotation")).toContainEqual([-Math.PI]);
  });

  it("creates centered text with CSS colors and updates text geometry", () => {
    const { scene, world } = setup();
    const entity = world.entity();
    entity.set(Position, { x: 0, y: 0 });
    entity.set(Text, {
      align: TextAlign.Center,
      backgroundAlpha: 1,
      backgroundColor: 0x112233,
      color: 0xabcdef,
      fontFamily: "serif",
      fontSize: 24,
      value: "hello",
    });

    world.progress(0, 0);

    const obj = scene.created[0]!;
    expect(obj.kind).toBe("text");
    expect(obj.createArgs).toEqual([
      0,
      0,
      "hello",
      {
        align: "center",
        backgroundColor: "#112233",
        color: "#abcdef",
        fontFamily: "serif",
        fontSize: 24,
      },
    ]);
    expect(methods(obj, "setOrigin")).toContainEqual([0.5]);
    expect(methods(obj, "setPosition")).toContainEqual([512, 384]);

    obj.calls.length = 0;
    entity.set(Text, { align: TextAlign.Right, color: 0x123, fontSize: 18, value: "bye" });
    world.progress(1, 0);

    expect(methods(obj, "setText")).toEqual([["bye"]]);
    expect(methods(obj, "setStyle")).toEqual([
      [
        {
          align: "right",
          backgroundColor: "#112233",
          color: "#000123",
          fontFamily: "serif",
          fontSize: 18,
        },
      ],
    ]);
    expect(methods(obj, "setOrigin")).toEqual([[0.5]]);
  });
});
