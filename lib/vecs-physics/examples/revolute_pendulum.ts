// A revolute joint as a pendulum: a dynamic bob hinged to a static anchor swings
// under gravity. See docs/joints.md for the full joint model.

import { World } from "@vworlds/vecs";
import {
  Body,
  BodyType,
  Box,
  JointBodyA,
  JointBodyB,
  JointFrame,
  Position,
  PhysicsModule,
  RevoluteJoint,
  Rotation,
  preloadPhysics,
} from "@vworlds/vecs-physics";

const STEP_MS = 1000 / 60;

await preloadPhysics();

const world = new World();
world.module(PhysicsModule, { gravity: { x: 0, y: -10 }, fixedTimeStep: 1 / 60, subSteps: 4 });

// Static hinge anchor at (0, 5).
const anchor = world.entity().set(Body, { type: BodyType.Static }).set(Position, { x: 0, y: 5 });

// Dynamic bob one meter to the right, with a box so it has mass.
const bob = world
  .entity()
  .set(Body, { type: BodyType.Dynamic })
  .set(Position, { x: 1, y: 5 })
  .add(Rotation);
world.entity().childOf(bob).set(Box, { hx: 0.2, hy: 0.2 });

// Hinge them at the anchor's position: anchor's origin, and the bob's (-1, 0)
// corner, both map to (0, 5). The bob swings about that pivot.
world
  .entity()
  .set(JointBodyA, { target: anchor })
  .set(JointBodyB, { target: bob })
  .add(RevoluteJoint)
  .set(JointFrame, {
    localAnchorA: { x: 0, y: 0 },
    localAnchorB: { x: -1, y: 0 },
    referenceAngle: 0,
  });

let now = 0;
for (let frame = 1; frame <= 120; frame++) {
  now += STEP_MS;
  world.progress(now, STEP_MS);
  if (frame % 20 === 0) {
    const pos = bob.get(Position)!;
    const angle = bob.get(Rotation)!.angle;
    console.log(
      `frame ${frame}: bob at (${pos.x.toFixed(3)}, ${pos.y.toFixed(3)}), angle ${angle.toFixed(3)}`
    );
  }
}

// The bob stays one meter from the pivot at (0, 5) throughout the swing.
const finalPos = bob.get(Position)!;
const radius = Math.hypot(finalPos.x - 0, finalPos.y - 5);
console.log(`pendulum radius held at ${radius.toFixed(3)} m (expected ~1.0)`);
