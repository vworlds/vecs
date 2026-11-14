/**
 * Core storage benchmark cases for the storage epic: iteration, injected
 * in-place writes, deferred `set`, watcher delivery, component churn and
 * retained heap, at 10,000 and 100,000 entities with two small components.
 * Composite rows add 16 distinct populated queries to the churn scene and
 * measure its enter/exit cost and retained heap separately.
 * The sparse-term heap row measures 200 ten-member queries in a 100k world.
 *
 * Run after building:
 *
 *   node --import ./bench/register-dist.mjs bench/core-storage.ts
 *
 * Every case and size prints one `CORE_STORAGE_RESULT` line: the median, min
 * and max nanoseconds per entity per tick over the rounds (bytes per entity for
 * world heap rows, bytes per term for `sparse-terms-heap`), plus a checksum that only
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
const COMPOSITE_TERMS = 16;
const SPARSE_TERMS = 200;
const SPARSE_MEMBERS = 10;
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
  composite: { 10_000: [20, 60], 100_000: [4, 12] },
  point: { 10_000: [400, 1200], 100_000: [50, 150] },
  "singleton-get": { 10_000: [400, 1200], 100_000: [50, 150] },
  "sparse-inject": { 10_000: [400, 1200], 100_000: [100, 300] },
};

type TickCase =
  | "iterate"
  | "inject"
  | "set"
  | "watch"
  | "churn"
  | "composite"
  | "point"
  | "singleton-get"
  | "sparse-inject";
type HeapCase = "heap" | "composite-heap" | "sparse-terms-heap" | "mixed-heap";
type CaseName = TickCase | HeapCase;
type ResultLine = {
  case: CaseName;
  entities: number;
  rounds: number;
  median: number;
  min: number;
  max: number;
  checksum: string;
  terms?: number;
  ticks?: number;
  warmupTicks?: number;
};
type Scene = {
  world: World;
  perTick: ((tick: number) => void) | null;
  reset: () => void;
  checksum: () => string;
};

const CASES: readonly CaseName[] = [
  "iterate",
  "inject",
  "set",
  "watch",
  "churn",
  "heap",
  "composite",
  "composite-heap",
  "sparse-terms-heap",
  "point",
  "singleton-get",
  "sparse-inject",
  "mixed-heap",
];
const benchFile = fileURLToPath(import.meta.url);
const registerDist = resolve(dirname(benchFile), "register-dist.mjs");

if (process.argv[2] === "--heap") {
  const heapCase = process.argv[4] as HeapCase;
  assert(
    ["heap", "composite-heap", "sparse-terms-heap", "mixed-heap"].includes(heapCase),
    "unknown heap case"
  );
  runHeapChild(positiveValue(process.argv[3], "heap size"), heapCase);
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
    for (const size of caseName === "sparse-terms-heap" || caseName === "mixed-heap"
      ? ([100_000] as const)
      : SIZES) {
      const line =
        caseName === "heap" ||
        caseName === "composite-heap" ||
        caseName === "sparse-terms-heap" ||
        caseName === "mixed-heap"
          ? runHeap(size, rounds, caseName)
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
function runHeap(size: number, rounds: number, caseName: HeapCase): ResultLine {
  const samples: number[] = [];
  let checksum = "";
  for (let round = 0; round < rounds; round++) {
    const child = spawnSync(
      process.execPath,
      ["--expose-gc", "--import", registerDist, benchFile, "--heap", String(size), caseName],
      { encoding: "utf8" }
    );
    if (child.status !== 0) {
      throw new Error(`heap child failed for ${size}:\n${child.stderr}`);
    }
    const lines = child.stdout.trim().split("\n");
    const report = JSON.parse(lines[lines.length - 1] ?? "") as {
      bytesPerUnit: number;
      checksum: string;
    };
    checksum ||= report.checksum;
    assert.equal(report.checksum, checksum, `heap/${size} round ${round}`);
    samples.push(report.bytesPerUnit);
  }
  return {
    case: caseName,
    entities: size,
    rounds,
    ...summary(samples),
    checksum,
    ...(caseName === "sparse-terms-heap" ? { terms: SPARSE_TERMS } : {}),
  };
}

/** Build a watch or composite world, settle it, and report retained heap. */
function runHeapChild(size: number, heapCase: HeapCase): void {
  assert(typeof globalThis.gc === "function", "run the heap child with --expose-gc");
  if (heapCase === "mixed-heap") {
    runMixedHeapChild(size);
    return;
  }
  if (heapCase === "sparse-terms-heap") {
    runSparseTermHeapChild(size);
    return;
  }
  globalThis.gc();
  const before = process.memoryUsage().heapUsed;
  const caseName = heapCase === "composite-heap" ? "composite" : "watch";
  const scene = buildScene(caseName, size);
  scene.reset();
  timeTicks(scene, 0, HEAP_SETTLE_TICKS);
  globalThis.gc();
  const bytesPerUnit = (process.memoryUsage().heapUsed - before) / size;
  const checksum = scene.checksum();
  assert.equal(checksum, expectedChecksum(caseName, size, 0, HEAP_SETTLE_TICKS), "heap child");
  console.log(JSON.stringify({ bytesPerUnit, checksum }));
  scene.world.dispose();
}

/** Incremental retained bytes per sparse query, including its leaf and scaffolding. */
function runMixedHeapChild(size: number): void {
  globalThis.gc!();
  const before = process.memoryUsage().heapUsed;
  const world = new World({
    idPools: [
      { name: "component", min: 1, max: 999 },
      { name: "module", min: 1000, max: 9999 },
      { name: "entity", min: 10000 },
    ],
  });
  const keys = Array.from(
    { length: 200 },
    () =>
      class Data {
        value = 1;
      }
  );
  keys.forEach((key) => world.component(key));
  const all = Array.from({ length: size }, () => world.entity());
  let slots = 0;
  keys.forEach((key, k) => {
    const stride = k < 10 ? 1 : k < 40 ? 33 : k < 100 ? 1000 : size;
    for (let i = 0; i < size; i += stride) {
      all[size - 1 - i]!.add(key);
      slots++;
    }
  });
  globalThis.gc!();
  const bytesPerUnit = (process.memoryUsage().heapUsed - before) / size;
  assert.equal(all.length, size);
  const actual = keys.reduce((sum, key) => sum + world.component(key).instanceCount(), 0);
  assert.equal(actual, slots);
  console.log(
    JSON.stringify({
      bytesPerUnit,
      checksum: `entities:${all.length};keys:${keys.length};slots:${actual}`,
    })
  );
  world.dispose();
}

/** Incremental retained bytes per sparse query, including its leaf and scaffolding. */
function runSparseTermHeapChild(size: number): void {
  const world = new World();
  const population = Array.from({ length: size }, () => world.entity());
  const members = population.slice(-SPARSE_MEMBERS);
  globalThis.gc!();
  const before = process.memoryUsage().heapUsed;
  const queries = [];
  for (let i = 0; i < SPARSE_TERMS; i++) {
    class SparseMember {}
    world.component(SparseMember);
    for (const entity of members) {
      entity.add(SparseMember);
    }
    queries.push(world.query(`sparse-${i}`).with(SparseMember).build());
  }
  for (let tick = 0; tick < HEAP_SETTLE_TICKS; tick++) {
    world.progress(tick * DELTA_MS, DELTA_MS);
  }
  globalThis.gc!();
  const bytesPerUnit = (process.memoryUsage().heapUsed - before) / SPARSE_TERMS;
  for (const query of queries) {
    assert.equal(query.count, SPARSE_MEMBERS);
    assert.equal(query.belongs(population[0]!), false);
    assert.deepEqual(new Set(query), new Set(members));
  }
  const checksum = `entities:${population.length};terms:${queries.length};members:${queries.reduce((sum, q) => sum + q.count, 0)}`;
  assert.equal(
    checksum,
    `entities:${size};terms:${SPARSE_TERMS};members:${SPARSE_TERMS * SPARSE_MEMBERS}`
  );
  console.log(JSON.stringify({ bytesPerUnit, checksum }));
  world.dispose();
}

/** Build a fresh world for one tick case with its per-tick hook and counters. */
function buildScene(caseName: TickCase, size: number): Scene {
  const world = new World();
  world.component(Pos);
  world.component(Vel);
  const all: Entity[] = [];
  for (let i = 0; i < size; i++) {
    const entity = world.entity().add(Pos);
    if (
      (caseName !== "sparse-inject" && caseName !== "singleton-get") ||
      (caseName === "sparse-inject" && i % 100 < 3) ||
      (caseName === "singleton-get" && i === size - 1)
    ) {
      entity.add(Vel);
    }
    all.push(entity);
  }
  const noop = (): void => {};
  switch (caseName) {
    case "point":
    case "singleton-get": {
      // Fixed Fisher-Yates permutation: random entities without PRNG work in timing.
      const random = all.slice();
      let seed = 24301;
      for (let i = random.length - 1; i > 0; i--) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const j = seed % (i + 1);
        [random[i], random[j]] = [random[j]!, random[i]!];
      }
      let sum = 0;
      const carrier = all[all.length - 1]!;
      return {
        world,
        perTick:
          caseName === "point"
            ? () => {
                for (const entity of random) {
                  sum += entity.get(Vel)!.x;
                }
              }
            : () => {
                for (let i = 0; i < size; i++) {
                  sum += carrier.get(Vel)!.x;
                }
              },
        reset: () => {
          sum = 0;
        },
        checksum: () => `reads:${sum}`,
      };
    }
    case "sparse-inject": {
      // Distributed carriers near 3% density, not a dense low-id prefix.
      let sum = 0;
      world
        .system("sparse-inject")
        .with(Vel)
        .each([Vel], (_entity, [vel]) => {
          sum += vel.x;
        });
      return {
        world,
        perTick: null,
        reset: () => {
          sum = 0;
        },
        checksum: () => `visits:${sum}`,
      };
    }
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
    case "churn":
    case "composite": {
      const window = size / 10;
      let visits = 0;
      let previous: Entity[] | null = null;
      let enters = 0;
      let exits = 0;
      if (caseName === "composite") {
        for (let i = 0; i < COMPOSITE_TERMS; i++) {
          // Unique absent keys produce distinct, populated composite terms,
          // sharing Pos/Vel leaves but maintaining independent membership.
          class Absent {}
          world.component(Absent);
          world
            .query(`composite-${i}`)
            .with(Pos, Vel)
            .without(Absent)
            .enter(() => {
              enters++;
            })
            .exit(() => {
              exits++;
            })
            .build();
        }
      }
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
          enters = 0;
          exits = 0;
        },
        checksum: () =>
          `sum:${sumPos(all)},visits:${visits},vel:${velCount(all)}` +
          (caseName === "composite" ? `,enters:${enters},exits:${exits}` : ""),
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
    case "point":
    case "singleton-get":
      return `reads:${size * ticks}`;
    case "sparse-inject":
      return `visits:${size * 0.03 * ticks}`;
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
    case "churn":
    case "composite": {
      const members = size - size / 10;
      return (
        `sum:${2 * total * members},visits:${ticks * members},vel:${members}` +
        (caseName === "composite"
          ? `,enters:${COMPOSITE_TERMS * (size / 10) * (ticks - (warmupTicks === 0 ? 1 : 0))},exits:${COMPOSITE_TERMS * (size / 10) * ticks}`
          : "")
      );
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
