import { World } from "@vworlds/vecs";
import { describe, expect, it } from "vitest";

import {
  Body,
  Box,
  Capsule,
  Chain,
  Circle,
  PhysicsModule,
  Polygon,
  Segment,
  Shape,
} from "../../src/index.js";
import { SingleShape } from "../../src/components/geometry.js";

describe("geometry interface tiers", () => {
  it("keeps Shape exclusivity across Chain and single-shape geometries", () => {
    const world = new World();
    world.module(PhysicsModule);

    const entity = world.entity().set(Box, { hx: 1, hy: 1 });
    entity.set(Chain, {
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 2, y: 0 },
        { x: 3, y: 0 },
      ],
      loop: false,
    });

    expect(entity.has(Box)).toBe(false);
    expect(entity.has(Chain)).toBe(true);
    expect(entity.get(Shape)).toBe(entity.get(Chain));
    expect(entity.get(SingleShape)).toBeUndefined();

    entity.set(Box, { hx: 2, hy: 2 });

    expect(entity.has(Chain)).toBe(false);
    expect(entity.has(Box)).toBe(true);
    expect(entity.get(Shape)).toBe(entity.get(Box));
    expect(entity.get(SingleShape)).toBe(entity.get(Box));
  });

  it("keeps single-shape geometries mutually exclusive through SingleShape", () => {
    const world = new World();
    world.module(PhysicsModule);

    const entity = world.entity().set(Box, { hx: 1, hy: 1 });
    entity.set(Circle, { radius: 2 });

    expect(entity.has(Box)).toBe(false);
    expect(entity.has(Circle)).toBe(true);
    expect(entity.get(Shape)).toBe(entity.get(Circle));
    expect(entity.get(SingleShape)).toBe(entity.get(Circle));
  });

  it("matches every concrete geometry through Shape and only singles through SingleShape", () => {
    const world = new World();
    world.module(PhysicsModule);
    const body = world.entity().add(Body);
    const geometries = [
      world.entity().childOf(body).add(Box),
      world.entity().childOf(body).add(Circle),
      world.entity().childOf(body).add(Capsule),
      world.entity().childOf(body).add(Segment),
      world
        .entity()
        .childOf(body)
        .set(Polygon, {
          vertices: [
            { x: 0, y: 0 },
            { x: 1, y: 0 },
            { x: 0, y: 1 },
          ],
        }),
      world
        .entity()
        .childOf(body)
        .set(Chain, {
          points: [
            { x: 0, y: 0 },
            { x: 1, y: 0 },
            { x: 2, y: 0 },
            { x: 3, y: 0 },
          ],
        }),
    ];

    expect(geometries.map((entity) => entity.get(Shape) !== undefined)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(geometries.map((entity) => entity.get(SingleShape) !== undefined)).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
  });
});
