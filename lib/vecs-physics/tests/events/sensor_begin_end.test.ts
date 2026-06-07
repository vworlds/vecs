// VP-21c / VP-21b: sensor overlap pass — ECS SensorEvents publishing.
//
// World-level integration tests: the full Vecs world pipeline verifies
// SensorEvents component arrays (the user-facing surface).
// The raw sensorBeginEvents / sensorEndEvents arrays were engine-internal
// and have been removed in M7-10.
//
// Tests cover:
//   - TestSensor parity (ported from box2d test/test_world.c:329-395).
//   - Opt-in: enableSensorEvents required on both shapes.
//   - Same-body shapes do not generate sensor events.
//   - A sensor does not detect itself.
//   - Two overlapping sensors detect each other as visitors.
//   - Begin then end as a body enters then leaves the sensor region.

import { World } from "@vworlds/vecs";
import { describe, expect, it } from "vitest";

import {
  Body,
  BodyType,
  Box,
  Circle,
  GravityScale,
  installPhysics,
  LinearVelocity,
  Position,
  Sensor,
  SensorEvents,
} from "../../src/index.js";
import { getPhysics } from "../../src/adapter/state.js";

const STEP_MS = 1000 / 60;

function makeWorld(gravityY = 0) {
  const world = new World();
  installPhysics(world, {
    gravity: { x: 0, y: gravityY },
    subSteps: 4,
  });
  world.start();
  return world;
}

let _now = 0;
function step(world: World) {
  _now += STEP_MS;
  world.progress(_now, STEP_MS);
}

// ─── TestSensor parity ────────────────────────────────────────────────────────

describe("TestSensor parity (box2d test_world.c:329-395)", () => {
  it("produces exactly one begin frame and one end frame", () => {
    const world = makeWorld();

    const wallBody = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 1.5, y: 11 });
    world.entity().childOf(wallBody).set(Box, { hx: 0.5, hy: 10 }).add(SensorEvents);

    const bulletBody = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 7.39814, y: 4 })
      .set(LinearVelocity, { x: -20, y: 0 })
      .add(GravityScale);
    const bulletShapeEntity = world
      .entity()
      .childOf(bulletBody)
      .set(Circle, { radius: 0.1 })
      .add(Sensor)
      .add(SensorEvents);

    let beginCount = 0;
    let endCount = 0;
    let prevBeginLen = 0;
    let prevEndLen = 0;

    for (let i = 0; i < 2000; i++) {
      step(world);

      const sev = bulletShapeEntity.get(SensorEvents)!;
      const curBeginLen = sev.begin.length;
      const curEndLen = sev.end.length;

      if (curBeginLen > 0 && prevBeginLen === 0) {
        beginCount++;
      }
      if (curEndLen > 0 && prevEndLen === 0) {
        endCount++;
      }
      prevBeginLen = curBeginLen;
      prevEndLen = curEndLen;

      const bulletPos = bulletBody.get(Position);
      if (bulletPos && bulletPos.x < -1.0) {
        break;
      }
    }

    expect(beginCount).toBe(1);
    expect(endCount).toBe(1);
  });

  it("sensor shape entity (bullet circle) gets SensorEvents with other = wall shape", () => {
    const world = makeWorld();

    const wallBody = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 1.5, y: 11 });
    const wallShapeEntity = world
      .entity()
      .childOf(wallBody)
      .set(Box, { hx: 0.5, hy: 10 })
      .add(SensorEvents);

    const bulletBody = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 7.39814, y: 4 })
      .set(LinearVelocity, { x: -20, y: 0 })
      .add(GravityScale);
    const bulletShapeEntity = world
      .entity()
      .childOf(bulletBody)
      .set(Circle, { radius: 0.1 })
      .add(Sensor)
      .add(SensorEvents);

    let foundBeginFrame = false;
    for (let i = 0; i < 2000; i++) {
      step(world);
      const sev = bulletShapeEntity.get(SensorEvents)!;
      if (sev.begin.length > 0) {
        expect(sev.begin[0]!.other.eid).toBe(wallShapeEntity.eid);
        foundBeginFrame = true;
        break;
      }
      const pos = bulletBody.get(Position);
      if (pos && pos.x < -1.0) {
        break;
      }
    }

    expect(foundBeginFrame).toBe(true);
  });
});

// ─── Opt-in tests ─────────────────────────────────────────────────────────────

describe("sensor opt-in (enableSensorEvents required on both shapes)", () => {
  it("no events when sensor shape has no SensorEvents component", () => {
    const world = makeWorld();

    const wallBody = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 });
    const wallShapeEntity = world
      .entity()
      .childOf(wallBody)
      .set(Box, { hx: 1, hy: 1 })
      .add(SensorEvents);

    const bulletBody = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0 })
      .add(GravityScale);
    world.entity().childOf(bulletBody).set(Circle, { radius: 0.1 }).add(Sensor);
    // NO SensorEvents on the sensor shape.

    step(world);
    step(world);
    step(world);
    // Wall shape has SensorEvents but it's the visitor, not the sensor.
    // The sensor (bullet circle) has no SensorEvents — no events fire.
    expect(wallShapeEntity.get(SensorEvents)!.begin.length).toBe(0);
  });

  it("no events when visitor shape has no SensorEvents component", () => {
    const world = makeWorld();

    const wallBody = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 });
    world.entity().childOf(wallBody).set(Box, { hx: 1, hy: 1 });
    // NO SensorEvents on the visitor.

    const bulletBody = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0 })
      .add(GravityScale);
    const bulletShape = world
      .entity()
      .childOf(bulletBody)
      .set(Circle, { radius: 0.1 })
      .add(Sensor)
      .add(SensorEvents);

    step(world);
    step(world);
    step(world);
    // Sensor has SensorEvents but visitor does not → box2d rejects it.
    expect(bulletShape.get(SensorEvents)!.begin.length).toBe(0);
  });

  it("events fire when BOTH shapes have SensorEvents and are overlapping", () => {
    const world = makeWorld();

    const wallBody = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 });
    world.entity().childOf(wallBody).set(Box, { hx: 1, hy: 1 }).add(SensorEvents);

    const bulletBody = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0 })
      .add(GravityScale);
    const bulletShape = world
      .entity()
      .childOf(bulletBody)
      .set(Circle, { radius: 0.1 })
      .add(Sensor)
      .add(SensorEvents);

    step(world);
    expect(bulletShape.get(SensorEvents)!.begin.length).toBeGreaterThan(0);
  });
});

// ─── Same-body rejection ──────────────────────────────────────────────────────

describe("same-body rejection", () => {
  it("shapes on the same body do not generate sensor events", () => {
    const world = makeWorld();

    const body = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0 })
      .add(GravityScale);
    const sensorShape = world
      .entity()
      .childOf(body)
      .set(Circle, { radius: 0.5 })
      .add(Sensor)
      .add(SensorEvents);
    world.entity().childOf(body).set(Box, { hx: 0.5, hy: 0.5 }).add(SensorEvents);

    step(world);
    step(world);
    expect(sensorShape.get(SensorEvents)!.begin.length).toBe(0);
    void getPhysics(world);
  });
});

// ─── Self-detection prevention ───────────────────────────────────────────────

describe("self-detection prevention", () => {
  it("a sensor shape does not detect itself", () => {
    const world = makeWorld();

    const body = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0 })
      .add(GravityScale);
    const sensorShape = world
      .entity()
      .childOf(body)
      .set(Circle, { radius: 0.5 })
      .add(Sensor)
      .add(SensorEvents);

    step(world);
    step(world);
    step(world);
    expect(sensorShape.get(SensorEvents)!.begin.length).toBe(0);
    void getPhysics(world);
  });
});

// ─── Sensor-vs-sensor ────────────────────────────────────────────────────────

describe("sensor-vs-sensor", () => {
  it("two overlapping sensors on different bodies produce events for each other", () => {
    const world = makeWorld();

    const bodyA = world.entity().set(Body, { type: BodyType.Static }).set(Position, { x: 0, y: 0 });
    const shapeA = world
      .entity()
      .childOf(bodyA)
      .set(Circle, { radius: 0.5 })
      .add(Sensor)
      .add(SensorEvents);

    const bodyB = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0 })
      .add(GravityScale);
    const shapeB = world
      .entity()
      .childOf(bodyB)
      .set(Circle, { radius: 0.5 })
      .add(Sensor)
      .add(SensorEvents);

    step(world);
    expect(shapeA.get(SensorEvents)!.begin).toHaveLength(1);
    expect(shapeA.get(SensorEvents)!.begin[0]!.other.eid).toBe(shapeB.eid);
    expect(shapeB.get(SensorEvents)!.begin).toHaveLength(1);
    expect(shapeB.get(SensorEvents)!.begin[0]!.other.eid).toBe(shapeA.eid);
  });
});

// ─── Enter / leave cycle ──────────────────────────────────────────────────────

describe("begin then end as body enters and leaves sensor", () => {
  it("emits begin on overlap, then end when body exits the sensor zone", () => {
    const world = makeWorld();

    const zoneBody = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 });
    const zoneShape = world
      .entity()
      .childOf(zoneBody)
      .set(Box, { hx: 1, hy: 1 })
      .add(Sensor)
      .add(SensorEvents);

    const movingBody = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0 })
      .set(LinearVelocity, { x: 10, y: 0 })
      .add(GravityScale);
    world.entity().childOf(movingBody).set(Circle, { radius: 0.1 }).add(SensorEvents);

    let beginStep = -1;
    let endStep = -1;
    let prevBeginLen = 0;
    let prevEndLen = 0;

    for (let i = 0; i < 200; i++) {
      step(world);
      const sev = zoneShape.get(SensorEvents)!;
      const curBeginLen = sev.begin.length;
      const curEndLen = sev.end.length;

      if (beginStep < 0 && curBeginLen > 0 && prevBeginLen === 0) {
        beginStep = i;
      }
      if (endStep < 0 && curEndLen > 0 && prevEndLen === 0) {
        endStep = i;
      }
      prevBeginLen = curBeginLen;
      prevEndLen = curEndLen;

      const pos = movingBody.get(Position);
      if (pos && pos.x > 3) {
        break;
      }
    }

    expect(beginStep).toBeGreaterThanOrEqual(0);
    expect(endStep).toBeGreaterThan(beginStep);
  });
});
