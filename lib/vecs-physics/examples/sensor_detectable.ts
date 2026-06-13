// See docs/events.md for the sensor event model and Detectable.

import { World } from "@vworlds/vecs";
import {
  Body,
  BodyType,
  Box,
  Detectable,
  PhysicsModule,
  Position,
  preloadPhysics,
  Sensor,
  SensorEvents,
} from "@vworlds/vecs-physics";

const STEP_MS = 1000 / 60;

await preloadPhysics();

const world = new World();
world.module(PhysicsModule, { gravity: { x: 0, y: 0 }, fixedTimeStep: 1 / 60, subSteps: 4 });

const zoneBody = world.entity().set(Body, { type: BodyType.Static }).set(Position, { x: 0, y: 0 });
const zoneShape = world
  .entity()
  .childOf(zoneBody)
  .set(Box, { hx: 1, hy: 1 })
  .add(Sensor)
  .add(SensorEvents);

// A solid (non-sensor) shape that overlaps the sensor zone from the start.
// Without Detectable, the sensor would never see it.
const solidBody = world.entity().set(Body, { type: BodyType.Static }).set(Position, { x: 0, y: 0 });
const solidShape = world.entity().childOf(solidBody).set(Box, { hx: 0.5, hy: 0.5 }).add(Detectable);

let now = 0;
let reported = false;

for (let frame = 1; frame <= 10; frame++) {
  now += STEP_MS;
  world.progress(now, STEP_MS);

  const events = zoneShape.get(SensorEvents)!;
  for (const event of events.begin) {
    console.log(
      `frame ${frame}: sensor begin, other=${event.other.eid} (solidShape=${solidShape.eid})`
    );
    reported = true;
  }
}

console.log(`sensor detected the Detectable solid: ${reported}`);
