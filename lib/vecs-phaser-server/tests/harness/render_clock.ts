import { ON_STORE } from "@vworlds/vecs";
import { DiffBuffer, type Diff } from "@vworlds/vecs-client";
import {
  Motion,
  phaserMotionComponents,
  phaserNetworkComponents,
  Position,
  Rotation,
} from "@vworlds/vecs-phaser";
import {
  Body,
  BodyType,
  Circle,
  LinearVelocity,
  PhysicsModule,
  Position as PhysicsPosition,
  Rotation as PhysicsRotation,
  Sleep,
} from "@vworlds/vecs-physics";
import { Networked } from "@vworlds/vecs-server";
import { DeadReckonedModule as ClientDR } from "../../../vecs-phaser-client/src/modules/dead_reckoned.js";
import { phaserInterpolators } from "../../../vecs-phaser-client/src/sync.js";
import { symmetric } from "../../../vecs-server/tests/harness/lossy_link.js";
import { ReplicationSim } from "../../../vecs-server/tests/harness/replication_sim.js";
import { DeadReckoned, DeadReckonedModule } from "../../src/dead_reckoned.js";

export interface Scenario {
  k: number;
  link: "clean" | "jitter" | "isolated" | "burst";
  rtt: number;
  hz: number;
  pause: number;
  gate: boolean;
  scene: "drift" | "corrections" | "mixed" | "resume" | "idle";
  redundancy?: number;
  /** Counterfactual only: shorten the dry-pull refill delay by one slot. */
  refill?: "two-slots";
  seed?: number;
  duration?: number;
  /** Actual scheduler frequency; the client is still configured for nominal 30 Hz. */
  tickHz?: number;
}

interface BufferInternals {
  _base: number | undefined;
  _tServ: number;
  _accept: (diff: Diff) => void;
}

export interface PullTrace {
  at: number;
  frame: number;
  version: number;
  base: number | undefined;
  deadline: number;
  slots: Array<number | null>;
  after: number;
  applied: number;
  dry: boolean;
}

interface Pose {
  x: number;
  y: number;
  angle: number;
}

/** Real physics, real DR on both ends, and server-side per-frame truth, independent of reception. */
export function characterize(scenario: Scenario) {
  const duration = scenario.duration ?? 30_000;
  const warmup = 2_000;
  const sim = new ReplicationSim({
    networkComponents: [...phaserNetworkComponents, ...phaserMotionComponents],
    seed: scenario.seed ?? 257,
    renderHz: scenario.hz,
    tickHz: scenario.tickHz,
    link: symmetric({
      oneWayMs: scenario.rtt / 2,
      reorder: scenario.link === "jitter" ? 1 : 0,
      reorderExtraMs: scenario.link === "jitter" ? 40 : 0,
    }),
    serverOptions: { keepAliveFrames: scenario.k, redundancyFrames: scenario.redundancy },
  });
  try {
    const server = sim.server;
    server.module(PhysicsModule, { fixedTimeStep: 1 / 30, gravity: { x: 0, y: 0 } });
    server.module(DeadReckonedModule, { idleKeepAlive: scenario.gate, maxBaselineAge: 0 });
    const resting = scenario.scene === "resume" || scenario.scene === "idle";
    const dr = server
      .entity()
      .add(Networked)
      .add(DeadReckoned)
      .set(Body, { type: BodyType.Dynamic })
      .set(PhysicsPosition, { y: 10 })
      .set(LinearVelocity, { x: resting ? 0 : 1 })
      .set(Sleep, { enabled: false });
    server.entity().childOf(dr).set(Circle, { radius: 0.1 });
    const streamed =
      scenario.scene === "mixed"
        ? server
            .entity()
            .add(Networked)
            .set(Body, { type: BodyType.Dynamic })
            .set(PhysicsPosition, { x: 0, y: 0 })
            .set(PhysicsRotation, { angle: 0 })
            .set(Position, { x: 0, y: 0 })
            .set(Rotation, { angle: 0 })
            .set(LinearVelocity, { x: 1 })
            .set(Sleep, { enabled: false })
        : undefined;
    if (streamed) {
      server.entity().childOf(streamed).set(Circle, { radius: 0.1 });
    }
    const truth = new Map<number, Map<number, Pose>>();
    server
      .system("characterization.truth")
      .with(PhysicsPosition, PhysicsRotation)
      .phase(ON_STORE)
      // Deliberately sample every physics pose every tick, even if no replicated field changed.
      .each([PhysicsPosition, PhysicsRotation], (entity, [position, rotation]) => {
        let poses = truth.get(server.frame);
        if (!poses) {
          truth.set(server.frame, (poses = new Map()));
        }
        poses.set(entity.eid, { x: position.x, y: position.y, angle: rotation.angle });
      });
    sim.onTick((tick) => {
      if (scenario.scene === "resume" && tick === 120) {
        dr.set(LinearVelocity, { x: 1 });
      }
      if (scenario.scene === "corrections" && tick > 0 && tick % 90 === 0) {
        const position = dr.get(PhysicsPosition)!;
        dr.set(PhysicsPosition, { x: position.x + 0.2, y: position.y });
      }
    });
    const client = sim.addClient({
      interpolators: phaserInterpolators(),
      serverTickIntervalMs: 1000 / 30,
    });
    client.world.module(ClientDR);
    const baselines: Array<{ at: number; frame: number; rendered: number; rest: boolean }> = [];
    client.world.component(Motion).on("set", (_entity, motion) => {
      baselines.push({
        at: sim.clock.now,
        frame: motion.frame,
        rendered: client.world.renderFrame,
        rest: motion.rest,
      });
    });
    const buffer = (client.world as unknown as { _diffBuffer: DiffBuffer })._diffBuffer;
    const observer = observeBuffer(buffer, sim.tickMs, scenario.refill);
    const deliver = client.down.onDeliver;
    client.down.onDeliver = (data) => {
      observer.setNow(sim.clock.now);
      deliver?.(data);
    };
    let packet = 0;
    client.down.drop = () => {
      packet++;
      if (sim.clock.now < warmup) {
        return false;
      }
      return scenario.link === "isolated"
        ? packet % 47 === 0
        : scenario.link === "burst" &&
            sim.clock.now % 5_000 >= 3_000 &&
            sim.clock.now % 5_000 < 3_300;
    };
    const samples: Array<{
      at: number;
      frame: number;
      delay: number;
      dr: number | null;
      streamed: number | null;
    }> = [];
    const progress = client.world.progress.bind(client.world);
    let lastRender = 0;
    client.world.progress = (now, delta) => {
      if (scenario.pause > 0 && now >= 10_000 && now < 10_000 + scenario.pause) {
        return;
      }
      progress(now, lastRender > 0 ? now - lastRender : delta);
      lastRender = now;
      if (now < warmup) {
        return;
      }
      const frame = client.world.renderFrame;
      const error = (eid: number): number | null => {
        const from = truth.get(Math.floor(frame))?.get(eid);
        const alpha = frame - Math.floor(frame);
        const to = alpha === 0 ? from : truth.get(Math.floor(frame) + 1)?.get(eid);
        const actual = client.world.entities.get(eid)?.get(Position);
        if (!from || !to || !actual) {
          return null;
        }
        return Math.hypot(
          actual.x - (from.x + (to.x - from.x) * alpha),
          actual.y - (from.y + (to.y - from.y) * alpha)
        );
      };
      samples.push({
        at: now,
        frame,
        delay: server.frame - frame,
        dr: error(dr.eid),
        streamed: streamed ? error(streamed.eid) : null,
      });
    };
    sim.run(warmup);
    const packetsBefore = client.stats.framesSent;
    const bytesBefore = client.stats.bytesSent;
    sim.run(duration - warmup);
    const rates: number[] = [];
    const holds: Array<{ at: number; ticks: number; samples: number; atCap: boolean }> = [];
    let active: (typeof holds)[number] | undefined;
    const jumps: Array<{ at: number; rate: number; frames: number }> = [];
    for (let i = 1; i < samples.length; i++) {
      const previous = samples[i - 1];
      const sample = samples[i];
      const ticks = (sample.at - previous.at) / sim.tickMs;
      const advance = sample.frame - previous.frame;
      const rate = advance / ticks;
      rates.push(rate);
      if (rate > 1.5 + 1e-8) {
        jumps.push({ at: sample.at, rate, frames: advance });
      }
      if (Math.abs(advance) < 1e-8) {
        const trace = observer.pulls.find((pull) => pull.at === sample.at)!;
        if (!active) {
          active = { at: sample.at, ticks: 0, samples: 0, atCap: true };
          holds.push(active);
        }
        active.ticks += ticks;
        active.samples++;
        active.atCap &&= Math.abs(sample.frame - trace.version) < 1e-8;
      } else {
        active = undefined;
      }
    }
    const firstHold = holds.find((hold) => hold.at > 4_000);
    const index = firstHold ? observer.pulls.findIndex((pull) => pull.at >= firstHold.at) : -1;
    const compaction = observer.compactions.find((event) => event.at >= warmup);
    const compactIndex = compaction
      ? observer.pulls.findIndex((pull) => pull.at >= compaction.at)
      : -1;
    const seconds = (duration - warmup) / 1000;
    return {
      scenario,
      samples: samples.length,
      holds,
      rate: {
        mean: mean(rates),
        worstDeviation: Math.max(...rates.map((rate) => Math.abs(rate - 1))),
        jumps,
      },
      delay: {
        ...summary(samples.map((sample) => sample.delay)),
        drift: samples[samples.length - 1].delay - samples[0].delay,
      },
      pose: {
        dr: summary(samples.flatMap((sample) => (sample.dr === null ? [] : [sample.dr]))),
        streamed: summary(
          samples.flatMap((sample) => (sample.streamed === null ? [] : [sample.streamed]))
        ),
      },
      packetsPerSecond: (client.stats.framesSent - packetsBefore) / seconds,
      bytesPerSecond: (client.stats.bytesSent - bytesBefore) / seconds,
      events: {
        compactions: observer.compactions.filter((event) => event.at >= warmup),
        baselines,
        dryPulls: observer.pulls.filter((pull) => pull.at >= warmup && pull.dry).length,
        tServResets: observer.resets.filter((event) => event.at >= warmup).length,
      },
      trace: index < 0 ? [] : observer.pulls.slice(Math.max(0, index - 4), index + 5),
      compactionTrace:
        compactIndex < 0
          ? []
          : observer.pulls.slice(Math.max(0, compactIndex - 4), compactIndex + 5),
      errors: client.stats.errors,
      disconnects: client.stats.disconnects,
    };
  } finally {
    sim.dispose();
    sim.server.dispose();
  }
}

export function matrix(): Scenario[] {
  const scenarios: Scenario[] = [];
  for (const k of [1, 2, 3, 4, 8]) {
    const base: Scenario = {
      k,
      link: "clean",
      rtt: 100,
      hz: 60,
      pause: 0,
      gate: true,
      scene: "drift",
    };
    for (const redundancy of [undefined, 2]) {
      for (const scene of ["drift", "corrections", "mixed", "resume", "idle"] as const) {
        for (const gate of [true, false]) {
          scenarios.push({ ...base, scene, gate, redundancy });
        }
      }
      for (const link of ["jitter", "isolated", "burst"] as const) {
        for (const scene of ["drift", "corrections", "mixed", "resume"] as const) {
          scenarios.push({ ...base, link, scene, redundancy });
        }
      }
      for (const rtt of [20, 200]) {
        scenarios.push({ ...base, rtt, redundancy });
      }
      scenarios.push({ ...base, hz: 59, redundancy });
      for (const pause of [100, 500, 2000]) {
        for (const scene of ["drift", "mixed", "resume"] as const) {
          scenarios.push({ ...base, pause, scene, redundancy });
        }
      }
    }
    scenarios.push({ ...base, refill: "two-slots" });
    scenarios.push({ ...base, tickHz: 29.8, duration: 60_000 });
    if (k === 1) {
      for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
        for (const hz of [60, 59]) {
          scenarios.push({ ...base, rtt: 40, hz, scene: "resume", seed, duration: 6_000 });
        }
      }
      scenarios.push({
        ...base,
        rtt: 40,
        hz: 59,
        scene: "resume",
        seed: 4,
        duration: 6_000,
        refill: "two-slots",
      });
    }
  }
  return scenarios;
}

/** Observe private buffer state exclusively from tests; no production counters or clock edits. */
function observeBuffer(buffer: DiffBuffer, tickMs: number, refill?: Scenario["refill"]) {
  const state = buffer as unknown as BufferInternals;
  const pulls: PullTrace[] = [];
  const compactions: Array<{ at: number; from: number; to: number; deadline: number }> = [];
  let now = 0;
  const resets: Array<{ at: number; cause: "dry" | "initialize" | "reset" }> = [];
  const reset = buffer.reset.bind(buffer);
  buffer.reset = () => {
    resets.push({ at: now, cause: "reset" });
    reset();
  };
  const accept = state._accept.bind(buffer);
  state._accept = (diff) => {
    const base = state._base;
    const overflow = base !== undefined && diff.to - base >= buffer.bucket.length;
    accept(diff);
    if (overflow && state._base !== base) {
      compactions.push({ at: now, from: base, to: state._base!, deadline: state._tServ });
    }
  };
  const pull = buffer.pull.bind(buffer);
  buffer.pull = (at) => {
    now = at;
    const dry = buffer.bucket[0] === undefined;
    const trace: PullTrace = {
      at,
      frame: buffer.renderFrame,
      version: buffer.version,
      base: state._base,
      deadline: state._tServ,
      slots: buffer.bucket.map((diff) => diff?.to ?? null),
      after: 0,
      applied: 0,
      dry,
    };
    if (dry || state._tServ === -1) {
      resets.push({ at, cause: dry ? "dry" : "initialize" });
    }
    const result = pull(at);
    if (dry && refill === "two-slots") {
      state._tServ = at + tickMs * (buffer.bucket.length - 1);
    }
    trace.after = buffer.renderFrame;
    trace.applied = result.to;
    pulls.push(trace);
    return result;
  };
  return { pulls, compactions, resets, setNow: (at: number) => (now = at) };
}

function summary(values: number[]) {
  const ordered = [...values].sort((a, b) => a - b);
  return {
    count: values.length,
    mean: mean(values),
    min: ordered[0] ?? null,
    p95: ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)] ?? null,
    max: ordered[ordered.length - 1] ?? null,
  };
}

function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}
