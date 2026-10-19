import { World } from "@vworlds/vecs";
import { describe, expect, it } from "vitest";

import { getPhysicsEngine, type PhysicsEngine, type b2BodyId } from "../../src/adapter/engine.js";
import {
  Body,
  BodyType,
  Box,
  Capsule,
  Circle,
  PhysicsModule,
  Polygon,
  ShapePosition,
} from "../../src/index.js";

describe("exact shape-derived mass centers", () => {
  it.each([
    [0.01, 0.01],
    [0.1, 0.1],
    [0.5, 0.5],
    [1, 1],
    [10, 10],
    [100, 100],
    [0.3, 0.7],
    [2, 0.1],
  ])("centers a box with half extents %s, %s without changing mass or inertia", (hx, hy) => {
    const world = new World();
    world.module(PhysicsModule, { gravity: { x: 0, y: 0 } });
    const engine = getPhysicsEngine(world);
    const body = world.entity().set(Body, { type: BodyType.Dynamic });
    world.entity().childOf(body).set(Box, { hx, hy });
    world.progress(0, 0);
    const id = body.get(Body)!._bodyId!;
    engine.box2d.b2Body_UpdateMassFromShapes(id);
    const mass = engine.box2d.b2Body_GetMass(id);
    const inertia = engine.box2d.b2Body_GetRotationalInertia(id);
    engine.dirtyMassBodies.add(body.eid);
    world.progress(16, 0);
    expect(readCenter(engine, id)).toEqual([0, 0]);
    expect(engine.box2d.b2Body_GetMass(id)).toBe(mass);
    expect(engine.box2d.b2Body_GetRotationalInertia(id)).toBe(inertia);
    world.dispose();
  });

  it.each(["rounded box", "circle", "capsule", "hexagon", "symmetric boxes"])(
    "centers %s",
    (kind) => {
      const world = new World();
      world.module(PhysicsModule, { gravity: { x: 0, y: 0 } });
      const body = world.entity().set(Body, { type: BodyType.Dynamic });
      const shape = world.entity().childOf(body);
      if (kind === "rounded box") {
        shape.set(Polygon, {
          radius: 0.1,
          vertices: [
            { x: -0.3, y: -0.7 },
            { x: 0.3, y: -0.7 },
            { x: 0.3, y: 0.7 },
            { x: -0.3, y: 0.7 },
          ],
        });
      } else if (kind === "circle") {
        shape.set(Circle, { radius: 0.5 });
      } else if (kind === "capsule") {
        shape.add(Capsule);
      } else if (kind === "hexagon") {
        shape.set(Polygon, {
          vertices: Array.from({ length: 6 }, (_, i) => ({
            x: Math.cos((i * Math.PI) / 3),
            y: Math.sin((i * Math.PI) / 3),
          })),
        });
      } else {
        shape.set(Box, { hx: 0.3, hy: 0.7 }).set(ShapePosition, { x: -1, y: 0 });
        world
          .entity()
          .childOf(body)
          .set(Box, { hx: 0.3, hy: 0.7 })
          .set(ShapePosition, { x: 1, y: 0 });
      }
      world.progress(0, 0);
      expect(readCenter(getPhysicsEngine(world), body.get(Body)!._bodyId!)).toEqual([0, 0]);
      world.dispose();
    }
  );

  it.each([0.001, 0.1])("preserves the exact Box2D center for a %s m offset", (offset) => {
    const world = new World();
    world.module(PhysicsModule, { gravity: { x: 0, y: 0 } });
    const engine = getPhysicsEngine(world);
    const body = world.entity().set(Body, { type: BodyType.Dynamic });
    world
      .entity()
      .childOf(body)
      .set(Box, { hx: 0.3, hy: 0.7 })
      .set(ShapePosition, { x: offset, y: offset });
    world.progress(0, 0);
    const id = body.get(Body)!._bodyId!;
    engine.box2d.b2Body_UpdateMassFromShapes(id);
    const expected = readCenter(engine, id);
    expect(expected[0]).toBeCloseTo(offset, 6);
    expect(expected[1]).toBeCloseTo(offset, 6);
    engine.dirtyMassBodies.add(body.eid);
    world.progress(16, 0);
    expect(readCenter(engine, id)).toEqual(expected);
    world.dispose();
  });

  it.each([0.05, 50])("uses a relative tolerance at %s m half-extent", (extent) => {
    const world = new World();
    world.module(PhysicsModule, { gravity: { x: 0, y: 0 } });
    const engine = getPhysicsEngine(world);
    const centered = world.entity().set(Body, { type: BodyType.Dynamic });
    world.entity().childOf(centered).set(Box, { hx: extent, hy: extent });
    const offset = world.entity().set(Body, { type: BodyType.Dynamic });
    world
      .entity()
      .childOf(offset)
      .set(Box, { hx: extent, hy: extent })
      .set(ShapePosition, { x: 1e-4 * extent, y: 1e-4 * extent });
    world.progress(0, 0);
    const centeredId = centered.get(Body)!._bodyId!;
    const offsetId = offset.get(Body)!._bodyId!;
    expect(readCenter(engine, centeredId)).toEqual([0, 0]);
    engine.box2d.b2Body_UpdateMassFromShapes(offsetId);
    const raw = readCenter(engine, offsetId);
    expect(raw[0] / extent).toBeCloseTo(1e-4, 6);
    expect(raw[1] / extent).toBeCloseTo(1e-4, 6);
    engine.dirtyMassBodies.add(offset.eid);
    world.progress(16, 0);
    expect(readCenter(engine, offsetId)).toEqual(raw);
    world.dispose();
  });

  it("corrects the surviving centered shape after removal, then leaves explicit raw mass data alone on idle frames", () => {
    const world = new World();
    world.module(PhysicsModule, { gravity: { x: 0, y: 0 } });
    const engine = getPhysicsEngine(world);
    const body = world.entity().set(Body, { type: BodyType.Dynamic });
    world.entity().childOf(body).set(Box, { hx: 0.3, hy: 0.7 });
    const extra = world
      .entity()
      .childOf(body)
      .set(Circle, { radius: 0.1 })
      .set(ShapePosition, { x: 1 });
    world.progress(0, 0);
    const id = body.get(Body)!._bodyId!;
    expect(readCenter(engine, id)[0]).toBeGreaterThan(0.01);
    extra.destroy();
    world.progress(16, 0);
    expect(readCenter(engine, id)).toEqual([0, 0]);
    const data = engine.box2d.b2Body_GetMassData(id);
    const center = new engine.box2d.b2Vec2(0.001, 0.001);
    try {
      data.center = center;
      engine.box2d.b2Body_SetMassData(id, data);
    } finally {
      center.delete();
      data.delete();
    }
    const explicit = readCenter(engine, id);
    world.progress(32, 0);
    expect(readCenter(engine, id)).toEqual(explicit);
    world.dispose();
  });
});

function readCenter(engine: PhysicsEngine, bodyId: b2BodyId): [number, number] {
  const center = engine.box2d.b2Body_GetLocalCenter(bodyId);
  try {
    return [center.x, center.y];
  } finally {
    center.delete();
  }
}
