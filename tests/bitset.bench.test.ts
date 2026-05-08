import { describe, expect, it } from "vitest";
import { Bitset, BitPtr } from "../src/util/bitset.js";

const runBench = process.env.RUN_BITSET_BENCH === "1" ? it : it.skip;

const COMPONENTS = 256;
const OPS = 5_000_000;
const ROUNDS = 7;

type BenchResult = {
  name: string;
  medianMs: number;
  opsPerSec: number;
  checksum: number;
};

function nowNs(): bigint {
  return process.hrtime.bigint();
}

function makeBitset(): Bitset {
  const bitset = new Bitset();
  for (let i = 0; i < COMPONENTS; i++) {
    bitset.add(i);
  }
  return bitset;
}

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function bench(name: string, callback: () => number): BenchResult {
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
    opsPerSec: Math.round((OPS / medianMs) * 1000),
    checksum,
  };
}

describe("Bitset benchmark", () => {
  runBench("measures ECS hot paths", () => {
    const ptrs = Array.from({ length: COMPONENTS }, (_, i) => new BitPtr(i));
    const results = [
      bench("has", () => {
        const bitset = makeBitset();
        let found = 0;
        for (let i = 0; i < OPS; i++) {
          if (bitset.has(i & (COMPONENTS - 1))) {
            found++;
          }
        }
        return found;
      }),
      bench("hasBit", () => {
        const bitset = makeBitset();
        let found = 0;
        for (let i = 0; i < OPS; i++) {
          if (bitset.hasBit(ptrs[i & (COMPONENTS - 1)])) {
            found++;
          }
        }
        return found;
      }),
      bench("add/delete", () => {
        const bitset = makeBitset();
        let found = 0;
        for (let i = 0; i < OPS; i++) {
          const n = i & (COMPONENTS - 1);
          bitset.delete(n);
          bitset.add(n);
          if (bitset.has(n)) {
            found++;
          }
        }
        return found;
      }),
      bench("addBit/deleteBit", () => {
        const bitset = makeBitset();
        let found = 0;
        for (let i = 0; i < OPS; i++) {
          const ptr = ptrs[i & (COMPONENTS - 1)];
          bitset.deleteBit(ptr);
          bitset.addBit(ptr);
          if (bitset.hasBit(ptr)) {
            found++;
          }
        }
        return found;
      }),
      bench("hasBitset", () => {
        const bitset = makeBitset();
        const required = new Bitset();
        required.add(1);
        required.add(33);
        required.add(67);
        required.add(130);
        let found = 0;
        for (let i = 0; i < OPS; i++) {
          if (bitset.hasBitset(required)) {
            found++;
          }
        }
        return found;
      }),
    ];

    console.info("\nBitset benchmark results");
    for (const result of results) {
      console.info(
        `${result.name}: ${result.medianMs.toFixed(2)} ms, ${result.opsPerSec.toLocaleString()} ops/sec, checksum ${result.checksum}`
      );
    }

    expect(results.every((result) => result.checksum === OPS)).toBe(true);
  });
});
