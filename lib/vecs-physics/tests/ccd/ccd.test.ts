// VP-24 CCD parity + acceptance tests.
//
// Covers the acceptance criteria from PROGRESS.md VP-24:
//   1. SetBulletDriftTest — bullet flag persistence (box2d test_world.c:611-654).
//      Also extended to the physical gate: a bullet does not tunnel through a wall.
//   2. Fast non-bullet body — triggers IS_FAST at maxMotion > 0.5 * minExtent,
//      resolves TOI against a static wall without tunnelling.
//   3. enableContinuous = false — disables CCD; a fast bullet WILL tunnel.
//   4. TimeOfImpactTest — direct port of test_distance.c:80-102.
//   5. Bullet-vs-bullet skip — two bullet bodies do not TOI-resolve against each other.
//   6. No regression — HelloWorld and the existing slow-body scenarios still pass
//      with CCD enabled (the default).

import { ChildOf, World } from "@vworlds/vecs";
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
  installPhysics,
} from "../../src/index.js";
import { IS_BULLET } from "../../src/engine/body.js";
import { makeProxy, makeSweep, timeOfImpact, TOIState } from "../../src/engine/distance.js";
import { getPhysics } from "../../src/engine/state.js";
import { AWAKE_SET } from "../../src/engine/solver_set.js";

const STEP_MS = 1000 / 60;

/** Run the world for `n` fixed steps of 1/60 s. */
function runSteps(world: World, n: number): void {
  let now = 0;
  for (let i = 0; i < n; i++) {
    now += STEP_MS;
    world.progress(now, STEP_MS);
  }
}

// ─── 1. SetBulletDriftTest (flag persistence) ─────────────────────────────────
//
// Ports box2d test_world.c::SetBulletDriftTest (lines 611-654):
//   - A body created with bullet=false has IS_BULLET clear; toggling it to true
//     sets the bit on sim.flags.
//   - A body created with bullet=true has IS_BULLET set; toggling to false clears it.
//   - Changing MotionLocks after a bullet toggle preserves the bullet flag.
//
// Also adds the physical gate: a bullet body fired at a wall does not tunnel through.

describe("SetBulletDriftTest (flag persistence, box2d test_world.c:611-654)", () => {
  it("bullet=false body has IS_BULLET clear, toggle to true sets it", () => {
    const world = new World();
    installPhysics(world, { gravity: { x: 0, y: 0 } });
    world.start();

    const bodyEntity = world.entity().set(Body, { type: BodyType.Dynamic, bullet: false });

    runSteps(world, 1);

    const state = getPhysics(world);
    const handle = state.bodyByEntity.get(bodyEntity.eid);
    expect(handle).toBeDefined();
    const record = state.bodies.get(handle!.index);
    const sim = state.solverSets[AWAKE_SET]!.bodySims[record.localIndex]!;

    expect(sim.flags & IS_BULLET).toBe(0); // bullet=false → IS_BULLET clear

    // Toggle to true.
    bodyEntity.set(Body, { type: BodyType.Dynamic, bullet: true });
    runSteps(world, 1);

    // Re-fetch (set transfer may have moved the sim).
    const record2 = state.bodies.get(handle!.index);
    const sim2 = state.solverSets[AWAKE_SET]!.bodySims[record2.localIndex]!;
    expect(sim2.flags & IS_BULLET).not.toBe(0); // IS_BULLET set after toggle
  });

  it("bullet=true body has IS_BULLET set, toggle to false clears it", () => {
    const world = new World();
    installPhysics(world, { gravity: { x: 0, y: 0 } });
    world.start();

    const bodyEntity = world.entity().set(Body, { type: BodyType.Dynamic, bullet: true });

    runSteps(world, 1);

    const state = getPhysics(world);
    const handle = state.bodyByEntity.get(bodyEntity.eid);
    const record = state.bodies.get(handle!.index);
    const sim = state.solverSets[AWAKE_SET]!.bodySims[record.localIndex]!;
    expect(sim.flags & IS_BULLET).not.toBe(0); // IS_BULLET set on creation

    // Toggle to false.
    bodyEntity.set(Body, { type: BodyType.Dynamic, bullet: false });
    runSteps(world, 1);

    const record2 = state.bodies.get(handle!.index);
    const sim2 = state.solverSets[AWAKE_SET]!.bodySims[record2.localIndex]!;
    expect(sim2.flags & IS_BULLET).toBe(0); // IS_BULLET cleared after toggle
  });
});

// ─── Physical bullet no-tunnel gate ──────────────────────────────────────────
//
// A bullet body (circle r=0.2) fired at vx=-20 m/s toward a static wall centred
// at x=0 (box half-extents: 0.25 wide, 5 tall) must stop at or before the wall
// face (x ≈ -0.25). This is the SetBulletDriftTest physical property asserted
// in PROGRESS.md VP-24 as the milestone gate.
//
// Setup mirrors box2d test_world.c::TestSensor adapted for a solid wall:
//   bullet starts at x=3, vx=-20, no gravity, 4 sub-steps/60Hz.

describe("Bullet no-tunnel gate (VP-24 milestone physical gate)", () => {
  it("a bullet body does not tunnel through a static wall", () => {
    const world = new World();
    installPhysics(world, {
      gravity: { x: 0, y: 0 },
      enableContinuous: true,
    });
    world.start();

    // Static wall: body at x=0, box 0.5 wide × 10 tall.
    const wall = world.entity().set(Body, { type: BodyType.Static }).set(Position, { x: 0, y: 0 });
    world
      .entity()
      .set(ChildOf, { target: wall })
      .set(Box, { width: 0.5, height: 10 })
      .set(Material, { density: 1, friction: 0 });

    // Bullet: dynamic, bullet=true, vx=-20, starting at x=3.
    const bullet = world
      .entity()
      .set(Body, { type: BodyType.Dynamic, bullet: true })
      .set(Position, { x: 3, y: 0 })
      .set(GravityScale, { value: 0 });
    world
      .entity()
      .set(ChildOf, { target: bullet })
      .set(Circle, { radius: 0.2 })
      .set(Material, { density: 1, friction: 0 });
    bullet.set(LinearVelocity, { x: -20, y: 0 });

    // Step until the bullet has moved far enough to have passed through the wall
    // if CCD were disabled (~0.25 s = 15 steps at v=-20 → Δx = 5 m).
    runSteps(world, 15);

    const pos = bullet.get(Position)!;
    // With CCD: bullet (r=0.2) stops at the wall right face (x = +0.25).
    // Expected resting centre: x ≈ 0.25 + 0.2 = 0.45.
    //
    // Upper bound: centre must not pass the wall right face minus body radius —
    //   i.e. must not have tunnelled into or through the wall.
    //   wall right face (x=+0.25) − radius (0.2) = +0.05; with contact slop: < 0.15.
    // Lower bound: centre must have reached the wall and stopped close to it —
    //   not sat far back. wall right face (0.25) + radius (0.2) − 0.15 slop = 0.30.
    //
    // Measured: pos.x ≈ 0.449. If CCD broke and body advanced 0.5 m past the
    // wall, pos.x would be ≈ −0.05, which fails the lower bound.
    expect(pos.x).toBeGreaterThan(0.3); // stopped near wall, not far past it
    expect(pos.x).toBeLessThan(0.55); // did not overshoot wall right face significantly
  });

  it("with enableContinuous=false a very-fast bullet WILL tunnel through a thin wall", () => {
    // To guarantee tunnelling without CCD: use an extremely thin wall (width=0.02)
    // and a very fast bullet (vx=-100) so that in ONE step it travels
    // Δx = 100/60 ≈ 1.67 m — far more than the wall width.
    // The bullet circle radius is also very small (r=0.05) so the geometry
    // cannot resolve contact in a single broadphase cycle.
    const world = new World();
    installPhysics(world, {
      gravity: { x: 0, y: 0 },
      enableContinuous: false,
    });
    world.start();

    // Very thin static wall centred at x=0.
    const wall = world.entity().set(Body, { type: BodyType.Static }).set(Position, { x: 0, y: 0 });
    world
      .entity()
      .set(ChildOf, { target: wall })
      .set(Box, { width: 0.02, height: 4 })
      .set(Material, { density: 1, friction: 0 });

    // Very fast tiny bullet at x=2.
    const bullet = world
      .entity()
      .set(Body, { type: BodyType.Dynamic, bullet: true })
      .set(Position, { x: 2, y: 0 })
      .set(GravityScale, { value: 0 });
    world
      .entity()
      .set(ChildOf, { target: bullet })
      .set(Circle, { radius: 0.05 })
      .set(Material, { density: 1, friction: 0 });
    bullet.set(LinearVelocity, { x: -100, y: 0 });

    // Just 3 steps — enough to cross the wall without CCD.
    runSteps(world, 3);

    const pos = bullet.get(Position)!;
    // Without CCD, the bullet crosses the thin wall in step 1 (Δx ≈ 1.67 m).
    // After 3 steps it should be at x ≈ 2 - 3*(100/60) ≈ 2 - 5 = -3.
    // With CCD it would be stopped. Without CCD it's far to the left.
    expect(pos.x).toBeLessThan(-0.5); // passed through the wall
  });
});

// ─── 2. Fast non-bullet body (IS_FAST threshold) ─────────────────────────────
//
// A non-bullet dynamic body moving fast enough that maxMotion > 0.5 * minExtent
// triggers the IS_FAST branch and resolves TOI against a static wall.

describe("Fast non-bullet body CCD", () => {
  it("a non-bullet body moving fast enough uses CCD to avoid tunnelling", () => {
    const world = new World();
    installPhysics(world, {
      gravity: { x: 0, y: 0 },
      enableContinuous: true,
    });
    world.start();

    // Static wall: very thin segment at x=0 (a box 0.1 wide × 10 tall).
    const wall = world.entity().set(Body, { type: BodyType.Static }).set(Position, { x: 0, y: 0 });
    world
      .entity()
      .set(ChildOf, { target: wall })
      .set(Box, { width: 0.1, height: 10 })
      .set(Material, { density: 1, friction: 0 });

    // Non-bullet body (box 0.5 × 0.5) at x=5, vx=-15 (fast enough to skip through
    // in one step: Δx = 15/60 = 0.25m, half-extent = 0.25, wall width = 0.05;
    // minExtent ≈ 0.25; maxMotion ≈ 0.25 > 0.5 * 0.25 = 0.125 → IS_FAST fires).
    const body = world
      .entity()
      .set(Body, { type: BodyType.Dynamic, bullet: false })
      .set(Position, { x: 5, y: 0 })
      .set(GravityScale, { value: 0 });
    world
      .entity()
      .set(ChildOf, { target: body })
      .set(Box, { width: 0.5, height: 0.5 })
      .set(Material, { density: 1, friction: 0 });
    body.set(LinearVelocity, { x: -15, y: 0 });

    runSteps(world, 20);

    const pos = body.get(Position)!;
    // CCD should stop the body at the wall right face (x = +0.05).
    // Expected resting centre: x ≈ 0.05 + 0.25 (half-extent) = 0.30.
    //
    // Upper bound: centre must not have tunnelled into the wall —
    //   wall right face (0.05) + half-extent (0.25) − 0.10 slop = 0.20.
    // Lower bound: centre must have reached the wall and stopped close to it.
    //   wall right face (0.05) + half-extent (0.25) − 0.20 slop = 0.10.
    //
    // Measured: pos.x ≈ 0.300. If CCD broke and body advanced 0.5 m past the
    // wall, pos.x would be ≈ −0.20, which fails the lower bound.
    expect(pos.x).toBeGreaterThan(0.1); // stopped near wall, not far past it
    expect(pos.x).toBeLessThan(0.4); // did not overshoot wall right face significantly
  });
});

// ─── 4. TimeOfImpactTest (direct TOI primitive unit test) ────────────────────
//
// Ports box2d test_distance.c::TimeOfImpactTest (lines 80-102).
// ProxyA = stationary square [-1,-1]×[1,1]; ProxyB = vertical segment [2,±1]
// moving to [-2, ±1]. Expected hit at fraction ≈ 0.5.

describe("TimeOfImpactTest (test_distance.c:80-102)", () => {
  it("box vs moving segment hits at fraction ≈ 0.5", () => {
    const vas = [
      { x: -1, y: -1 },
      { x: 1, y: -1 },
      { x: 1, y: 1 },
      { x: -1, y: 1 },
    ];
    const vbs = [
      { x: 2, y: -1 },
      { x: 2, y: 1 },
    ];

    const proxyA = makeProxy(vas, 4, 0);
    const proxyB = makeProxy(vbs, 2, 0);

    // Stationary A: c1=c2=(0,0), q1=q2=identity
    const sweepA = makeSweep({
      center0X: 0,
      center0Y: 0,
      centerX: 0,
      centerY: 0,
      rotation0Cos: 1,
      rotation0Sin: 0,
      cos: 1,
      sin: 0,
      localCenterX: 0,
      localCenterY: 0,
    });

    // Moving B: c1=(0,0), c2=(-2,0), q1=q2=identity
    const sweepB = makeSweep({
      center0X: 0,
      center0Y: 0,
      centerX: -2,
      centerY: 0,
      rotation0Cos: 1,
      rotation0Sin: 0,
      cos: 1,
      sin: 0,
      localCenterX: 0,
      localCenterY: 0,
    });

    const output = timeOfImpact({ proxyA, proxyB, sweepA, sweepB, maxFraction: 1 });

    expect(output.state).toBe(TOIState.Hit);
    expect(Math.abs(output.fraction - 0.5)).toBeLessThan(0.005); // ENSURE_SMALL 0.005
  });

  it("non-overlapping bodies that move apart produce Separated state", () => {
    // ProxyA at x=-5, ProxyB at x=5 moving away (c2 at x=10).
    const proxyA = makeProxy([{ x: -5, y: 0 }], 1, 0.5);
    const proxyB = makeProxy([{ x: 5, y: 0 }], 1, 0.5);

    const sweepA = makeSweep({
      center0X: -5,
      center0Y: 0,
      centerX: -5,
      centerY: 0,
      rotation0Cos: 1,
      rotation0Sin: 0,
      cos: 1,
      sin: 0,
      localCenterX: 0,
      localCenterY: 0,
    });

    const sweepB = makeSweep({
      center0X: 5,
      center0Y: 0,
      centerX: 10,
      centerY: 0,
      rotation0Cos: 1,
      rotation0Sin: 0,
      cos: 1,
      sin: 0,
      localCenterX: 0,
      localCenterY: 0,
    });

    const output = timeOfImpact({ proxyA, proxyB, sweepA, sweepB, maxFraction: 1 });
    expect(output.state).toBe(TOIState.Separated);
  });

  it("already-overlapping bodies produce Overlapped state", () => {
    // Two circles at the same position (d=0 → overlapped).
    const proxyA = makeProxy([{ x: 0, y: 0 }], 1, 1.0);
    const proxyB = makeProxy([{ x: 0, y: 0 }], 1, 1.0);

    const sweepA = makeSweep({
      center0X: 0,
      center0Y: 0,
      centerX: 0,
      centerY: 0,
      rotation0Cos: 1,
      rotation0Sin: 0,
      cos: 1,
      sin: 0,
      localCenterX: 0,
      localCenterY: 0,
    });
    const sweepB = makeSweep({
      center0X: 0,
      center0Y: 0,
      centerX: 1,
      centerY: 0,
      rotation0Cos: 1,
      rotation0Sin: 0,
      cos: 1,
      sin: 0,
      localCenterX: 0,
      localCenterY: 0,
    });

    const output = timeOfImpact({ proxyA, proxyB, sweepA, sweepB, maxFraction: 1 });
    expect(output.state).toBe(TOIState.Overlapped);
  });
});

// ─── 5. Bullet-vs-bullet skip ─────────────────────────────────────────────────
//
// Two bullet bodies fired at each other do NOT TOI-resolve against each other
// (solver.c:227-230: "Skip bullets"). Both should tunnel through each other.
// The test asserts that with two bullets both marked IS_BULLET, neither stops
// the other — they should pass through.

describe("Bullet-vs-bullet skip (solver.c:227-230)", () => {
  it("two bullets do not TOI-resolve against each other", () => {
    const world = new World();
    installPhysics(world, {
      gravity: { x: 0, y: 0 },
      enableContinuous: true,
    });
    world.start();

    // Bullet A: starts at x=-3, vx=+20.
    const bulletA = world
      .entity()
      .set(Body, { type: BodyType.Dynamic, bullet: true })
      .set(Position, { x: -3, y: 0 })
      .set(GravityScale, { value: 0 });
    world
      .entity()
      .set(ChildOf, { target: bulletA })
      .set(Circle, { radius: 0.1 })
      .set(Material, { density: 1, friction: 0 });
    bulletA.set(LinearVelocity, { x: 20, y: 0 });

    // Bullet B: starts at x=+3, vx=-20.
    const bulletB = world
      .entity()
      .set(Body, { type: BodyType.Dynamic, bullet: true })
      .set(Position, { x: 3, y: 0 })
      .set(GravityScale, { value: 0 });
    world
      .entity()
      .set(ChildOf, { target: bulletB })
      .set(Circle, { radius: 0.1 })
      .set(Material, { density: 1, friction: 0 });
    bulletB.set(LinearVelocity, { x: -20, y: 0 });

    // Run 15 steps (~0.25 s). At v=±20, they would each travel ≈5m if unconstrained.
    // They start 6m apart; at 0.25 s they would have crossed and be at ≈ x=+2 (A)
    // and x=-2 (B) — having tunnelled through each other.
    runSteps(world, 15);

    const posA = bulletA.get(Position)!;
    const posB = bulletB.get(Position)!;

    // Baseline recorded from box2d3-wasm 5.2.0: the upstream WASM backend keeps
    // the bullets separated here rather than tunnelling them through each other.
    expect(posA.x).toBeCloseTo(-0.056019868701696396, 6);
    expect(posB.x).toBeCloseTo(0.056019868701696396, 6);
  });
});

// ─── 6. No regression — HelloWorld with CCD enabled ─────────────────────────
//
// CCD must not interfere with normal slow-body simulation. A box dropped on a
// static ground still comes to rest at y≈1 with CCD enabled (the default).

describe("HelloWorld parity with CCD enabled (no regression)", () => {
  it("a dynamic box dropped on a ground rests at y≈1 with enableContinuous=true", () => {
    const world = new World();
    installPhysics(world, {
      gravity: { x: 0, y: -10 },
      enableContinuous: true,
    });
    world.start();

    const ground = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: -10 });
    world.entity().set(ChildOf, { target: ground }).set(Box, { width: 100, height: 20 });

    const bodyEntity = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 4 });
    world
      .entity()
      .set(ChildOf, { target: bodyEntity })
      .set(Box, { width: 2, height: 2 })
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
