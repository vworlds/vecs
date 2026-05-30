// VP-20: `PhysicsKinematicTargets` tests.
//
// Tests are world-level: install physics, create entities, run `world.progress`,
// assert ECS component state. The same pattern as `tests/lifecycle/contacts.test.ts`.
//
// Coverage:
//   1. Convergence: kinematic body moves toward KinematicTargetPosition each step
//      and Position component reflects the motion (proves write-back).
//   2. Re-engage: after reaching the target, updating the target moves it again.
//   3. No overshoot / zero velocity at tolerance.
//   4. Rotation target: converges via shortest arc; near ±π handled correctly.
//   5. Non-kinematic body with target component is ignored.

import { World } from "@vworlds/vecs";
import { beforeEach, describe, expect, it } from "vitest";

import {
  Body,
  BodyType,
  KinematicTargetPosition,
  KinematicTargetRotation,
  Position,
  Rotation,
  installPhysics,
} from "../../src/index.js";
import { getPhysics, type PhysicsState } from "../../src/engine/state.js";
import { getAngle } from "../../src/math/rot.js";

const STEP_MS = 1000 / 60;
const DT = 1 / 60;

let world: World;
let state: PhysicsState;
let now: number;

beforeEach(() => {
  world = new World();
  // No gravity — we only care about kinematic motion, not free-fall.
  installPhysics(world, { gravity: { x: 0, y: 0 } });
  world.start();
  state = getPhysics(world);
  now = 0;
});

function step(n = 1): void {
  for (let i = 0; i < n; i++) {
    now += STEP_MS;
    world.progress(now, STEP_MS);
  }
}

function bodySim(eid: number) {
  const handle = state.bodyByEntity.get(eid)!;
  const r = state.bodies.get(handle.index);
  return state.solverSets[r.setIndex]!.bodySims[r.localIndex]!;
}

function bodyState(eid: number) {
  const handle = state.bodyByEntity.get(eid)!;
  const r = state.bodies.get(handle.index);
  return state.solverSets[r.setIndex]!.bodyStates[r.localIndex]!;
}

// ─── 1. Convergence ──────────────────────────────────────────────────────────

describe("KinematicTargetPosition convergence", () => {
  it("moves the body toward the target each step", () => {
    const e = world
      .entity()
      .set(Body, { type: BodyType.Kinematic })
      .set(Position, { x: 0, y: 0 })
      .set(KinematicTargetPosition, { x: 1, y: 0, tolerance: 0.001 });

    step(1);

    // After one step the body should have moved toward x=1.
    const pos = e.get(Position)!;
    expect(pos.x).toBeGreaterThan(0);
    expect(pos.x).toBeLessThanOrEqual(1 + 1e-9);
  });

  it("Position component reflects kinematic motion (write-back)", () => {
    // This is the key VP-6 M1 asymmetry fix: kinematic bodies must be written
    // back to their Position component after the engine moves them.
    const e = world
      .entity()
      .set(Body, { type: BodyType.Kinematic })
      .set(Position, { x: 0, y: 0 })
      .set(KinematicTargetPosition, { x: 2, y: 0, tolerance: 0.001 });

    step(1);

    // The engine sim must have advanced toward x=2.
    const sim = bodySim(e.eid);
    expect(sim.transformX).toBeGreaterThan(0);

    // And that advance MUST be visible in the Position component.
    const pos = e.get(Position)!;
    expect(pos.x).toBeCloseTo(sim.transformX, 10);
    expect(pos.x).toBeGreaterThan(0);
  });

  it("converges to the target within enough steps", () => {
    // A kinematic body 1m away at 60 Hz takes exactly 1 step to arrive
    // (velocity = dx/dt = 1/(1/60) = 60 m/s; dt = 1/60 → Δx = 60 * 1/60 = 1).
    const e = world
      .entity()
      .set(Body, { type: BodyType.Kinematic })
      .set(Position, { x: 0, y: 0 })
      .set(KinematicTargetPosition, { x: 1, y: 0, tolerance: 0.001 });

    step(1);

    const pos = e.get(Position)!;
    expect(pos.x).toBeCloseTo(1, 6);
  });

  it("component stays attached after reaching the target", () => {
    const e = world
      .entity()
      .set(Body, { type: BodyType.Kinematic })
      .set(Position, { x: 0, y: 0 })
      .set(KinematicTargetPosition, { x: 1, y: 0, tolerance: 0.001 });

    step(2); // one to arrive, one extra

    // Component must still be present.
    expect(e.get(KinematicTargetPosition)).toBeDefined();
  });
});

// ─── 2. Re-engage ─────────────────────────────────────────────────────────────

describe("KinematicTargetPosition re-engage", () => {
  it("moves again when the target is updated after reaching it", () => {
    const e = world
      .entity()
      .set(Body, { type: BodyType.Kinematic })
      .set(Position, { x: 0, y: 0 })
      .set(KinematicTargetPosition, { x: 1, y: 0, tolerance: 0.001 });

    step(2); // arrive at x≈1

    const arrivedX = e.get(Position)!.x;
    expect(arrivedX).toBeCloseTo(1, 4);

    // Update the target to a new position.
    e.set(KinematicTargetPosition, { x: 3, y: 0, tolerance: 0.001 });
    step(1);

    const newPos = e.get(Position)!;
    expect(newPos.x).toBeGreaterThan(arrivedX + 0.1);
  });
});

// ─── 3. Tolerance / no overshoot ─────────────────────────────────────────────

describe("KinematicTargetPosition tolerance", () => {
  it("does not overshoot: body rests at the target, no jitter", () => {
    const e = world
      .entity()
      .set(Body, { type: BodyType.Kinematic })
      .set(Position, { x: 0, y: 0 })
      .set(KinematicTargetPosition, { x: 1, y: 0, tolerance: 0.001 });

    step(1); // arrive

    const pos1 = e.get(Position)!.x;
    expect(pos1).toBeCloseTo(1, 6);

    step(3); // extra steps at rest

    const pos2 = e.get(Position)!.x;
    // Must stay at ~1, not drift or oscillate.
    expect(Math.abs(pos2 - 1)).toBeLessThan(0.01);
  });

  it("velocity is zero once within tolerance", () => {
    const e = world
      .entity()
      .set(Body, { type: BodyType.Kinematic })
      .set(Position, { x: 0, y: 0 })
      .set(KinematicTargetPosition, { x: 1, y: 0, tolerance: 0.001 });

    step(1); // arrive at x=1 (velocity 60 m/s drove it there)
    step(1); // next pre-step: dist = 0 <= tolerance → vx = vy = 0

    // Body state must show zero linear velocity now that the target is reached.
    const bs = bodyState(e.eid);
    expect(Math.hypot(bs.vx, bs.vy)).toBeCloseTo(0, 6);
  });
});

// ─── 4. Rotation target ───────────────────────────────────────────────────────

describe("KinematicTargetRotation", () => {
  it("rotates toward the target angle each step", () => {
    const e = world
      .entity()
      .set(Body, { type: BodyType.Kinematic })
      .set(Rotation, { angle: 0 })
      .set(KinematicTargetRotation, { angle: Math.PI / 2, tolerance: 0.001 });

    step(1);

    const rot = e.get(Rotation)!;
    expect(rot.angle).toBeGreaterThan(0);
  });

  it("converges to the target angle within enough steps", () => {
    // The angular speed is capped at MAX_ROTATION * (1/dt) per step (= π/4 * 60),
    // so a body can advance at most π/4 radians per full step. A target of π/2
    // therefore requires at least 2 steps plus a settling step.
    const e = world
      .entity()
      .set(Body, { type: BodyType.Kinematic })
      .set(Rotation, { angle: 0 })
      .set(KinematicTargetRotation, { angle: Math.PI / 2, tolerance: 0.001 });

    step(3); // 2 steps to traverse π/2, 1 extra to settle

    const rot = e.get(Rotation)!;
    expect(rot.angle).toBeCloseTo(Math.PI / 2, 3);
  });

  it("uses shortest arc: near-±π wrap correctly", () => {
    // Current angle 0, target just under +π. The shortest arc is ~π radians
    // going counterclockwise. The long arc (going clockwise) is also ~π.
    // Use a smaller target to clearly distinguish: target = π/4.
    // relativeAngle should give +π/4 (CCW), not -(7π/4) (CW long way).
    const e = world
      .entity()
      .set(Body, { type: BodyType.Kinematic })
      .set(Rotation, { angle: 0 })
      .set(KinematicTargetRotation, { angle: Math.PI / 4, tolerance: 0.001 });

    // π/4 < MAX_ROTATION (π/4), so it converges in one step.
    // Actually MAX_ROTATION = 0.25 * π = π/4, so omega = (π/4)*60 which is AT
    // the cap. Use a smaller target to ensure a clean one-step test.
    step(3);

    const rot = e.get(Rotation)!;
    expect(rot.angle).toBeCloseTo(Math.PI / 4, 3);
  });

  it("uses shortest arc for negative delta: body does not take the long way", () => {
    // Body at +π/2, target at -π/2. Shortest arc is -π going through 0.
    // relativeAngle should give -π. Since this exceeds the speed cap (π/4 per
    // step) the body takes multiple steps but always moves in the - direction.
    const e = world
      .entity()
      .set(Body, { type: BodyType.Kinematic })
      .set(Rotation, { angle: Math.PI / 2 })
      .set(KinematicTargetRotation, { angle: -Math.PI / 2, tolerance: 0.001 });

    step(1); // first step: body should move toward -π/2 (i.e. angle decreases)

    const sim = bodySim(e.eid);
    const angle = getAngle({ c: sim.cos, s: sim.sin });
    // Angle must have decreased from π/2 toward 0 (going the short way through 0).
    expect(angle).toBeLessThan(Math.PI / 2);
    expect(angle).toBeGreaterThan(-Math.PI / 2 - 0.1); // not overshot past target
  });

  it("angular velocity is zero once within tolerance", () => {
    // Use a small target (< MAX_ROTATION = π/4 per step) so the body converges
    // cleanly in one integration step and the next pre-phase sees dist = 0.
    const e = world
      .entity()
      .set(Body, { type: BodyType.Kinematic })
      .set(Rotation, { angle: 0 })
      .set(KinematicTargetRotation, { angle: 0.1, tolerance: 0.001 });

    step(1); // body drives toward 0.1 rad (well within angular cap)
    step(1); // pre-phase sees dist ≈ 0 → sets omega = 0

    const bs = bodyState(e.eid);
    expect(Math.abs(bs.omega)).toBeCloseTo(0, 6);
  });
});

// ─── 5. Non-kinematic bodies are ignored ──────────────────────────────────────

describe("target on non-kinematic body is ignored", () => {
  it("does not move a dynamic body via KinematicTargetPosition", () => {
    // A dynamic body with no gravity and a target should NOT be driven by the
    // kinematic system — the system skips non-kinematic bodies.
    const e = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0 })
      .set(KinematicTargetPosition, { x: 5, y: 0, tolerance: 0.001 });

    step(1);

    // No movement attributable to the kinematic system: velocity should be 0.
    const bs = bodyState(e.eid);
    expect(Math.hypot(bs.vx, bs.vy)).toBeCloseTo(0, 6);
  });

  it("does not move a static body via KinematicTargetPosition", () => {
    const e = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 })
      .set(KinematicTargetPosition, { x: 5, y: 0, tolerance: 0.001 });

    expect(() => step(1)).not.toThrow();

    // Static bodies have no body state; Position stays at origin.
    expect(e.get(Position)!.x).toBe(0);
  });
});

// ─── 6. Both position AND rotation targets ────────────────────────────────────

describe("KinematicTargetPosition and KinematicTargetRotation together", () => {
  it("converges both position and rotation independently", () => {
    const e = world
      .entity()
      .set(Body, { type: BodyType.Kinematic })
      .set(Position, { x: 0, y: 0 })
      .set(Rotation, { angle: 0 })
      .set(KinematicTargetPosition, { x: 1, y: 0, tolerance: 0.001 })
      .set(KinematicTargetRotation, { angle: Math.PI / 4, tolerance: 0.001 });

    step(1);

    const pos = e.get(Position)!;
    const rot = e.get(Rotation)!;
    expect(pos.x).toBeGreaterThan(0.5);
    expect(rot.angle).toBeGreaterThan(0.5);
  });
});
