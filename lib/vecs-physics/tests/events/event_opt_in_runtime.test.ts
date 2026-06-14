// Runtime event opt-in sync (PhysicsEventOptInSync).
//
// Regression for: ContactEvents / HitEvents / SensorEvents added to or removed
// from a shape AFTER it entered the engine were silently ignored. These tests
// drive the documented "add an event component when you want events" contract
// at runtime, not just at shape creation.

import { World } from "@vworlds/vecs";
import { beforeEach, describe, expect, it } from "vitest";

import {
  Body,
  BodyType,
  Box,
  Circle,
  ContactEvents,
  GravityScale,
  HitEvents,
  PhysicsModule,
  Position,
  Sensor,
  SensorEvents,
} from "../../src/index.js";
import { getPhysicsEngine, type b2ShapeId, type PhysicsEngine } from "../../src/adapter/engine.js";
import { SingleShape } from "../../src/components/geometry.js";

const STEP_MS = 1000 / 60;

let world: World;
let engine: PhysicsEngine;
let now: number;

beforeEach(() => {
  world = new World();
  world.module(PhysicsModule, { gravity: { x: 0, y: 0 } });
  engine = getPhysicsEngine(world);
  now = 0;
});

function step(n = 1): void {
  for (let i = 0; i < n; i++) {
    now += STEP_MS;
    world.progress(now, STEP_MS);
  }
}

/** A dynamic 2×2 box body+shape at (x, y). Returns the body and shape entities. */
function makeBox(x: number, y: number) {
  const body = world.entity().set(Body, { type: BodyType.Dynamic }).set(Position, { x, y });
  const shapeEnt = world.entity().childOf(body).set(Box, { hx: 1, hy: 1 });
  return { body, shapeEnt };
}

// ─── ContactEvents ────────────────────────────────────────────────────────────

describe("runtime ContactEvents opt-in", () => {
  it("delivers a begin event after ContactEvents is added to an existing shape", () => {
    // Two boxes far apart, neither opted in. After they enter the engine, add
    // ContactEvents to one, then teleport them together so a NEW contact forms.
    const a = makeBox(-3, 0);
    const b = makeBox(3, 0);
    step(1);

    a.shapeEnt.add(ContactEvents); // runtime opt-in

    // Bring them into overlap (2×2 boxes, centres 1 apart → overlap by 1).
    a.body.set(Position, { x: -0.5, y: 0 });
    b.body.set(Position, { x: 0.5, y: 0 });
    step(1);

    const events = a.shapeEnt.get(ContactEvents)!;
    expect(events.begin.length).toBe(1);
    expect(events.begin[0]!.other.eid).toBe(b.shapeEnt.eid);
  });

  it("clears the WASM contact events flag when ContactEvents is removed", () => {
    const a = makeBox(-0.5, 0);
    const b = makeBox(0.5, 0);
    a.shapeEnt.set(ContactEvents, {});
    step(1);

    // Sanity: contact events enabled on the WASM shape.
    const shapeId = a.shapeEnt.get(SingleShape)!._shapeId as b2ShapeId;
    expect(engine.box2d.b2Shape_AreContactEventsEnabled(shapeId)).toBe(true);

    a.shapeEnt.remove(ContactEvents); // runtime opt-out
    step(1);

    expect(engine.box2d.b2Shape_AreContactEventsEnabled(shapeId)).toBe(false);
    void b;
  });
});

// ─── HitEvents ──────────────────────────────────────────────────────────────

describe("runtime HitEvents opt-in", () => {
  it("flips the WASM enableHitEvents flag when HitEvents is added then removed", () => {
    const a = makeBox(0, 0);
    step(1);
    const shapeId = a.shapeEnt.get(SingleShape)!._shapeId as b2ShapeId;
    expect(engine.box2d.b2Shape_AreHitEventsEnabled(shapeId)).toBe(false);

    a.shapeEnt.add(HitEvents);
    step(1);
    expect(engine.box2d.b2Shape_AreHitEventsEnabled(shapeId)).toBe(true);

    a.shapeEnt.remove(HitEvents);
    step(1);
    expect(engine.box2d.b2Shape_AreHitEventsEnabled(shapeId)).toBe(false);
  });
});

// ─── SensorEvents (the originally-filed visitor case) ─────────────────────────

describe("runtime SensorEvents opt-in", () => {
  it("a sensor begins detecting a visitor once the visitor adds SensorEvents", () => {
    // Sensor shape on a static body; a solid visitor overlapping it. The visitor
    // is NOT opted in at creation, so box2d's detection rule rejects it.
    const sensorBody = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 });
    const sensorShape = world
      .entity()
      .childOf(sensorBody)
      .set(Box, { hx: 1, hy: 1 })
      .add(Sensor)
      .add(SensorEvents);

    const visitorBody = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0 })
      .add(GravityScale); // 0 scale → stays overlapping
    const visitorShape = world.entity().childOf(visitorBody).set(Circle, { radius: 0.4 });

    step(1);
    // Visitor not opted in → no detection.
    expect(sensorShape.get(SensorEvents)!.begin.length).toBe(0);

    visitorShape.add(SensorEvents); // runtime opt-in on the visitor
    step(1);

    const events = sensorShape.get(SensorEvents)!;
    expect(events.begin.length).toBe(1);
    expect(events.begin[0]!.other.eid).toBe(visitorShape.eid);
  });
});
