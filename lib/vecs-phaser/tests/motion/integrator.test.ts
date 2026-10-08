// The shared integrator on its own. Its agreement with Box2D is tested against the real
// box2d3-wasm in `lib/vecs-phaser-server/tests/motion_accuracy.test.ts`.

import { afterEach, describe, expect, it, vi } from "vitest";
import { Motion, MotionClock } from "../../src/components/motion.js";
import {
  MotionPose,
  MotionState,
  motionPose,
  motionStateFrom,
  stepMotion,
} from "../../src/motion/integrator.js";

function motion(fields: Partial<Motion> = {}): Motion {
  return Object.assign(new Motion(), fields);
}

function clock(fields: Partial<MotionClock> = {}): MotionClock {
  return Object.assign(new MotionClock(), fields);
}

/** Step `baseline` `steps` times and return the state after each step. */
function run(baseline: Motion, worldClock: MotionClock, steps: number): MotionState[] {
  const state = motionStateFrom(baseline, new MotionState());
  const states: MotionState[] = [];
  for (let i = 0; i < steps; i++) {
    stepMotion(state, baseline, worldClock);
    states.push({ ...state });
  }
  return states;
}

const flying = motion({
  x: 3,
  y: -2,
  angle: 0.7,
  vx: 6,
  vy: -8,
  w: 2,
  linearDamping: 0.15,
  angularDamping: 0.1,
  localCenterX: 4 / 3,
  localCenterY: 7 / 9,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("motionStateFrom and motionPose", () => {
  it("put the center of mass at the origin plus the turned local center, and read it back", () => {
    const baseline = motion({ x: 1, y: 2, angle: Math.PI / 2, localCenterX: 1, localCenterY: 0 });
    const state = motionStateFrom(baseline, new MotionState());
    const pose = motionPose(state, baseline, new MotionPose());

    expect(state.cx).toBeCloseTo(1, 6);
    expect(state.cy).toBeCloseTo(3, 6);
    expect(pose.x).toBeCloseTo(1, 6);
    expect(pose.y).toBeCloseTo(2, 6);
    expect(pose.angle).toBeCloseTo(Math.PI / 2, 4);
  });

  it("return the objects they are given", () => {
    const state = new MotionState();
    const pose = new MotionPose();

    expect(motionStateFrom(flying, state)).toBe(state);
    expect(motionPose(state, flying, pose)).toBe(pose);
  });
});

describe("stepMotion", () => {
  it("moves an undamped body in a straight line at constant speed", () => {
    const baseline = motion({ vx: 6, vy: -8 });
    const [, , last] = run(baseline, clock({ stepSeconds: 0.5 }), 3);

    expect(last.vx).toBe(6);
    expect(last.vy).toBe(-8);
    expect(last.cx).toBeCloseTo(9, 5);
    expect(last.cy).toBeCloseTo(-12, 5);
  });

  it("damps velocities like exp(-c t)", () => {
    const states = run(flying, clock(), 60);
    const last = states[59];

    expect(Math.hypot(last.vx, last.vy)).toBeCloseTo(10 * Math.exp(-0.15), 3);
    expect(last.w).toBeCloseTo(2 * Math.exp(-0.1), 3);
  });

  it("accelerates with gravity", () => {
    const [last] = run(motion(), clock({ stepSeconds: 1, subSteps: 1, gravityY: -10 }), 1);

    expect(last.vy).toBe(-10);
    expect(last.cy).toBe(-10);
  });

  it("caps the linear speed at maxLinearSpeed", () => {
    const [last] = run(motion({ vx: 300, vy: 400 }), clock({ maxLinearSpeed: 100 }), 1);

    expect(Math.hypot(last.vx, last.vy)).toBeCloseTo(100, 4);
    expect(last.vy / last.vx).toBeCloseTo(4 / 3, 6);
  });

  it("caps the rotation at a quarter turn per step", () => {
    const [last] = run(motion({ w: -100 }), clock({ stepSeconds: 1 / 60 }), 1);

    expect(last.w).toBeCloseTo((-Math.PI / 4) * 60, 3);
  });

  it("does nothing for a step of zero seconds", () => {
    const state = motionStateFrom(flying, new MotionState());
    const before = { ...state };
    stepMotion(state, flying, clock({ stepSeconds: 0 }));

    expect({ ...state }).toEqual(before);
  });

  it("holds f32 values only", () => {
    for (const state of run(flying, clock(), 30)) {
      for (const value of Object.values(state)) {
        expect(Math.fround(value)).toBe(value);
      }
    }
  });
});

describe("determinism", () => {
  it("computes the same states, bit for bit, every run", () => {
    const worldClock = clock({ gravityX: 1, gravityY: -4 });

    expect(run(flying, worldClock, 600)).toEqual(run(flying, worldClock, 600));
  });

  it("calls no sin, cos or atan2 in stepMotion or motionPose", () => {
    const state = motionStateFrom(flying, new MotionState());
    const pose = new MotionPose();
    const sin = vi.spyOn(Math, "sin");
    const cos = vi.spyOn(Math, "cos");
    const atan2 = vi.spyOn(Math, "atan2");

    for (let i = 0; i < 100; i++) {
      stepMotion(state, flying, clock());
      motionPose(state, flying, pose);
    }

    expect(sin).not.toHaveBeenCalled();
    expect(cos).not.toHaveBeenCalled();
    expect(atan2).not.toHaveBeenCalled();
  });
});
