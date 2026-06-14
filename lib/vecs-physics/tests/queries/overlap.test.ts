// M8-5 — Spatial overlap queries (UP-4): `overlapAABB`, `overlapCircle`.
//
// Tests cover:
//   - overlapAABB returns shapes whose (fat) AABB intersects the query region.
//   - overlapCircle is precise (mid-phase): a box overlapping the circle is
//     included, a box clearly outside is excluded, and a box that sits inside
//     the circle's bounding AABB but outside the circle radius is excluded
//     (mid-phase beats broad-phase).
//   - Filter gating: maskBits restrict results to matching categories.
//   - Empty region / circle with nothing nearby -> [].
//   - Duplicate-free: a single overlapping shape appears exactly once.
//   - A destroyed shape entity's former location is dropped from results.
//   - Overlap queries are pure reads: a sleeping dynamic body stays asleep.

import { World } from "@vworlds/vecs";
import { describe, expect, it } from "vitest";

import { Body, BodyType, Box, CollisionFilter, PhysicsModule, Position } from "../../src/index.js";
import { physics } from "../../src/adapter/queries.js";
import { getPhysicsEngine } from "../../src/adapter/engine.js";

const STEP_MS = 1000 / 60;

function makeWorld(gravityY = 0) {
  const world = new World();
  world.module(PhysicsModule, {
    gravity: { x: 0, y: gravityY },
    subSteps: 4,
  });
  return world;
}

let _now = 0;
function step(world: World) {
  _now += STEP_MS;
  world.progress(_now, STEP_MS);
}

describe("overlapAABB returns shapes whose fat AABB intersects the region", () => {
  it("returns the boxes inside the query region and excludes ones well outside it", () => {
    const world = makeWorld();

    // Box A: centered at (0, 0), half-extents 0.5 -> spans roughly [-0.5, 0.5].
    const bodyA = world.entity().set(Body, { type: BodyType.Static }).set(Position, { x: 0, y: 0 });
    const shapeA = world.entity().childOf(bodyA).set(Box, { hx: 0.5, hy: 0.5 });

    // Box B: centered at (3, 0), well outside the query region with margin.
    const bodyB = world.entity().set(Body, { type: BodyType.Static }).set(Position, { x: 3, y: 0 });
    world.entity().childOf(bodyB).set(Box, { hx: 0.5, hy: 0.5 });

    step(world);

    // Query region [-1, 1] x [-1, 1]: covers box A, leaves a 1.5-unit margin
    // before box B's nearest edge at x = 2.5.
    const hits = physics(world).overlapAABB({ min: { x: -1, y: -1 }, max: { x: 1, y: 1 } });

    expect(hits.map((e) => e.eid)).toEqual([shapeA.eid]);
  });
});

describe("overlapCircle is precise (mid-phase)", () => {
  it("includes a box overlapping the origin and excludes a box centered at (5, 0)", () => {
    const world = makeWorld();

    const bodyA = world.entity().set(Body, { type: BodyType.Static }).set(Position, { x: 0, y: 0 });
    const shapeA = world.entity().childOf(bodyA).set(Box, { hx: 0.25, hy: 0.25 });

    const bodyB = world.entity().set(Body, { type: BodyType.Static }).set(Position, { x: 5, y: 0 });
    world.entity().childOf(bodyB).set(Box, { hx: 0.25, hy: 0.25 });

    step(world);

    const hits = physics(world).overlapCircle({ center: { x: 0, y: 0 }, radius: 1 });

    expect(hits.map((e) => e.eid)).toEqual([shapeA.eid]);
  });

  it("excludes a box near a far corner of the circle's bounding AABB but outside the radius", () => {
    const world = makeWorld();

    // Circle: center (0, 0), radius 1. Its bounding AABB is [-1, 1] x [-1, 1].
    // Place a small box centered at (0.9, 0.9): inside the bounding AABB
    // (corner region), but its center is at distance sqrt(0.9^2 + 0.9^2)
    // ~= 1.273 from the origin, well outside radius 1. Even allowing for the
    // box's half-extent of 0.1, its closest point to the origin is at
    // distance ~= 1.273 - 0.1*sqrt(2) ~= 1.13, still > 1. A broad-phase
    // overlapAABB query over the circle's bounding AABB would report this
    // box; the precise overlapCircle must not.
    const body = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0.9, y: 0.9 });
    world.entity().childOf(body).set(Box, { hx: 0.1, hy: 0.1 });

    step(world);

    // Sanity: a broad-phase AABB query over the circle's bounding box DOES
    // pick up the corner box, confirming the corner box is positioned as
    // intended (mid-phase beats broad-phase, not "nothing is there").
    const aabbHits = physics(world).overlapAABB({ min: { x: -1, y: -1 }, max: { x: 1, y: 1 } });
    expect(aabbHits.length).toBeGreaterThan(0);

    const circleHits = physics(world).overlapCircle({ center: { x: 0, y: 0 }, radius: 1 });
    expect(circleHits).toEqual([]);
  });
});

describe("filter gating", () => {
  it("overlapAABB with maskBits 0b01 returns only the 0b01-category box", () => {
    const world = makeWorld();

    const bodyA = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: -1, y: 0 });
    const shapeA = world
      .entity()
      .childOf(bodyA)
      .set(Box, { hx: 0.25, hy: 0.25 })
      .set(CollisionFilter, { categoryBits: 0b01 });

    const bodyB = world.entity().set(Body, { type: BodyType.Static }).set(Position, { x: 1, y: 0 });
    world
      .entity()
      .childOf(bodyB)
      .set(Box, { hx: 0.25, hy: 0.25 })
      .set(CollisionFilter, { categoryBits: 0b10 });

    step(world);

    const hits = physics(world).overlapAABB({
      min: { x: -2, y: -1 },
      max: { x: 2, y: 1 },
      filter: { maskBits: 0b01 },
    });

    expect(hits.map((e) => e.eid)).toEqual([shapeA.eid]);
  });

  it("overlapCircle with maskBits 0b01 returns only the 0b01-category box", () => {
    const world = makeWorld();

    const bodyA = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: -0.3, y: 0 });
    const shapeA = world
      .entity()
      .childOf(bodyA)
      .set(Box, { hx: 0.1, hy: 0.1 })
      .set(CollisionFilter, { categoryBits: 0b01 });

    const bodyB = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0.3, y: 0 });
    world
      .entity()
      .childOf(bodyB)
      .set(Box, { hx: 0.1, hy: 0.1 })
      .set(CollisionFilter, { categoryBits: 0b10 });

    step(world);

    const hits = physics(world).overlapCircle({
      center: { x: 0, y: 0 },
      radius: 1,
      filter: { maskBits: 0b01 },
    });

    expect(hits.map((e) => e.eid)).toEqual([shapeA.eid]);
  });
});

describe("empty region / circle returns []", () => {
  it("overlapAABB over an empty region returns []", () => {
    const world = makeWorld();

    const body = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 10, y: 10 });
    world.entity().childOf(body).set(Box, { hx: 0.5, hy: 0.5 });

    step(world);

    expect(physics(world).overlapAABB({ min: { x: -1, y: -1 }, max: { x: 1, y: 1 } })).toEqual([]);
  });

  it("overlapCircle with nothing nearby returns []", () => {
    const world = makeWorld();

    const body = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 10, y: 10 });
    world.entity().childOf(body).set(Box, { hx: 0.5, hy: 0.5 });

    step(world);

    expect(physics(world).overlapCircle({ center: { x: 0, y: 0 }, radius: 1 })).toEqual([]);
  });
});

describe("duplicate-free results", () => {
  it("overlapAABB returns exactly one entry for a single overlapping shape", () => {
    const world = makeWorld();

    const body = world.entity().set(Body, { type: BodyType.Static }).set(Position, { x: 0, y: 0 });
    const shape = world.entity().childOf(body).set(Box, { hx: 1, hy: 1 });

    step(world);

    const hits = physics(world).overlapAABB({ min: { x: -2, y: -2 }, max: { x: 2, y: 2 } });

    expect(hits).toHaveLength(1);
    expect(hits[0]!.eid).toBe(shape.eid);
  });

  it("overlapCircle returns exactly one entry for a single overlapping shape", () => {
    const world = makeWorld();

    const body = world.entity().set(Body, { type: BodyType.Static }).set(Position, { x: 0, y: 0 });
    const shape = world.entity().childOf(body).set(Box, { hx: 1, hy: 1 });

    step(world);

    const hits = physics(world).overlapCircle({ center: { x: 0, y: 0 }, radius: 2 });

    expect(hits).toHaveLength(1);
    expect(hits[0]!.eid).toBe(shape.eid);
  });
});

describe("destroyed-entity dropped", () => {
  it("a query over a destroyed shape's former location finds nothing", () => {
    const world = makeWorld();

    const body = world.entity().set(Body, { type: BodyType.Static }).set(Position, { x: 0, y: 0 });
    const shape = world.entity().childOf(body).set(Box, { hx: 1, hy: 1 });

    step(world);

    // Sanity: the shape is found before destruction.
    expect(physics(world).overlapAABB({ min: { x: -2, y: -2 }, max: { x: 2, y: 2 } })).toHaveLength(
      1
    );
    expect(physics(world).overlapCircle({ center: { x: 0, y: 0 }, radius: 2 })).toHaveLength(1);

    shape.destroy();
    step(world);

    expect(physics(world).overlapAABB({ min: { x: -2, y: -2 }, max: { x: 2, y: 2 } })).toEqual([]);
    expect(physics(world).overlapCircle({ center: { x: 0, y: 0 }, radius: 2 })).toEqual([]);
  });
});

describe("sleeping body not woken by an overlap query", () => {
  it("overlapAABB and overlapCircle over a sleeping body do not wake it", () => {
    const world = makeWorld();

    const body = world.entity().set(Body, { type: BodyType.Dynamic }).set(Position, { x: 0, y: 0 });
    world.entity().childOf(body).set(Box, { hx: 0.5, hy: 0.5 });

    // Step until the body falls asleep (gravity is zero, so it should settle
    // quickly once Box2D's sleep timer elapses).
    for (let i = 0; i < 120; i++) {
      step(world);
    }

    const engine = getPhysicsEngine(world);
    const bodyId = (
      body.get(Body) as unknown as { _bodyId: Parameters<typeof engine.box2d.b2Body_IsAwake>[0] }
    )._bodyId!;

    expect(engine.box2d.b2Body_IsAwake(bodyId)).toBe(false);

    for (let i = 0; i < 5; i++) {
      physics(world).overlapAABB({ min: { x: -2, y: -2 }, max: { x: 2, y: 2 } });
      physics(world).overlapCircle({ center: { x: 0, y: 0 }, radius: 2 });
    }

    expect(engine.box2d.b2Body_IsAwake(bodyId)).toBe(false);
  });
});
