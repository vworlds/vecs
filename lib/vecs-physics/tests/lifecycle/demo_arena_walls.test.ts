import { World } from "@vworlds/vecs";
import { describe, expect, it } from "vitest";

import {
  Body,
  BodyType,
  Chain,
  Circle,
  LinearVelocity,
  Material,
  Position,
  PhysicsModule,
} from "../../src/index.js";

const WIDTH = 9.6;
const HEIGHT = 4.8;
const RADIUS = 0.12;
const STEP_MS = 1000 / 30;

describe("demo arena walls", () => {
  it("keeps a falling ball inside the loop-chain arena", () => {
    const world = new World();
    world.module(PhysicsModule, { gravity: { x: 0, y: -10 }, fixedTimeStep: 1 / 30, subSteps: 4 });

    const walls = world.entity().set(Position, { x: 0, y: 0 }).set(Body, {
      type: BodyType.Static,
    });
    world
      .entity()
      .childOf(walls)
      .set(Chain, {
        points: [
          { x: WIDTH, y: 0 },
          { x: 0, y: 0 },
          { x: 0, y: HEIGHT },
          { x: WIDTH, y: HEIGHT },
        ],
        loop: true,
      })
      .set(Material, { density: 0, friction: 0.6, restitution: 0.7 });

    const ball = world
      .entity()
      .set(Position, { x: 1.1, y: 4.2 })
      .set(Body, { type: BodyType.Dynamic })
      .set(LinearVelocity, { x: 1.2, y: -1.0 });
    world
      .entity()
      .childOf(ball)
      .set(Circle, { radius: RADIUS })
      .set(Material, { friction: 0.6, restitution: 0.7 });

    let now = 0;
    for (let i = 0; i < 300; i++) {
      now += STEP_MS;
      world.progress(now, STEP_MS);
    }

    const position = ball.get(Position)!;
    expect(position.x).toBeGreaterThanOrEqual(RADIUS - 0.01);
    expect(position.x).toBeLessThanOrEqual(WIDTH - RADIUS + 0.01);
    expect(position.y).toBeGreaterThanOrEqual(RADIUS - 0.01);
    expect(position.y).toBeLessThanOrEqual(HEIGHT - RADIUS + 0.01);
  });
});
