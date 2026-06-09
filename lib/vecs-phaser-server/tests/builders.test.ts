import { type ComponentClass, type Entity } from "@vworlds/vecs";
import {
  Alpha,
  Arc,
  Depth,
  Ellipse,
  FillStyle,
  Line,
  phaserNetworkComponents,
  phaserRenderableComponents,
  Polygon,
  Position,
  Rectangle,
  Rotation,
  Scale,
  Star,
  StrokeStyle,
  Text,
  Triangle,
} from "@vworlds/vecs-phaser";
import { Networked, ServerWorld } from "@vworlds/vecs-server";
import { describe, expect, it } from "vitest";

import {
  createArc,
  createEllipse,
  createLine,
  createPolygon,
  createRectangle,
  createStar,
  createText,
  createTriangle,
  registerRenderExclusivity,
} from "../src/index.js";

interface BuilderCase {
  build: (world: ServerWorld) => Entity;
  component: ComponentClass;
  name: string;
}

function createWorld(): ServerWorld {
  return new ServerWorld({ name: "test", networkComponents: phaserNetworkComponents });
}

describe("shape builders", () => {
  it("adds Networked and exactly the intended renderable", () => {
    const cases: BuilderCase[] = [
      { name: "Arc", component: Arc, build: createArc },
      { name: "Ellipse", component: Ellipse, build: createEllipse },
      { name: "Rectangle", component: Rectangle, build: createRectangle },
      { name: "Polygon", component: Polygon, build: createPolygon },
      { name: "Line", component: Line, build: createLine },
      { name: "Triangle", component: Triangle, build: createTriangle },
      { name: "Star", component: Star, build: createStar },
      { name: "Text", component: Text, build: createText },
    ];

    for (const testCase of cases) {
      const entity = testCase.build(createWorld());

      expect(entity.has(Networked), testCase.name).toBe(true);
      expect(entity.has(testCase.component), testCase.name).toBe(true);
      for (const renderable of phaserRenderableComponents) {
        if (renderable !== testCase.component) {
          expect(entity.has(renderable), testCase.name).toBe(false);
        }
      }
    }
  });

  it("sets renderable fields from builder props", () => {
    const world = createWorld();
    const entity = createText(world, {
      backgroundAlpha: 0.25,
      fontFamily: "serif",
      fontSize: 20,
      value: "Score: 3",
    });

    expect(entity.get(Text)).toMatchObject({
      backgroundAlpha: 0.25,
      fontFamily: "serif",
      fontSize: 20,
      value: "Score: 3",
    });
  });

  it("sets only provided transform and style components", () => {
    const world = createWorld();
    const entity = createRectangle(world, {
      alpha: { value: 0.5 },
      depth: { value: 7 },
      fillStyle: { alpha: 0.8, color: 0xffcc00 },
      height: 2,
      position: { x: 1.5, y: 2.5 },
      rotation: { angle: Math.PI / 4 },
      scale: { x: 2 },
      width: 3,
    });

    expect(entity.get(Rectangle)).toMatchObject({ width: 3, height: 2 });
    expect(entity.get(Position)).toMatchObject({ x: 1.5, y: 2.5 });
    expect(entity.get(Rotation)).toMatchObject({ angle: Math.PI / 4 });
    expect(entity.get(Scale)).toMatchObject({ x: 2, y: 1 });
    expect(entity.get(Alpha)).toMatchObject({ value: 0.5 });
    expect(entity.get(Depth)).toMatchObject({ value: 7 });
    expect(entity.get(FillStyle)).toMatchObject({ alpha: 0.8, color: 0xffcc00 });
    expect(entity.has(StrokeStyle)).toBe(false);
  });
});

describe("registerRenderExclusivity", () => {
  it("removes an existing renderable when a second renderable is set", () => {
    const world = createWorld();
    registerRenderExclusivity(world);
    const entity = createArc(world, { radius: 1 });

    entity.set(Rectangle, { width: 4, height: 5 });

    expect(entity.has(Arc)).toBe(false);
    expect(entity.get(Rectangle)).toMatchObject({ width: 4, height: 5 });
    expect(entity.has(Networked)).toBe(true);
  });
});
