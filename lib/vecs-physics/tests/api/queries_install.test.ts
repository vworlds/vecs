// M8-3 — Query foundation: `physics(world)` accessor + `PhysicsQueries` facade.
//
// Tests cover:
//   - `physics(world)` throws before `world.module(PhysicsModule)` (message from
//     `getPhysicsEngine`).
//   - After install, `physics(world)` returns a stable facade (same instance on
//     repeated calls).
//   - Filter defaults map correctly: an empty world's `rayCastClosest` returns
//     `undefined` (default 0xffffffff/0xffffffff, full alloc/dispose path).
//   - No allocation leak / no crash across many calls, interleaved with steps.
//   - A world with a static box: `rayCastClosest` through it resolves to the
//     shape entity with `0 <= fraction <= 1`.
//   - `rayCastAll` on an empty world returns `[]` (implemented in M8-4; the
//     full ray-cast suite lives in `tests/queries/raycast.test.ts`).
//   - `overlapAABB`/`overlapCircle` on an empty world return `[]`
//     (implemented in M8-5; the full overlap suite lives in
//     `tests/queries/overlap.test.ts`).

import { World } from "@vworlds/vecs";
import { describe, expect, it } from "vitest";

import { Body, BodyType, Box, PhysicsModule, Position } from "../../src/index.js";
import { physics } from "../../src/adapter/queries.js";

const STEP_MS = 1000 / 60;

describe("physics(world) accessor", () => {
  it("throws when called before world.module(PhysicsModule)", () => {
    const world = new World();
    expect(() => physics(world)).toThrow(
      "world.module(PhysicsModule) must be called before reading physics engine"
    );
  });

  it("returns a stable facade after install", () => {
    const world = new World();
    world.module(PhysicsModule);

    const queries = physics(world);
    expect(queries).toBeDefined();
    expect(physics(world)).toBe(queries);
  });
});

describe("rayCastClosest on an empty world", () => {
  it("returns undefined with default filter (0xffffffff/0xffffffff)", () => {
    const world = new World();
    world.module(PhysicsModule);

    const hit = physics(world).rayCastClosest({ from: { x: -5, y: 0 }, to: { x: 5, y: 0 } });
    expect(hit).toBeUndefined();
  });

  it("does not leak allocations or crash across many calls interleaved with steps", () => {
    const world = new World();
    world.module(PhysicsModule);

    let now = 0;
    for (let i = 0; i < 2000; i++) {
      expect(() =>
        physics(world).rayCastClosest({ from: { x: -5, y: 0 }, to: { x: 5, y: 0 } })
      ).not.toThrow();
      expect(
        physics(world).rayCastClosest({ from: { x: -5, y: 0 }, to: { x: 5, y: 0 } })
      ).toBeUndefined();

      if (i % 50 === 0) {
        now += STEP_MS;
        world.progress(now, STEP_MS);
      }
    }
  });
});

describe("rayCastClosest against a static box", () => {
  it("returns a RayHit whose entity is the shape entity, with 0 <= fraction <= 1", () => {
    const world = new World();
    world.module(PhysicsModule);

    const ground = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 });
    const shape = world.entity().childOf(ground).set(Box, { width: 2, height: 2 });

    // PhysicsShapeLifecycle creates the Box2D shape (and registers it in
    // entityByShapeIndex) during world.progress(), not on `.set()`.
    world.progress(0, STEP_MS);

    // Cast a horizontal ray through the box from well to its left to well to
    // its right.
    const hit = physics(world).rayCastClosest({ from: { x: -10, y: 0 }, to: { x: 10, y: 0 } });

    expect(hit).toBeDefined();
    expect(hit!.entity.eid).toBe(shape.eid);
    expect(hit!.fraction).toBeGreaterThanOrEqual(0);
    expect(hit!.fraction).toBeLessThanOrEqual(1);
  });
});

describe("rayCastAll on an empty world", () => {
  it("returns [] (implemented in M8-4)", () => {
    const world = new World();
    world.module(PhysicsModule);

    expect(physics(world).rayCastAll({ from: { x: -5, y: 0 }, to: { x: 5, y: 0 } })).toEqual([]);
  });
});

describe("overlapAABB on an empty world", () => {
  it("returns [] (implemented in M8-5)", () => {
    const world = new World();
    world.module(PhysicsModule);

    expect(physics(world).overlapAABB({ min: { x: -1, y: -1 }, max: { x: 1, y: 1 } })).toEqual([]);
  });
});

describe("overlapCircle on an empty world", () => {
  it("returns [] (implemented in M8-5)", () => {
    const world = new World();
    world.module(PhysicsModule);

    expect(physics(world).overlapCircle({ center: { x: 0, y: 0 }, radius: 1 })).toEqual([]);
  });
});
