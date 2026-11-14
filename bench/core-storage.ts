/**
 * Core storage benchmark cases for the storage epic: iteration, injected
 * in-place writes, deferred `set`, watcher delivery, component churn and
 * retained heap, at 10,000 and 100,000 entities with two small components.
 *
 * Run after building:
 *
 *   node --import ./bench/register-dist.mjs bench/core-storage.ts
 *
 * Every case and size prints one `CORE_STORAGE_RESULT` line: the median, min
 * and max nanoseconds per entity per tick over the rounds (bytes per entity for
 * `heap`), plus a checksum of component field sums and callback counts that only
 * changes when observable behavior changes. Tick counts are fixed per case and
 * size so builds compare equal work; the warm-up and the timed loop share one
 * small function so a case is not bimodal between JIT tiers. `BENCH_TICKS` and
 * `BENCH_WARMUP_TICKS` override the tick counts uniformly and `BENCH_ROUNDS`
 * (5) the round count. Pass a case name to isolate it for `node --cpu-prof`.
 * Set `BENCH_VECS_ROOT` to run the same benchmark against another built
 * checkout, as `bench/compare.ts` does for release checks.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { World, type Entity } from "@vworlds/vecs";

class Pos {
  x = 0;
  y = 0;
}
class Vel {
  x = 1;
  y = 1;
}

const DELTA_MS = 16;
const SIZES = [10_000, 100_000] as const;
const HEAP_SETTLE_TICKS = 3;
/**
 * Fixed `[warmupTicks, ticks]` per case and size. The write-heavy cases carry
 * about six times the headroom of today's core, so a 6x faster storage still
 * measures a ~200 ms region; a full default run takes about two minutes now.
 */
const TICKS: Record<TickCase, Record<(typeof SIZES)[number], [number, number]>> = {
  iterate: { 10_000: [300, 900], 100_000: [50, 150] },
  inject: { 10_000: [400, 1_200], 100_000: [30, 90] },
  set: { 10_000: [200, 600], 100_000: [12, 30] },
  watch: { 10_000: [120, 360], 100_000: [12, 30] },
  churn: { 10_000: [200, 600], 100_000: [12, 36] },
};

type TickCase = "iterate" | "inject" | "set" | "watch" | "churn";
type CaseName = TickCase | "heap";
type ResultLine = {
  case: CaseName;
  entities: number;
  rounds: number;
  median: number;
  min: number;
  max: number;
  checksum: string;
  ticks?: number;
  warmupTicks?: number;
};
type Scene = {
  world: World;
  perTick: ((tick: number) => void) | null;
  reset: () => void;
  checksum: () => string;
};

const CASES: readonly CaseName[] = ["iterate", "inject", "set", "watch", "churn", "heap"];
const benchFile = fileURLToPath(import.meta.url);
const registerDist = resolve(dirname(benchFile), "register-dist.mjs");

if (process.argv[2] === "--heap") {
  runHeapChild(positiveValue(process.argv[3], "heap size"));
} else {
  const only = process.argv[2] as CaseName | undefined;
  assert(
    only === undefined || (CASES as readonly string[]).includes(only),
    `unknown case '${only}'; expected one of ${CASES.join(", ")}`
  );
  const rounds = positiveInteger("BENCH_ROUNDS", 5);
  const ticks = optionalPositiveInteger("BENCH_TICKS");
  const warmupTicks = optionalPositiveInteger("BENCH_WARMUP_TICKS");
  for (const caseName of only === undefined ? CASES : [only]) {
    for (const size of SIZES) {
      const line =
        caseName === "heap"
          ? runHeap(size, rounds)
          : runTickCase(
              caseName,
              size,
              warmupTicks ?? TICKS[caseName][size][0],
              ticks ?? TICKS[caseName][size][1],
              rounds
            );
      console.log(`CORE_STORAGE_RESULT ${JSON.stringify(line)}`);
    }
  }
}

/** Warm up and time `count` ticks from `from` in one small shared loop. */
function timeTicks(scene: Scene, from: number, count: number): number {
  const start = performance.now();
  for (let tick = from; tick < from + count; tick++) {
    if (scene.perTick !== null) {
      scene.perTick(tick);
    }
    scene.world.progress(tick * DELTA_MS, DELTA_MS);
  }
  return performance.now() - start;
}

/** Run one tick case for `rounds` fresh worlds and summarize the round samples. */
function runTickCase(
  caseName: TickCase,
  size: number,
  warmupTicks: number,
  ticks: number,
  rounds: number
): ResultLine {
  const expected = expectedChecksum(caseName, size, warmupTicks, ticks);
  const samples: number[] = [];
  for (let round = 0; round < rounds; round++) {
    const scene = buildScene(caseName, size);
    timeTicks(scene, 0, warmupTicks);
    scene.reset();
    const ms = timeTicks(scene, warmupTicks, ticks);
    const checksum = scene.checksum();
    assert.equal(checksum, expected, `${caseName}/${size} round ${round}`);
    samples.push((ms * 1e6) / (size * ticks));
    scene.world.dispose();
  }
  return {
    case: caseName,
    entities: size,
    rounds,
    ...summary(samples),
    checksum: expected,
    ticks,
    warmupTicks,
  };
}

/** Run the heap case as one fresh `--expose-gc` child process per round. */
function runHeap(size: number, rounds: number): ResultLine {
  const samples: number[] = [];
  let checksum = "";
  for (let round = 0; round < rounds; round++) {
    const child = spawnSync(
      process.execPath,
      ["--expose-gc", "--import", registerDist, benchFile, "--heap", String(size)],
      { encoding: "utf8" }
    );
    if (child.status !== 0) {
      throw new Error(`heap child failed for ${size}:\n${child.stderr}`);
    }
    const lines = child.stdout.trim().split("\n");
    const report = JSON.parse(lines[lines.length - 1] ?? "") as {
      bytesPerEntity: number;
      checksum: string;
    };
    checksum ||= report.checksum;
    assert.equal(report.checksum, checksum, `heap/${size} round ${round}`);
    samples.push(report.bytesPerEntity);
  }
  return { case: "heap", entities: size, rounds, ...summary(samples), checksum };
}

/** Build the watch world, settle it with ticks, and report the retained heap. */
function runHeapChild(size: number): void {
  assert(typeof globalThis.gc === "function", "run the heap child with --expose-gc");
  globalThis.gc();
  const before = process.memoryUsage().heapUsed;
  const scene = buildScene("watch", size);
  timeTicks(scene, 0, HEAP_SETTLE_TICKS);
  globalThis.gc();
  const bytesPerEntity = (process.memoryUsage().heapUsed - before) / size;
  const checksum = scene.checksum();
  assert.equal(checksum, expectedChecksum("watch", size, 0, HEAP_SETTLE_TICKS), "heap child");
  console.log(JSON.stringify({ bytesPerEntity, checksum }));
  scene.world.dispose();
}

/** Build a fresh world for one tick case with its per-tick hook and counters. */
function buildScene(caseName: TickCase, size: number): Scene {
  const world = new World();
  world.component(Pos);
  world.component(Vel);
  const all: Entity[] = [];
  for (let i = 0; i < size; i++) {
    all.push(world.entity().add(Pos).add(Vel));
  }
  const noop = (): void => {};
  switch (caseName) {
    case "iterate": {
      let visits = 0;
      world
        .system("iterate")
        .with(Pos, Vel)
        .each([], () => {
          visits++;
        });
      return {
        world,
        perTick: null,
        reset: () => {
          visits = 0;
        },
        checksum: () => `visits:${visits}`,
      };
    }
    case "inject": {
      world
        .system("inject")
        .with(Pos, Vel)
        .each([Pos, Vel], (_entity, [pos, vel]) => {
          pos.x += vel.x;
          pos.y += vel.y;
        });
      return {
        world,
        perTick: null,
        reset: noop,
        checksum: () => `sum:${sumPos(all)}`,
      };
    }
    case "set": {
      world
        .system("set")
        .with(Pos, Vel)
        .each([Pos, Vel], (entity, [pos, vel]) => {
          entity.set(Pos, { x: pos.x + vel.x });
        });
      return {
        world,
        perTick: null,
        reset: noop,
        checksum: () => `sum:${sumPos(all)}`,
      };
    }
    case "watch": {
      let watched = 0;
      world
        .system("watch.write")
        .with(Pos, Vel)
        .each([Pos, Vel], (entity, [pos, vel]) => {
          entity.set(Pos, { x: pos.x + vel.x });
        });
      world
        .system("watch.read")
        .with(Pos)
        .update({ watch: Pos }, (_entity, pos) => {
          watched += pos.x;
        });
      return {
        world,
        perTick: null,
        reset: () => {
          watched = 0;
        },
        checksum: () => `sum:${sumPos(all)};watched:${watched}`,
      };
    }
    case "churn": {
      const window = size / 10;
      let visits = 0;
      let previous: Entity[] | null = null;
      // Precompute the ten membership windows outside the timed loop, so the
      // timed region only contains the remove/add calls and the system.
      const windows: Entity[][] = [];
      for (let block = 0; block < 10; block++) {
        const current: Entity[] = [];
        for (let j = 0; j < window; j++) {
          current.push(all[(block * window + j) % size]!);
        }
        windows.push(current);
      }
      world
        .system("churn")
        .with(Pos, Vel)
        .each([Pos, Vel], (_entity, [pos, vel]) => {
          visits++;
          pos.x += vel.x;
          pos.y += vel.y;
        });
      return {
        world,
        perTick: (tick) => {
          // Rotating window: `window` entities lose Vel this tick, the previous
          // window gains it back, so exactly one tenth lacks Vel at any time.
          const current = windows[tick % 10]!;
          for (const entity of current) {
            entity.remove(Vel);
          }
          if (previous !== null) {
            for (const entity of previous) {
              entity.add(Vel);
            }
          }
          previous = current;
        },
        reset: () => {
          visits = 0;
        },
        checksum: () => `sum:${sumPos(all)},visits:${visits},vel:${velCount(all)}`,
      };
    }
  }
}

/** The exact fingerprint a scene must show after `warmupTicks + ticks` ticks. */
function expectedChecksum(
  caseName: TickCase,
  size: number,
  warmupTicks: number,
  ticks: number
): string {
  const total = warmupTicks + ticks;
  switch (caseName) {
    case "iterate":
      return `visits:${size * ticks}`;
    case "inject":
      return `sum:${2 * size * total}`;
    case "set":
      return `sum:${size * total}`;
    case "watch": {
      // `watched` counts only the measured ticks, so the warm-up deliveries
      // (sums 1..warmupTicks) are excluded from the triangular number.
      const measured = (total * (total + 1) - warmupTicks * (warmupTicks + 1)) / 2;
      return `sum:${size * total};watched:${size * measured}`;
    }
    case "churn": {
      const members = size - size / 10;
      return `sum:${2 * total * members},visits:${ticks * members},vel:${members}`;
    }
  }
}

function sumPos(all: Entity[]): number {
  let sum = 0;
  for (const entity of all) {
    const pos = entity.get(Pos)!;
    sum += pos.x + pos.y;
  }
  return sum;
}

function velCount(all: Entity[]): number {
  let count = 0;
  for (const entity of all) {
    if (entity.has(Vel)) {
      count++;
    }
  }
  return count;
}

function summary(samples: number[]): { median: number; min: number; max: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return {
    median: sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
  };
}

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  assert(Number.isSafeInteger(value) && value > 0, `${name} must be a positive integer`);
  return value;
}

function optionalPositiveInteger(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  assert(Number.isSafeInteger(value) && value > 0, `${name} must be a positive integer when set`);
  return value;
}

function positiveValue(raw: string | undefined, name: string): number {
  const value = Number(raw);
  assert(Number.isSafeInteger(value) && value > 0, `${name} must be a positive integer`);
  return value;
}
