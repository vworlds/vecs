// Regression: a sensor shape created in the SAME frame another shape is
// destroyed must keep its sensor-event opt-in.
//
// Box2D recycles a destroyed shape's id slot (incrementing its generation).
// PhysicsEventOptInSync:Sensor's `exit` runs for the destroyed shape in the same
// inbox drain as the new shape's `enter`. The exit's captured shape id keeps the
// OLD generation, but b2Shape_EnableSensorEvents does not validate generation --
// it indexes by index1 and would clobber the freshly-created shape that recycled
// the slot, silently disabling its sensor events. The fix guards the setter with
// b2Shape_IsValid (which does check generation). See
// events/opt_in.ts.
//
// Mirrors the spacerocks bug where split-spawned asteroids (created the same
// frame the parent + bullet were destroyed) were invisible to all projectiles.

import { World } from "@vworlds/vecs";
import { describe, expect, it } from "vitest";

import {
  Body,
  BodyType,
  Circle,
  GravityScale,
  PhysicsModule,
  Position,
  Sensor,
  SensorEvents,
} from "../../src/index.js";

const STEP_MS = 1000 / 60;

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

describe("sensor shape-id slot recycling (regression)", () => {
  it("a sensor created the same frame another sensor is destroyed still fires begin", () => {
    const world = makeWorld();

    // Stable overlapping detector at the origin (both detector and visitor).
    const probeBody = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 });
    world.entity().childOf(probeBody).set(Circle, { radius: 1 }).add(Sensor).add(SensorEvents);

    // Victim sensor at the origin; destroying it frees its Box2D shape slot.
    const victimBody = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0 })
      .add(GravityScale);
    world.entity().childOf(victimBody).set(Circle, { radius: 0.2 }).add(Sensor).add(SensorEvents);

    step(world);
    step(world);

    // SAME frame, matching the asteroid split handler's order: create the new
    // sensor FIRST (its opt-in `enter` is queued), THEN destroy the victim (its
    // `exit` is queued after). The new shape recycles the victim's freed slot, so
    // the victim's stale-id exit -- processed after the new shape's enter -- lands
    // on the recycled slot.
    const freshBody = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0 })
      .add(GravityScale);
    const freshShape = world
      .entity()
      .childOf(freshBody)
      .set(Circle, { radius: 0.2 })
      .add(Sensor)
      .add(SensorEvents);
    victimBody.destroy();

    // The victim's exit and the fresh shape's enter drain together on the next
    // step. `begin` only holds the transition from the most recent step and is
    // cleared each frame, so accumulate across a few steps.
    let beganEver = false;
    for (let i = 0; i < 5; i++) {
      step(world);
      if (freshShape.get(SensorEvents)!.begin.length > 0) {
        beganEver = true;
      }
    }

    // The fresh sensor must still be detectable: its opt-in must not have been
    // clobbered by the victim's stale-id exit.
    expect(beganEver).toBe(true);
  });
});
