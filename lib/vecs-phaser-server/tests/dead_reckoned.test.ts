// DeadReckonedModule on the server: the structural guarantees of the DeadReckoned tag, the
// MotionClock singleton, and the divergence check that decides when a body needs a new Motion
// baseline. Each scenario counts the baselines the server writes; what reaches clients, and when,
// is in dead_reckoning_replication.test.ts.

import { ON_STORE, ON_UPDATE, POST_UPDATE, PRE_STORE, World, type Entity } from "@vworlds/vecs";
import {
  defaultMotionParams,
  Motion,
  MotionClock,
  MotionParams,
  MotionPose,
  MotionState,
  motionPose,
  motionStateFrom,
  phaserMotionComponents,
  phaserNetworkComponents,
  Position as RenderPosition,
  Rotation as RenderRotation,
  stepMotion,
} from "@vworlds/vecs-phaser";
import {
  AngularVelocity,
  Body,
  BodyType,
  Box,
  Circle,
  Damping,
  GravityScale,
  LinearVelocity,
  Material,
  PhysicsModule,
  Polygon,
  Position as PhysicsPosition,
  preloadPhysics,
  Rotation as PhysicsRotation,
  Sleep,
  type Vec2,
} from "@vworlds/vecs-physics";
import { Networked, ServerWorld } from "@vworlds/vecs-server";
import { Decoder, Encoder } from "@vworlds/vecs-wire";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { DeadReckoned, DeadReckonedModule, type DeadReckonedOptions } from "../src/index.js";

const HZ = 30;
const STEP_MS = 1000 / HZ;
const NETWORK_COMPONENTS = [...phaserNetworkComponents, ...phaserMotionComponents];
const DAMPING = { linear: 0.15, angular: 0.1 };
/**
 * An asymmetric convex quadrilateral whose center of mass, (4/3, 7/9), is well away from its
 * origin.
 */
const QUADRILATERAL: Vec2[] = [
  { x: 0, y: 0 },
  { x: 3, y: 0 },
  { x: 3, y: 1 },
  { x: 0, y: 2 },
];

beforeAll(async () => {
  await preloadPhysics();
});

/** A server world with physics at 30 Hz and dead reckoning, plus a log of every baseline written. */
class Server {
  public readonly world: ServerWorld;
  /** Every baseline the module wrote, as `[eid, frame]`, in order. */
  public readonly baselines: Array<[number, number]> = [];
  /** Every `MotionParams` the module added or updated, as `[eid, frame]`, in order. */
  public readonly paramWrites: Array<[number, number]> = [];
  private _now = 0;

  public constructor(options: DeadReckonedOptions = {}, gravity = { x: 0, y: 0 }, name = "test") {
    this.world = new ServerWorld({ name, networkComponents: NETWORK_COMPONENTS });
    this.world.module(PhysicsModule, { gravity, fixedTimeStep: 1 / HZ });
    this.world.module(DeadReckonedModule, options);
    this.world.component(Motion).on("set", (entity, motion) => {
      this.baselines.push([entity.eid, motion.frame]);
    });
    // The hook runs in the flush after the sync system, so `frame` is the one it stamped the baseline with.
    this.world.component(MotionParams).on("set", (entity) => {
      this.paramWrites.push([entity.eid, this.world.frame]);
    });
  }

  /** Baselines written for `entity`, by frame. */
  public framesOf(entity: Entity): number[] {
    return this.baselines.filter(([eid]) => eid === entity.eid).map(([, frame]) => frame);
  }

  /** Frames at which the module wrote `entity`'s `MotionParams`. */
  public paramFramesOf(entity: Entity): number[] {
    return this.paramWrites.filter(([eid]) => eid === entity.eid).map(([, frame]) => frame);
  }

  /** Run `steps` server ticks. */
  public step(steps = 1): void {
    for (let i = 0; i < steps; i++) {
      this.world.progress(this._now, STEP_MS);
      this._now += STEP_MS;
    }
  }

  /**
   * A networked, dead-reckoned dynamic body: a disc of radius 0.5, or a convex polygon (whose
   * center of mass is off the body origin when the outline is).
   */
  public disc(options: {
    x?: number;
    y?: number;
    angle?: number;
    vx?: number;
    vy?: number;
    w?: number;
    damping?: { linear: number; angular: number };
    gravityScale?: number;
    bullet?: boolean;
    /** Keep the body awake however slowly it moves. */
    insomniac?: boolean;
    polygon?: Vec2[];
    restitution?: number;
    /** Stream the body's render pose instead of dead reckoning it. */
    streamed?: boolean;
  }): Entity {
    const body = this.world
      .entity()
      .add(Networked)
      .set(Body, { type: BodyType.Dynamic, bullet: options.bullet ?? false })
      .set(PhysicsPosition, { x: options.x ?? 0, y: options.y ?? 0 })
      .set(PhysicsRotation, { angle: options.angle ?? 0 })
      .set(LinearVelocity, { x: options.vx ?? 0, y: options.vy ?? 0 })
      .set(AngularVelocity, { value: options.w ?? 0 });
    if (options.streamed === true) {
      body.add(RenderPosition).add(RenderRotation);
    } else {
      body.add(DeadReckoned);
    }
    if (options.damping !== undefined) {
      body.set(Damping, options.damping);
    }
    if (options.gravityScale !== undefined) {
      body.set(GravityScale, { value: options.gravityScale });
    }
    if (options.insomniac === true) {
      body.set(Sleep, { enabled: false });
    }
    const shape = this.world.entity().childOf(body);
    if (options.polygon === undefined) {
      shape.set(Circle, { radius: 0.5 });
    } else {
      shape.set(Polygon, { vertices: options.polygon });
    }
    shape.set(Material, { restitution: options.restitution ?? 0 });
    return body;
  }

  /** A static wall: a box of half extents `hx`, `hy` at (`x`, `y`). */
  public wall(x: number, y: number, hx: number, hy: number): Entity {
    const wall = this.world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(PhysicsPosition, { x, y });
    this.world.entity().childOf(wall).set(Box, { hx, hy }).set(Material, { restitution: 1 });
    return wall;
  }
}

describe("the DeadReckoned tag", () => {
  it("brings Motion and the physics Rotation, and removes the render pose", () => {
    const server = new Server();
    const entity = server.world
      .entity()
      .set(RenderPosition, { x: 1, y: 2 })
      .set(RenderRotation, { angle: 0.5 })
      .add(DeadReckoned);

    expect(entity.has(Motion)).toBe(true);
    expect(entity.has(PhysicsRotation)).toBe(true);
    expect(entity.has(RenderPosition)).toBe(false);
    expect(entity.has(RenderRotation)).toBe(false);
  });

  it("rejects a render pose on a dead-reckoned entity", () => {
    const server = new Server();
    const entity = server.world.entity().add(DeadReckoned);

    expect(() => entity.set(RenderPosition, { x: 1, y: 2 })).toThrow(/is DeadReckoned/);
    expect(() => entity.set(RenderRotation, { angle: 1 })).toThrow(/is DeadReckoned/);
  });

  it("leaves streamed entities to the streamed sync, which also serves an entity without a body", () => {
    const server = new Server();
    const decoration = server.world
      .entity()
      .add(Networked)
      .set(PhysicsPosition, { x: 3, y: 4 })
      .set(PhysicsRotation, { angle: 0.25 })
      .set(RenderPosition, { x: 0, y: 0 })
      .set(RenderRotation, { angle: 0 });

    server.step();
    decoration.set(PhysicsPosition, { x: 5, y: 6 });
    server.step();

    expect(decoration.get(RenderPosition)).toEqual({ x: 5, y: 6 });
    expect(decoration.get(RenderRotation)).toEqual({ angle: 0.25 });
    expect(decoration.has(Motion)).toBe(false);
  });
});

describe("DeadReckonedModule setup", () => {
  it("creates one networked MotionClock from the physics settings, gravity included", () => {
    const server = new Server({}, { x: 1, y: -4 });

    const clocks = [...server.world.entities.values()].filter((entity) => entity.has(MotionClock));
    expect(clocks).toHaveLength(1);
    expect(clocks[0]!.has(Networked)).toBe(true);
    expect({ ...clocks[0]!.get(MotionClock) }).toEqual({
      stepSeconds: Math.fround(1 / HZ),
      subSteps: 4,
      gravityX: 1,
      gravityY: -4,
      maxLinearSpeed: 400,
    });
  });

  it("rejects a second MotionClock", () => {
    const server = new Server();

    expect(() => server.world.entity().set(MotionClock, {})).toThrow(/owned by DeadReckonedModule/);
  });

  it("requires a ServerWorld with the motion components on the wire", () => {
    const plain = new World();
    plain.module(PhysicsModule);
    expect(() => plain.module(DeadReckonedModule)).toThrow(/ServerWorld/);

    const streamedOnly = new ServerWorld({ networkComponents: phaserNetworkComponents });
    streamedOnly.module(PhysicsModule);
    expect(() => streamedOnly.module(DeadReckonedModule)).toThrow(/phaserMotionComponents/);

    const withoutParams = new ServerWorld({
      networkComponents: [...phaserNetworkComponents, MotionClock, Motion],
    });
    withoutParams.module(PhysicsModule);
    expect(() => withoutParams.module(DeadReckonedModule)).toThrow(/MotionParams/);
  });
});

describe("the divergence check", () => {
  it("sends a ballistic body once, then only for a collision, a teleport and falling asleep", () => {
    const server = new Server();
    server.wall(10, 0, 0.5, 5);
    const rock = server.disc({ vx: 4, w: 1, restitution: 1 });

    server.step();
    const spawn = server.world.frame - 1;
    expect(server.framesOf(rock)).toEqual([spawn]);

    // The disc reaches the wall at x = 9 after about two seconds and bounces straight back.
    server.step(3 * HZ);
    const afterBounce = server.framesOf(rock);
    expect(afterBounce).toHaveLength(2);
    expect(rock.get(Motion)!.vx).toBeLessThan(0);

    server.step(HZ);
    expect(server.framesOf(rock)).toEqual(afterBounce);

    rock.set(PhysicsPosition, { x: -20, y: 3 });
    server.step();
    const afterTeleport = server.framesOf(rock);
    expect(afterTeleport).toEqual([...afterBounce, server.world.frame - 1]);
    // The baseline holds the pose after the step that follows the teleport.
    expect(rock.get(Motion)!.x).toBeCloseTo(-20, 0);
    expect(rock.get(Motion)!.y).toBeCloseTo(3, 0);

    server.step(HZ);
    expect(server.framesOf(rock)).toEqual(afterTeleport);

    // Stopping it sends one baseline at rest. Box2D puts it to sleep half a second later, which
    // sends nothing more: the baseline already holds it still. (A body that falls asleep while it
    // drifts is the damped case below.)
    rock.set(LinearVelocity, { x: 0, y: 0 }).set(AngularVelocity, { value: 0 });
    server.step(3 * HZ);
    expect(server.framesOf(rock)).toHaveLength(afterTeleport.length + 1);
    expect(rock.get(Motion)).toMatchObject({ vx: 0, vy: 0, w: 0 });

    server.step(5 * HZ);
    expect(server.framesOf(rock)).toHaveLength(afterTeleport.length + 1);
  });

  it("sends a damped, drifting body nothing until it falls asleep, then one baseline at rest", () => {
    const server = new Server();
    const container = server.disc({
      vx: 1.5,
      vy: -0.5,
      w: 0.4,
      damping: { linear: 0.15, angular: 0.1 },
    });

    server.step();
    const spawn = server.framesOf(container);
    expect(spawn).toHaveLength(1);
    expect(container.get(Motion)).toMatchObject({ vx: expect.any(Number), rest: false });
    expect(container.get(MotionParams)).toMatchObject({
      linearDamping: Math.fround(0.15),
      angularDamping: Math.fround(0.1),
    });

    // From 1.6 m/s, damping 0.15 brings it under Box2D's 0.05 m/s sleep threshold in about 23 s.
    let asleepAt = 0;
    for (let frame = 0; frame < 40 * HZ && asleepAt === 0; frame++) {
      server.step();
      if (server.framesOf(container).length > 1) {
        asleepAt = frame;
      }
    }

    expect(asleepAt).toBeGreaterThan(20 * HZ);
    expect(server.framesOf(container)).toHaveLength(2);
    expect(container.get(Motion)).toMatchObject({ vx: 0, vy: 0, w: 0, rest: true });
    // The baseline at rest leaves the constants alone.
    expect(container.get(MotionParams)).toMatchObject({
      linearDamping: Math.fround(0.15),
      angularDamping: Math.fround(0.1),
    });
    expect(server.paramFramesOf(container)).toEqual(spawn);
    const resting = { ...container.get(PhysicsPosition) };
    expect(container.get(Motion)).toMatchObject({
      x: Math.fround(resting.x!),
      y: Math.fround(resting.y!),
    });

    server.step(10 * HZ);
    expect(server.framesOf(container)).toHaveLength(2);
  });

  it("re-baselines within tolerance: the prediction never strays further than it", () => {
    const server = new Server({}, { x: 0, y: -10 });
    server.wall(0, -10, 50, 0.5);
    const bodies = [
      server.disc({ x: -5, vx: 3, vy: 6, w: 2, restitution: 0.5 }),
      server.disc({ x: 5, vx: -2, vy: 1, w: -1, damping: { linear: 0.5, angular: 0.5 } }),
    ];
    const prediction = bodies.map(() => ({ state: new MotionState(), pose: new MotionPose() }));
    let worst = 0;

    for (let frame = 0; frame < 10 * HZ; frame++) {
      server.step();
      const clock = clockOf(server.world);
      bodies.forEach((body, i) => {
        const motion = decoded(Motion, body.get(Motion)!);
        const params = decoded(MotionParams, body.get(MotionParams) ?? defaultMotionParams);
        const { state, pose } = prediction[i]!;
        motionStateFrom(motion, params, state);
        for (let n = motion.frame; n < server.world.frame - 1; n++) {
          stepMotion(state, params, clock);
        }
        motionPose(state, params, pose);
        const position = body.get(PhysicsPosition)!;
        worst = Math.max(worst, Math.hypot(position.x - pose.x, position.y - pose.y));
      });
    }

    expect(worst).toBeLessThanOrEqual(0.01);
  });

  it("writes every baseline exactly as the wire carries it", () => {
    const server = new Server({}, { x: 0, y: -10 });
    const body = server.disc({ vx: 0.1, vy: 3, w: 0.3, damping: { linear: 0.15, angular: 0.1 } });

    server.step(5);

    const motion = body.get(Motion)!;
    expect(decoded(Motion, motion)).toEqual({ ...motion });
    const params = body.get(MotionParams)!;
    expect(decoded(MotionParams, params)).toEqual({ ...params });
  });

  it("makes the tolerances configurable", () => {
    const strict = new Server();
    const loose = new Server({ positionTolerance: 1, angleTolerance: 1 });
    const strictBody = strict.disc({ vx: 1 });
    const looseBody = loose.disc({ vx: 1 });
    strict.step();
    loose.step();

    for (const [server, body] of [
      [strict, strictBody],
      [loose, looseBody],
    ] as const) {
      const position = body.get(PhysicsPosition)!;
      body.set(PhysicsPosition, { x: position.x + 0.5, y: position.y });
      server.step();
    }

    expect(strict.framesOf(strictBody)).toHaveLength(2);
    expect(loose.framesOf(looseBody)).toHaveLength(1);
  });

  it("refreshes a moving body's baseline once it is maxBaselineAge old", () => {
    const server = new Server({ maxBaselineAge: 2 });
    const rock = server.disc({ vx: 1 });

    server.step(5 * HZ);

    const frames = server.framesOf(rock);
    expect(frames).toHaveLength(3);
    expect(frames[1]! - frames[0]!).toBe(2 * HZ);
    expect(frames[2]! - frames[1]!).toBe(2 * HZ);
  });
});

describe("the body constants in MotionParams", () => {
  it("carries a damped, off-center body's constants with its first moving baseline, then only Motion", () => {
    const server = new Server();
    const container = server.disc({
      vx: 2,
      vy: -1,
      w: 0.5,
      damping: DAMPING,
      polygon: QUADRILATERAL,
    });

    server.step();
    const spawn = server.framesOf(container);
    expect(spawn).toHaveLength(1);
    const params = container.get(MotionParams)!;
    expect(params.linearDamping).toBe(Math.fround(0.15));
    expect(params.angularDamping).toBe(Math.fround(0.1));
    expect(params.localCenterX).toBeCloseTo(4 / 3, 6);
    expect(params.localCenterY).toBeCloseTo(7 / 9, 6);
    expect(params.gravityScale).toBe(1);
    expect(params.allowFastRotation).toBe(false);
    // Written in the frame of the baseline it belongs to, so both land in the same diff.
    expect(server.paramFramesOf(container)).toEqual(spawn);

    // Two corrections later the constants are still the ones sent with the first baseline.
    for (const x of [-20, 20]) {
      container.set(PhysicsPosition, { x, y: 3 });
      server.step();
    }
    expect(server.framesOf(container)).toHaveLength(3);
    expect(server.paramFramesOf(container)).toEqual(spawn);
    expect(container.get(MotionParams)).toBe(params);
  });

  it("never gives a body with default constants a MotionParams", () => {
    const server = new Server();
    const bullet = server.disc({ vx: 12, vy: 3, w: 2, bullet: true });

    server.step();
    for (const x of [-20, 20, -10]) {
      bullet.set(PhysicsPosition, { x, y: 3 });
      server.step();
    }

    expect(server.framesOf(bullet)).toHaveLength(4);
    expect(bullet.has(MotionParams)).toBe(false);
    expect(server.paramWrites).toEqual([]);
  });

  it("carries a gravity scale other than 1", () => {
    const server = new Server({}, { x: 0, y: -10 });
    const floaty = server.disc({ vx: 2, vy: 3, gravityScale: 0.5 });
    const heavy = server.disc({ vx: 2, vy: 3 });

    server.step();

    expect(floaty.get(MotionParams)).toMatchObject({ gravityScale: 0.5, linearDamping: 0 });
    expect(heavy.has(MotionParams)).toBe(false);
  });

  it("writes a baseline at rest as the pose only, and leaves MotionParams alone", () => {
    const server = new Server();
    const container = server.disc({ vx: 1.5, w: 0.5, damping: DAMPING, polygon: QUADRILATERAL });
    server.step();
    const params = container.get(MotionParams)!;
    const held = { ...params };

    // Stopping it sends one baseline at rest.
    container.set(LinearVelocity, { x: 0, y: 0 }).set(AngularVelocity, { value: 0 });
    server.step(3 * HZ);

    expect(server.framesOf(container)).toHaveLength(2);
    const motion = container.get(Motion)!;
    expect(motion).toMatchObject({ rest: true, vx: 0, vy: 0, w: 0 });
    expect(encoded(motion).length).toBe(14);
    expect(container.get(MotionParams)).toBe(params);
    expect({ ...params }).toEqual(held);
    expect(server.paramFramesOf(container)).toHaveLength(1);

    // Moving again sends a moving baseline, which has no new constants to send.
    container.set(LinearVelocity, { x: 2, y: 0 });
    server.step(HZ);

    expect(server.framesOf(container)).toHaveLength(3);
    expect(container.get(Motion)).toMatchObject({ rest: false });
    expect(container.get(Motion)!.vx).toBeGreaterThan(1);
    expect(encoded(container.get(Motion)!).length).toBe(26);
    expect(server.paramFramesOf(container)).toHaveLength(1);
  });

  it("holds a body at rest that has no velocity and that nothing accelerates, awake or not", () => {
    const space = new Server();
    const planet = new Server({}, { x: 0, y: -10 });
    const drifter = space.disc({ insomniac: true });
    const hovering = planet.disc({ insomniac: true, gravityScale: 0 });
    const falling = planet.disc({ insomniac: true });

    space.step();
    planet.step();

    expect(drifter.get(Motion)).toMatchObject({ rest: true });
    expect(hovering.get(Motion)).toMatchObject({ rest: true });
    expect(falling.get(Motion)).toMatchObject({ rest: false });
    // A baseline at rest sends no constants, even when the body's differ from the defaults.
    expect(hovering.has(MotionParams)).toBe(false);
    expect(space.paramWrites).toEqual([]);
    expect(planet.paramWrites).toEqual([]);
  });

  it("holds an entity without a body at rest, and gives it no constants", () => {
    const server = new Server();
    const effect = server.world
      .entity()
      .add(Networked)
      .add(DeadReckoned)
      .set(PhysicsPosition, { x: 3, y: 4 })
      .set(PhysicsRotation, { angle: 0.5 });

    server.step();

    expect(effect.get(Motion)).toMatchObject({ rest: true, x: 3, y: 4 });
    expect(effect.has(MotionParams)).toBe(false);
  });

  it("adds the constants at the first moving baseline of a body that began at rest", () => {
    const server = new Server();
    const container = server.disc({ damping: DAMPING, polygon: QUADRILATERAL });

    server.step();
    expect(container.get(Motion)).toMatchObject({ rest: true });
    expect(container.has(MotionParams)).toBe(false);

    container.set(LinearVelocity, { x: 2, y: 1 });
    server.step(HZ);

    const frames = server.framesOf(container);
    expect(frames).toHaveLength(2);
    expect(container.get(Motion)).toMatchObject({ rest: false });
    expect(container.get(MotionParams)).toMatchObject({ linearDamping: Math.fround(0.15) });
    expect(server.paramFramesOf(container)).toEqual([frames[1]]);
  });

  it("sends one baseline and one MotionParams update, in the same frame, when the damping changes mid-flight", () => {
    const server = new Server();
    const container = server.disc({ vx: 1.5, vy: -0.5, w: 0.4, damping: DAMPING });
    server.step();
    server.step(HZ);
    const spawn = server.framesOf(container);
    expect(spawn).toHaveLength(1);
    expect(server.paramFramesOf(container)).toEqual(spawn);

    // The body now strays from the path clients extrapolate with the old damping.
    container.set(Damping, { linear: 0.6, angular: 0.1 });
    server.step(HZ);

    const frames = server.framesOf(container);
    expect(frames).toHaveLength(2);
    expect(server.paramFramesOf(container)).toEqual(frames);
    expect(container.get(MotionParams)).toMatchObject({
      linearDamping: Math.fround(0.6),
      angularDamping: Math.fround(0.1),
    });

    // The new constants predict the body again: nothing more is sent.
    server.step(2 * HZ);
    expect(server.framesOf(container)).toEqual(frames);
    expect(server.paramFramesOf(container)).toEqual(frames);
  });
});

describe("switching the tag at runtime", () => {
  const LATE_PHASES = [ON_UPDATE, POST_UPDATE, PRE_STORE, ON_STORE] as const;

  it("gives a body that leaves dead reckoning its render pose, and takes away Motion, MotionParams and the prediction", () => {
    const server = new Server();
    const container = server.disc({
      x: 3,
      y: -2,
      angle: 0.7,
      vx: 1,
      vy: 0.5,
      w: 0.4,
      damping: DAMPING,
      polygon: QUADRILATERAL,
    });
    server.step(5);
    expect(container.has(MotionParams)).toBe(true);
    expect(predictionOf(container)).toBeDefined();

    container.remove(DeadReckoned);

    // Outside a system the switch completes at once.
    expect(container.has(Motion)).toBe(false);
    expect(container.has(MotionParams)).toBe(false);
    expect(predictionOf(container)).toBeUndefined();
    const position = { ...container.get(PhysicsPosition)! };
    expect(container.get(RenderPosition)).toMatchObject({ x: position.x, y: position.y });
    expect(container.get(RenderRotation)).toMatchObject({
      angle: container.get(PhysicsRotation)!.angle,
    });
    // The streamed sync takes over.
    server.step(3);
    const moved = container.get(PhysicsPosition)!;
    expect(moved.x).not.toBe(position.x);
    expect(container.get(RenderPosition)).toMatchObject({ x: moved.x, y: moved.y });
    expect(server.framesOf(container)).toHaveLength(1);
  });

  it.each(LATE_PHASES)(
    "gives a body that a system in %s takes out of dead reckoning its render pose by the end of the frame",
    (phase) => {
      const server = new Server();
      const rock = server.disc({ x: 1, y: 2, angle: 0.2, vx: 1, w: 0.5 });
      server.step(3);
      const switchFrame = server.world.frame;
      server.world
        .system("test.leave")
        .phase(phase)
        .run(() => {
          if (server.world.frame === switchFrame) {
            rock.remove(DeadReckoned);
          }
        });

      server.step();

      expect(rock.has(Motion)).toBe(false);
      expect(predictionOf(rock)).toBeUndefined();
      const position = rock.get(PhysicsPosition)!;
      expect(rock.get(RenderPosition)).toMatchObject({ x: position.x, y: position.y });
      expect(rock.get(RenderRotation)).toMatchObject({ angle: rock.get(PhysicsRotation)!.angle });
    }
  );

  it.each(LATE_PHASES)(
    "removes the render pose of a streamed body that a system in %s makes dead reckoned, and writes its first baseline in that frame",
    (phase) => {
      const server = new Server();
      const rock = server.disc({ x: 1, y: 2, angle: 0.2, vx: 1, w: 0.5, streamed: true });
      server.step(3);
      expect(rock.has(Motion)).toBe(false);
      const switchFrame = server.world.frame;
      server.world
        .system("test.join")
        .phase(phase)
        .run(() => {
          if (server.world.frame === switchFrame) {
            rock.add(DeadReckoned);
          }
        });

      server.step();

      expect(rock.has(RenderPosition)).toBe(false);
      expect(rock.has(RenderRotation)).toBe(false);
      expect(server.framesOf(rock)).toEqual([switchFrame]);
      const position = rock.get(PhysicsPosition)!;
      expect(rock.get(Motion)).toMatchObject({
        frame: switchFrame,
        x: Math.fround(position.x),
        y: Math.fround(position.y),
      });
    }
  );

  it("starts a returning body fresh: a new baseline, and its constants sent again", () => {
    const server = new Server();
    const container = server.disc({
      x: -4,
      vx: 2,
      vy: 1,
      w: 0.5,
      damping: DAMPING,
      polygon: QUADRILATERAL,
    });
    server.step(HZ);
    const first = server.framesOf(container);
    expect(server.paramFramesOf(container)).toEqual(first);

    container.remove(DeadReckoned);
    server.step(HZ);
    expect(container.has(MotionParams)).toBe(false);
    container.add(DeadReckoned);
    server.step();

    const returned = server.world.frame - 1;
    expect(server.framesOf(container)).toEqual([...first, returned]);
    // The constants differ from the defaults, so they come back in the same frame.
    expect(server.paramFramesOf(container)).toEqual([...first, returned]);
    expect(container.get(MotionParams)).toMatchObject({
      linearDamping: Math.fround(0.15),
      angularDamping: Math.fround(0.1),
    });
    expect(container.get(Motion)).toMatchObject({ frame: returned, rest: false });
    expect(container.has(RenderPosition)).toBe(false);
  });

  it("keeps the structural rules once a switch completes", () => {
    const server = new Server();
    const rock = server.disc({ vx: 1, streamed: true });

    rock.add(DeadReckoned);
    expect(() => rock.set(RenderPosition, { x: 1, y: 1 })).toThrow(/is DeadReckoned/);
    expect(() => rock.set(RenderRotation, { angle: 1 })).toThrow(/is DeadReckoned/);

    rock.remove(DeadReckoned);
    expect(() => rock.set(RenderPosition, { x: 1, y: 1 })).not.toThrow();
  });

  it("meets no render-pose check when the tag is removed and added in one flush, or added and removed", () => {
    const server = new Server();
    const dead = server.disc({ vx: 1, w: 0.5 });
    const streamed = server.disc({ x: 4, vx: 1, w: 0.5, streamed: true });
    server.step(3);

    server.world.defer(() => {
      dead.remove(DeadReckoned);
      dead.add(DeadReckoned);
      streamed.add(DeadReckoned);
      streamed.remove(DeadReckoned);
    });
    server.step();

    expect(dead.has(DeadReckoned)).toBe(true);
    expect(dead.has(RenderPosition)).toBe(false);
    expect(dead.has(Motion)).toBe(true);
    expect(server.framesOf(dead)).toHaveLength(2);
    expect(streamed.has(DeadReckoned)).toBe(false);
    expect(streamed.has(Motion)).toBe(false);
    expect(predictionOf(streamed)).toBeUndefined();
    const position = streamed.get(PhysicsPosition)!;
    expect(streamed.get(RenderPosition)).toMatchObject({ x: position.x, y: position.y });
  });

  it("destroys a dead-reckoned entity without writing to it", () => {
    const server = new Server();
    const doomed = server.disc({ vx: 1, w: 0.5 });
    const inSystem = server.disc({ x: 3, vx: 1, w: 0.5 });
    server.step(3);

    doomed.destroy();
    server.world
      .system("test.destroy")
      .phase(ON_UPDATE)
      .run(() => inSystem.destroy());
    expect(() => server.step(2)).not.toThrow();

    expect(doomed.destroyed).toBe(true);
    expect(inSystem.destroyed).toBe(true);
    expect(server.world.getEntity(doomed.eid)).toBeUndefined();
    expect(server.world.getEntity(inSystem.eid)).toBeUndefined();
  });
});

describe("a baseline at rest", () => {
  it("holds exactly the pose it carries, for an off-center body", () => {
    const server = new Server();
    const angles = [0.7, -2.4, 3.1];
    const bodies = angles.map((angle, i) =>
      server.disc({ x: 2.3 + 20 * i, y: -1.7, angle, polygon: QUADRILATERAL })
    );

    server.step();

    for (const body of bodies) {
      const motion = body.get(Motion)!;
      expect(motion.rest).toBe(true);
      // Neither the center of mass nor atan2 touches the pose a baseline at rest holds.
      const held = predictionOf(body)!.pose;
      expect(held.x).toBe(motion.x);
      expect(held.y).toBe(motion.y);
      expect(held.angle).toBe(motion.angle);
    }
  });

  it("is not corrected by the round trip the integrator would add", () => {
    const server = new Server();
    const body = server.disc({ x: 2.3, y: -1.7, angle: 0.7, polygon: QUADRILATERAL });
    server.step();
    const motion = body.get(Motion)!;
    // What deriving the pose through the integrator's state gives for this off-center body.
    const params = body.has(MotionParams) ? body.get(MotionParams)! : defaultMotionParams;
    const state = motionStateFrom(motion, params, new MotionState());
    const derived = motionPose(state, params, new MotionPose());
    const held = predictionOf(body)!.pose;

    expect(derived.x !== motion.x || derived.y !== motion.y || derived.angle !== motion.angle).toBe(
      true
    );
    expect(held).toEqual({ x: motion.x, y: motion.y, angle: motion.angle });
  });
});

describe("the MotionParams write", () => {
  it("goes through the callback form of ensure, so it holds outside deferred mode too", () => {
    const server = new Server();
    const container = server.disc({ vx: 1, damping: DAMPING, polygon: QUADRILATERAL });
    const ensure = vi.spyOn(container, "ensure");

    server.step();

    expect(ensure).toHaveBeenCalledTimes(1);
    expect(ensure).toHaveBeenCalledWith(MotionParams, expect.any(Function));
    expect(container.get(MotionParams)).toMatchObject({ linearDamping: Math.fround(0.15) });
  });
});

describe("the pose guard", () => {
  it("writes the first baseline of a body created after POST_UPDATE in the frame it was created", () => {
    const server = new Server();
    let created: Entity | undefined;
    let createdAt = 0;
    server.world
      .system("test.spawn")
      .phase(ON_STORE)
      .run(() => {
        if (created === undefined) {
          createdAt = server.world.frame;
          created = server.disc({ x: 3, y: 4, angle: 0.5, vx: 2 });
        }
      });

    server.step();

    expect(server.framesOf(created!)).toEqual([createdAt]);
    // No Box2D body exists yet to read velocities from, so the baseline holds the pose at rest.
    expect(created!.get(Motion)).toMatchObject({ frame: createdAt, x: 3, y: 4, rest: true });
    expect(created!.get(Motion)!.angle).toBeCloseTo(0.5, 6);

    // The first step creates the body, finds it off its held pose and corrects the baseline.
    server.step();
    expect(server.framesOf(created!)).toEqual([createdAt, createdAt + 1]);
    expect(created!.get(Motion)).toMatchObject({ rest: false });
    expect(created!.get(Motion)!.vx).toBeCloseTo(2, 5);
  });

  it("writes nothing more for a body POST_UPDATE already primed", () => {
    const server = new Server();
    let created: Entity | undefined;
    server.world
      .system("test.spawn")
      .phase(ON_UPDATE)
      .run(() => {
        created ??= server.disc({ x: 3, y: 4, vx: 2 });
      });

    server.step();

    expect(server.framesOf(created!)).toHaveLength(1);
  });

  it("does not write a baseline for an entity that lost its tag before the frame ended", () => {
    const server = new Server();
    server.world
      .system("test.spawn-and-leave")
      .phase(PRE_STORE)
      .run(() => {
        if (server.world.frame === 1) {
          const rock = server.disc({ x: 3, y: 4, vx: 2 });
          rock.remove(DeadReckoned);
        }
      });

    server.step();

    expect(server.baselines).toEqual([]);
  });
});

describe("sector transfer", () => {
  it("keeps the body dead reckoned and re-baselines it at the destination's frame", () => {
    const source = new Server({}, { x: 0, y: 0 }, "source");
    const destination = new Server({}, { x: 0, y: 0 }, "destination");
    destination.step(40); // the two worlds' frames differ
    const ship = source.disc({ vx: 2, w: 0.5 });
    source.step(10);

    const moved = source.world.moveSubtree(ship, destination.world);
    const arrived = moved.roots[0]!;
    destination.step();

    expect(arrived.has(DeadReckoned)).toBe(true);
    expect(arrived.has(RenderPosition)).toBe(false);
    expect(destination.framesOf(arrived)).toEqual([destination.world.frame - 1]);
    const motion = arrived.get(Motion)!;
    const position = arrived.get(PhysicsPosition)!;
    expect(motion.frame).toBe(destination.world.frame - 1);
    expect(motion).toMatchObject({ x: Math.fround(position.x), y: Math.fround(position.y) });
    expect(motion.vx).toBeCloseTo(2, 5);
  });
});

interface Pose {
  x: number;
  y: number;
  angle: number;
}

/**
 * The server-local prediction of `entity`, or `undefined`. Its class is private to the module, so it
 * is found by name.
 */
function predictionOf(entity: Entity): { primed: boolean; pose: Pose } | undefined {
  let found: { primed: boolean; pose: Pose } | undefined;
  entity.components.forEach((component) => {
    if (component.constructor.name === "MotionPrediction") {
      found = component as { primed: boolean; pose: Pose };
    }
  });
  return found;
}

/** The `MotionClock` the module created in `world`. */
function clockOf(world: ServerWorld): MotionClock {
  const entity = [...world.entities.values()].find((candidate) => candidate.has(MotionClock))!;
  return entity.get(MotionClock) as MotionClock;
}

/** `value` after a trip through the wire codec. */
function decoded<T extends object>(Class: new () => T, value: Readonly<T>): T {
  return new Decoder(encoded(value)).read(Class);
}

/** `value` as it goes on the wire. */
function encoded(value: object): Uint8Array {
  const encoder = new Encoder(new Uint8Array(64));
  encoder.write(value);
  return encoder.getBuffer();
}
