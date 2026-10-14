import { performance } from "node:perf_hooks";

import { ChildOf, System, World } from "@vworlds/vecs";
import {
  AngularVelocity,
  Body,
  BodyType,
  Circle,
  LinearVelocity,
  PhysicsModule,
  Position,
  preloadPhysics,
  Rotation,
} from "@vworlds/vecs-physics";

const warmup = Number(process.env.BENCH_WARMUP_TICKS ?? 300);
const steps = Number(process.env.BENCH_TICKS ?? 1000);
const dt = 1 / 30;

await preloadPhysics();
for (const count of [500, 2000]) {
  run(count);
}

function run(count: number): void {
  const world = new World();
  world.module(PhysicsModule, { gravity: { x: 0, y: 0 }, fixedTimeStep: dt, enableSleep: false });
  const bodies = [];
  for (let i = 0; i < count; i++) {
    const body = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: i * 10, y: (i % 7) * 10 })
      .set(Rotation, { angle: (i % 11) * 0.1 })
      .set(LinearVelocity, { x: 0.25 + (i % 13) * 0.01, y: -0.125 })
      .set(AngularVelocity, { value: (i % 5) * 0.01 });
    world.entity().add(ChildOf, body).set(Circle, { radius: 0.25 });
    bodies.push(body);
  }
  world.progress(0, dt);
  const poseOut = world.queries.find((query) => query.name === "PhysicsPoseSyncOut");
  if (!(poseOut instanceof System)) {
    throw new Error("PhysicsPoseSyncOut system missing");
  }
  // Time the built system itself, excluding the subsequent deferred-command flush.
  // Install once, outside the hot loop; no per-step instrumentation allocation.
  const originalRun = poseOut._run.bind(poseOut);
  let poseMs = 0;
  poseOut._run = (now, delta) => {
    const start = performance.now();
    const ran = originalRun(now, delta);
    poseMs += performance.now() - start;
    return ran;
  };
  for (let i = 0; i < warmup; i++) {
    world.progress((i + 1) * dt, dt);
  }
  poseMs = 0;
  const start = performance.now();
  for (let i = 0; i < steps; i++) {
    world.progress((warmup + i + 1) * dt, dt);
  }
  const tickMs = performance.now() - start;
  // Hash all eight bytes of each JS number, preserving bit-level output differences.
  const bytes = new DataView(new ArrayBuffer(8));
  let hash = 2166136261;
  for (const body of bodies) {
    const p = body.get(Position)!;
    const r = body.get(Rotation)!;
    const v = body.get(LinearVelocity)!;
    const w = body.get(AngularVelocity)!;
    for (const value of [p.x, p.y, r.angle, v.x, v.y, w.value]) {
      bytes.setFloat64(0, value, true);
      for (let i = 0; i < 8; i++) {
        hash = Math.imul(hash ^ bytes.getUint8(i), 16777619) >>> 0;
      }
    }
  }
  console.log(
    `POSE_OUT_RESULT ${JSON.stringify({
      count,
      warmup,
      steps,
      tickNsPerBodyStep: (tickMs * 1e6) / (count * steps),
      poseNsPerBodyStep: (poseMs * 1e6) / (count * steps),
      checksum: hash.toString(16).padStart(8, "0"),
    })}`
  );
  world.dispose();
}
