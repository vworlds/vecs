// M8-1 / UP-1: `Detectable` marker — sensor detectability for solid shapes.
//
// Box2D v3 reports a sensor overlap only when BOTH the sensor shape and the
// visited (other) shape have `enableSensorEvents == true`. A plain solid
// shape has `enableSensorEvents == false` by default, so it is invisible to
// every sensor. `Detectable` forces `enableSensorEvents = true` on a shape
// without making it a sensor and without it receiving sensor events itself.
//
// Tests cover:
//   (a) solid WITHOUT Detectable -> sensor sees nothing.
//   (b) solid WITH Detectable (no SensorEvents/Sensor) -> sensor sees it.
//   (c) runtime add/remove of Detectable toggles detection without recreating
//       the shape (same Box2D shape index before/after).
//   (d) CollisionFilter still gates a Detectable solid.

import { World } from "@vworlds/vecs";
import { describe, expect, it } from "vitest";

import {
  Body,
  BodyType,
  Box,
  CollisionFilter,
  Detectable,
  PhysicsModule,
  Position,
  Sensor,
  SensorEvents,
} from "../../src/index.js";

const STEP_MS = 1000 / 60;

function makeWorld(gravityY = 0) {
  const world = new World();
  world.module(PhysicsModule, {
    gravity: { x: 0, y: gravityY },
    subSteps: 4,
  });
  return world;
}

let _now = 0;
function step(world: World) {
  _now += STEP_MS;
  world.progress(_now, STEP_MS);
}

describe("Detectable marker (UP-1)", () => {
  it("(a) solid shape WITHOUT Detectable is not seen by an overlapping sensor", () => {
    const world = makeWorld();

    const zoneBody = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 });
    const sensorShape = world
      .entity()
      .childOf(zoneBody)
      .set(Box, { hx: 1, hy: 1 })
      .add(Sensor)
      .add(SensorEvents);

    const solidBody = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 });
    world.entity().childOf(solidBody).set(Box, { hx: 0.5, hy: 0.5 });
    // NO Detectable on the solid.

    step(world);
    step(world);

    expect(sensorShape.get(SensorEvents)!.begin.length).toBe(0);
  });

  it("(b) solid shape WITH Detectable (no SensorEvents/Sensor) is reported to the sensor", () => {
    const world = makeWorld();

    const zoneBody = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 });
    const sensorShape = world
      .entity()
      .childOf(zoneBody)
      .set(Box, { hx: 1, hy: 1 })
      .add(Sensor)
      .add(SensorEvents);

    const solidBody = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 });
    const solidShape = world
      .entity()
      .childOf(solidBody)
      .set(Box, { hx: 0.5, hy: 0.5 })
      .add(Detectable);
    // No SensorEvents, no Sensor on the solid.

    let foundBeginFrame = false;
    for (let i = 0; i < 10; i++) {
      step(world);
      const sev = sensorShape.get(SensorEvents)!;
      if (sev.begin.length > 0) {
        expect(sev.begin[0]!.other.eid).toBe(solidShape.eid);
        foundBeginFrame = true;
        break;
      }
    }

    expect(foundBeginFrame).toBe(true);
  });

  it("(c) Detectable toggles detection at runtime without recreating the shape", () => {
    const world = makeWorld();

    const zoneBody = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 });
    const sensorShape = world
      .entity()
      .childOf(zoneBody)
      .set(Box, { hx: 1, hy: 1 })
      .add(Sensor)
      .add(SensorEvents);

    const solidBody = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 });
    const solidShape = world.entity().childOf(solidBody).set(Box, { hx: 0.5, hy: 0.5 });
    // No Detectable yet.

    step(world);
    step(world);
    expect(sensorShape.get(SensorEvents)!.begin.length).toBe(0);

    const shapeIndexBefore = (solidShape.get(Box) as unknown as { _shapeId?: { index1: number } })
      ._shapeId?.index1;

    solidShape.add(Detectable);
    step(world);

    const shapeIndexAfter = (solidShape.get(Box) as unknown as { _shapeId?: { index1: number } })
      ._shapeId?.index1;

    expect(shapeIndexAfter).toBe(shapeIndexBefore);
    expect(sensorShape.get(SensorEvents)!.begin.length).toBeGreaterThan(0);

    solidShape.remove(Detectable);
    step(world);
    // `end` fires on the first step after the flag flips. A second step would
    // already clear it again (clearUntouchedSensorEvents), so assert here.
    expect(sensorShape.get(SensorEvents)!.end.length).toBeGreaterThan(0);
  });

  it("(d) CollisionFilter still gates a Detectable solid (no bypass)", () => {
    const world = makeWorld();

    const zoneBody = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 });
    const sensorShape = world
      .entity()
      .childOf(zoneBody)
      .set(Box, { hx: 1, hy: 1 })
      .add(Sensor)
      .add(SensorEvents)
      .set(CollisionFilter, { maskBits: 0b01 });

    const solidBody = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 });
    world
      .entity()
      .childOf(solidBody)
      .set(Box, { hx: 0.5, hy: 0.5 })
      .add(Detectable)
      .set(CollisionFilter, { categoryBits: 0b10 });

    step(world);
    step(world);

    expect(sensorShape.get(SensorEvents)!.begin.length).toBe(0);
  });
});
