/** Price deferred `add(R, target)`: enqueue alone, and enqueue plus drain, per edge. */
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

const modes = ["exclusive", "many"] as const;
const selected = process.argv[2];
if (
  process.argv.length > 3 ||
  (selected !== undefined && !modes.some((mode) => mode === selected))
) {
  throw new Error("usage: pending-edges.ts [exclusive|many]");
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

for (const mode of modes) {
  if (selected !== undefined && mode !== selected) {
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
