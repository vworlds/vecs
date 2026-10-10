// Dead reckoning end to end: a real ServerWorld with physics and DeadReckonedModule, real
// ClientWorlds with the client DeadReckonedModule, joined by the simulated lossy links of
// lib/vecs-server/tests/harness. It checks what clients render against the server's physics pose,
// what crosses the wire, and prints the bandwidth dead reckoning saves.

import { ON_STORE, PRE_STORE, type Entity } from "@vworlds/vecs";
import {
  Motion,
  MotionClock,
  MotionParams,
  phaserMotionComponents,
  phaserNetworkComponents,
  Position as RenderPosition,
  Rotation as RenderRotation,
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
  Polygon,
  Position as PhysicsPosition,
  preloadPhysics,
  Rotation as PhysicsRotation,
  type Vec2,
} from "@vworlds/vecs-physics";
import { ComponentSnapshot, Server2Client } from "@vworlds/vecs-protocol";
import { Networked } from "@vworlds/vecs-server";
import { Decoder } from "@vworlds/vecs-wire";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { DeadReckonedModule as ClientDeadReckonedModule } from "../../vecs-phaser-client/src/modules/dead_reckoned.js";
import { phaserInterpolators } from "../../vecs-phaser-client/src/sync.js";
import { symmetric, type DuplexConditions } from "../../vecs-server/tests/harness/lossy_link.js";
import { ReplicationSim, type SimClient } from "../../vecs-server/tests/harness/replication_sim.js";
import {
  DeadReckoned,
  DeadReckonedModule,
  PhaserServerModule,
  type DeadReckonedOptions,
} from "../src/index.js";

const HZ = 30;
const NETWORK_COMPONENTS = [...phaserNetworkComponents, ...phaserMotionComponents];
const MOTION = NETWORK_COMPONENTS.indexOf(Motion) + 1;
const MOTION_PARAMS = NETWORK_COMPONENTS.indexOf(MotionParams) + 1;
/** An asymmetric convex quadrilateral whose center of mass, (4/3, 7/9), is far from its origin. */
const QUADRILATERAL: Vec2[] = [
  { x: 0, y: 0 },
  { x: 3, y: 0 },
  { x: 3, y: 1 },
  { x: 0, y: 2 },
];
/** 200 ms round trip, 5% loss each way, and one datagram in ten overtaken by up to 60 ms. */
const HARSH_LINK = symmetric({ oneWayMs: 100, loss: 0.05, reorder: 0.1, reorderExtraMs: 60 });
const POSITION_TOLERANCE = 0.01;
const ANGLE_TOLERANCE = 0.01;
/** How long after a correction's frame a client's pose may still be off. */
const TRANSIENT_MS = 150;
/**
 * How many server frames before the frame of a switch to dead reckoning a streamed body may already
 * hold still on a client: the switching diff removes its render pose, so there is nothing to
 * interpolate toward once its last streamed update has been shown, and a lost update lengthens that.
 */
const HANDOFF_LEAD_FRAMES = 4;

let sim: ReplicationSim | undefined;
const bench: string[] = [];

beforeAll(async () => {
  await preloadPhysics();
});

afterEach(() => {
  sim?.dispose();
  sim = undefined;
});

afterAll(() => {
  if (bench.length > 0) {
    console.log(bench.join("\n"));
  }
});

interface Pose {
  x: number;
  y: number;
  angle: number;
}

/** A server and one client, with the server's physics pose and every baseline recorded per frame. */
class Run {
  public readonly sim: ReplicationSim;
  public readonly client: SimClient;
  /** Server physics pose of every dead-reckoned body, by frame, then eid. */
  public readonly truth = new Map<number, Map<number, Pose>>();
  /** Frames of the baselines the server wrote, by eid. */
  public readonly baselines = new Map<number, number[]>();

  public constructor(options: {
    seed: number;
    link?: DuplexConditions;
    deadReckoning?: boolean;
    options?: DeadReckonedOptions;
    /** Interpolate the client's streamed poses between server frames, as a game client does. */
    interpolated?: boolean;
    /** The client extrapolator's `blendMs`. */
    blendMs?: number;
    /**
     * Build the server without `keepAliveFrames`, as every dead-reckoning world must set it, to
     * show what an idle scene looks like without it. The module refuses such a world, so the world
     * is made to report the option to it while the server never sends a keepalive.
     */
    withoutKeepAlive?: boolean;
    /** The server's `keepAliveFrames` when it has one. Default `1`. */
    keepAliveFrames?: number;
  }) {
    const keepAlive = options.deadReckoning !== false && options.withoutKeepAlive !== true;
    this.sim = new ReplicationSim({
      networkComponents: NETWORK_COMPONENTS,
      seed: options.seed,
      tickHz: HZ,
      link: options.link,
      serverOptions: keepAlive ? { keepAliveFrames: options.keepAliveFrames ?? 1 } : undefined,
    });
    sim = this.sim;
    const server = this.sim.server;
    server.module(PhysicsModule, { gravity: { x: 0, y: 0 }, fixedTimeStep: 1 / HZ });
    if (options.deadReckoning === false) {
      server.module(PhaserServerModule);
    } else {
      if (options.withoutKeepAlive === true) {
        Object.defineProperty(server, "keepAliveFrames", { value: 1 });
      }
      server.module(DeadReckonedModule, {
        ...options.options,
        ...(options.withoutKeepAlive === true ? { idleKeepAlive: false } : {}),
      });
      server.component(Motion).on("set", (entity, motion) => {
        const frames = this.baselines.get(entity.eid) ?? [];
        frames.push(motion.frame);
        this.baselines.set(entity.eid, frames);
      });
      // Every body's physics pose, dead reckoned or streamed: a body may switch between the two.
      server
        .system("test.truth")
        .with(PhysicsPosition, PhysicsRotation)
        .phase(ON_STORE)
        .each([PhysicsPosition, PhysicsRotation], (entity, [position, rotation]) => {
          let poses = this.truth.get(server.frame);
          if (poses === undefined) {
            poses = new Map();
            this.truth.set(server.frame, poses);
          }
          poses.set(entity.eid, { x: position.x, y: position.y, angle: rotation.angle });
        });
    }
    this.client = this.sim.addClient({
      interpolators: options.interpolated === true ? phaserInterpolators() : undefined,
    });
    this.client.world.module(ClientDeadReckonedModule, { blendMs: options.blendMs });
  }

  /** The server's pose of `eid` at fractional frame `frame`, interpolated as a client would. */
  public truthAt(eid: number, frame: number): Pose | undefined {
    const whole = Math.floor(frame);
    const from = this.truth.get(whole)?.get(eid);
    const fraction = frame - whole;
    if (from === undefined || fraction === 0) {
      return from;
    }
    const to = this.truth.get(whole + 1)?.get(eid);
    if (to === undefined) {
      return undefined;
    }
    return {
      x: from.x + (to.x - from.x) * fraction,
      y: from.y + (to.y - from.y) * fraction,
      angle: from.angle + wrap(to.angle - from.angle) * fraction,
    };
  }
}

/** A networked dynamic disc; dead reckoned unless `streamed`. */
function disc(
  run: Run,
  options: {
    x: number;
    y: number;
    vx: number;
    vy: number;
    w: number;
    radius?: number;
    damping?: number;
    restitution?: number;
    bullet?: boolean;
    streamed?: boolean;
    /** A convex outline instead of the disc, which puts the center of mass off the body origin. */
    polygon?: Vec2[];
  }
): Entity {
  const world = run.sim.server;
  const body = world
    .entity()
    .add(Networked)
    .set(Body, { type: BodyType.Dynamic, bullet: options.bullet ?? false })
    .set(PhysicsPosition, { x: options.x, y: options.y })
    .set(PhysicsRotation, { angle: 0 })
    .set(LinearVelocity, { x: options.vx, y: options.vy })
    .set(AngularVelocity, { value: options.w });
  if (options.streamed === true) {
    body.set(RenderPosition, { x: options.x, y: options.y }).set(RenderRotation, { angle: 0 });
  } else {
    body.add(DeadReckoned);
  }
  if (options.damping !== undefined) {
    body.set(Damping, { linear: options.damping, angular: options.damping * 0.66 });
  }
  const shape = world.entity().childOf(body);
  if (options.polygon === undefined) {
    shape.set(Circle, { radius: options.radius ?? 0.5 });
  } else {
    shape.set(Polygon, { vertices: options.polygon });
  }
  shape.set(Material, { restitution: options.restitution ?? 0 });
  return body;
}

/** Four static walls around a square arena of half size `half`. */
function arena(run: Run, half: number): void {
  const world = run.sim.server;
  for (const [x, y, hx, hy] of [
    [half, 0, 0.5, half],
    [-half, 0, 0.5, half],
    [0, half, half, 0.5],
    [0, -half, half, 0.5],
  ] as const) {
    const wall = world.entity().set(Body, { type: BodyType.Static }).set(PhysicsPosition, { x, y });
    world.entity().childOf(wall).set(Box, { hx, hy }).set(Material, { restitution: 1 });
  }
}

/** Call `observe` with every frame the server sends `client`, after the harness's own tap. */
function tapFrames(
  client: SimClient,
  observe: (message: Server2Client, bytes: number) => void
): void {
  const harness = client.down.tap;
  client.down.tap = (data) => {
    harness?.(data);
    observe(new Decoder(data).read(Server2Client), data.length);
  };
}

describe("dead reckoning over a lossy link", () => {
  it.each([1, 2])(
    "keeps the rendered pose within tolerance for 60 s at 200 ms round trip, 5%% loss and reordering, seed %i",
    (seed) => {
      const run = new Run({ seed, link: HARSH_LINK });
      arena(run, 15);
      const bodies = [
        disc(run, { x: -10, y: -10, vx: 5, vy: 3, w: 1, restitution: 1 }),
        disc(run, { x: 8, y: 4, vx: -7, vy: 2.5, w: -3, restitution: 1 }),
        disc(run, { x: 0, y: 9, vx: 11, vy: -13, w: 0, radius: 0.1, restitution: 1, bullet: true }),
        disc(run, { x: -4, y: 2, vx: 2, vy: -1.5, w: 0.5, damping: 0.15 }),
        disc(run, { x: 6, y: -6, vx: 0.5, vy: 0.5, w: 0.2, damping: 0.4 }),
        disc(run, { x: 3, y: -12, vx: 0, vy: 0, w: 0 }),
      ];
      // An off-center, damped body whose damping changes twice while it flies.
      const wobbler = disc(run, {
        x: -8,
        y: -4,
        vx: 2.5,
        vy: 1.5,
        w: 1.5,
        damping: 0.15,
        polygon: QUADRILATERAL,
        restitution: 1,
      });
      run.sim.onTick((tick) => {
        if (tick === 15 * HZ) {
          wobbler.set(Damping, { linear: 0.5, angular: 0.3 });
        } else if (tick === 35 * HZ) {
          wobbler.set(Damping, { linear: 0, angular: 0 });
        }
      });
      // Teleport one body every 7 seconds, as a sector-edge wrap would.
      run.sim.onTick((tick) => {
        if (tick > 0 && tick % (7 * HZ) === 0) {
          const body = bodies[(tick / (7 * HZ)) % 2]!;
          const position = body.get(PhysicsPosition)!;
          body.set(PhysicsPosition, { x: -position.x * 0.5, y: -position.y * 0.5 });
        }
      });

      const samples: Array<{ eid: number; frame: number; pose: Pose }> = [];
      run.client.world
        .system("test.sample")
        .with(Motion, RenderPosition, RenderRotation)
        .phase(ON_STORE)
        .each([RenderPosition, RenderRotation], (entity, [position, rotation]) => {
          samples.push({
            eid: entity.eid,
            frame: run.client.world.renderFrame,
            pose: { x: position.x, y: position.y, angle: rotation.angle },
          });
        });

      run.sim.run(60_000);

      const transientFrames = TRANSIENT_MS / run.sim.tickMs;
      let worstPosition = 0;
      let worstAngle = 0;
      let exempt = 0;
      let checked = 0;
      for (const { eid, frame, pose } of samples) {
        const truth = run.truthAt(eid, frame);
        if (truth === undefined) {
          continue;
        }
        const corrected = (run.baselines.get(eid) ?? []).some(
          (baseline) => frame >= baseline - 1 && frame <= baseline + transientFrames
        );
        if (corrected) {
          exempt++;
          continue;
        }
        checked++;
        worstPosition = Math.max(worstPosition, Math.hypot(pose.x - truth.x, pose.y - truth.y));
        worstAngle = Math.max(worstAngle, Math.abs(wrap(pose.angle - truth.angle)));
      }
      const corrections = [...run.baselines.values()].reduce(
        (sum, frames) => sum + frames.length,
        0
      );
      bench.push(
        `lossy run, seed ${seed}: ${checked} samples checked, ${exempt} within ${TRANSIENT_MS} ms of ` +
          `one of ${corrections} baselines; worst |Δp| ${worstPosition.toExponential(2)} m, ` +
          `|Δθ| ${worstAngle.toExponential(2)} rad`
      );

      expect(checked).toBeGreaterThan(exempt);
      expect(worstPosition).toBeLessThanOrEqual(POSITION_TOLERANCE + 1e-6);
      expect(worstAngle).toBeLessThanOrEqual(ANGLE_TOLERANCE + 1e-6);
      expect(run.client.stats.errors).toEqual([]);
      expect(run.client.stats.disconnects).toEqual([]);
      expect(run.client.stats.resets).toHaveLength(1);
      // Motion and MotionParams arrive exactly as sent: never interpolated, never rolled back.
      run.sim.run(1000);
      expect(run.sim.diffFromServer(run.client, [Motion, MotionParams, MotionClock])).toEqual([]);
    }
  );

  it("sends Motion only in frames that carry a baseline the client has not acked", () => {
    const run = new Run({ seed: 3, link: HARSH_LINK });
    arena(run, 10);
    const rock = disc(run, { x: 0, y: 0, vx: 6, vy: 1, w: 2, restitution: 1 });
    const sent: Array<{ fromFrame: number; toFrame: number }> = [];
    tapFrames(run.client, (message) => {
      const diff = message.diff;
      if (diff === undefined || diff.fromFrame === 0) {
        return;
      }
      const carriesMotion = diff.snapshots.some((encoded) => {
        const snapshot = new Decoder(encoded.bytes).read(ComponentSnapshot);
        return snapshot.eid === rock.eid && snapshot.wireType === MOTION;
      });
      if (carriesMotion) {
        sent.push({ fromFrame: diff.fromFrame, toFrame: diff.toFrame });
      }
    });

    run.sim.run(20_000);

    const baselines = run.baselines.get(rock.eid)!;
    // Wall bounces: about one every two seconds.
    expect(baselines.length).toBeGreaterThan(5);
    for (const { fromFrame, toFrame } of sent) {
      expect(baselines.some((frame) => frame > fromFrame && frame <= toFrame)).toBe(true);
    }
    // Retransmits: a baseline rides every frame until the client's ack for it arrives.
    expect(sent.length).toBeGreaterThan(baselines.length);
  });
});

describe("the body constants", () => {
  it("omits the centered box's center fields from its first baseline's MotionParams", () => {
    const run = new Run({ seed: 259, link: symmetric({ oneWayMs: 0 }) });
    const body = run.sim.server
      .entity()
      .add(Networked)
      .add(DeadReckoned)
      .set(Body, { type: BodyType.Dynamic })
      .set(Damping, { linear: 0.15, angular: 0.1 })
      .set(LinearVelocity, { x: 1, y: 0 });
    run.sim.server.entity().childOf(body).set(Box, { hx: 0.3, hy: 0.7 });
    const payloads: Uint8Array[] = [];
    tapFrames(run.client, (message) => {
      for (const encoded of message.diff?.snapshots ?? []) {
        const snapshot = new Decoder(encoded.bytes).read(ComponentSnapshot);
        if (snapshot.eid === body.eid && snapshot.wireType === MOTION_PARAMS) {
          payloads.push(snapshot.payload);
          expect(
            message.diff!.snapshots.some((entry) => {
              const carried = new Decoder(entry.bytes).read(ComponentSnapshot);
              return carried.eid === body.eid && carried.wireType === MOTION;
            })
          ).toBe(true);
        }
      }
    });
    run.sim.run(500);
    expect(payloads.length).toBeGreaterThan(0);
    expect(payloads[0]![0]).toBe(1); // Damping only; local-center mask bit 1 is clear.
    expect(payloads[0]).toHaveLength(9); // One mask byte + two damping f32s, saving 8 bytes.
    expect(new Decoder(payloads[0]!).read(MotionParams)).toMatchObject({
      localCenterX: 0,
      localCenterY: 0,
    });
  });

  it("ride in MotionParams, sent with the baseline that changes them and never for default constants", () => {
    const run = new Run({ seed: 6, link: symmetric({ oneWayMs: 50 }) });
    arena(run, 15);
    const container = disc(run, {
      x: -6,
      y: -6,
      vx: 2,
      vy: 1.2,
      w: 0.5,
      damping: 0.15,
      polygon: QUADRILATERAL,
      restitution: 1,
    });
    const bullet = disc(run, {
      x: 6,
      y: 6,
      vx: 9,
      vy: -7,
      w: 1,
      radius: 0.1,
      bullet: true,
      restitution: 1,
    });
    run.sim.onTick((tick) => {
      if (tick === 10 * HZ) {
        container.set(Damping, { linear: 0.5, angular: 0.3 });
      }
      // A teleport every two seconds is a correction that changes no constant.
      if (tick > 0 && tick % (2 * HZ) === 0) {
        container.set(PhysicsPosition, tick % (4 * HZ) === 0 ? { x: -6, y: -6 } : { x: 4, y: -8 });
      }
    });
    // What each diff carries for the two bodies: the Motion and MotionParams payloads.
    const diffs: Array<{ motion: Uint8Array[]; params: Uint8Array[]; bulletParams: number }> = [];
    tapFrames(run.client, (message) => {
      const diff = message.diff;
      if (diff === undefined) {
        return;
      }
      const carried = { motion: [] as Uint8Array[], params: [] as Uint8Array[], bulletParams: 0 };
      for (const encoded of diff.snapshots) {
        const snapshot = new Decoder(encoded.bytes).read(ComponentSnapshot);
        if (snapshot.wireType === MOTION && snapshot.eid === container.eid) {
          carried.motion.push(snapshot.payload);
        } else if (snapshot.wireType === MOTION_PARAMS && snapshot.eid === container.eid) {
          carried.params.push(snapshot.payload);
        } else if (snapshot.wireType === MOTION_PARAMS && snapshot.eid === bullet.eid) {
          carried.bulletParams++;
        }
      }
      diffs.push(carried);
    });

    run.sim.run(30_000);

    // Whenever the constants ride in a diff, so does the baseline they belong to.
    const withParams = diffs.filter(({ params }) => params.length > 0);
    expect(withParams.length).toBeGreaterThan(0);
    for (const { motion, params } of withParams) {
      expect(motion).toHaveLength(1);
      expect(params).toHaveLength(1);
    }
    // Two sets of constants in the whole run, the spawn's and the one after the damping changed:
    // each damped, off-center and 17 bytes (the mask, the damping pair and the local center).
    const distinct = new Set(withParams.map(({ params }) => params[0]!.join(",")));
    expect(distinct.size).toBe(2);
    for (const { params } of withParams) {
      expect(params[0]!.length).toBe(17);
    }
    const damping = [...distinct].map((bytes) => {
      const payload = Uint8Array.from(bytes.split(",").map(Number));
      return new Decoder(payload).read(MotionParams).linearDamping;
    });
    expect(damping).toEqual([Math.fround(0.15), Math.fround(0.5)]);
    // Corrections ride without them: far more diffs carry a baseline than carry constants.
    const withMotion = diffs.filter(({ motion }) => motion.length > 0);
    expect(withMotion.length).toBeGreaterThan(3 * withParams.length);
    // A moving baseline is the frame, the flags, the pose and the velocities; one at rest has no
    // velocities. Either way it carries no constant.
    for (const { motion } of withMotion) {
      const baseline = new Decoder(motion[0]!).read(Motion);
      const frameBytes = baseline.frame < 128 ? 1 : 2;
      expect(motion[0]!.length).toBe(frameBytes + 1 + (baseline.rest ? 12 : 24));
    }
    // A body with the default constants never has any.
    expect(diffs.reduce((sum, { bulletParams }) => sum + bulletParams, 0)).toBe(0);
    expect(bullet.has(MotionParams)).toBe(false);

    run.sim.run(1000);
    expect(run.sim.diffFromServer(run.client, [Motion, MotionParams, MotionClock])).toEqual([]);
    expect(run.client.stats.errors).toEqual([]);
  });
});

describe("streamed bodies", () => {
  it("bring an entity without a body to clients through the render pose", () => {
    const run = new Run({ seed: 4, link: HARSH_LINK });
    const explosion = run.sim.server
      .entity()
      .add(Networked)
      .set(PhysicsPosition, { x: 1, y: 1 })
      .set(PhysicsRotation, { angle: 0 })
      .set(RenderPosition, { x: 0, y: 0 })
      .set(RenderRotation, { angle: 0 });
    let moving = true;
    run.sim.onTick((tick) => {
      if (moving) {
        explosion.set(PhysicsPosition, { x: 1 + tick * 0.01, y: 1 });
        explosion.set(PhysicsRotation, { angle: tick * 0.001 });
      }
    });

    run.sim.run(3000);
    moving = false;
    run.sim.run(1000);

    const seen = run.client.world.entity(explosion.eid);
    expect(explosion.get(RenderPosition)).toEqual(explosion.get(PhysicsPosition));
    expect(explosion.get(RenderRotation)).toEqual(explosion.get(PhysicsRotation));
    expect(explosion.get(RenderPosition)!.x).toBeGreaterThan(1.8);
    // The wire carries the render pose as f32.
    const sent = explosion.get(RenderPosition)!;
    expect(seen.get(RenderPosition)).toEqual({ x: Math.fround(sent.x), y: Math.fround(sent.y) });
    expect(seen.get(RenderRotation)!.angle).toBe(Math.fround(explosion.get(RenderRotation)!.angle));
    expect(seen.has(Motion)).toBe(false);
  });
});

describe("a body switched between a streamed pose and dead reckoning", () => {
  /**
   * A body gliding at constant velocity, streamed, then dead reckoned from t = 2 s, then streamed
   * again from t = 4 s, over a clean link with an interpolating client. The client's render pose is
   * sampled at every render frame, and each step is compared with the `v * dt` it should make.
   */
  function glide(blendMs: number): {
    catchUp: number;
    stall: number;
    sideways: number;
    turn: number;
  } {
    const run = new Run({
      seed: 11,
      link: symmetric({ oneWayMs: 20 }),
      interpolated: true,
      blendMs,
    });
    const v = { x: 0.8, y: 0.6 };
    const w = 0.5;
    const body = disc(run, { x: 0, y: 0, vx: v.x, vy: v.y, w, streamed: true });
    run.sim.onTick((tick) => {
      if (tick === 2 * HZ) {
        body.add(DeadReckoned);
      }
    });
    run.sim.server
      .system("test.release")
      .phase(PRE_STORE)
      .run(() => {
        if (run.sim.server.frame === 4 * HZ + 1) {
          body.remove(DeadReckoned);
        }
      });
    const samples: Array<{ t: number } & Pose> = [];
    run.client.world
      .system("test.sample")
      .with(RenderPosition, RenderRotation)
      .phase(ON_STORE)
      .each([RenderPosition, RenderRotation], (entity, [position, rotation]) => {
        if (entity.eid === body.eid) {
          samples.push({
            t: run.sim.clock.now,
            x: position.x,
            y: position.y,
            angle: rotation.angle,
          });
        }
      });

    run.sim.run(6000);

    // Each step is split into what it moves along the velocity, beyond what `v * dt` says it
    // should (a catch-up) or short of it (a stall), and what it moves across it.
    const dt = 1 / 60;
    const speed = Math.hypot(v.x, v.y);
    let catchUp = 0;
    let stall = 0;
    let sideways = 0;
    let turn = 0;
    // From the second second on, once frames are flowing and the first baseline has settled.
    for (let i = 1; i < samples.length; i++) {
      const before = samples[i - 1]!;
      const after = samples[i]!;
      if (before.t < 1000) {
        continue;
      }
      const ex = after.x - before.x - v.x * dt;
      const ey = after.y - before.y - v.y * dt;
      const along = (ex * v.x + ey * v.y) / speed;
      catchUp = Math.max(catchUp, along);
      stall = Math.max(stall, -along);
      sideways = Math.max(sideways, Math.abs((ey * v.x - ex * v.y) / speed));
      turn = Math.max(turn, Math.abs(after.angle - before.angle - w * dt));
    }
    expect(run.client.stats.errors).toEqual([]);
    return { catchUp, stall, sideways, turn };
  }

  it("never jumps ahead of its velocity in a render frame, through both hand-offs", () => {
    const steps = glide(100);

    // The blend spreads the hand-off over `blendMs`: no step exceeds `v * dt` by the tolerance.
    expect(steps.catchUp).toBeLessThanOrEqual(POSITION_TOLERANCE);
    expect(steps.sideways).toBeLessThanOrEqual(1e-4);
    expect(steps.turn).toBeLessThanOrEqual(ANGLE_TOLERANCE);
    // A streamed body whose updates stop holds its last pose until the baseline's frame (the
    // switching diff has no render pose to interpolate toward), so a step can fall short of
    // `v * dt` by all of it, a stall, but the pose never goes backward.
    expect(steps.stall).toBeLessThanOrEqual(1 / 60 + 1e-6);
  });

  it("does, without the blend: the first baseline jumps to the path", () => {
    const steps = glide(0);

    expect(steps.catchUp).toBeGreaterThan(POSITION_TOLERANCE);
  });

  it.each([1, 2])(
    "converges, with no protocol error or disconnect, while it is toggled over a lossy link, seed %i",
    (seed) => {
      const run = new Run({ seed, link: HARSH_LINK, interpolated: true });
      arena(run, 15);
      const server = run.sim.server;
      // Other bodies, to put baselines, corrections and the window of a switch in context.
      disc(run, { x: -10, y: -10, vx: 5, vy: 3, w: 1, restitution: 1 });
      disc(run, { x: 8, y: 4, vx: -7, vy: 2.5, w: -3, restitution: 1 });
      const toggled = disc(run, {
        x: -14,
        y: -10,
        vx: 0.4,
        vy: 0.3,
        w: 0.5,
        damping: 0,
        polygon: QUADRILATERAL,
        streamed: true,
      });
      // Every switch, as the server frame it takes effect in. The first is at t = 5 s and then
      // every 1.5 s; even ones run outside a system, odd ones inside a system of a late phase.
      const switches: number[] = [];
      const toggleAt = (frame: number, index: number): void => {
        const toDeadReckoned = index % 2 === 0;
        const action = (): void => {
          switches.push(server.frame);
          if (toDeadReckoned) {
            toggled.add(DeadReckoned);
          } else {
            toggled.remove(DeadReckoned);
          }
        };
        if (index % 4 < 2) {
          run.sim.onTick((tick) => tick + 1 === frame && action());
        } else {
          server
            .system(`test.toggle.${index}`)
            .phase(index % 4 === 2 ? PRE_STORE : ON_STORE)
            .run(() => server.frame === frame && action());
        }
      };
      let toggles = 0;
      for (let frame = 5 * HZ; frame < 55 * HZ; frame += Math.round(1.5 * HZ)) {
        toggleAt(frame, toggles++);
      }
      // An odd number of switches would leave it dead reckoned; end streamed, to compare it directly.
      if (toggles % 2 === 1) {
        toggleAt(55 * HZ, toggles++);
      }

      const samples: Array<{ frame: number } & Pose> = [];
      run.client.world
        .system("test.sample")
        .with(RenderPosition, RenderRotation)
        .phase(ON_STORE)
        .each([RenderPosition, RenderRotation], (entity, [position, rotation]) => {
          if (entity.eid === toggled.eid) {
            samples.push({
              frame: run.client.world.renderFrame,
              x: position.x,
              y: position.y,
              angle: rotation.angle,
            });
          }
        });

      run.sim.run(60_000);

      // The pose is within tolerance of the server's, outside the documented transients: the
      // 150 ms after a correction, and around a switch. A streamed body whose updates stop holds
      // its last pose until the baseline's frame, which on this link, with its loss and reordering,
      // is up to HANDOFF_LEAD_FRAMES frames before the switch; the hand-off then blends out over
      // 100 ms after it.
      const transientFrames = TRANSIENT_MS / run.sim.tickMs;
      const corrections = run.baselines.get(toggled.eid) ?? [];
      let worstPosition = 0;
      let worstAngle = 0;
      let checked = 0;
      for (const { frame, x, y, angle } of samples) {
        const truth = run.truthAt(toggled.eid, frame);
        if (truth === undefined) {
          continue;
        }
        if (
          corrections.some((start) => frame >= start - 1 && frame <= start + transientFrames) ||
          switches.some(
            (start) => frame >= start - HANDOFF_LEAD_FRAMES && frame <= start + transientFrames
          )
        ) {
          continue;
        }
        checked++;
        worstPosition = Math.max(worstPosition, Math.hypot(x - truth.x, y - truth.y));
        worstAngle = Math.max(worstAngle, Math.abs(wrap(angle - truth.angle)));
      }

      expect(switches.length).toBeGreaterThan(30);
      expect(checked).toBeGreaterThan(samples.length / 2);
      expect(worstPosition).toBeLessThanOrEqual(POSITION_TOLERANCE + 1e-6);
      expect(worstAngle).toBeLessThanOrEqual(ANGLE_TOLERANCE + 1e-6);
      expect(run.client.stats.errors).toEqual([]);
      expect(run.client.stats.disconnects).toEqual([]);
      expect(run.client.stats.resets).toHaveLength(1);
      // It ends streamed. Stop it and let the link settle: the client then holds what the server
      // holds, and no Motion.
      toggled.set(LinearVelocity, { x: 0, y: 0 }).set(AngularVelocity, { value: 0 });
      run.sim.run(2500);
      expect(toggled.has(DeadReckoned)).toBe(false);
      const shown = run.client.world.entity(toggled.eid);
      expect(shown.has(Motion)).toBe(false);
      expect(shown.has(MotionParams)).toBe(false);
      const sent = toggled.get(RenderPosition)!;
      expect(shown.get(RenderPosition)).toEqual({ x: Math.fround(sent.x), y: Math.fround(sent.y) });
      // The client's interpolator keeps angles in [0, 2π).
      const turn = wrap(shown.get(RenderRotation)!.angle - toggled.get(RenderRotation)!.angle);
      expect(Math.abs(turn)).toBeLessThan(1e-5);
      expect(run.sim.diffFromServer(run.client, [MotionClock])).toEqual([]);
    }
  );
});

describe("an idle scene", () => {
  // One dead-reckoned body drifting in empty space. After its first baseline nothing about it
  // replicates, so the server has no state to send: without a keepalive the client's render frame
  // stops, and the body with it.
  const VELOCITY = { x: 3, y: 2 };
  const SPIN = 0.5;
  /** Client render frames per second, the harness default. */
  const RENDER_HZ = 60;
  /** From here on the first baseline has landed and the client's buffer has settled. */
  const SETTLED_MS = 1000;

  interface Sample extends Pose {
    t: number;
    renderFrame: number;
  }

  /** Run 8 s of the drifting body, sampling the client's pose of it on every render frame. */
  function drift(options: {
    withoutKeepAlive?: boolean;
    keepAliveFrames?: number;
    traffic?: boolean;
  }): {
    run: Run;
    body: Entity;
    samples: Sample[];
  } {
    const run = new Run({
      seed: 21,
      link: symmetric({ oneWayMs: 20 }),
      interpolated: true,
      withoutKeepAlive: options.withoutKeepAlive,
      keepAliveFrames: options.keepAliveFrames,
    });
    if (options.traffic === true) {
      // The reference the keepalive is measured against: frames kept flowing by a streamed entity
      // that changes on every tick, which is what a busy scene does for free.
      const traffic = run.sim.server.entity().add(Networked).set(RenderPosition, { x: 50, y: 50 });
      run.sim.onTick((tick) => {
        traffic.set(RenderPosition, { x: 50 + tick * 0.01, y: 50 });
      });
    }
    const body = disc(run, { x: 0, y: 0, vx: VELOCITY.x, vy: VELOCITY.y, w: SPIN });
    const samples: Sample[] = [];
    run.client.world
      .system("test.sample")
      .with(RenderPosition, RenderRotation)
      .phase(ON_STORE)
      .each([RenderPosition, RenderRotation], (entity, [position, rotation]) => {
        if (entity.eid === body.eid) {
          samples.push({
            t: run.sim.clock.now,
            renderFrame: run.client.world.renderFrame,
            x: position.x,
            y: position.y,
            angle: rotation.angle,
          });
        }
      });
    run.sim.run(8000);
    expect(run.client.stats.errors).toEqual([]);
    return { run, body, samples };
  }

  function settled(samples: Sample[]): Sample[] {
    return samples.filter((sample) => sample.t >= SETTLED_MS);
  }

  it("advances the extrapolated pose on every render frame with keepAliveFrames 1", () => {
    const { run, samples } = drift({});

    const after = settled(samples);
    expect(after.length).toBeGreaterThan(400);
    const dt = 1 / RENDER_HZ;
    for (let i = 1; i < after.length; i++) {
      const before = after[i - 1]!;
      const sample = after[i]!;
      // The render frame moves a half server frame per render frame, so the body moves `v * dt`.
      expect(sample.renderFrame - before.renderFrame).toBeCloseTo(HZ / RENDER_HZ, 6);
      expect(sample.x - before.x).toBeCloseTo(VELOCITY.x * dt, 4);
      expect(sample.y - before.y).toBeCloseTo(VELOCITY.y * dt, 4);
    }
    // Over the whole settled stretch it moved as far as the velocity says, with no jump at the end.
    const first = after[0]!;
    const last = after[after.length - 1]!;
    expect(last.x - first.x).toBeCloseTo((VELOCITY.x * (last.t - first.t)) / 1000, 1);
    // A header-only frame on every tick is all that crossed the wire after the first baseline.
    expect(run.client.stats.disconnects).toEqual([]);
    expect(run.client.stats.deltasSent.length).toBeGreaterThan(8 * HZ - 12);
  });

  it("moves exactly as it does when a streamed entity keeps the frames flowing", () => {
    const keepAlive = drift({}).samples;
    const traffic = drift({ withoutKeepAlive: true, traffic: true }).samples;

    expect(keepAlive).toHaveLength(traffic.length);
    for (let i = 0; i < keepAlive.length; i++) {
      expect(keepAlive[i]!.renderFrame).toBeCloseTo(traffic[i]!.renderFrame, 9);
      expect(keepAlive[i]!.x).toBeCloseTo(traffic[i]!.x, 9);
      expect(keepAlive[i]!.y).toBeCloseTo(traffic[i]!.y, 9);
      expect(keepAlive[i]!.angle).toBeCloseTo(traffic[i]!.angle, 9);
    }
  });

  /** How far each render frame moved the body, as a multiple of the `v * dt` it should move. */
  function stepRatios(samples: Sample[]): number[] {
    const after = settled(samples);
    return after.slice(1).map((sample, i) => (sample.x - after[i]!.x) / (VELOCITY.x / RENDER_HZ));
  }

  it("stays smooth with a keepalive every other frame, because the client's buffer spans the empty one", () => {
    const ratios = stepRatios(drift({ keepAliveFrames: 2 }).samples);

    expect(ratios.length).toBeGreaterThan(400);
    expect(Math.min(...ratios)).toBeCloseTo(1, 4);
    expect(Math.max(...ratios)).toBeCloseTo(1, 4);
  });

  it("stalls and jumps with a keepalive every fourth frame: the render frame waits for the next one", () => {
    const ratios = stepRatios(drift({ keepAliveFrames: 4 }).samples);

    // On about a quarter of the render frames the body does not move at all, and the frame that
    // follows makes up for it. `keepAliveFrames: 1` is the safe value.
    expect(ratios.filter((ratio) => ratio < 0.01).length).toBeGreaterThan(ratios.length / 5);
    expect(Math.max(...ratios)).toBeGreaterThan(1.2);
  });

  it("freezes without a keepalive: the body holds its first pose for as long as nothing changes", () => {
    // The module refuses a world without the option; this documents why.
    const { run, body, samples } = drift({ withoutKeepAlive: true });

    const after = settled(samples);
    expect(after.length).toBeGreaterThan(400);
    const first = after[0]!;
    expect(after.every((sample) => sample.x === first.x && sample.y === first.y)).toBe(true);
    expect(after.every((sample) => sample.renderFrame === first.renderFrame)).toBe(true);
    // Meanwhile the server's body kept going: the client is metres behind it.
    expect(body.get(PhysicsPosition)!.x - first.x).toBeGreaterThan(VELOCITY.x * 5);
    // After the baseline and the entity that carries the clock, the server sent no frame at all.
    expect(run.client.stats.framesSent).toBeLessThan(5);
  });
});

describe("bandwidth", () => {
  it("prints the bytes per second 200 drifting bodies cost streamed and dead reckoned", () => {
    const modes: Array<{ name: string; deadReckoning: boolean; options?: DeadReckonedOptions }> = [
      { name: "streamed", deadReckoning: false },
      { name: "dead reckoned", deadReckoning: true },
      { name: "dead reckoned, no refresh", deadReckoning: true, options: { maxBaselineAge: 0 } },
    ];
    const rates = modes.map(({ deadReckoning, options }) => {
      const run = new Run({ seed: 5, deadReckoning, options });
      const streamed = !deadReckoning;
      for (let i = 0; i < 200; i++) {
        const x = ((i % 20) - 10) * 12;
        const y = (Math.floor(i / 20) - 5) * 12;
        const turn = ((i * 37) % 100) / 100 - 0.5;
        const kind = i % 4;
        if (kind === 0) {
          disc(run, { x, y, vx: 30 * turn, vy: 25, w: 0, radius: 0.1, bullet: true, streamed });
        } else if (kind === 1) {
          // A container: damped, it comes to rest within the minute.
          disc(run, { x, y, vx: 2 * turn, vy: 1, w: turn, damping: 0.15, streamed });
        } else {
          disc(run, { x, y, vx: 1.5 * turn, vy: 0.5, w: 0.8 * turn, streamed });
        }
      }
      let bytes = 0;
      let counting = false;
      tapFrames(run.client, (_message, length) => {
        if (counting) {
          bytes += length;
        }
      });
      run.sim.run(1000); // past the first baseline
      counting = true;
      run.sim.run(60_000);
      sim?.dispose();
      sim = undefined;
      return bytes / 60;
    });

    const streamed = rates[0]!;
    bench.push(
      [
        "200 drifting bodies (50 bullets, 50 damped containers, 100 rocks), 1 client, 30 Hz, 60 s:",
        ...modes.map(
          ({ name }, i) =>
            `  ${name.padEnd(26)}${rates[i]!.toFixed(0).padStart(8)} B/s ` +
            `(${((100 * rates[i]!) / streamed).toFixed(1)}%)`
        ),
      ].join("\n")
    );
    expect(rates[1]!).toBeLessThan(streamed / 10);
  }, 120_000);
});

function wrap(angle: number): number {
  return angle - 2 * Math.PI * Math.round(angle / (2 * Math.PI));
}
