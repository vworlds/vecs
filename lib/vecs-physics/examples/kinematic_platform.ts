// See docs/kinematic-motion.md for target-driven kinematic bodies.

import { World } from "@vworlds/vecs";
import {
  Body,
  BodyType,
  Box,
  KinematicTargetPosition,
  Material,
  Position,
  PhysicsModule,
  preloadPhysics,
} from "@vworlds/vecs-physics";

const STEP_MS = 1000 / 60;

await preloadPhysics();

const world = new World();
world.module(PhysicsModule, { gravity: { x: 0, y: -10 }, fixedTimeStep: 1 / 60, subSteps: 4 });
const platform = world
  .entity()
  .set(Body, { type: BodyType.Kinematic })
  .set(Position, { x: 0, y: 0 })
  .set(KinematicTargetPosition, { x: 0, y: 0 });
world.entity().childOf(platform).set(Box, { width: 4, height: 0.4 }).set(Material, { friction: 1 });

const rider = world.entity().set(Body, { type: BodyType.Dynamic }).set(Position, { x: 0, y: 0.9 });
world
  .entity()
  .childOf(rider)
  .set(Box, { width: 0.8, height: 0.8 })
  .set(Material, { density: 1, friction: 1 });

let now = 0;

for (let frame = 1; frame <= 180; frame++) {
  const targetX = Math.sin(frame * 0.03) * 2;
  platform.set(KinematicTargetPosition, { x: targetX, y: 0 });

  now += STEP_MS;
  world.progress(now, STEP_MS);

  if (frame % 20 === 0) {
    const riderX = rider.get(Position)!.x.toFixed(3);
    const platformX = platform.get(Position)!.x.toFixed(3);
    console.log(`frame ${frame}: rider x=${riderX}, platform x=${platformX}`);
  }
}
