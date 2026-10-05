// `physics(world).stats()`: live Box2D object counts across create and destroy.

import { World } from "@vworlds/vecs";
import { beforeEach, describe, expect, it } from "vitest";

import { Body, BodyType, Box, Circle, PhysicsModule, Position, physics } from "../../src/index.js";

const STEP_MS = 1000 / 60;

let world: World;
let now = 0;

function step(): void {
  world.progress(now, STEP_MS);
  now += STEP_MS;
}

beforeEach(() => {
  world = new World();
  world.module(PhysicsModule, { gravity: { x: 0, y: 0 } });
  now = 0;
});

describe("physics(world).stats()", () => {
  it("starts at zero", () => {
    expect(physics(world).stats()).toEqual({
      bodyCount: 0,
      shapeCount: 0,
      jointCount: 0,
      contactCount: 0,
    });
  });

  it("counts bodies and shapes once created and returns to baseline after destroy", () => {
    const bodies = [0, 1, 2].map((i) =>
      world
        .entity()
        .set(Body, { type: BodyType.Dynamic })
        .set(Position, { x: i * 10, y: 0 })
    );
    const shapes = bodies.flatMap((body) => [
      world.entity().childOf(body).set(Box, new Box()),
      world.entity().childOf(body).set(Circle, new Circle()),
    ]);
    step();

    expect(physics(world).stats()).toMatchObject({ bodyCount: 3, shapeCount: 6 });

    shapes[0].destroy();
    step();
    expect(physics(world).stats()).toMatchObject({ bodyCount: 3, shapeCount: 5 });

    bodies.forEach((body) => body.destroy());
    step();
    expect(physics(world).stats()).toMatchObject({ bodyCount: 0, shapeCount: 0 });
  });

  it("counts a contact between overlapping bodies", () => {
    for (const x of [0, 0.5]) {
      const body = world.entity().set(Body, { type: BodyType.Dynamic }).set(Position, { x, y: 0 });
      world.entity().childOf(body).set(Box, new Box());
    }
    step();
    step();

    expect(physics(world).stats().contactCount).toBe(1);
  });

  it("allocates no result handles that survive the call", () => {
    const first = physics(world).stats();
    const second = physics(world).stats();
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });
});
