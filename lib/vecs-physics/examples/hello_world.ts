// See docs/getting-started.md for setup and the full falling-box walkthrough.

import { ChildOf, World } from "@vworlds/vecs";
import {
  Body,
  BodyType,
  Box,
  LinearVelocity,
  Material,
  Position,
  installPhysics,
} from "@vworlds/vecs-physics";

const STEP_MS = 1000 / 60;

const world = new World();
installPhysics(world, { gravity: { x: 0, y: -10 }, fixedTimeStep: 1 / 60, subSteps: 4 });
world.start();

const ground = world.entity().set(Body, { type: BodyType.Static }).set(Position, { x: 0, y: -1 });
world.entity().set(ChildOf, { target: ground }).set(Box, { width: 100, height: 2 });

const box = world
  .entity()
  .set(Body, { type: BodyType.Dynamic })
  .set(Position, { x: 0, y: 4 })
  .add(LinearVelocity);
world
  .entity()
  .set(ChildOf, { target: box })
  .set(Box, { width: 1, height: 1 })
  .set(Material, { density: 1, friction: 0.3 });

let now = 0;
let settledFrames = 0;

for (let frame = 1; frame <= 240; frame++) {
  now += STEP_MS;
  world.progress(now, STEP_MS);

  const position = box.get(Position)!;
  const velocity = box.get(LinearVelocity)!;

  if (frame % 10 === 0) {
    console.log(`frame ${frame}: y=${position.y.toFixed(3)}`);
  }

  if (
    Math.abs(velocity.x) < 0.01 &&
    Math.abs(velocity.y) < 0.01 &&
    Math.abs(position.y - 0.5) < 0.01
  ) {
    settledFrames++;
  } else {
    settledFrames = 0;
  }

  if (settledFrames >= 10) {
    console.log(`resting at (${position.x.toFixed(3)}, ${position.y.toFixed(3)})`);
    break;
  }
}
