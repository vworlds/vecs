// See docs/events.md for the full sensor event model.

import { World } from "@vworlds/vecs";
import {
  Body,
  BodyType,
  Box,
  Circle,
  LinearVelocity,
  Position,
  Sensor,
  SensorEvents,
  installPhysics,
  preloadPhysics,
} from "@vworlds/vecs-physics";

class Tint {
  value = "blue";
}

const STEP_MS = 1000 / 60;

await preloadPhysics();

const world = new World();
installPhysics(world, { gravity: { x: 0, y: 0 }, fixedTimeStep: 1 / 60, subSteps: 4 });
world.component(Tint);
const zoneBody = world.entity().set(Body, { type: BodyType.Static }).set(Position, { x: 0, y: 0 });
const zoneShape = world
  .entity()
  .childOf(zoneBody)
  .set(Box, { hx: 1, hy: 1 })
  .add(Sensor)
  .add(SensorEvents);

const mover = world
  .entity()
  .set(Body, { type: BodyType.Dynamic })
  .set(Position, { x: -3, y: 0 })
  .set(LinearVelocity, { x: 3, y: 0 })
  .set(Tint, { value: "blue" });
const moverShape = world.entity().childOf(mover).set(Circle, { radius: 0.25 }).add(SensorEvents);

let now = 0;

for (let frame = 1; frame <= 180; frame++) {
  now += STEP_MS;
  world.progress(now, STEP_MS);

  const events = zoneShape.get(SensorEvents)!;
  for (const event of events.begin) {
    if (event.other.eid === moverShape.eid) {
      mover.set(Tint, { value: "green" });
      console.log(`entered: tint=${mover.get(Tint)!.value}`);
    }
  }
  for (const event of events.end) {
    if (event.other.eid === moverShape.eid) {
      mover.set(Tint, { value: "blue" });
      console.log(`exited: tint=${mover.get(Tint)!.value}`);
    }
  }
}
