// See docs/kinematic-motion.md for target-driven kinematic bodies.

import { ChildOf, World } from "@vworlds/vecs";
import {
  Body,
  BodyType,
  Box,
  KinematicTargetPosition,
  Material,
  Position,
  installPhysics,
} from "@vworlds/vecs-physics";

const STEP_MS = 1000 / 60;

const world = new World();
installPhysics(world, { gravity: { x: 0, y: -10 }, fixedTimeStep: 1 / 60, subSteps: 4 });
world.start();

const platform = world
  .entity()
  .set(Position, { x: 0, y: 0 })
  .set(Body, { type: BodyType.Kinematic })
  .set(KinematicTargetPosition, { x: 0, y: 0 });
world
  .entity()
  .set(ChildOf, { target: platform })
  .set(Box, { width: 5, height: 0.4 })
  .set(Material, { friction: 1 });

const box = world.entity().set(Position, { x: 0, y: 1.2 }).set(Body, { type: BodyType.Dynamic });
world
  .entity()
  .set(ChildOf, { target: box })
  .set(Box, { width: 0.8, height: 0.8 })
  .set(Material, { density: 1, friction: 1 });

let now = 0;
for (let frame = 1; frame <= 180; frame++) {
  const targetX = Math.sin(frame / 30) * 2;
  platform.set(KinematicTargetPosition, { x: targetX, y: 0 });

  now += STEP_MS;
  world.progress(now, STEP_MS);

  if (frame % 20 === 0) {
    const boxX = box.get(Position)!.x;
    console.log(`frame ${frame}: box.x=${boxX.toFixed(3)} platform.x=${targetX.toFixed(3)}`);
  }
}
