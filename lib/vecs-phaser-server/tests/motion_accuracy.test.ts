// The shared dead-reckoning integrator against the real box2d3-wasm.
//
// `PhysicsModule` simulates a free body while `motionStateFrom` and repeated `stepMotion` follow it
// from its baseline. After every step the integrator's pose and velocities are compared with what
// Box2D reports. The integrator must stay within 1 mm and 1e-4 rad of Box2D; the table printed at
// the end of the file gives the deviations it actually had.
//
// The baseline and the clock cross the wire like the real ones, so the integrator only sees the
// f32 values a peer would decode.

import { World, type Entity } from "@vworlds/vecs";
import {
  Motion,
  MotionClock,
  MotionParams,
  MotionPose,
  MotionState,
  motionPose,
  motionStateFrom,
  stepMotion,
} from "@vworlds/vecs-phaser";
import {
  AngularVelocity,
  Body,
  BodyType,
  Circle,
  Damping,
  GravityScale,
  LinearVelocity,
  PhysicsModule,
  Polygon,
  Position,
  preloadPhysics,
  Rotation,
  Sleep,
  type Vec2,
} from "@vworlds/vecs-physics";
import { Decoder, Encoder } from "@vworlds/vecs-wire";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** The accuracy the integrator must keep against Box2D, in meters. */
const POSITION_TOLERANCE = 1e-3;
/** The accuracy the integrator must keep against Box2D, in radians. */
const ANGLE_TOLERANCE = 1e-4;
/** How long each main accuracy case simulates, in seconds. */
const MINUTE = 60;

/** Everything about a case that Box2D and the integrator have to agree on. */
interface Scenario {
  name: string;
  /** Launch velocity of the center of mass in m/s. */
  velocity: Vec2;
  /** Launch angular velocity in rad/s. */
  spin: number;
  /** World gravity in m/s², default none. */
  gravity?: Vec2;
  /** Per-body gravity factor, default 1. */
  gravityScale?: number;
  /** Exempts the body from Box2D's cap on rotation per step. */
  allowFastRotation?: boolean;
  /** Per-body damping, default none. */
  damping?: { linear: number; angular: number };
  /** The body's outline. A circle at the origin when absent, which puts the center of mass there. */
  polygon?: Vec2[];
  /** Box2D's maximum linear speed in m/s, default 400. */
  maxLinearSpeed?: number;
  /**
   * The step whose Box2D state becomes the baseline, default 0: the launch state, which Box2D holds
   * exactly. A later step starts from the pose as the physics components report it, with the angle
   * by `b2Atan2`, as a server's baseline does.
   */
  baselineStep?: number;
}

/** How far the integrator strayed from Box2D, at its worst step. */
interface Deviation {
  /** Distance between the body origins, in meters. */
  position: number;
  /** Difference between the physics `Rotation.angle` and the integrator's angle, in radians. */
  angle: number;
  /** Difference between the linear velocities, in m/s. */
  linearVelocity: number;
  /** Difference between the angular velocities, in rad/s. */
  angularVelocity: number;
  /** Box2D's speed after the first step, in m/s. */
  firstSpeed: number;
  /** Box2D's angular speed after the first step, in rad/s. */
  firstSpin: number;
}

const LAUNCH: Vec2 = { x: 6, y: -8 }; // 10 m/s
const DAMPING = { linear: 0.15, angular: 0.1 };
const GRAVITY: Vec2 = { x: 1, y: -4 };
/**
 * An asymmetric convex quadrilateral whose center of mass, (4/3, 7/9), is well away from its
 * origin. Box2D computes the center in f32 and gets exactly the f32 rounding of the analytic
 * centroid, so the test can state it without reading Box2D's mass data.
 */
const QUADRILATERAL: Vec2[] = [
  { x: 0, y: 0 },
  { x: 3, y: 0 },
  { x: 3, y: 1 },
  { x: 0, y: 2 },
];

const results: { name: string; cells: number[] }[] = [];

beforeAll(async () => {
  await preloadPhysics();
});

afterAll(() => {
  const width = Math.max(...results.map((row) => row.name.length)) + 2;
  const headings = ["|Δp| m", "|Δθ| rad", "|Δv| m/s", "|Δω| rad/s"];
  console.log(
    [
      "Shared integrator against box2d3-wasm, worst step of each case:",
      "case".padEnd(width) + headings.map((heading) => heading.padStart(12)).join(""),
      ...results.map(
        ({ name, cells }) =>
          name.padEnd(width) + cells.map((cell) => cell.toExponential(2).padStart(12)).join("")
      ),
    ].join("\n")
  );
});

describe("the shared integrator against box2d3-wasm", () => {
  const accuracyCases: Scenario[] = [
    { name: "free body", velocity: LAUNCH, spin: 2 },
    {
      name: "damped body, 0.15 linear and 0.1 angular",
      velocity: LAUNCH,
      spin: 2,
      damping: DAMPING,
    },
    { name: "gravity (1, -4)", velocity: LAUNCH, spin: 2, gravity: GRAVITY },
    {
      name: "gravity (1, -4), gravityScale 0.5",
      velocity: LAUNCH,
      spin: 2,
      gravity: GRAVITY,
      gravityScale: 0.5,
    },
    { name: "off-center mass", velocity: LAUNCH, spin: 2, polygon: QUADRILATERAL },
    {
      name: "damped, gravity, off-center mass",
      velocity: LAUNCH,
      spin: -3,
      gravity: GRAVITY,
      damping: DAMPING,
      polygon: QUADRILATERAL,
    },
  ];

  describe.each([30, 60])("at %i Hz, 4 substeps, for a minute", (hz) => {
    it.each(accuracyCases)("matches Box2D bit for bit: $name", (scenario) => {
      const deviation = measure(scenario, hz, MINUTE);

      record(scenario, hz, deviation);
      expectWithinTolerance(deviation);
      expectExact(deviation);
    });

    it("stays within tolerance from a baseline taken in flight", () => {
      const scenario: Scenario = {
        name: "in-flight baseline, damped, off-center mass",
        velocity: LAUNCH,
        spin: 2,
        damping: DAMPING,
        polygon: QUADRILATERAL,
        baselineStep: 37,
      };
      const deviation = measure(scenario, hz, MINUTE);

      record(scenario, hz, deviation);
      expectWithinTolerance(deviation);
    });
  });

  describe("at 60 Hz, 4 substeps, for 10 seconds", () => {
    it("matches Box2D when the speed is clamped to the maximum", () => {
      const scenario: Scenario = {
        name: "launched at 500 m/s, maximum 400",
        velocity: { x: 300, y: 400 },
        spin: 1,
      };
      const deviation = measure(scenario, 60, 10);

      record(scenario, 60, deviation);
      expect(deviation.firstSpeed).toBeCloseTo(400, 2);
      expectWithinTolerance(deviation);
      expectExact(deviation);
    });

    it("matches Box2D when the speed is clamped to a custom maximum", () => {
      const scenario: Scenario = {
        name: "launched at 10 m/s, maximum 5",
        velocity: LAUNCH,
        spin: 1,
        maxLinearSpeed: 5,
      };
      const deviation = measure(scenario, 60, 10);

      record(scenario, 60, deviation);
      expect(deviation.firstSpeed).toBeCloseTo(5, 4);
      expectWithinTolerance(deviation);
      expectExact(deviation);
    });

    it("matches Box2D when the rotation is clamped per step", () => {
      const scenario: Scenario = {
        name: "spin -100 rad/s, maximum π/4 per step",
        velocity: LAUNCH,
        spin: -100,
      };
      const deviation = measure(scenario, 60, 10);

      record(scenario, 60, deviation);
      expect(deviation.firstSpin).toBeCloseTo((-Math.PI / 4) * 60, 2);
      expectWithinTolerance(deviation);
      expectExact(deviation);
    });

    it("matches Box2D when the body allows fast rotation", () => {
      const scenario: Scenario = {
        name: "spin -100 rad/s, allowFastRotation",
        velocity: LAUNCH,
        spin: -100,
        allowFastRotation: true,
      };
      const deviation = measure(scenario, 60, 10);

      record(scenario, 60, deviation);
      expect(deviation.firstSpin).toBeCloseTo(-100, 2);
      expectWithinTolerance(deviation);
      expectExact(deviation);
    });
  });
});

function expectWithinTolerance(deviation: Deviation): void {
  expect(deviation.position).toBeLessThanOrEqual(POSITION_TOLERANCE);
  expect(deviation.angle).toBeLessThanOrEqual(ANGLE_TOLERANCE);
}

/**
 * From a baseline Box2D holds exactly, the integrator computes the f32 sequence Box2D computes,
 * operation for operation, so it agrees bit for bit and never drifts. The server relies on that to
 * send no correction for a body that flies undisturbed, however long it flies. If a box2d3-wasm
 * upgrade breaks this, compare `lib/vecs-phaser/src/motion/integrator.ts` with the Box2D source it
 * cites before relaxing it.
 */
function expectExact(deviation: Deviation): void {
  expect(deviation.position, "origin").toBe(0);
  expect(deviation.angle, "angle").toBe(0);
  expect(deviation.linearVelocity, "linear velocity").toBe(0);
  expect(deviation.angularVelocity, "angular velocity").toBe(0);
}

function record(scenario: Scenario, hz: number, deviation: Deviation): void {
  results.push({
    name: `${scenario.name} @ ${hz} Hz`,
    cells: [
      deviation.position,
      deviation.angle,
      deviation.linearVelocity,
      deviation.angularVelocity,
    ],
  });
}

/**
 * Simulate the scenario in Box2D and in the integrator side by side and return the worst
 * deviation over the run, from the baseline step on.
 */
function measure(scenario: Scenario, hz: number, seconds: number): Deviation {
  const stepSeconds = 1 / hz;
  const subSteps = 4;
  const gravity = scenario.gravity ?? { x: 0, y: 0 };
  const maxLinearSpeed = scenario.maxLinearSpeed ?? 400;
  const world = new World();
  world.module(PhysicsModule, {
    gravity,
    fixedTimeStep: stepSeconds,
    subSteps,
    maximumLinearSpeed: maxLinearSpeed,
  });
  const body = createBody(world, scenario);
  const stepMs = stepSeconds * 1000;
  let step = 0;
  const progress = (): void => {
    world.progress(step * stepMs, stepMs);
    step++;
  };

  const baselineStep = scenario.baselineStep ?? 0;
  while (step < baselineStep) {
    progress();
  }
  const motion = viaWire(Motion, baselineOf(body, baselineStep));
  const params = viaWire(MotionParams, paramsOf(scenario));
  const clock = viaWire(MotionClock, {
    stepSeconds,
    subSteps,
    gravityX: gravity.x,
    gravityY: gravity.y,
    maxLinearSpeed,
  });
  const state = motionStateFrom(motion, params, new MotionState());
  const pose = new MotionPose();

  const deviation: Deviation = {
    position: 0,
    angle: 0,
    linearVelocity: 0,
    angularVelocity: 0,
    firstSpeed: 0,
    firstSpin: 0,
  };
  const lastStep = Math.round(seconds * hz);
  while (step < lastStep) {
    progress();
    stepMotion(state, params, clock);
    motionPose(state, params, pose);

    const position = body.get(Position)!;
    const angle = body.get(Rotation)!.angle;
    const velocity = body.get(LinearVelocity)!;
    const spin = body.get(AngularVelocity)!.value;
    deviation.position = Math.max(
      deviation.position,
      Math.hypot(pose.x - position.x, pose.y - position.y)
    );
    deviation.angle = Math.max(deviation.angle, angleBetween(pose.angle, angle));
    deviation.linearVelocity = Math.max(
      deviation.linearVelocity,
      Math.hypot(state.vx - velocity.x, state.vy - velocity.y)
    );
    deviation.angularVelocity = Math.max(deviation.angularVelocity, Math.abs(state.w - spin));
    if (step === 1) {
      deviation.firstSpeed = Math.hypot(velocity.x, velocity.y);
      deviation.firstSpin = spin;
    }
  }
  return deviation;
}

/** A free dynamic body at rest at the origin, launched with the scenario's velocities. */
function createBody(world: World, scenario: Scenario): Entity {
  const body = world
    .entity()
    .set(Body, { type: BodyType.Dynamic, allowFastRotation: scenario.allowFastRotation ?? false })
    .set(Position, { x: 0, y: 0 })
    .set(Rotation, { angle: 0 })
    .set(LinearVelocity, scenario.velocity)
    .set(AngularVelocity, { value: scenario.spin })
    // A body that falls asleep stops, which the integrator is not meant to follow: the server
    // restarts a sleeping body from a baseline with no velocity.
    .set(Sleep, { enabled: false })
    .set(Damping, scenario.damping ?? { linear: 0, angular: 0 })
    .set(GravityScale, { value: scenario.gravityScale ?? 1 });
  const shape = world.entity().childOf(body);
  if (scenario.polygon === undefined) {
    shape.set(Circle, { radius: 0.25 });
  } else {
    shape.set(Polygon, { vertices: scenario.polygon });
  }
  return body;
}

/** The baseline a server would send for the body: its physics pose and velocities. */
function baselineOf(body: Entity, frame: number): Partial<Motion> {
  const position = body.get(Position)!;
  const velocity = body.get(LinearVelocity)!;
  return {
    frame,
    x: position.x,
    y: position.y,
    angle: body.get(Rotation)!.angle,
    vx: velocity.x,
    vy: velocity.y,
    w: body.get(AngularVelocity)!.value,
  };
}

/** The constants a server would send for the body in a `MotionParams`. */
function paramsOf(scenario: Scenario): Partial<MotionParams> {
  const localCenter = scenario.polygon === undefined ? { x: 0, y: 0 } : centroid(scenario.polygon);
  return {
    linearDamping: scenario.damping?.linear ?? 0,
    angularDamping: scenario.damping?.angular ?? 0,
    gravityScale: scenario.gravityScale ?? 1,
    allowFastRotation: scenario.allowFastRotation ?? false,
    localCenterX: localCenter.x,
    localCenterY: localCenter.y,
  };
}

/** The centroid of a convex polygon's area. */
function centroid(outline: Vec2[]): Vec2 {
  let area = 0;
  let x = 0;
  let y = 0;
  outline.forEach((from, i) => {
    const to = outline[(i + 1) % outline.length];
    const cross = from.x * to.y - to.x * from.y;
    area += cross;
    x += (from.x + to.x) * cross;
    y += (from.y + to.y) * cross;
  });
  return { x: x / (3 * area), y: y / (3 * area) };
}

/** Build a component from its defaults and `fields`, then encode and decode it, as it crosses the wire. */
function viaWire<T extends object>(type: new () => T, fields: Partial<T>): T {
  const encoder = new Encoder(new Uint8Array(256));
  encoder.write(Object.assign(new type(), fields));
  return new Decoder(encoder.getBuffer()).read(type);
}

/** The absolute difference of two angles, wrapped to [0, π]. */
function angleBetween(a: number, b: number): number {
  const turn = 2 * Math.PI;
  const difference = (a - b) % turn;
  return Math.abs(difference - turn * Math.round(difference / turn));
}
