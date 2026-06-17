// Regression: a Detectable *visitor* solid created the SAME frame another shape
// is destroyed must keep its entry in engine.entityByShapeIndex so sensor begin
// events against it still resolve.
//
// Box2D recycles a destroyed shape's id slot (same index1, bumped generation) to
// a shape created in the same inbox drain. destroyShapeForEntity used to call
// engine.entityByShapeIndex.delete(shapeId.index1) unconditionally; when the
// destroyed shape's slot had already been recycled to a fresh, live shape, that
// delete wiped the fresh shape's reverse-map entry. PhysicsEvents.emitSensorEvent
// then resolved the visitor to `undefined` and silently dropped the begin event.
// The fix only deletes the mapping when it still points at us. See
// systems/shape_lifecycle.ts.
//
// Mirrors the spacerocks bug where a split-spawned child asteroid (a Detectable
// visitor created the same frame the parent + bullet were destroyed, recycling
// their freed slots) was invisible to all projectiles.

import { World, type Entity } from "@vworlds/vecs";
import { describe, expect, it } from "vitest";

import {
  Body,
  BodyType,
  Circle,
  CollisionFilter,
  Detectable,
  GravityScale,
  PhysicsModule,
  Position,
  Sensor,
  SensorEvents,
} from "../../src/index.js";

const STEP_MS = 1000 / 60;
const CAT_SENSOR = 0b0001;
const CAT_VISITOR = 0b0010;

function makeWorld() {
  const world = new World();
  world.module(PhysicsModule, { gravity: { x: 0, y: 0 }, subSteps: 4 });
  return world;
}

let _now = 0;
function step(world: World) {
  _now += STEP_MS;
  world.progress(_now, STEP_MS);
}

function makeVisitor(world: World): Entity {
  const body = world
    .entity()
    .set(Body, { type: BodyType.Dynamic })
    .set(Position, { x: 0, y: 0 })
    .add(GravityScale);
  world
    .entity()
    .childOf(body)
    .set(Circle, { radius: 0.2 })
    .add(Detectable)
    .set(CollisionFilter, { categoryBits: CAT_VISITOR, maskBits: CAT_SENSOR });
  return body;
}

describe("visitor shape-id slot recycling (regression)", () => {
  it("a Detectable visitor created the same frame another shape is destroyed is still detected", () => {
    const world = makeWorld();

    // Stable sensor detector at the origin; reports begin against any Detectable
    // visitor that overlaps it.
    const detectorBody = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 });
    const detector = world
      .entity()
      .childOf(detectorBody)
      .set(Circle, { radius: 1 })
      .add(Sensor)
      .add(SensorEvents)
      .set(CollisionFilter, { categoryBits: CAT_SENSOR, maskBits: CAT_VISITOR });

    // Victim visitor occupies a Box2D shape slot; destroying its body frees it.
    const victimBody = makeVisitor(world);

    step(world);
    step(world);

    // SAME frame, matching the asteroid split handler's order: create the fresh
    // visitor FIRST (its shape-lifecycle `enter` is queued), THEN destroy the
    // victim body (its shape `exit` is queued after, and the body teardown frees
    // the victim's slot, which the fresh visitor recycles).
    const freshBody = makeVisitor(world);
    victimBody.destroy();

    // `begin` only holds the most recent step's transitions and is cleared each
    // frame, so accumulate which visitors the detector reported across a few steps.
    let detectedFresh = false;
    for (let i = 0; i < 5; i++) {
      step(world);
      for (const event of detector.get(SensorEvents)!.begin) {
        if (event.other.parent === freshBody) {
          detectedFresh = true;
        }
      }
    }

    // The fresh visitor must still resolve in entityByShapeIndex: the victim's
    // stale-id teardown must not have wiped the recycled slot's mapping.
    expect(detectedFresh).toBe(true);
  });
});
