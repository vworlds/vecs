// See docs/events.md for contact begin/end events.

import { ChildOf, World } from "@vworlds/vecs";
import {
  Body,
  BodyType,
  Box,
  ContactEvents,
  Position,
  installPhysics,
} from "@vworlds/vecs-physics";

const STEP_MS = 1000 / 60;

const world = new World();
installPhysics(world, { gravity: { x: 0, y: 0 }, fixedTimeStep: 1 / 60 });
world.start();

function makeBox(x: number, y: number, withEvents: boolean) {
  const body = world.entity().set(Position, { x, y }).set(Body, { type: BodyType.Dynamic });
  const shape = world.entity().set(ChildOf, { target: body }).set(Box, { width: 1, height: 1 });
  if (withEvents) {
    shape.add(ContactEvents);
  }
  return { body, shape };
}

const lower = makeBox(0, 0, true);
makeBox(0, 0.75, true);

let now = 0;
for (let frame = 1; frame <= 4; frame++) {
  now += STEP_MS;
  world.progress(now, STEP_MS);

  const events = lower.shape.get(ContactEvents)!;
  for (const event of events.begin) {
    console.log(`begin contact with shape ${event.other.eid}`);
  }
}

lower.body.set(Position, { x: 10, y: 0 });
now += STEP_MS;
world.progress(now, STEP_MS);

for (const event of lower.shape.get(ContactEvents)!.end) {
  console.log(`end contact with shape ${event.other.eid}`);
}
