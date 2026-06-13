// See docs/queries.md for the physics(world) query API.

import { World } from "@vworlds/vecs";
import {
  Body,
  BodyType,
  Box,
  PhysicsModule,
  physics,
  preloadPhysics,
  Position,
} from "@vworlds/vecs-physics";

await preloadPhysics();

const world = new World();
world.module(PhysicsModule, { gravity: { x: 0, y: 0 }, fixedTimeStep: 1 / 60, subSteps: 4 });

const bodyA = world.entity().set(Body, { type: BodyType.Static }).set(Position, { x: -2, y: 0 });
const shapeA = world.entity().childOf(bodyA).set(Box, { hx: 0.5, hy: 0.5 });

const bodyB = world.entity().set(Body, { type: BodyType.Static }).set(Position, { x: 2, y: 0 });
const shapeB = world.entity().childOf(bodyB).set(Box, { hx: 0.5, hy: 0.5 });

let now = 0;
now += 1000 / 60;
world.progress(now, 1000 / 60);

const closest = physics(world).rayCastClosest({ from: { x: -10, y: 0 }, to: { x: 10, y: 0 } });

if (closest) {
  console.log(
    `rayCastClosest hit eid=${closest.entity.eid} point=(${closest.point.x.toFixed(3)}, ${closest.point.y.toFixed(3)}) normal=(${closest.normal.x.toFixed(3)}, ${closest.normal.y.toFixed(3)}) fraction=${closest.fraction.toFixed(3)}`
  );
  console.log(`closest hit is shapeA: ${closest.entity.eid === shapeA.eid}`);
}

const all = physics(world).rayCastAll({ from: { x: -10, y: 0 }, to: { x: 10, y: 0 } });

console.log(`rayCastAll hit count: ${all.length}`);
for (const hit of all) {
  const which =
    hit.entity.eid === shapeA.eid ? "shapeA" : hit.entity.eid === shapeB.eid ? "shapeB" : "?";
  console.log(`  hit eid=${hit.entity.eid} (${which}) fraction=${hit.fraction.toFixed(3)}`);
}

// A ray that misses everything returns null / [].
const miss = physics(world).rayCastClosest({ from: { x: -10, y: 5 }, to: { x: 10, y: 5 } });
console.log(`miss -> ${miss}`);
