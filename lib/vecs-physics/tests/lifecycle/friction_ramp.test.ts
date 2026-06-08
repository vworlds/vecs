// M4 closeout parity test: friction ramp.
//
// Validates the friction mixing rule and the qualitative effect of friction on
// a dynamic body placed on an inclined surface:
//   - High friction (default 0.6 on both surfaces): body rests on the ramp,
//     does not slide indefinitely.  Static friction holds when the ramp angle
//     is below the friction angle θ_max = atan(μ_mix).
//   - Zero friction on the dynamic body: body slides down the ramp regardless.
//
// Friction mixing rule (engine/contact.ts mixFriction):
//   μ_mix = sqrt(μ_A * μ_B)  (mirrors b2DefaultFrictionCallback)
//
// With default friction 0.6 on both surfaces: μ_mix = sqrt(0.6 * 0.6) = 0.6.
// The friction angle is atan(0.6) ≈ 31°.
// Ramp angle 20° < 31° → static friction holds → body stays.
// With μ=0 on the dynamic body: μ_mix = 0 → body slides under any angle.
//
// Ramp setup: a static body at the origin with Rotation.angle = -RAMP_ANGLE
// (sloping downward to the right) with a thin flat Box shape.  A dynamic box
// is placed just above the ramp surface on the uphill side.

import { World } from "@vworlds/vecs";
import { describe, expect, it } from "vitest";

import {
  Body,
  BodyType,
  Box,
  LinearVelocity,
  Material,
  Position,
  Rotation,
  installPhysics,
} from "../../src/index.js";

const STEP_MS = 1000 / 60;

// Ramp angle in radians: 20° < atan(0.6) ≈ 31°, so default friction holds.
const RAMP_ANGLE = (20 * Math.PI) / 180;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function step(world: World, n: number, now: { value: number }): void {
  for (let i = 0; i < n; i++) {
    now.value += STEP_MS;
    world.progress(now.value, STEP_MS);
  }
}

/**
 * Build an inclined static ramp at the origin.
 *
 * The ramp body is at (0, 0) and rotated -RAMP_ANGLE so the surface
 * slopes downward to the right.  The ramp box is wide and thin.
 */
function makeRamp(world: World): void {
  const rampBody = world
    .entity()
    .set(Body, { type: BodyType.Static })
    .set(Position, { x: 0, y: 0 })
    .set(Rotation, { angle: -RAMP_ANGLE });
  world.entity().childOf(rampBody).set(Box, { hx: 8, hy: 0.25 });
}

/**
 * Place a dynamic box on the ramp.
 *
 * The ramp surface in world space at x=-2 is approximately at
 * y ≈ 2 * sin(RAMP_ANGLE).  The dynamic body starts slightly above this.
 * The half-height of the dynamic box is 0.4.
 *
 * Returns the dynamic body entity.
 */
function makeDynamicBox(world: World, friction: number) {
  // Position above the ramp surface on the uphill side.
  // ramp y at x = -2: y ≈ 2 * sin(RAMP_ANGLE) + 0.25*cos(RAMP_ANGLE)
  // Add 0.5 clearance above that.
  const rampSurfaceY = 2 * Math.sin(RAMP_ANGLE) + 0.25 * Math.cos(RAMP_ANGLE);
  const startX = -2;
  const startY = rampSurfaceY + 0.5;

  const body = world
    .entity()
    .set(Body, { type: BodyType.Dynamic })
    .set(Position, { x: startX, y: startY })
    .set(LinearVelocity, { x: 0, y: 0 });
  world
    .entity()
    .childOf(body)
    .set(Box, { hx: 0.4, hy: 0.4 })
    .set(Material, { density: 1, friction });
  return body;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Friction ramp (M4 closeout parity gate)", () => {
  it("high friction (0.6): box rests on a 20-degree ramp without sliding", () => {
    // μ_mix = sqrt(0.6 * 0.6) = 0.6; atan(0.6) ≈ 31°; ramp angle 20° < 31°
    // → static friction holds → box comes to rest on the ramp.
    const world = new World();
    installPhysics(world, { gravity: { x: 0, y: -10 } });

    makeRamp(world);
    const body = makeDynamicBox(world, 0.6);

    const now = { value: 0 };
    // Drop and settle.
    step(world, 120, now);

    const settled = body.get(Position)!;
    const startX = -2;

    // Has the box slid far down the slope?  The slope descends to the right
    // (positive x direction).  Sliding significantly means x >> startX.
    // High friction: box should stay close to starting x (< 1 m of x-movement).
    const xDisplacement = settled.x - startX;
    expect(xDisplacement).toBeLessThan(1.5);

    // Velocity should be near zero (at rest).
    const vel = body.get(LinearVelocity);
    const speed = vel ? Math.sqrt(vel.x * vel.x + vel.y * vel.y) : 0;
    expect(speed).toBeLessThan(0.5);
  });

  it("high friction box is stable on the ramp over 180 additional steps", () => {
    const world = new World();
    installPhysics(world, { gravity: { x: 0, y: -10 } });

    makeRamp(world);
    const body = makeDynamicBox(world, 0.6);

    const now = { value: 0 };
    step(world, 120, now);

    const settled = body.get(Position)!;
    let minX = settled.x;
    let maxX = settled.x;

    for (let i = 0; i < 180; i++) {
      step(world, 1, now);
      const p = body.get(Position)!;
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
    }

    // Stays within a small band — not drifting down the slope.
    expect(maxX - minX).toBeLessThan(0.2);
  });

  it("zero friction: box slides down the ramp (moves significantly)", () => {
    // μ_mix = sqrt(0 * 0.6) = 0 → no friction → box slides under gravity.
    const world = new World();
    installPhysics(world, { gravity: { x: 0, y: -10 } });

    makeRamp(world);
    const body = makeDynamicBox(world, 0);

    const now = { value: 0 };
    // Run long enough for the box to slide visibly.
    step(world, 120, now);

    const pos = body.get(Position)!;
    const startX = -2;

    // Zero friction: box slides downhill (to the right, positive x).
    // After 120 steps (2 s) on a 20° slope with g=10, rough estimate:
    //   a ≈ g·sin(20°) ≈ 3.42 m/s²
    //   displacement ≈ 0.5·3.42·4 ≈ 6.8 m  (unrestrrained)
    // Allow for solver damping — still expect significant movement (> 2 m).
    const xDisplacement = pos.x - startX;
    expect(xDisplacement).toBeGreaterThan(2);
  });

  it("qualitative difference: high-friction box barely moves; zero-friction box slides far", () => {
    // Side-by-side comparison to confirm the friction mixing rule has observable effect.
    const worldHigh = new World();
    installPhysics(worldHigh, { gravity: { x: 0, y: -10 } });
    makeRamp(worldHigh);
    const highBody = makeDynamicBox(worldHigh, 0.6);

    const worldZero = new World();
    installPhysics(worldZero, { gravity: { x: 0, y: -10 } });
    makeRamp(worldZero);
    const zeroBody = makeDynamicBox(worldZero, 0);

    const nowHigh = { value: 0 };
    const nowZero = { value: 0 };

    const startX = -2;
    for (let i = 0; i < 120; i++) {
      nowHigh.value += STEP_MS;
      worldHigh.progress(nowHigh.value, STEP_MS);
      nowZero.value += STEP_MS;
      worldZero.progress(nowZero.value, STEP_MS);
    }

    const highX = highBody.get(Position)!.x;
    const zeroX = zeroBody.get(Position)!.x;

    // Zero-friction box slides much further down the slope.
    expect(zeroX - startX).toBeGreaterThan(2);
    // High-friction box moves significantly less.
    expect(highX - startX).toBeLessThan(zeroX - startX - 1);
  });
});
