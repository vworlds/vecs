import { World } from "@vworlds/vecs";
import { describe, expect, it } from "vitest";

import {
  Body,
  BodyType,
  Chain,
  Circle,
  Detectable,
  GravityScale,
  PhysicsModule,
  Position,
  Sensor,
  SensorEvents,
  ShapePosition,
  ShapeRotation,
} from "../../src/index.js";
import { getPhysicsEngine } from "../../src/adapter/engine.js";

const STEP_MS = 1000 / 60;

function step(world: World, now: { value: number }, count = 1): void {
  for (let i = 0; i < count; i++) {
    now.value += STEP_MS;
    world.progress(now.value, STEP_MS);
  }
}

describe("PhysicsChainLifecycle", () => {
  it("applies ShapePosition and ShapeRotation to chain points", () => {
    const world = new World();
    world.module(PhysicsModule, { gravity: { x: 0, y: -10 } });

    const groundBody = world.entity().set(Body, { type: BodyType.Static });
    world
      .entity()
      .childOf(groundBody)
      .set(Chain, {
        points: [
          { x: 5, y: 0 },
          { x: -5, y: 0 },
          { x: -5, y: -2 },
          { x: 5, y: -2 },
        ],
        loop: true,
      })
      .set(ShapePosition, { x: 0, y: 3 })
      .set(ShapeRotation, { angle: 0 });

    const ballBody = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 5 });
    world.entity().childOf(ballBody).set(Circle, { radius: 0.5 });

    const now = { value: 0 };
    step(world, now, 120);

    expect(ballBody.get(Position)!.y).toBeGreaterThan(3.3);
    expect(ballBody.get(Position)!.y).toBeLessThan(3.7);
  });

  it("resolves sensor events against chain segment shapes and clears segment slots on destroy", () => {
    const world = new World();
    world.module(PhysicsModule, { gravity: { x: 0, y: 0 } });
    const engine = getPhysicsEngine(world);

    const chainBody = world.entity().set(Body, { type: BodyType.Static });
    const chainShape = world
      .entity()
      .childOf(chainBody)
      .set(Chain, {
        points: [
          { x: 5, y: 0 },
          { x: -5, y: 0 },
          { x: -5, y: -2 },
          { x: 5, y: -2 },
        ],
        loop: true,
      })
      .add(Detectable);

    const sensorBody = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0 })
      .add(GravityScale);
    const sensorShape = world
      .entity()
      .childOf(sensorBody)
      .set(Circle, { radius: 0.25 })
      .add(Sensor)
      .add(SensorEvents);

    const now = { value: 0 };
    step(world, now, 1);

    expect(sensorShape.get(SensorEvents)!.begin.some((event) => event.other === chainShape)).toBe(
      true
    );

    const segmentIndices = [...chainShape.get(Chain)!._segmentIndices];
    expect(segmentIndices.length).toBeGreaterThan(0);
    expect(
      segmentIndices.every((index) => engine.entityByShapeIndex.get(index) === chainShape.eid)
    ).toBe(true);

    chainShape.destroy();
    step(world, now, 1);

    expect(
      segmentIndices.every((index) => engine.entityByShapeIndex.get(index) === undefined)
    ).toBe(true);
  });

  it("keeps chains out of the single-shape sensor opt-in system but enables them at creation", () => {
    const world = new World();
    world.module(PhysicsModule, { gravity: { x: 0, y: 0 } });
    const engine = getPhysicsEngine(world);

    const chainBody = world.entity().set(Body, { type: BodyType.Static });
    const chainShape = world
      .entity()
      .childOf(chainBody)
      .set(Chain, {
        points: [
          { x: 5, y: 0 },
          { x: -5, y: 0 },
          { x: -5, y: -2 },
          { x: 5, y: -2 },
        ],
        loop: true,
      });

    const now = { value: 0 };
    step(world, now, 1);

    const calls: unknown[] = [];
    const originalEnableSensorEvents = engine.box2d.b2Shape_EnableSensorEvents;
    engine.box2d.b2Shape_EnableSensorEvents = ((shapeId: unknown, enabled: boolean) => {
      calls.push([shapeId, enabled]);
      return originalEnableSensorEvents(shapeId as never, enabled);
    }) as typeof engine.box2d.b2Shape_EnableSensorEvents;

    try {
      chainShape.add(Detectable);
      step(world, now, 1);
    } finally {
      engine.box2d.b2Shape_EnableSensorEvents = originalEnableSensorEvents;
    }

    expect(calls).toHaveLength(0);

    const sensorBody = world.entity().set(Body, { type: BodyType.Dynamic }).add(GravityScale);
    const sensorShape = world
      .entity()
      .childOf(sensorBody)
      .set(Circle, { radius: 0.25 })
      .add(Sensor)
      .add(SensorEvents);

    step(world, now, 1);

    expect(chainShape.get(Chain)!._chainId).toBeDefined();
    expect(chainShape.get(Chain)!._segmentIndices.length).toBeGreaterThan(0);
    expect(sensorShape.get(SensorEvents)!.begin.some((event) => event.other === chainShape)).toBe(
      true
    );
  });
});
