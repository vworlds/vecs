// The `HelloWorld` parity gate — the Milestone 3 Definition of Done.
//
// Ports box2d/test/test_world.c::HelloWorld (lines 19-99) through the full Vecs
// world: install physics, drop a dynamic box onto a static ground box under
// gravity for 90 steps, and assert the box comes to rest centred at (0, 1) with
// zero angle (box2d's own `< 0.01` tolerance).
//
// Ground top is at y = 0 (static body at y=-10, box half-height 10), so a box
// with half-height 1 rests with its centre at y = 1.0.

import { World } from "@vworlds/vecs";
import { describe, expect, it } from "vitest";

import {
  Body,
  BodyType,
  Box,
  Material,
  Position,
  Rotation,
  PhysicsModule,
} from "../../src/index.js";

const STEP_MS = 1000 / 60;

describe("HelloWorld (M3 parity gate)", () => {
  it("a dynamic box dropped on a static ground comes to rest at (0, 1, 0)", () => {
    const world = new World();
    world.module(PhysicsModule.configure({ gravity: { x: 0, y: -10 } }));

    // Ground: static body at (0, -10) with a child Box of half-extents (50, 10),
    // i.e. b2MakeBox(50, 10). Box stores full width/height.
    const ground = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: -10 });
    world.entity().childOf(ground).set(Box, { width: 100, height: 20 });

    // Dynamic: body at (0, 4) with a child Box of half-extents (1, 1), density 1,
    // friction 0.3.
    const bodyEntity = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 4 });
    world
      .entity()
      .childOf(bodyEntity)
      .set(Box, { width: 2, height: 2 })
      .set(Material, { density: 1, friction: 0.3 });

    // Game loop: 90 fixed steps at 1/60, advancing `now` by 1000/60 each call.
    let now = 0;
    for (let i = 0; i < 90; i++) {
      now += STEP_MS;
      world.progress(now, STEP_MS);
    }

    const pos = bodyEntity.get(Position)!;
    const rot = bodyEntity.get(Rotation);
    const angle = rot ? rot.angle : 0;

    expect(Math.abs(pos.x)).toBeLessThan(0.01);
    expect(Math.abs(pos.y - 1.0)).toBeLessThan(0.01);
    expect(Math.abs(angle)).toBeLessThan(0.01);
  });
});
