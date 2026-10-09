// The shared integrator on its own. Its agreement with Box2D is tested against the real
// box2d3-wasm in `lib/vecs-phaser-server/tests/motion_accuracy.test.ts`.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultMotionParams,
  Motion,
  MotionClock,
  MotionParams,
} from "../../src/components/motion.js";
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

function params(fields: Partial<MotionParams> = {}): MotionParams {
  return Object.assign(new MotionParams(), fields);
}

function clock(fields: Partial<MotionClock> = {}): MotionClock {
  return Object.assign(new MotionClock(), fields);
}

/** Step `baseline` `steps` times with `constants` and return the state after each step. */
function run(
  baseline: Motion,
  constants: Readonly<MotionParams>,
  worldClock: MotionClock,
  steps: number
): MotionState[] {
  const state = motionStateFrom(baseline, constants, new MotionState());
  const states: MotionState[] = [];
  for (let i = 0; i < steps; i++) {
    stepMotion(state, constants, worldClock);
    states.push({ ...state });
  }
  return states;
}

const flying = motion({ x: 3, y: -2, angle: 0.7, vx: 6, vy: -8, w: 2 });
const flyingParams = params({
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
    const baseline = motion({ x: 1, y: 2, angle: Math.PI / 2 });
    const constants = params({ localCenterX: 1, localCenterY: 0 });
    const state = motionStateFrom(baseline, constants, new MotionState());
    const pose = motionPose(state, constants, new MotionPose());

    expect(state.cx).toBeCloseTo(1, 6);
    expect(state.cy).toBeCloseTo(3, 6);
    expect(pose.x).toBeCloseTo(1, 6);
    expect(pose.y).toBeCloseTo(2, 6);
    expect(pose.angle).toBeCloseTo(Math.PI / 2, 4);
  });

  it("take the center of mass from the constants, and the defaults put it at the origin", () => {
    const baseline = motion({ x: 1, y: 2, angle: 0 });
    const centered = motionStateFrom(baseline, defaultMotionParams, new MotionState());
    const off = motionStateFrom(baseline, params({ localCenterX: 0.5 }), new MotionState());

    expect([centered.cx, centered.cy]).toEqual([1, 2]);
    expect([off.cx, off.cy]).toEqual([1.5, 2]);
  });

  it("copy the velocities of the baseline into the state", () => {
    const state = motionStateFrom(flying, flyingParams, new MotionState());

    expect([state.vx, state.vy, state.w]).toEqual([6, -8, 2]);
  });

  it("return the objects they are given", () => {
    const state = new MotionState();
    const pose = new MotionPose();

    expect(motionStateFrom(flying, flyingParams, state)).toBe(state);
    expect(motionPose(state, flyingParams, pose)).toBe(pose);
  });
});

describe("stepMotion", () => {
  it("moves an undamped body in a straight line at constant speed", () => {
    const baseline = motion({ vx: 6, vy: -8 });
    const [, , last] = run(baseline, params(), clock({ stepSeconds: 0.5 }), 3);

    expect(last.vx).toBe(6);
    expect(last.vy).toBe(-8);
    expect(last.cx).toBeCloseTo(9, 5);
    expect(last.cy).toBeCloseTo(-12, 5);
  });

  it("damps velocities like exp(-c t)", () => {
    const states = run(flying, flyingParams, clock(), 60);
    const last = states[59];

    expect(Math.hypot(last.vx, last.vy)).toBeCloseTo(10 * Math.exp(-0.15), 3);
    expect(last.w).toBeCloseTo(2 * Math.exp(-0.1), 3);
  });

  it("accelerates with gravity", () => {
    const [last] = run(
      motion(),
      params(),
      clock({ stepSeconds: 1, subSteps: 1, gravityY: -10 }),
      1
    );

    expect(last.vy).toBe(-10);
    expect(last.cy).toBe(-10);
  });

  it("scales gravity by the body's gravityScale, down to none", () => {
    const worldClock = clock({ stepSeconds: 1, subSteps: 1, gravityY: -10 });
    const [half] = run(motion(), params({ gravityScale: 0.5 }), worldClock, 1);
    const [none] = run(motion(), params({ gravityScale: 0 }), worldClock, 1);

    expect(half.vy).toBe(-5);
    expect(none.vy).toBe(0);
    expect(none.cy).toBe(0);
  });

  it("caps the linear speed at maxLinearSpeed", () => {
    const [last] = run(motion({ vx: 300, vy: 400 }), params(), clock({ maxLinearSpeed: 100 }), 1);

    expect(Math.hypot(last.vx, last.vy)).toBeCloseTo(100, 4);
    expect(last.vy / last.vx).toBeCloseTo(4 / 3, 6);
  });

  it("caps the rotation at a quarter turn per step", () => {
    const [last] = run(motion({ w: -100 }), params(), clock({ stepSeconds: 1 / 60 }), 1);

    expect(last.w).toBeCloseTo((-Math.PI / 4) * 60, 3);
  });

  it("does not cap the rotation of a body that allows fast rotation", () => {
    const baseline = motion({ w: -100 });
    const [last] = run(
      baseline,
      params({ allowFastRotation: true }),
      clock({ stepSeconds: 1 / 60 }),
      1
    );

    expect(last.w).toBe(-100);
  });

  it("does nothing for a step of zero seconds", () => {
    const state = motionStateFrom(flying, flyingParams, new MotionState());
    const before = { ...state };
    stepMotion(state, flyingParams, clock({ stepSeconds: 0 }));

    expect({ ...state }).toEqual(before);
  });

  // The server holds such a body as a baseline at rest, and peers skip stepping it: stepping it
  // would leave it where it is.
  it.each([
    {
      name: "a gravity scale of 0 in a world with gravity",
      constants: params({ gravityScale: 0, linearDamping: 0.2, localCenterX: 0.5 }),
      worldClock: clock({ gravityY: -10 }),
    },
    { name: "a world without gravity", constants: params(), worldClock: clock() },
  ])("leaves a body with no velocity where it is: $name", ({ constants, worldClock }) => {
    const baseline = motion({ x: 3, y: -2, angle: 0.75 });
    const state = motionStateFrom(baseline, constants, new MotionState());
    const before = motionPose(state, constants, new MotionPose());

    stepMotion(state, constants, worldClock);

    expect({ ...motionPose(state, constants, new MotionPose()) }).toEqual({ ...before });
  });

  it("holds f32 values only", () => {
    for (const state of run(flying, flyingParams, clock(), 30)) {
      for (const value of Object.values(state)) {
        expect(Math.fround(value)).toBe(value);
      }
    }
  });
});

describe("determinism", () => {
  it("computes the same states, bit for bit, every run", () => {
    const worldClock = clock({ gravityX: 1, gravityY: -4 });

    expect(run(flying, flyingParams, worldClock, 600)).toEqual(
      run(flying, flyingParams, worldClock, 600)
    );
  });

  it("computes the same states with a copy of the constants as with the original", () => {
    const worldClock = clock({ gravityX: 1, gravityY: -4 });
    const copy = Object.assign(new MotionParams(), flyingParams);

    expect(run(flying, copy, worldClock, 600)).toEqual(run(flying, flyingParams, worldClock, 600));
  });

  it("calls no sin, cos or atan2 in stepMotion or motionPose", () => {
    const state = motionStateFrom(flying, flyingParams, new MotionState());
    const pose = new MotionPose();
    const sin = vi.spyOn(Math, "sin");
    const cos = vi.spyOn(Math, "cos");
    const atan2 = vi.spyOn(Math, "atan2");

    for (let i = 0; i < 100; i++) {
      stepMotion(state, flyingParams, clock());
      motionPose(state, flyingParams, pose);
    }

    expect(sin).not.toHaveBeenCalled();
    expect(cos).not.toHaveBeenCalled();
    expect(atan2).not.toHaveBeenCalled();
  });
});
