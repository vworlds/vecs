// See docs/events.md for the full event model.

import { ChildOf, World } from "@vworlds/vecs";
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
} from "@vworlds/vecs-physics";

const STEP_MS = 1000 / 60;

const world = new World();
installPhysics(world, { gravity: { x: 0, y: 0 }, fixedTimeStep: 1 / 60 });
world.start();

const triggerBody = world.entity().set(Position, { x: 0, y: 0 }).add(Body);
const triggerShape = world
  .entity()
  .set(ChildOf, { target: triggerBody })
  .set(Box, { hx: 1, hy: 1 })
  .add(Sensor)
  .add(SensorEvents);

const actor = world
  .entity()
  .set(Position, { x: -3, y: 0 })
  .set(LinearVelocity, { x: 2, y: 0 })
  .set(Body, { type: BodyType.Dynamic });
world.entity().set(ChildOf, { target: actor }).set(Circle, { radius: 0.25 }).add(SensorEvents);

let now = 0;
let actorColor = "blue";
for (let frame = 1; frame <= 240; frame++) {
  now += STEP_MS;
  world.progress(now, STEP_MS);

  const events = triggerShape.get(SensorEvents)!;
  if (events.begin.length > 0) {
    actorColor = "green";
    console.log(`entered trigger at frame ${frame}; color=${actorColor}`);
  }
  if (events.end.length > 0) {
    actorColor = "blue";
    console.log(`exited trigger at frame ${frame}; color=${actorColor}`);
    break;
  }
}
