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

// Box A sits inside the query region; box B sits well outside it but its fat
// AABB can still reach into a sufficiently large region.
const bodyA = world.entity().set(Body, { type: BodyType.Static }).set(Position, { x: 0, y: 0 });
const shapeA = world.entity().childOf(bodyA).set(Box, { hx: 0.5, hy: 0.5 });

const bodyB = world.entity().set(Body, { type: BodyType.Static }).set(Position, { x: 0.9, y: 0.9 });
const shapeB = world.entity().childOf(bodyB).set(Box, { hx: 0.1, hy: 0.1 });

let now = 0;
now += 1000 / 60;
world.progress(now, 1000 / 60);

const aabbHits = physics(world).overlapAABB({ min: { x: -1, y: -1 }, max: { x: 1, y: 1 } });

console.log(`overlapAABB hit count: ${aabbHits.length}`);
for (const entity of aabbHits) {
  const which = entity.eid === shapeA.eid ? "shapeA" : entity.eid === shapeB.eid ? "shapeB" : "?";
  console.log(`  eid=${entity.eid} (${which})`);
}

// overlapCircle is the precise mid-phase variant: shapeB sits in the AABB's
// corner but outside a circle of radius 1 centered at the origin, so it is
// excluded even though overlapAABB reported it above.
const circleHits = physics(world).overlapCircle({ center: { x: 0, y: 0 }, radius: 1 });

console.log(`overlapCircle hit count: ${circleHits.length}`);
for (const entity of circleHits) {
  const which = entity.eid === shapeA.eid ? "shapeA" : entity.eid === shapeB.eid ? "shapeB" : "?";
  console.log(`  eid=${entity.eid} (${which})`);
}

console.log(`broad-phase over-reports relative to precise: ${aabbHits.length > circleHits.length}`);
