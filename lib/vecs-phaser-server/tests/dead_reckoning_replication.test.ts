// Dead reckoning end to end: a real ServerWorld with physics and DeadReckonedModule, real
// ClientWorlds with the client DeadReckonedModule, joined by the simulated lossy links of
// lib/vecs-server/tests/harness. It checks what clients render against the server's physics pose,
// what crosses the wire, and prints the bandwidth dead reckoning saves.

import { ON_STORE, type Entity } from "@vworlds/vecs";
import {
  Motion,
  MotionClock,
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
  Position as PhysicsPosition,
  preloadPhysics,
  Rotation as PhysicsRotation,
} from "@vworlds/vecs-physics";
import { ComponentSnapshot, Server2Client } from "@vworlds/vecs-protocol";
import { Networked } from "@vworlds/vecs-server";
import { Decoder } from "@vworlds/vecs-wire";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { DeadReckonedModule as ClientDeadReckonedModule } from "../../vecs-phaser-client/src/modules/dead_reckoned.js";
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
/** 200 ms round trip, 5% loss each way, and one datagram in ten overtaken by up to 60 ms. */
const HARSH_LINK = symmetric({ oneWayMs: 100, loss: 0.05, reorder: 0.1, reorderExtraMs: 60 });
const POSITION_TOLERANCE = 0.01;
const ANGLE_TOLERANCE = 0.01;
/** How long after a correction's frame a client's pose may still be off. */
const TRANSIENT_MS = 150;

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
  }) {
    this.sim = new ReplicationSim({
      networkComponents: NETWORK_COMPONENTS,
      seed: options.seed,
      tickHz: HZ,
      link: options.link,
    });
    sim = this.sim;
    const server = this.sim.server;
    server.module(PhysicsModule, { gravity: { x: 0, y: 0 }, fixedTimeStep: 1 / HZ });
    if (options.deadReckoning === false) {
      server.module(PhaserServerModule);
    } else {
      server.module(DeadReckonedModule, options.options ?? {});
      server.component(Motion).on("set", (entity, motion) => {
        const frames = this.baselines.get(entity.eid) ?? [];
        frames.push(motion.frame);
        this.baselines.set(entity.eid, frames);
      });
      server
        .system("test.truth")
        .with(DeadReckoned, PhysicsPosition, PhysicsRotation)
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
    this.client = this.sim.addClient();
    this.client.world.module(ClientDeadReckonedModule);
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
  world
    .entity()
    .childOf(body)
    .set(Circle, { radius: options.radius ?? 0.5 })
    .set(Material, { restitution: options.restitution ?? 0 });
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
      // Motion arrives exactly as sent: never interpolated, never rolled back.
      run.sim.run(1000);
      expect(run.sim.diffFromServer(run.client, [Motion, MotionClock])).toEqual([]);
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
