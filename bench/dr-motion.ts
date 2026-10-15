/** Motion-sync and total-tick timings for sparse and dense moving populations.
 * Run against alternating built roots with BENCH_VECS_ROOT; see bench/README.md. */
import { performance } from "node:perf_hooks";
import { phaserMotionComponents, phaserNetworkComponents } from "@vworlds/vecs-phaser";
import { DeadReckoned, DeadReckonedModule } from "@vworlds/vecs-phaser-server";
import {
  AngularVelocity,
  Body,
  BodyType,
  Circle,
  LinearVelocity,
  PhysicsModule,
  Position,
  preloadPhysics,
  Sleep,
} from "@vworlds/vecs-physics";
import { ServerWorld } from "@vworlds/vecs-server";

const ticks = Number(process.env.BENCH_TICKS ?? 1200);
const warmup = Number(process.env.BENCH_WARMUP_TICKS ?? 300);
const dt = 1000 / 30;

function measure(asleep: number, moving: number): object {
  const world = new ServerWorld({
    networkComponents: [...phaserNetworkComponents, ...phaserMotionComponents],
    keepAliveFrames: 1,
  });
  world.module(PhysicsModule, { gravity: { x: 0, y: 0 }, fixedTimeStep: 1 / 30 });
  world.module(DeadReckonedModule);
  try {
    for (let i = 0; i < asleep + moving; i++) {
      // Separate lanes prevent contacts, even over a long measurement horizon.
      const active = i >= asleep;
      const body = world
        .entity()
        .set(Body, { type: BodyType.Dynamic })
        .set(Position, { x: 0, y: i * 4 })
        .set(Sleep, { awake: active, enabled: !active })
        .set(LinearVelocity, { x: active ? 1 : 0, y: 0 })
        .set(AngularVelocity, { value: active ? 0.3 : 0 })
        .add(DeadReckoned);
      world.entity().childOf(body).set(Circle, { radius: 0.5 });
    }
    for (let i = 0; i < warmup; i++) {
      world.progress(i * dt, dt);
    }
    world.stats.enableSystems();
    world.stats.resetSystems();
    const start = performance.now();
    for (let i = warmup; i < warmup + ticks; i++) {
      world.progress(i * dt, dt);
    }
    const totalMs = performance.now() - start;
    const systems = world.stats.systems();
    const sync = systems.find(({ system }) => system.name === "phaser.sync.motion")!;
    const eligibility = systems
      .filter(({ system }) => system.name?.startsWith("phaser.motion."))
      .reduce((sum, timing) => sum + timing.totalMs, 0);
    const poseOut = systems.find(({ system }) => system.name === "PhysicsPoseSyncOut")!;
    return {
      asleep,
      moving,
      ticks,
      syncUs: (sync.totalMs * 1000) / ticks,
      eligibilityUs: (eligibility * 1000) / ticks,
      motionUs: ((sync.totalMs + eligibility) * 1000) / ticks,
      poseOutUs: (poseOut.totalMs * 1000) / ticks,
      tickUs: (totalMs * 1000) / ticks,
    };
  } finally {
    world.dispose();
  }
}

await preloadPhysics();
console.log(`BENCH_RESULT ${JSON.stringify([measure(2000, 50), measure(100, 1600)])}`);
