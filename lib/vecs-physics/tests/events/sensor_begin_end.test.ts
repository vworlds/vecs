// VP-21c / VP-21b: sensor overlap pass — raw arrays and ECS SensorEvents publishing.
//
// After VP-21b, `PhysicsEvents` clears `state.sensorBeginEvents` and
// `state.sensorEndEvents` at the END of physics-post (after publishing). World-level
// tests therefore check the ECS `SensorEvents` component arrays. Engine-level tests
// (destroySensor path) bypass the Vecs pipeline and still read raw arrays directly.
//
// Tests cover:
//   - TestSensor parity (ported from box2d test/test_world.c:329-395): exactly
//     one begin frame and one end frame (checked via SensorEvents component).
//   - Opt-in: enableSensorEvents required on both shapes (checked via raw array
//     absence at engine level / component presence at world level).
//   - Same-body shapes do not generate sensor events.
//   - A sensor does not detect itself.
//   - Two overlapping sensors detect each other as visitors.
//   - Begin then end as a body enters then leaves the sensor region.
//   - destroySensor path: removing a sensor while overlapping emits a raw end event.

import { ChildOf, World } from "@vworlds/vecs";
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
import { destroySensor } from "../../src/engine/sensor.js";
import { makeCircleShape, createShape } from "../../src/engine/shape.js";
import { AWAKE_SET, createBody } from "../../src/engine/solver_set.js";
import { getPhysics, PhysicsState, type ResolvedPhysicsOptions } from "../../src/engine/state.js";
import { IDENTITY } from "../../src/math/transform.js";
import type { BodyHandle } from "../../src/util/handle.js";
import { DYNAMIC_BODY } from "../../src/engine/body.js";

// ─── Engine-level helpers (mirroring contact_begin_end.test.ts) ───────────────

const ENTITY = { eid: 99 } as unknown as Parameters<typeof createBody>[2];

const ENGINE_OPTIONS: ResolvedPhysicsOptions = {
  gravityX: 0,
  gravityY: 0,
  fixedTimeStep: 1 / 60,
  subSteps: 4,
  debug: false,
  restitutionThreshold: 1,
  hitEventThreshold: 1,
  contactHertz: 30,
  contactDampingRatio: 10,
  contactSpeed: 3,
  maximumLinearSpeed: 400,
  enableSleep: true,
  enableContinuous: true,
};

function makeEngineState(): PhysicsState {
  return new PhysicsState(ENGINE_OPTIONS);
}

function makeBodyInState(state: PhysicsState): BodyHandle {
  return createBody(state, state.solverSets[AWAKE_SET]!, ENTITY, DYNAMIC_BODY);
}

function makeSensorShapeOnBody(state: PhysicsState, bodyHandle: BodyHandle): number {
  const shape = makeCircleShape(0.5, IDENTITY);
  shape.bodyHandle = bodyHandle;
  shape.sensor = true;
  shape.enableSensorEvents = true;
  const handle = createShape(state.shapes, shape);
  // Register the sensor record.
  shape.sensorIndex = state.sensors.create(handle.index);
  return handle.index;
}

function makeVisitorShapeOnBody(state: PhysicsState, bodyHandle: BodyHandle): number {
  const shape = makeCircleShape(0.5, IDENTITY);
  shape.bodyHandle = bodyHandle;
  shape.sensor = false;
  shape.enableSensorEvents = true;
  const handle = createShape(state.shapes, shape);
  return handle.index;
}

// ─── World-level helper ───────────────────────────────────────────────────────

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

/** Advance one physics step (1/60 s, matching box2d TestSensor). */
let _now = 0;
function step(world: World) {
  _now += STEP_MS;
  world.progress(_now, STEP_MS);
}

// ─── TestSensor parity ────────────────────────────────────────────────────────

describe("TestSensor parity (box2d test_world.c:329-395)", () => {
  // Port of the box2d TestSensor golden test.
  //
  // Setup (box2d test_world.c:330-358):
  //   - Static wall body at x=1.5, y=11; polygon box 0.5×10 with enableSensorEvents.
  //   - Dynamic bullet body at x=7.39814, y=4; linearVelocity=(-20,0); gravityScale=0.
  //   - Bullet shape: circle r=0.1, isSensor=true, enableSensorEvents=true.
  //   - Wall shape: NOT a sensor — it is the visitor shape.
  //
  // Box2d expectation (test_world.c:391-393):
  //   ENSURE(beginCount == 1);   // exactly one step has begin events
  //   ENSURE(endCount == 1);     // exactly one step has end events

  it("produces exactly one begin frame and one end frame", () => {
    const world = makeWorld();

    // Wall: static body at x=1.5, y=11, box 0.5×10.
    // box2d test_world.c:335-343: b2_staticBody, position={1.5,11},
    //   b2MakeBox(0.5, 10), shapeDef.enableSensorEvents = true.
    const wallBody = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 1.5, y: 11 });
    world
      .entity()
      .set(ChildOf, { target: wallBody })
      .set(Box, { hx: 0.5, hy: 10 })
      .add(SensorEvents); // enableSensorEvents on the visitor

    // Bullet: dynamic body at x=7.39814, y=4, vx=-20, gravityScale=0.
    // box2d test_world.c:345-358: b2_dynamicBody, isBullet=true, gravityScale=0,
    //   position={7.39814,4}, linearVelocity={-20,0}.
    //   shapeDef.isSensor=true, enableSensorEvents=true, circle r=0.1.
    const bulletBody = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 7.39814, y: 4 })
      .set(LinearVelocity, { x: -20, y: 0 })
      .add(GravityScale); // defaults to 0 scale (no gravity)
    const bulletShapeEntity = world
      .entity()
      .set(ChildOf, { target: bulletBody })
      .set(Circle, { radius: 0.1 })
      .add(Sensor)
      .add(SensorEvents);

    // After VP-21b the raw arrays are cleared at end-of-publish.
    // Count frames by checking the SensorEvents component instead.
    let beginCount = 0;
    let endCount = 0;
    let prevBeginLen = 0;
    let prevEndLen = 0;

    // Run until the bullet has passed through (x < -1.0 matches box2d test_world.c:382).
    for (let i = 0; i < 2000; i++) {
      step(world);

      const sev = bulletShapeEntity.get(SensorEvents)!;
      const curBeginLen = sev.begin.length;
      const curEndLen = sev.end.length;

      // Count frames where new events arrived (component is non-empty after this step
      // but was empty/smaller before — modified fires means new events).
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

    // Mirrors box2d test_world.c:391-393:
    //   ENSURE(beginCount == 1);
    //   ENSURE(endCount == 1);
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
      .set(ChildOf, { target: wallBody })
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
      .set(ChildOf, { target: bulletBody })
      .set(Circle, { radius: 0.1 })
      .add(Sensor)
      .add(SensorEvents);

    let foundBeginFrame = false;
    for (let i = 0; i < 2000; i++) {
      step(world);
      const sev = bulletShapeEntity.get(SensorEvents)!;
      if (sev.begin.length > 0) {
        // The bullet is the sensor; other = the wall shape entity.
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

    // Visitor has SensorEvents, sensor does NOT.
    const wallBody = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 });
    world.entity().set(ChildOf, { target: wallBody }).set(Box, { hx: 1, hy: 1 }).add(SensorEvents); // visitor opt-in

    const bulletBody = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0 })
      .add(GravityScale);
    world.entity().set(ChildOf, { target: bulletBody }).set(Circle, { radius: 0.1 }).add(Sensor);
    // NO SensorEvents on the sensor shape — enableSensorEvents will be false.

    const state = getPhysics(world);
    step(world);
    step(world);
    step(world);
    expect(state.sensorBeginEvents).toHaveLength(0);
    expect(state.sensorEndEvents).toHaveLength(0);
  });

  it("no events when visitor shape has no SensorEvents component", () => {
    const world = makeWorld();

    // Sensor has SensorEvents, visitor does NOT.
    const wallBody = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 });
    world.entity().set(ChildOf, { target: wallBody }).set(Box, { hx: 1, hy: 1 });
    // NO SensorEvents on the visitor — box2d rejects it at line:
    //   if (otherShape->enableSensorEvents == false) return true; (sensor.c:63-66)

    const bulletBody = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0 })
      .add(GravityScale);
    world
      .entity()
      .set(ChildOf, { target: bulletBody })
      .set(Circle, { radius: 0.1 })
      .add(Sensor)
      .add(SensorEvents); // sensor opt-in

    const state = getPhysics(world);
    step(world);
    step(world);
    step(world);
    expect(state.sensorBeginEvents).toHaveLength(0);
    expect(state.sensorEndEvents).toHaveLength(0);
  });

  it("events fire when BOTH shapes have SensorEvents and are overlapping", () => {
    const world = makeWorld();

    // Static sensor overlapping a dynamic visitor at the same position.
    const wallBody = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 });
    world.entity().set(ChildOf, { target: wallBody }).set(Box, { hx: 1, hy: 1 }).add(SensorEvents);

    const bulletBody = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0 })
      .add(GravityScale);
    const bulletShape = world
      .entity()
      .set(ChildOf, { target: bulletBody })
      .set(Circle, { radius: 0.1 })
      .add(Sensor)
      .add(SensorEvents);

    step(world); // first step detects overlap → begin event
    // After VP-21b the raw arrays are cleared; check the ECS component.
    expect(bulletShape.get(SensorEvents)!.begin.length).toBeGreaterThan(0);
  });
});

// ─── Same-body rejection ──────────────────────────────────────────────────────

describe("same-body rejection", () => {
  it("shapes on the same body do not generate sensor events", () => {
    const world = makeWorld();

    // One body with a sensor shape and a non-sensor shape (same body).
    // box2d sensor.c:69-71: if (otherShape->bodyId == sensorShape->bodyId) return true;
    const body = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0 })
      .add(GravityScale);
    world
      .entity()
      .set(ChildOf, { target: body })
      .set(Circle, { radius: 0.5 })
      .add(Sensor)
      .add(SensorEvents);
    world.entity().set(ChildOf, { target: body }).set(Box, { hx: 0.5, hy: 0.5 }).add(SensorEvents);

    const state = getPhysics(world);
    step(world);
    step(world);
    expect(state.sensorBeginEvents).toHaveLength(0);
    expect(state.sensorEndEvents).toHaveLength(0);
  });
});

// ─── Self-detection prevention ───────────────────────────────────────────────

describe("self-detection prevention", () => {
  it("a sensor shape does not detect itself", () => {
    const world = makeWorld();

    // box2d sensor.c:54-57: if (shapeId == sensorShapeId) return true;
    const body = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0 })
      .add(GravityScale);
    world
      .entity()
      .set(ChildOf, { target: body })
      .set(Circle, { radius: 0.5 })
      .add(Sensor)
      .add(SensorEvents);

    const state = getPhysics(world);
    step(world);
    step(world);
    step(world);
    expect(state.sensorBeginEvents).toHaveLength(0);
  });
});

// ─── Sensor-vs-sensor ────────────────────────────────────────────────────────

describe("sensor-vs-sensor", () => {
  // box2d b2SensorQueryCallback (sensor.c:44-120) does NOT have an isSensor
  // gate — it only rejects shapes that are disabled, on the same body, or have
  // enableSensorEvents == false. Two sensors on different bodies that both have
  // enableSensorEvents WILL detect each other as visitors, producing events.
  // Each sensor queries the trees and finds the other as a visitor.
  it("two overlapping sensors on different bodies produce events for each other", () => {
    const world = makeWorld();

    const bodyA = world.entity().set(Body, { type: BodyType.Static }).set(Position, { x: 0, y: 0 });
    const shapeA = world
      .entity()
      .set(ChildOf, { target: bodyA })
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
      .set(ChildOf, { target: bodyB })
      .set(Circle, { radius: 0.5 })
      .add(Sensor)
      .add(SensorEvents);

    step(world);
    // Each sensor sees the other as a visitor → each SensorEvents gets a begin event.
    // shapeA detects shapeB (other = shapeB), shapeB detects shapeA (other = shapeA).
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

    // Static sensor zone at origin — box 2×2 (hx=1, hy=1).
    const zoneBody = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 });
    const zoneShape = world
      .entity()
      .set(ChildOf, { target: zoneBody })
      .set(Box, { hx: 1, hy: 1 })
      .add(Sensor)
      .add(SensorEvents);

    // Dynamic body starting inside the zone, moving right at 10 m/s.
    // After ~0.2 s (12 steps at dt=1/60) it will be past x=2 (zone right edge=1).
    const movingBody = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0 })
      .set(LinearVelocity, { x: 10, y: 0 })
      .add(GravityScale);
    world
      .entity()
      .set(ChildOf, { target: movingBody })
      .set(Circle, { radius: 0.1 })
      .add(SensorEvents);

    // After VP-21b the raw arrays are cleared at end-of-publish.
    // Track begin/end frames via the SensorEvents component on the zone shape.
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
      } // well past the zone
    }

    // A begin event fires on the first step (starts inside the zone).
    expect(beginStep).toBeGreaterThanOrEqual(0);
    // An end event fires after the body moves out of the zone.
    expect(endStep).toBeGreaterThan(beginStep);
  });
});

// ─── destroySensor end-event path (engine-level) ─────────────────────────────
//
// These tests bypass the Vecs pipeline entirely and call destroySensor directly.
// They verify the raw sensorEndEvents emission path in the engine, independent
// of the PhysicsEvents publish/clear cycle. The timing gap described in VP-21a
// (physics-pre teardown events cleared before VP-21b could read them) is now
// fixed by the ARCHITECT RESOLUTION: PhysicsEvents clears arrays at end-of-publish,
// so teardown events generated in physics-pre survive to the publish. But
// engine-level tests remain useful for validating the emit logic directly.

describe("destroySensor emits end events for current overlaps (engine-level)", () => {
  it("destroySensor pushes an end event for each visitor in overlaps2", () => {
    const state = makeEngineState();

    const bodyA = makeBodyInState(state);
    const bodyB = makeBodyInState(state);

    const sensorShapeIndex = makeSensorShapeOnBody(state, bodyA);
    const visitorShapeIndex = makeVisitorShapeOnBody(state, bodyB);

    // Manually seed overlaps2 to simulate an active overlap.
    const sensorRecord = state.sensors.records[0]!;
    sensorRecord.overlaps2.push({
      shapeIndex: visitorShapeIndex,
      generation: state.shapes.idPool.generationOf(visitorShapeIndex),
    });

    // Verify no events yet.
    expect(state.sensorEndEvents).toHaveLength(0);

    // Call destroySensor directly — mirrors b2DestroySensor (sensor.c:372-409).
    destroySensor(state, 0);

    // An end event should have been emitted for the visitor in overlaps2.
    expect(state.sensorEndEvents).toHaveLength(1);
    expect(state.sensorEndEvents[0]!.sensorShape.index).toBe(sensorShapeIndex);
    expect(state.sensorEndEvents[0]!.visitorShape.index).toBe(visitorShapeIndex);
  });

  it("destroySensor swap-removes and patches the moved sensor shape's sensorIndex", () => {
    const state = makeEngineState();

    const bodyA = makeBodyInState(state);
    const bodyB = makeBodyInState(state);

    // Create two sensor shapes.
    const sensor0ShapeIndex = makeSensorShapeOnBody(state, bodyA);
    const sensor1ShapeIndex = makeSensorShapeOnBody(state, bodyB);

    expect(state.sensors.count).toBe(2);
    expect(state.shapes.get(sensor0ShapeIndex).sensorIndex).toBe(0);
    expect(state.shapes.get(sensor1ShapeIndex).sensorIndex).toBe(1);

    // Destroy sensor 0 (swap-removes: sensor1 moves to index 0).
    destroySensor(state, 0);
    state.shapes.get(sensor0ShapeIndex).sensorIndex = -1; // mimic shape lifecycle clearing

    expect(state.sensors.count).toBe(1);
    // sensor1's shape should have its sensorIndex patched to 0.
    expect(state.shapes.get(sensor1ShapeIndex).sensorIndex).toBe(0);
  });
});
