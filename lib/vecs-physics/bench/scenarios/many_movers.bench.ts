// Many-movers benchmark — 500 dynamic bodies in motion.
// Also compares the old linear-scan reverse-id resolution with the M7-13
// index-keyed map lookup using the same live b2BodyId values.

import { World, type EID } from "@vworlds/vecs";

import {
  Body,
  BodyType,
  Box,
  PhysicsModule,
  LinearVelocity,
  Material,
  Position,
} from "../../src/index.js";
import { getPhysics } from "../../src/adapter/state.js";

const BODY_COUNT = 500;
const LOOKUP_REPEATS = 100;
const STEPS = 300;
const DT_MS = 1000 / 60;

export function runManyMovers(): {
  totalMs: number;
  msPerStep: number;
  steps: number;
  lookupLinearMs: number;
  lookupIndexMs: number;
  lookupSpeedup: number;
} {
  const world = new World();
  world.module(PhysicsModule, {
    gravity: { x: 0, y: 0 },
    fixedTimeStep: 1 / 60,
    subSteps: 4,
  });
  for (let i = 0; i < BODY_COUNT; i++) {
    const x = (i % 50) - 25;
    const y = Math.floor(i / 50) - 5;
    const speed = i % 2 === 0 ? 1 : -1;
    const body = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x, y })
      .set(LinearVelocity, { x: speed, y: 0.25 });
    world.entity().childOf(body).set(Box, { hx: 0.1, hy: 0.1 }).set(Material, { density: 1 });
  }

  world.progress(DT_MS, DT_MS);

  const t0 = performance.now();
  let now = DT_MS;
  for (let i = 0; i < STEPS; i++) {
    now += DT_MS;
    world.progress(now, DT_MS);
  }
  const totalMs = performance.now() - t0;

  const state = getPhysics(world);
  const bodyIds = [...state.bodyByEntityWasm.values()];
  const entries = [...state.bodyByEntityWasm.entries()].map(([entityId, bodyId]) => ({
    bodyId,
    entityId,
  }));

  const linearStart = performance.now();
  let linearChecksum = 0;
  for (let repeat = 0; repeat < LOOKUP_REPEATS; repeat++) {
    for (const bodyId of bodyIds) {
      linearChecksum += resolveByLinearScan(entries, bodyId) ?? 0;
    }
  }
  const lookupLinearMs = performance.now() - linearStart;

  const indexStart = performance.now();
  let indexChecksum = 0;
  for (let repeat = 0; repeat < LOOKUP_REPEATS; repeat++) {
    for (const bodyId of bodyIds) {
      indexChecksum += state.entityByBodyIndex.get(bodyId.index1) ?? 0;
    }
  }
  const lookupIndexMs = performance.now() - indexStart;

  if (linearChecksum !== indexChecksum) {
    throw new Error("many_movers lookup comparison produced mismatched results");
  }

  return {
    totalMs,
    msPerStep: totalMs / STEPS,
    steps: STEPS,
    lookupLinearMs,
    lookupIndexMs,
    lookupSpeedup: lookupLinearMs / lookupIndexMs,
  };
}

function resolveByLinearScan(
  entries: Array<{
    bodyId: { index1: number; world0: number; generation: number };
    entityId: EID;
  }>,
  bodyId: { index1: number; world0: number; generation: number }
): EID | undefined {
  for (const entry of entries) {
    if (
      entry.bodyId.index1 === bodyId.index1 &&
      entry.bodyId.world0 === bodyId.world0 &&
      entry.bodyId.generation === bodyId.generation
    ) {
      return entry.entityId;
    }
  }
  return undefined;
}
