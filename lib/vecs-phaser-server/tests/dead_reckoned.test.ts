// DeadReckonedModule on the server: the structural guarantees of the DeadReckoned tag, the
// MotionClock singleton, and the divergence check that decides when a body needs a new Motion
// baseline. Each scenario counts the baselines the server writes; what reaches clients, and when,
// is in dead_reckoning_replication.test.ts.

import { World, type Entity } from "@vworlds/vecs";
import {
  Motion,
  MotionClock,
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
  LinearVelocity,
  Material,
  PhysicsModule,
  Position as PhysicsPosition,
  preloadPhysics,
  Rotation as PhysicsRotation,
} from "@vworlds/vecs-physics";
import { Networked, ServerWorld } from "@vworlds/vecs-server";
import { Decoder, Encoder } from "@vworlds/vecs-wire";
import { beforeAll, describe, expect, it } from "vitest";

import { DeadReckoned, DeadReckonedModule, type DeadReckonedOptions } from "../src/index.js";

const HZ = 30;
const STEP_MS = 1000 / HZ;
const NETWORK_COMPONENTS = [...phaserNetworkComponents, ...phaserMotionComponents];

beforeAll(async () => {
  await preloadPhysics();
});

/** A server world with physics at 30 Hz and dead reckoning, plus a log of every baseline written. */
class Server {
  public readonly world: ServerWorld;
  /** Every baseline the module wrote, as `[eid, frame]`, in order. */
  public readonly baselines: Array<[number, number]> = [];
  private _now = 0;

  public constructor(options: DeadReckonedOptions = {}, gravity = { x: 0, y: 0 }, name = "test") {
    this.world = new ServerWorld({ name, networkComponents: NETWORK_COMPONENTS });
    this.world.module(PhysicsModule, { gravity, fixedTimeStep: 1 / HZ });
    this.world.module(DeadReckonedModule, options);
    this.world.component(Motion).on("set", (entity, motion) => {
      this.baselines.push([entity.eid, motion.frame]);
    });
  }

  /** Baselines written for `entity`, by frame. */
  public framesOf(entity: Entity): number[] {
    return this.baselines.filter(([eid]) => eid === entity.eid).map(([, frame]) => frame);
  }

  /** Run `steps` server ticks. */
  public step(steps = 1): void {
    for (let i = 0; i < steps; i++) {
      this.world.progress(this._now, STEP_MS);
      this._now += STEP_MS;
    }
  }

  /** A networked, dead-reckoned dynamic disc of radius 0.5. */
  public disc(options: {
    x?: number;
    y?: number;
    vx?: number;
    vy?: number;
    w?: number;
    damping?: { linear: number; angular: number };
    restitution?: number;
  }): Entity {
    const body = this.world
      .entity()
      .add(Networked)
      .add(DeadReckoned)
      .set(Body, { type: BodyType.Dynamic })
      .set(PhysicsPosition, { x: options.x ?? 0, y: options.y ?? 0 })
      .set(LinearVelocity, { x: options.vx ?? 0, y: options.vy ?? 0 })
      .set(AngularVelocity, { value: options.w ?? 0 });
    if (options.damping !== undefined) {
      body.set(Damping, options.damping);
    }
    this.world
      .entity()
      .childOf(body)
      .set(Circle, { radius: 0.5 })
      .set(Material, { restitution: options.restitution ?? 0 });
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
    expect(container.get(Motion)).toMatchObject({
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
    expect(container.get(Motion)).toMatchObject({ vx: 0, vy: 0, w: 0, gravityScale: 0 });
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
        const motion = decoded(body.get(Motion)!);
        const { state, pose } = prediction[i]!;
        motionStateFrom(motion, state);
        for (let n = motion.frame; n < server.world.frame - 1; n++) {
          stepMotion(state, motion, clock);
        }
        motionPose(state, motion, pose);
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
    expect(decoded(motion)).toEqual({ ...motion });
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

/** The `MotionClock` the module created in `world`. */
function clockOf(world: ServerWorld): MotionClock {
  const entity = [...world.entities.values()].find((candidate) => candidate.has(MotionClock))!;
  return entity.get(MotionClock) as MotionClock;
}

/** `motion` after a trip through the wire codec. */
function decoded(motion: Readonly<Motion>): Motion {
  const encoder = new Encoder(new Uint8Array(64));
  encoder.write(motion as Motion);
  return new Decoder(encoder.getBuffer()).read(Motion);
}
