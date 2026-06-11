// VP-24 CCD parity + acceptance tests.
//
// Covers the acceptance criteria from PROGRESS.md VP-24:
//   1. SetBulletDriftTest — bullet flag persistence (box2d test_world.c:611-654).
//      Also extended to the physical gate: a bullet does not tunnel through a wall.
//   2. Fast non-bullet body — triggers IS_FAST, resolves TOI against a static wall.
//   3. enableContinuous = false — disables CCD; a fast bullet WILL tunnel.
//   4. Bullet-vs-bullet skip — two bullet bodies do not TOI-resolve against each other.
//   5. No regression — HelloWorld still passes with CCD enabled (the default).

import { World } from "@vworlds/vecs";
import { describe, expect, it } from "vitest";

import {
  Body,
  BodyType,
  Box,
  Circle,
  GravityScale,
  LinearVelocity,
  Material,
  Position,
  Rotation,
  PhysicsModule,
} from "../../src/index.js";
import { getPhysics } from "../../src/adapter/state.js";

const STEP_MS = 1000 / 60;

function runSteps(world: World, n: number): void {
  let now = 0;
  for (let i = 0; i < n; i++) {
    now += STEP_MS;
    world.progress(now, STEP_MS);
  }
}

// ─── 1. SetBulletDriftTest (flag persistence) ─────────────────────────────────
//
// Ports box2d test_world.c::SetBulletDriftTest (lines 611-654).
// Uses b2Body_IsBullet to verify the flag via WASM API.

describe("SetBulletDriftTest (flag persistence, box2d test_world.c:611-654)", () => {
  it("bullet=false body: b2Body_IsBullet returns false, toggle to true returns true", () => {
    const world = new World();
    world.module(PhysicsModule, { gravity: { x: 0, y: 0 } });
    const state = getPhysics(world);

    const bodyEntity = world.entity().set(Body, { type: BodyType.Dynamic, bullet: false });
    runSteps(world, 1);

    const bodyId = bodyEntity.get(Body)!._bodyId!;
    expect(state.box2d.b2Body_IsBullet(bodyId)).toBe(false);

    bodyEntity.set(Body, { type: BodyType.Dynamic, bullet: true });
    runSteps(world, 1);

    expect(state.box2d.b2Body_IsBullet(bodyId)).toBe(true);
  });

  it("bullet=true body: b2Body_IsBullet returns true, toggle to false returns false", () => {
    const world = new World();
    world.module(PhysicsModule, { gravity: { x: 0, y: 0 } });
    const state = getPhysics(world);

    const bodyEntity = world.entity().set(Body, { type: BodyType.Dynamic, bullet: true });
    runSteps(world, 1);

    const bodyId = bodyEntity.get(Body)!._bodyId!;
    expect(state.box2d.b2Body_IsBullet(bodyId)).toBe(true);

    bodyEntity.set(Body, { type: BodyType.Dynamic, bullet: false });
    runSteps(world, 1);

    expect(state.box2d.b2Body_IsBullet(bodyId)).toBe(false);
  });
});

// ─── Physical bullet no-tunnel gate ──────────────────────────────────────────

describe("Bullet no-tunnel gate (VP-24 milestone physical gate)", () => {
  it("a bullet body does not tunnel through a static wall", () => {
    const world = new World();
    world.module(PhysicsModule, {
      gravity: { x: 0, y: 0 },
      enableContinuous: true,
    });

    const wall = world.entity().set(Body, { type: BodyType.Static }).set(Position, { x: 0, y: 0 });
    world
      .entity()
      .childOf(wall)
      .set(Box, { hx: 0.25, hy: 5 })
      .set(Material, { density: 1, friction: 0 });

    const bullet = world
      .entity()
      .set(Body, { type: BodyType.Dynamic, bullet: true })
      .set(Position, { x: 3, y: 0 })
      .set(GravityScale, { value: 0 });
    world
      .entity()
      .childOf(bullet)
      .set(Circle, { radius: 0.2 })
      .set(Material, { density: 1, friction: 0 });
    bullet.set(LinearVelocity, { x: -20, y: 0 });

    runSteps(world, 15);

    const pos = bullet.get(Position)!;
    expect(pos.x).toBeGreaterThan(0.3);
    expect(pos.x).toBeLessThan(0.55);
  });

  it("with enableContinuous=false a very-fast bullet WILL tunnel through a thin wall", () => {
    const world = new World();
    world.module(PhysicsModule, {
      gravity: { x: 0, y: 0 },
      enableContinuous: false,
    });

    const wall = world.entity().set(Body, { type: BodyType.Static }).set(Position, { x: 0, y: 0 });
    world
      .entity()
      .childOf(wall)
      .set(Box, { hx: 0.01, hy: 2 })
      .set(Material, { density: 1, friction: 0 });

    const bullet = world
      .entity()
      .set(Body, { type: BodyType.Dynamic, bullet: true })
      .set(Position, { x: 2, y: 0 })
      .set(GravityScale, { value: 0 });
    world
      .entity()
      .childOf(bullet)
      .set(Circle, { radius: 0.05 })
      .set(Material, { density: 1, friction: 0 });
    bullet.set(LinearVelocity, { x: -100, y: 0 });

    runSteps(world, 3);

    const pos = bullet.get(Position)!;
    expect(pos.x).toBeLessThan(-0.5);
  });
});

// ─── 2. Fast non-bullet body (IS_FAST threshold) ─────────────────────────────

describe("Fast non-bullet body CCD", () => {
  it("a non-bullet body moving fast enough uses CCD to avoid tunnelling", () => {
    const world = new World();
    world.module(PhysicsModule, {
      gravity: { x: 0, y: 0 },
      enableContinuous: true,
    });

    const wall = world.entity().set(Body, { type: BodyType.Static }).set(Position, { x: 0, y: 0 });
    world
      .entity()
      .childOf(wall)
      .set(Box, { hx: 0.05, hy: 5 })
      .set(Material, { density: 1, friction: 0 });

    const body = world
      .entity()
      .set(Body, { type: BodyType.Dynamic, bullet: false })
      .set(Position, { x: 5, y: 0 })
      .set(GravityScale, { value: 0 });
    world
      .entity()
      .childOf(body)
      .set(Box, { hx: 0.25, hy: 0.25 })
      .set(Material, { density: 1, friction: 0 });
    body.set(LinearVelocity, { x: -15, y: 0 });

    runSteps(world, 20);

    const pos = body.get(Position)!;
    expect(pos.x).toBeGreaterThan(0.1);
    expect(pos.x).toBeLessThan(0.4);
  });
});

// ─── 4. Bullet-vs-bullet skip ─────────────────────────────────────────────────

describe("Bullet-vs-bullet skip (solver.c:227-230)", () => {
  it("two bullets do not TOI-resolve against each other", () => {
    const world = new World();
    world.module(PhysicsModule, {
      gravity: { x: 0, y: 0 },
      enableContinuous: true,
    });

    const bulletA = world
      .entity()
      .set(Body, { type: BodyType.Dynamic, bullet: true })
      .set(Position, { x: -3, y: 0 })
      .set(GravityScale, { value: 0 });
    world
      .entity()
      .childOf(bulletA)
      .set(Circle, { radius: 0.1 })
      .set(Material, { density: 1, friction: 0 });
    bulletA.set(LinearVelocity, { x: 20, y: 0 });

    const bulletB = world
      .entity()
      .set(Body, { type: BodyType.Dynamic, bullet: true })
      .set(Position, { x: 3, y: 0 })
      .set(GravityScale, { value: 0 });
    world
      .entity()
      .childOf(bulletB)
      .set(Circle, { radius: 0.1 })
      .set(Material, { density: 1, friction: 0 });
    bulletB.set(LinearVelocity, { x: -20, y: 0 });

    runSteps(world, 15);

    const posA = bulletA.get(Position)!;
    const posB = bulletB.get(Position)!;

    // Baseline recorded from box2d3-wasm 5.2.0: upstream WASM backend keeps
    // the bullets separated rather than tunnelling through each other.
    // Baseline recorded against box2d3-wasm@5.2.0.
    expect(posA.x).toBeCloseTo(-0.056019868701696396, 6);
    expect(posB.x).toBeCloseTo(0.056019868701696396, 6);
  });
});

// ─── 5. No regression — HelloWorld with CCD enabled ─────────────────────────

describe("HelloWorld parity with CCD enabled (no regression)", () => {
  it("a dynamic box dropped on a ground rests at y≈1 with enableContinuous=true", () => {
    const world = new World();
    world.module(PhysicsModule, {
      gravity: { x: 0, y: -10 },
      enableContinuous: true,
    });

    const ground = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: -10 });
    world.entity().childOf(ground).set(Box, { hx: 50, hy: 10 });

    const bodyEntity = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 4 });
    world
      .entity()
      .childOf(bodyEntity)
      .set(Box, { hx: 1, hy: 1 })
      .set(Material, { density: 1, friction: 0.3 });

    runSteps(world, 90);

    const pos = bodyEntity.get(Position)!;
    const rot = bodyEntity.get(Rotation);
    const angle = rot ? rot.angle : 0;

    expect(Math.abs(pos.x)).toBeLessThan(0.01);
    expect(Math.abs(pos.y - 1.0)).toBeLessThan(0.01);
    expect(Math.abs(angle)).toBeLessThan(0.01);
  });
});
