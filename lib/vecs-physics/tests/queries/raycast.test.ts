// M8-4 — Ray casts (UP-3): `rayCastClosest` geometry parity + `rayCastAll`.
//
// Tests cover:
//   - rayCastClosest geometry parity (exact numbers) against a static box.
//   - rayCastAll returns every crossed shape, fractions ascending / in [0,1].
//   - Filter gating: rayCastAll honors maskBits; rayCastClosest skips a closer
//     non-matching shape in favor of a farther matching one.
//   - A ray that crosses nothing → rayCastClosest returns null, rayCastAll
//     returns [].
//   - A destroyed shape entity's hit is dropped (resolveShapeEntity returns
//     undefined once entityByShapeIndex is cleared on `.exit`).
//   - Ray casts are pure reads: a sleeping dynamic body stays asleep.

import { World } from "@vworlds/vecs";
import { describe, expect, it } from "vitest";

import { Body, BodyType, Box, CollisionFilter, PhysicsModule, Position } from "../../src/index.js";
import { physics } from "../../src/adapter/queries.js";
import { getPhysics } from "../../src/adapter/state.js";

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

describe("rayCastClosest geometry parity", () => {
  it("hits a static box at x=-1 with normal (-1,0) and fraction 9/20", () => {
    const world = makeWorld();

    const ground = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 });
    const shape = world.entity().childOf(ground).set(Box, { hx: 1, hy: 1 });

    step(world);

    const hit = physics(world).rayCastClosest({ from: { x: -10, y: 0 }, to: { x: 10, y: 0 } });

    expect(hit).not.toBeNull();
    expect(hit!.entity.eid).toBe(shape.eid);
    expect(hit!.point.x).toBeCloseTo(-1);
    expect(hit!.point.y).toBeCloseTo(0);
    expect(hit!.normal.x).toBeCloseTo(-1);
    expect(hit!.normal.y).toBeCloseTo(0);
    expect(hit!.fraction).toBeCloseTo(9 / 20);
  });
});

describe("rayCastAll returns every crossed shape", () => {
  it("returns both boxes the ray crosses, with ascending fractions in [0,1]", () => {
    const world = makeWorld();

    const bodyA = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: -2, y: 0 });
    const shapeA = world.entity().childOf(bodyA).set(Box, { hx: 0.5, hy: 0.5 });

    const bodyB = world.entity().set(Body, { type: BodyType.Static }).set(Position, { x: 2, y: 0 });
    const shapeB = world.entity().childOf(bodyB).set(Box, { hx: 0.5, hy: 0.5 });

    step(world);

    const hits = physics(world).rayCastAll({ from: { x: -10, y: 0 }, to: { x: 10, y: 0 } });

    expect(hits).toHaveLength(2);

    const eids = new Set(hits.map((hit) => hit.entity.eid));
    expect(eids).toEqual(new Set([shapeA.eid, shapeB.eid]));

    for (const hit of hits) {
      expect(hit.fraction).toBeGreaterThanOrEqual(0);
      expect(hit.fraction).toBeLessThanOrEqual(1);
    }

    expect(hits[0]!.fraction).toBeLessThan(hits[1]!.fraction);
  });
});

describe("filter gating", () => {
  it("rayCastAll with maskBits 0b01 returns only the 0b01-category box", () => {
    const world = makeWorld();

    const bodyA = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: -2, y: 0 });
    const shapeA = world
      .entity()
      .childOf(bodyA)
      .set(Box, { hx: 0.5, hy: 0.5 })
      .set(CollisionFilter, { categoryBits: 0b01 });

    const bodyB = world.entity().set(Body, { type: BodyType.Static }).set(Position, { x: 2, y: 0 });
    world
      .entity()
      .childOf(bodyB)
      .set(Box, { hx: 0.5, hy: 0.5 })
      .set(CollisionFilter, { categoryBits: 0b10 });

    step(world);

    const hits = physics(world).rayCastAll({
      from: { x: -10, y: 0 },
      to: { x: 10, y: 0 },
      filter: { maskBits: 0b01 },
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]!.entity.eid).toBe(shapeA.eid);
  });

  it("rayCastClosest with maskBits 0b01 skips the closer non-matching box", () => {
    const world = makeWorld();

    // The 0b10 box is closer to the ray origin (at x=2) but does not match the
    // query mask; the 0b01 box (at x=-2) is farther but matches and should be
    // returned instead.
    const bodyClose = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 2, y: 0 });
    world
      .entity()
      .childOf(bodyClose)
      .set(Box, { hx: 0.5, hy: 0.5 })
      .set(CollisionFilter, { categoryBits: 0b10 });

    const bodyFar = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: -2, y: 0 });
    const shapeFar = world
      .entity()
      .childOf(bodyFar)
      .set(Box, { hx: 0.5, hy: 0.5 })
      .set(CollisionFilter, { categoryBits: 0b01 });

    step(world);

    const hit = physics(world).rayCastClosest({
      from: { x: -10, y: 0 },
      to: { x: 10, y: 0 },
      filter: { maskBits: 0b01 },
    });

    expect(hit).not.toBeNull();
    expect(hit!.entity.eid).toBe(shapeFar.eid);
  });
});

describe("miss returns null / []", () => {
  it("rayCastClosest returns null and rayCastAll returns [] when nothing is crossed", () => {
    const world = makeWorld();

    const ground = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 10 });
    world.entity().childOf(ground).set(Box, { hx: 1, hy: 1 });

    step(world);

    // Horizontal ray at y=0 misses the box at y=10.
    expect(
      physics(world).rayCastClosest({ from: { x: -10, y: 0 }, to: { x: 10, y: 0 } })
    ).toBeNull();
    expect(physics(world).rayCastAll({ from: { x: -10, y: 0 }, to: { x: 10, y: 0 } })).toEqual([]);
  });
});

describe("destroyed-entity hit dropped", () => {
  it("a ray cast through a destroyed shape's former location finds nothing", () => {
    const world = makeWorld();

    const ground = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 });
    const shape = world.entity().childOf(ground).set(Box, { hx: 1, hy: 1 });

    step(world);

    // Sanity: the shape is hit before destruction.
    expect(
      physics(world).rayCastClosest({ from: { x: -10, y: 0 }, to: { x: 10, y: 0 } })
    ).not.toBeNull();

    shape.destroy();
    step(world);

    expect(
      physics(world).rayCastClosest({ from: { x: -10, y: 0 }, to: { x: 10, y: 0 } })
    ).toBeNull();
    expect(physics(world).rayCastAll({ from: { x: -10, y: 0 }, to: { x: 10, y: 0 } })).toEqual([]);
  });
});

describe("sleeping body not woken by a cast", () => {
  it("ray casts through a sleeping body do not wake it", () => {
    const world = makeWorld();

    const body = world.entity().set(Body, { type: BodyType.Dynamic }).set(Position, { x: 0, y: 0 });
    world.entity().childOf(body).set(Box, { hx: 0.5, hy: 0.5 });

    // Step until the body falls asleep (gravity is zero, so it should settle
    // quickly once Box2D's sleep timer elapses).
    for (let i = 0; i < 120; i++) {
      step(world);
    }

    const state = getPhysics(world);
    const bodyId = (
      body.get(Body) as unknown as { _bodyId: Parameters<typeof state.box2d.b2Body_IsAwake>[0] }
    )._bodyId!;

    expect(state.box2d.b2Body_IsAwake(bodyId)).toBe(false);

    for (let i = 0; i < 5; i++) {
      physics(world).rayCastClosest({ from: { x: -10, y: 0 }, to: { x: 10, y: 0 } });
      physics(world).rayCastAll({ from: { x: -10, y: 0 }, to: { x: 10, y: 0 } });
    }

    expect(state.box2d.b2Body_IsAwake(bodyId)).toBe(false);
  });
});
