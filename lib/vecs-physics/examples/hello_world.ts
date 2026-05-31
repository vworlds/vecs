// See docs/getting-started.md for the body + shape setup used here.

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

const ground = world.entity().set(Position, { x: 0, y: -10 }).add(Body);
world.entity().set(ChildOf, { target: ground }).set(Box, { width: 100, height: 20 });

const box = world
  .entity()
  .set(Position, { x: 0, y: 4 })
  .set(LinearVelocity, { x: 0, y: 0 })
  .set(Body, { type: BodyType.Dynamic });
world
  .entity()
  .set(ChildOf, { target: box })
  .set(Box, { width: 2, height: 2 })
  .set(Material, { density: 1, friction: 0.3 });

let now = 0;
for (let frame = 1; frame <= 240; frame++) {
  now += STEP_MS;
  world.progress(now, STEP_MS);

  const pos = box.get(Position)!;
  const vel = box.get(LinearVelocity)!;
  if (frame % 10 === 0) {
    console.log(`frame ${frame}: x=${pos.x.toFixed(3)} y=${pos.y.toFixed(3)}`);
  }
  if (frame > 30 && Math.abs(vel.y) < 0.001 && Math.abs(pos.y - 1) < 0.01) {
    break;
  }
}

const pos = box.get(Position)!;
console.log(`resting pose: x=${pos.x.toFixed(3)} y=${pos.y.toFixed(3)}`);
