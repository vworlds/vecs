/**
 * Price deferred `add(R, target)` (enqueue alone, and enqueue plus drain, per
 * edge) and one pending-aware `hasTarget` read over 0, 100 and 1,000 queued
 * commands.
 */
import { performance } from "node:perf_hooks";
import { Exclusive, Relationship, World } from "@vworlds/vecs";

class InCell extends Relationship {}
class Tag extends Relationship {}

const sources = Number(process.env.BENCH_SOURCES ?? 1_000);
const rounds = Number(process.env.BENCH_ROUNDS ?? 3_000);
const warmup = Number(process.env.BENCH_WARMUP_ROUNDS ?? 750);
if (![sources, rounds, warmup].every((n) => Number.isSafeInteger(n) && n > 0)) {
  throw new Error("BENCH_SOURCES, BENCH_ROUNDS and BENCH_WARMUP_ROUNDS must be positive integers");
}
const CELLS = 16;

const modes = ["exclusive", "many", "read"] as const;
const READ_QUEUES = [0, 100, 1_000];
const READS = 1_000;
const selected = process.argv[2];
if (
  process.argv.length > 3 ||
  (selected !== undefined && !modes.some((mode) => mode === selected))
) {
  throw new Error("usage: pending-edges.ts [exclusive|many|read]");
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

for (const mode of modes) {
  if (selected !== undefined && mode !== selected) {
    continue;
  }
  if (mode === "read") {
    measureReads();
    continue;
  }
  const world = new World();
  world.component(InCell).add(Exclusive);
  world.component(Tag);
  const Rel = mode === "exclusive" ? InCell : Tag;
  const entities = Array.from({ length: sources }, () => world.entity());
  const cells = Array.from({ length: CELLS }, () => world.entity());
  const enqueue: number[] = [];
  const total: number[] = [];

  for (let round = 0; round < warmup + rounds; round++) {
    const start = performance.now();
    world.beginDefer();
    for (let i = 0; i < sources; i++) {
      entities[i].add(Rel, cells[(i + round) % CELLS]);
    }
    const queued = performance.now();
    world.endDefer();
    const drained = performance.now();
    if (round >= warmup) {
      enqueue.push(((queued - start) * 1e6) / sources);
      total.push(((drained - start) * 1e6) / sources);
    }
    const expected = cells[(sources - 1 + round) % CELLS];
    if (!entities[sources - 1].hasTarget(Rel, expected)) {
      throw new Error(`Edge not applied in ${mode} round ${round}`);
    }
    if (mode === "many") {
      // Clear outside the timed window so every round adds one fresh edge per source.
      world.defer(() => entities.forEach((e) => e.remove(Tag)));
      if (entities[0].has(Tag)) {
        throw new Error(`Edge not removed in ${mode} round ${round}`);
      }
    }
  }
  console.log(
    `PENDING_EDGES_RESULT ${JSON.stringify({
      mode,
      sources,
      rounds,
      warmup,
      enqueueNsPerEdge: median(enqueue),
      enqueueDrainNsPerEdge: median(total),
    })}`
  );
  world.dispose();
}

/**
 * One `hasTarget(R, t, { pending: true })` and one `targets(R, { pending: true })`
 * with the reader's own edge queued first and then `queued` commands from other
 * entities: the worst case for the backward `hasTarget` scan.
 */
function measureReads(): void {
  const world = new World();
  world.component(Tag);
  const target = world.entity();
  const reader = world.entity();
  const others = Array.from({ length: Math.max(...READ_QUEUES) }, () => world.entity());
  for (const queued of READ_QUEUES) {
    const hasTargetNs: number[] = [];
    const targetsNs: number[] = [];
    let hits = 0;
    for (let round = 0; round < warmup + rounds; round++) {
      world.beginDefer();
      // Queue the reader's edge first so both reads walk every later command.
      reader.add(Tag, target);
      for (let i = 0; i < queued; i++) {
        others[i].add(Tag, target);
      }
      const start = performance.now();
      for (let i = 0; i < READS; i++) {
        if (reader.hasTarget(Tag, target, { pending: true })) {
          hits++;
        }
      }
      const middle = performance.now();
      for (let i = 0; i < READS; i++) {
        hits += reader.targets(Tag, { pending: true }).length;
      }
      const end = performance.now();
      world.endDefer();
      world.defer(() => {
        reader.remove(Tag);
        for (let i = 0; i < queued; i++) {
          others[i].remove(Tag);
        }
      });
      if (round >= warmup) {
        hasTargetNs.push(((middle - start) * 1e6) / READS);
        targetsNs.push(((end - middle) * 1e6) / READS);
      }
    }
    if (hits !== 2 * (warmup + rounds) * READS || reader.has(Tag)) {
      throw new Error(`Pending read missed the queued edge with ${queued} queued commands`);
    }
    console.log(
      `PENDING_EDGES_RESULT ${JSON.stringify({
        mode: "read",
        queued,
        rounds,
        warmup,
        hasTargetNsPerCall: median(hasTargetNs),
        targetsNsPerCall: median(targetsNs),
      })}`
    );
  }
  world.dispose();
}
