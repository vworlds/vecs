import { World } from "@vworlds/vecs";
import { describe, expect, it } from "vitest";

import {
  Body,
  BodyType,
  Box,
  Circle,
  CollisionFilter,
  ContactEvents,
  Damping,
  DistanceJoint,
  JointBodyA,
  JointBodyB,
  JointFrame,
  JointLinearSpring,
  JointSettings,
  LinearVelocity,
  Material,
  PhysicsModule,
  Position,
  Rotation,
  physics,
} from "../../src/index.js";

const STEP_MS = 1000 / 30;
const ANGLE = (5 * Math.PI) / 6;
const BASE = { x: 1.9095190528383295, y: 2.0578649646984553 };
const RISE = { x: 0.12, y: (0.24 * Math.sqrt(3)) / 2 };

describe("released static column (Box2D 3.2)", () => {
  for (const earlyEvents of [false, true]) {
    it(`finds support by a cast without a begin edge (events ${earlyEvents ? "before" : "after"} release)`, () => {
      const scene = createColumn(earlyEvents);
      const { world, column, step } = scene;
      try {
        release(scene);
        column[1]!.body.destroy();
        const origin = { ...column[2]!.body.get(Position)! };
        const begins: number[] = [];
        for (let tick = 0; tick < 8; tick++) {
          step();
          begins.push(...column[2]!.shape.get(ContactEvents)!.begin.map((e) => e.other.eid));
        }

        // Zero gravity: changing type does not close the removed brick's gap.
        expect(column[2]!.body.get(Position)!.x).toBeCloseTo(origin.x, 5);
        expect(column[2]!.body.get(Position)!.y).toBeCloseTo(origin.y, 5);
        expect(begins).toContain(column[3]!.shape.eid);
        expect(begins).not.toContain(column[0]!.shape.eid);

        // A release-time placement decision can sweep across that gap without
        // relying on collision impulses to happen to move the body toward it.
        const cast = () =>
          physics(world).shapeCastClosest({
            shape: column[2]!.shape.get(Box)!,
            from: origin,
            to: BASE,
            rotation: ANGLE,
            filter: { maskBits: 2 },
          });
        const hit = cast()!;
        expect(hit.entity).toBe(column[0]!.shape);
        expect(hit.fraction).toBeGreaterThan(0);
        expect(hit.fraction).toBeLessThan(1);

        column[0]!.body.set(Body, { enabled: false });
        step();
        expect(cast()).toBeUndefined();
        column[0]!.body.set(Body, { enabled: true });
        step();
        expect(cast()!.entity).toBe(column[0]!.shape);
      } finally {
        world.dispose();
      }
    });

    it(`reports the picked and upper shapes, not distant support (events ${earlyEvents ? "before" : "after"} release)`, () => {
      const scene = createColumn(earlyEvents);
      const { world, column, step } = scene;
      try {
        release(scene);
        // Model the synthetic pickup fixture's long, initially stretched tow
        // spring. The picked brick is still a colliding dynamic body, not gone.
        column[1]!.body.set(Damping, { linear: 0.5, angular: 0.3 });
        world
          .entity()
          .add(JointBodyA, scene.ship)
          .add(JointBodyB, column[1]!.body)
          .set(JointFrame, { localAnchorA: { x: -0.12, y: 0 }, localAnchorB: { x: 0.12, y: 0 } })
          .set(DistanceJoint, { length: 0.32 })
          .set(JointLinearSpring, { hertz: 4, dampingRatio: 1 })
          .set(JointSettings, { collideConnected: true });

        step();
        expect(
          column[2]!.shape
            .get(ContactEvents)!
            .begin.map((e) => e.other.eid)
            .sort()
        ).toEqual([column[1]!.shape.eid, column[3]!.shape.eid].sort());
        const velocity = column[2]!.body.get(LinearVelocity)!;
        // Positive outward velocity: this box does not land on the support.
        expect(velocity.x * RISE.x + velocity.y * RISE.y).toBeGreaterThan(0.05);
        const begins: number[] = [];
        for (let tick = 0; tick < 7; tick++) {
          step();
          begins.push(...column[2]!.shape.get(ContactEvents)!.begin.map((e) => e.other.eid));
        }
        expect(begins).not.toContain(column[0]!.shape.eid);
        expect(column[2]!.body.get(Position)!.x).toBeGreaterThan(BASE.x + 2 * RISE.x + 0.1);
      } finally {
        world.dispose();
      }
    });
  }
});

function createColumn(earlyEvents: boolean) {
  const world = new World();
  world.module(PhysicsModule, { gravity: { x: 0, y: 0 }, fixedTimeStep: 1 / 30, subSteps: 4 });
  let now = 0;
  const step = () => world.progress((now += STEP_MS), STEP_MS);
  const column = Array.from({ length: 4 }, (_, height) => {
    const body = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: BASE.x + height * RISE.x, y: BASE.y + height * RISE.y })
      .set(Rotation, { angle: ANGLE })
      .add(LinearVelocity)
      .set(Damping, { linear: 0.15, angular: 0.3 });
    const shape = world
      .entity()
      .childOf(body)
      .set(Box, { hx: 0.12, hy: 0.12 })
      .set(Material, { density: 0.3 / (0.24 * 0.24), friction: 0.2, restitution: 0.5 })
      .set(CollisionFilter, { categoryBits: height === 0 ? 2 : 1 });
    if (earlyEvents && height >= 2) {
      shape.add(ContactEvents);
    }
    return { body, shape };
  });
  const ship = world
    .entity()
    .set(Body, { type: BodyType.Dynamic })
    .set(Position, { x: 25, y: -19.200000762939453 })
    .set(Damping, { linear: 1.2, angular: 20 });
  world
    .entity()
    .childOf(ship)
    .set(Circle, { radius: 0.12 })
    .set(Material, { density: 1 / (Math.PI * 0.12 * 0.12), friction: 0 });
  step();
  step();
  return { world, column, ship, step };
}

function release({ column }: ReturnType<typeof createColumn>): void {
  for (const { body } of column.slice(1)) {
    body.set(Body, { type: BodyType.Dynamic });
  }
  for (const { shape } of column.slice(2)) {
    shape.add(ContactEvents);
  }
}
