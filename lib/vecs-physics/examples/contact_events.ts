// See docs/events.md for contact begin/end events.

import { ChildOf, World } from "@vworlds/vecs";
import {
  Body,
  BodyType,
  Box,
  ContactEvents,
  Material,
  Position,
  installPhysics,
  preloadPhysics,
} from "@vworlds/vecs-physics";

const STEP_MS = 1000 / 60;

await preloadPhysics();

const world = new World();
installPhysics(world, { gravity: { x: 0, y: -10 }, fixedTimeStep: 1 / 60, subSteps: 4 });
world.start();

const ground = world.entity().set(Body, { type: BodyType.Static }).set(Position, { x: 0, y: -0.5 });
const groundShape = world
  .entity()
  .set(ChildOf, { target: ground })
  .set(Box, { width: 8, height: 1 })
  .add(ContactEvents);

const lower = world.entity().set(Body, { type: BodyType.Dynamic }).set(Position, { x: 0, y: 1.2 });
const lowerShape = world
  .entity()
  .set(ChildOf, { target: lower })
  .set(Box, { width: 1, height: 1 })
  .set(Material, { density: 1, friction: 0.6 })
  .add(ContactEvents);

const upper = world.entity().set(Body, { type: BodyType.Dynamic }).set(Position, { x: 0, y: 2.4 });
const upperShape = world
  .entity()
  .set(ChildOf, { target: upper })
  .set(Box, { width: 1, height: 1 })
  .set(Material, { density: 1, friction: 0.6 })
  .add(ContactEvents);

const shapes = [groundShape, lowerShape, upperShape];
let now = 0;

for (let frame = 1; frame <= 180; frame++) {
  now += STEP_MS;
  world.progress(now, STEP_MS);

  for (const shape of shapes) {
    const events = shape.get(ContactEvents)!;
    for (const event of events.begin) {
      console.log(`frame ${frame}: shape ${shape.eid} began contact with ${event.other.eid}`);
    }
    for (const event of events.end) {
      console.log(`frame ${frame}: shape ${shape.eid} ended contact with ${event.other.eid}`);
    }
  }
}
