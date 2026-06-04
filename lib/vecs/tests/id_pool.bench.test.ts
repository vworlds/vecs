import { describe, expect, it } from "vitest";
import { IdPool } from "../src/util/id_pool.js";

const runBench = process.env.RUN_ID_POOL_BENCH === "1" ? it : it.skip;

const ROUNDS = 5;
const POOL_MIN = 1;

type BenchResult = {
  name: string;
  medianMs: number;
  opsPerSec: number;
  checksum: number;
};

function nowNs(): bigint {
  return process.hrtime.bigint();
}

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function bench(name: string, operations: number, callback: () => number): BenchResult {
  const durations: number[] = [];
  let checksum = 0;

  callback(); // Warm up this exact path before measuring.

  for (let i = 0; i < ROUNDS; i++) {
    const start = nowNs();
    checksum ^= callback();
    const elapsedMs = Number(nowNs() - start) / 1_000_000;
    durations.push(elapsedMs);
  }

  const medianMs = median(durations);
  return {
    name,
    medianMs,
    opsPerSec: Math.round((operations / medianMs) * 1000),
    checksum,
  };
}

function makePool(): IdPool {
  return new IdPool("bench", POOL_MIN, undefined, 0);
}

// Deterministic PRNG so all variants share the same workload.
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("IdPool benchmark", () => {
  runBench(
    "measures alloc/free hot paths",
    () => {
      const results: BenchResult[] = [];

      // Scenario 1: sequential allocation from empty pool. Pure fresh-id path.
      // Baseline is O(N^2) here because alloc rescans from min each call.
      {
        const N = 5_000;
        results.push(
          bench("seq-alloc-5k", N, () => {
            const pool = makePool();
            let sum = 0;
            for (let i = 0; i < N; i++) {
              sum += pool.alloc();
            }
            return sum;
          })
        );
      }

      // Scenario 2: alloc N, free all, alloc N again. Tests full reuse path.
      // Baseline pays N^2 in both alloc phases.
      {
        const N = 5_000;
        results.push(
          bench("alloc-freeAll-allocAgain-5k", N, () => {
            const pool = makePool();
            const ids: number[] = [];
            for (let i = 0; i < N; i++) {
              ids.push(pool.alloc());
            }
            for (let i = 0; i < N; i++) {
              pool.free(ids[i]);
            }
            let sum = 0;
            for (let i = 0; i < N; i++) {
              sum += pool.alloc();
            }
            return sum;
          })
        );
      }

      // Scenario 3: alloc N, free the last 10%, alloc 10% more.
      // Current impl scans through ~90% to find a hole - this is worst case.
      {
        const N = 10_000;
        const HOLE = 1_000;
        results.push(
          bench("alloc-freeHighTail-alloc-10k", HOLE, () => {
            const pool = makePool();
            const ids: number[] = [];
            for (let i = 0; i < N; i++) {
              ids.push(pool.alloc());
            }
            for (let i = N - HOLE; i < N; i++) {
              pool.free(ids[i]);
            }
            let sum = 0;
            for (let i = 0; i < HOLE; i++) {
              sum += pool.alloc();
            }
            return sum;
          })
        );
      }

      // Scenario 4: alloc N, free random 50%, alloc 50% more. Many holes scattered.
      {
        const N = 5_000;
        results.push(
          bench("alloc-freeRandomHalf-alloc-5k", N, () => {
            const pool = makePool();
            const rng = makeRng(0xc0ffee);
            const ids: number[] = [];
            for (let i = 0; i < N; i++) {
              ids.push(pool.alloc());
            }
            // Shuffle and free half.
            for (let i = ids.length - 1; i > 0; i--) {
              const j = Math.floor(rng() * (i + 1));
              const t = ids[i];
              ids[i] = ids[j];
              ids[j] = t;
            }
            const half = N >> 1;
            for (let i = 0; i < half; i++) {
              pool.free(ids[i]);
            }
            let sum = 0;
            for (let i = 0; i < half; i++) {
              sum += pool.alloc();
            }
            return sum;
          })
        );
      }

      // Scenario 5: heavy fragmentation - alloc N, free every other ID, alloc N/2.
      // Forces alloc() to find scattered low holes.
      {
        const N = 5_000;
        results.push(
          bench("alloc-freeEveryOther-alloc-5k", N, () => {
            const pool = makePool();
            const ids: number[] = [];
            for (let i = 0; i < N; i++) {
              ids.push(pool.alloc());
            }
            for (let i = 0; i < N; i += 2) {
              pool.free(ids[i]);
            }
            let sum = 0;
            for (let i = 0; i < N / 2; i++) {
              sum += pool.alloc();
            }
            return sum;
          })
        );
      }

      // Scenario 6: realistic ECS churn. Steady-state alloc/free mix.
      {
        const STEADY = 2_000;
        const CHURN = 10_000;
        results.push(
          bench("steady-churn-2k-10kops", CHURN, () => {
            const pool = makePool();
            const live: number[] = [];
            for (let i = 0; i < STEADY; i++) {
              live.push(pool.alloc());
            }
            const rng = makeRng(0xdeadbeef);
            let sum = 0;
            for (let i = 0; i < CHURN; i++) {
              const idx = Math.floor(rng() * live.length);
              pool.free(live[idx]);
              const fresh = pool.alloc();
              live[idx] = fresh;
              sum += fresh;
            }
            return sum;
          })
        );
      }

      // Scenario 7: alloc into a sparsely populated high-ID pool via reserve.
      // Tests how alloc behaves when many high IDs are reserved with gaps.
      {
        const N = 5_000;
        const ALLOC_OPS = 500;
        results.push(
          bench("reserve-sparse-then-alloc-5k", ALLOC_OPS, () => {
            const pool = makePool();
            const rng = makeRng(0xabcd1234);
            const taken = new Set<number>();
            while (taken.size < N) {
              taken.add(1 + Math.floor(rng() * (N * 4)));
            }
            for (const id of taken) {
              pool.reserve(id);
            }
            let sum = 0;
            for (let i = 0; i < ALLOC_OPS; i++) {
              sum += pool.alloc();
            }
            return sum;
          })
        );
      }

      console.info("\nIdPool benchmark results");
      for (const result of results) {
        console.info(
          `${result.name}: ${result.medianMs.toFixed(2)} ms, ${result.opsPerSec.toLocaleString()} ops/sec, checksum ${result.checksum}`
        );
      }

      expect(results.every((result) => result.checksum !== 0)).toBe(true);
    },
    600_000
  );
});
