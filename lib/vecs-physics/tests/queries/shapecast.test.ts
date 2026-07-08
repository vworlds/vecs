// Shape casts: `shapeCastClosest` + `shapeCastAll` sweep a CastGeometry along
// `from` → `to` against the live Box2D world.
//
// Tests cover:
//   - shapeCastClosest geometry parity (circle vs static box: point, normal,
//     fraction shortened by the cast shape's radius relative to a ray).
//   - shapeCastAll returns each crossed shape with its own first-contact
//     fraction in [0, 1].
//   - Every CastGeometry variant hits (Box, Circle, Capsule, Segment, Polygon)
//     and a live entity's own geometry component can be cast directly.
//   - `rotation` is applied to the cast geometry (a rotated thin box hits a
//     target the unrotated cast misses).
//   - Initial overlap reports fraction 0.
//   - Filter gating: shapeCastClosest skips a closer non-matching shape.
//   - Polygon vertex-count validation throws (0 or > 8 vertices).
//   - A destroyed shape entity's hit is dropped without masking farther hits
//     (the closest-cast callback filters with -1 instead of clipping).
//   - A miss returns undefined / [].
//   - Shape casts are pure reads: a sleeping dynamic body stays asleep.

import { World } from "@vworlds/vecs";
import { describe, expect, it } from "vitest";

import {
  Body,
  BodyType,
  Box,
  Capsule,
  Circle,
  CollisionFilter,
  PhysicsModule,
  Polygon,
  Position,
  Segment,
} from "../../src/index.js";
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

function circle(radius: number): Circle {
  const shape = new Circle();
  shape.radius = radius;
  return shape;
}

describe("shapeCastClosest geometry parity", () => {
  it("sweeps a circle into a static box: contact at x=-1, normal (-1,0), fraction ~0.425", () => {
    const world = makeWorld();

    const ground = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 });
    const shape = world.entity().childOf(ground).set(Box, { hx: 1, hy: 1 });

    step(world);

    // The circle's surface leads its center by its radius, so first contact
    // happens when the center reaches x = -1.5: fraction (10 - 1.5) / 20 =
    // 0.425 (Box2D stops one linear slop short of exact touch).
    const hit = physics(world).shapeCastClosest({
      shape: circle(0.5),
      from: { x: -10, y: 0 },
      to: { x: 10, y: 0 },
    });

    expect(hit).toBeDefined();
    expect(hit!.entity.eid).toBe(shape.eid);
    expect(hit!.point.x).toBeCloseTo(-1, 1);
    expect(hit!.point.y).toBeCloseTo(0);
    expect(hit!.normal.x).toBeCloseTo(-1);
    expect(hit!.normal.y).toBeCloseTo(0);
    expect(hit!.fraction).toBeCloseTo(0.425, 2);
  });
});

describe("shapeCastAll returns every crossed shape", () => {
  it("returns both boxes with per-target first-contact fractions in [0,1]", () => {
    const world = makeWorld();

    const bodyA = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: -2, y: 0 });
    const shapeA = world.entity().childOf(bodyA).set(Box, { hx: 0.5, hy: 0.5 });

    const bodyB = world.entity().set(Body, { type: BodyType.Static }).set(Position, { x: 2, y: 0 });
    const shapeB = world.entity().childOf(bodyB).set(Box, { hx: 0.5, hy: 0.5 });

    step(world);

    const hits = physics(world).shapeCastAll({
      shape: circle(0.5),
      from: { x: -10, y: 0 },
      to: { x: 10, y: 0 },
    });

    expect(hits).toHaveLength(2);

    const byEid = new Map(hits.map((hit) => [hit.entity.eid, hit]));
    expect(new Set(byEid.keys())).toEqual(new Set([shapeA.eid, shapeB.eid]));

    // Circle center first touches box A at x=-3 and box B at x=1.
    expect(byEid.get(shapeA.eid)!.fraction).toBeCloseTo(0.35, 2);
    expect(byEid.get(shapeB.eid)!.fraction).toBeCloseTo(0.55, 2);

    for (const hit of hits) {
      expect(hit.fraction).toBeGreaterThanOrEqual(0);
      expect(hit.fraction).toBeLessThanOrEqual(1);
    }
  });
});

describe("every CastGeometry variant", () => {
  function makeTargetWorld() {
    const world = makeWorld();
    const ground = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 });
    const target = world.entity().childOf(ground).set(Box, { hx: 1, hy: 1 });
    step(world);
    return { world, target };
  }

  it("casts a Box", () => {
    const { world, target } = makeTargetWorld();
    const box = new Box();
    box.hx = 0.5;
    box.hy = 0.5;

    const hit = physics(world).shapeCastClosest({
      shape: box,
      from: { x: -10, y: 0 },
      to: { x: 10, y: 0 },
    });

    expect(hit?.entity.eid).toBe(target.eid);
  });

  it("casts a Capsule", () => {
    const { world, target } = makeTargetWorld();
    const capsule = new Capsule();
    capsule.x1 = 0;
    capsule.y1 = -0.75;
    capsule.x2 = 0;
    capsule.y2 = 0.75;
    capsule.radius = 0.25;

    const hit = physics(world).shapeCastClosest({
      shape: capsule,
      from: { x: -10, y: 0 },
      to: { x: 10, y: 0 },
    });

    expect(hit?.entity.eid).toBe(target.eid);
  });

  it("casts a Segment", () => {
    const { world, target } = makeTargetWorld();
    const segment = new Segment();
    segment.x1 = 0;
    segment.y1 = -0.5;
    segment.x2 = 0;
    segment.y2 = 0.5;

    const hit = physics(world).shapeCastClosest({
      shape: segment,
      from: { x: -10, y: 0 },
      to: { x: 10, y: 0 },
    });

    expect(hit?.entity.eid).toBe(target.eid);
  });

  it("casts a Polygon", () => {
    const { world, target } = makeTargetWorld();
    const triangle = new Polygon();
    triangle.vertices = [
      { x: 0, y: 0.5 },
      { x: -0.5, y: -0.5 },
      { x: 0.5, y: -0.5 },
    ];

    const hit = physics(world).shapeCastClosest({
      shape: triangle,
      from: { x: -10, y: 0 },
      to: { x: 10, y: 0 },
    });

    expect(hit?.entity.eid).toBe(target.eid);
  });

  it("casts a live entity's own geometry component", () => {
    const { world, target } = makeTargetWorld();

    const probeBody = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 100 });
    const probe = world.entity().childOf(probeBody).set(Circle, { radius: 0.5 });
    step(world);

    const hit = physics(world).shapeCastClosest({
      shape: probe.get(Circle)!,
      from: { x: -10, y: 0 },
      to: { x: 10, y: 0 },
    });

    expect(hit?.entity.eid).toBe(target.eid);
  });
});

describe("rotation is applied to the cast geometry", () => {
  it("a thin box misses an offset target unrotated and hits it rotated 90 degrees", () => {
    const world = makeWorld();

    // Target occupies y in [0.7, 1.7]; a thin horizontal box swept at y=0
    // spans y in [-0.1, 0.1] and passes under it. Rotated 90 degrees the same
    // box spans y in [-1, 1] and clips the target.
    const body = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 5, y: 1.2 });
    const target = world.entity().childOf(body).set(Box, { hx: 0.5, hy: 0.5 });

    step(world);

    const thinBox = new Box();
    thinBox.hx = 1;
    thinBox.hy = 0.1;

    const flat = physics(world).shapeCastClosest({
      shape: thinBox,
      from: { x: -10, y: 0 },
      to: { x: 10, y: 0 },
    });
    expect(flat).toBeUndefined();

    const upright = physics(world).shapeCastClosest({
      shape: thinBox,
      from: { x: -10, y: 0 },
      to: { x: 10, y: 0 },
      rotation: Math.PI / 2,
    });
    expect(upright?.entity.eid).toBe(target.eid);
  });
});

describe("initial overlap", () => {
  it("a cast starting inside a shape reports that shape at fraction 0", () => {
    const world = makeWorld();

    const ground = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 });
    const shape = world.entity().childOf(ground).set(Box, { hx: 1, hy: 1 });

    step(world);

    const hit = physics(world).shapeCastClosest({
      shape: circle(0.5),
      from: { x: 0, y: 0 },
      to: { x: 10, y: 0 },
    });

    expect(hit).toBeDefined();
    expect(hit!.entity.eid).toBe(shape.eid);
    expect(hit!.fraction).toBe(0);
  });
});

describe("filter gating", () => {
  it("shapeCastClosest with maskBits 0b01 skips the closer non-matching box", () => {
    const world = makeWorld();

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

    const hit = physics(world).shapeCastClosest({
      shape: circle(0.25),
      from: { x: -10, y: 0 },
      to: { x: 10, y: 0 },
      filter: { maskBits: 0b01 },
    });

    expect(hit).toBeDefined();
    expect(hit!.entity.eid).toBe(shapeFar.eid);
  });
});

describe("Polygon vertex-count validation", () => {
  it("throws for 0 vertices and for more than 8", () => {
    const world = makeWorld();
    step(world);

    const empty = new Polygon();
    expect(() =>
      physics(world).shapeCastClosest({
        shape: empty,
        from: { x: 0, y: 0 },
        to: { x: 1, y: 0 },
      })
    ).toThrow(/1 to 8 vertices/);

    const oversized = new Polygon();
    oversized.vertices = Array.from({ length: 9 }, (_, i) => ({
      x: Math.cos((i / 9) * 2 * Math.PI),
      y: Math.sin((i / 9) * 2 * Math.PI),
    }));
    expect(() =>
      physics(world).shapeCastAll({
        shape: oversized,
        from: { x: 0, y: 0 },
        to: { x: 1, y: 0 },
      })
    ).toThrow(/1 to 8 vertices/);
  });
});

describe("destroyed-entity hit dropped", () => {
  it("a destroyed closer shape is skipped without masking the farther hit", () => {
    const world = makeWorld();

    const bodyClose = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: -2, y: 0 });
    const shapeClose = world.entity().childOf(bodyClose).set(Box, { hx: 0.5, hy: 0.5 });

    const bodyFar = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 2, y: 0 });
    const shapeFar = world.entity().childOf(bodyFar).set(Box, { hx: 0.5, hy: 0.5 });

    step(world);

    // Sanity: the closer shape wins before destruction.
    expect(
      physics(world).shapeCastClosest({
        shape: circle(0.25),
        from: { x: -10, y: 0 },
        to: { x: 10, y: 0 },
      })!.entity.eid
    ).toBe(shapeClose.eid);

    // Destroy the closer shape but do NOT step: the Box2D shape still exists,
    // so this exercises the resolve-and-filter (-1) path rather than reaping.
    shapeClose.destroy();

    const hit = physics(world).shapeCastClosest({
      shape: circle(0.25),
      from: { x: -10, y: 0 },
      to: { x: 10, y: 0 },
    });
    expect(hit).toBeDefined();
    expect(hit!.entity.eid).toBe(shapeFar.eid);

    const all = physics(world).shapeCastAll({
      shape: circle(0.25),
      from: { x: -10, y: 0 },
      to: { x: 10, y: 0 },
    });
    expect(all).toHaveLength(1);
    expect(all[0]!.entity.eid).toBe(shapeFar.eid);
  });
});

describe("miss returns undefined / []", () => {
  it("a sweep that touches nothing returns undefined and []", () => {
    const world = makeWorld();

    const ground = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 10 });
    world.entity().childOf(ground).set(Box, { hx: 1, hy: 1 });

    step(world);

    expect(
      physics(world).shapeCastClosest({
        shape: circle(0.5),
        from: { x: -10, y: 0 },
        to: { x: 10, y: 0 },
      })
    ).toBeUndefined();
    expect(
      physics(world).shapeCastAll({
        shape: circle(0.5),
        from: { x: -10, y: 0 },
        to: { x: 10, y: 0 },
      })
    ).toEqual([]);
  });
});

describe("sleeping body not woken by a cast", () => {
  it("shape casts through a sleeping body do not wake it", () => {
    const world = makeWorld();

    const body = world.entity().set(Body, { type: BodyType.Dynamic }).set(Position, { x: 0, y: 0 });
    world.entity().childOf(body).set(Box, { hx: 0.5, hy: 0.5 });

    for (let i = 0; i < 120; i++) {
      step(world);
    }

    const engine = getPhysicsEngine(world);
    const bodyId = (
      body.get(Body) as unknown as { _bodyId: Parameters<typeof engine.box2d.b2Body_IsAwake>[0] }
    )._bodyId!;

    expect(engine.box2d.b2Body_IsAwake(bodyId)).toBe(false);

    for (let i = 0; i < 5; i++) {
      physics(world).shapeCastClosest({
        shape: circle(0.5),
        from: { x: -10, y: 0 },
        to: { x: 10, y: 0 },
      });
      physics(world).shapeCastAll({
        shape: circle(0.5),
        from: { x: -10, y: 0 },
        to: { x: 10, y: 0 },
      });
    }

    expect(engine.box2d.b2Body_IsAwake(bodyId)).toBe(false);
  });
});
