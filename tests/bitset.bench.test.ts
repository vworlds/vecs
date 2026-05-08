import { describe, it, expect } from "vitest";
import { Bitset, BitPtr } from "../src/util/bitset.js";
import { performance } from "perf_hooks";

const ITERATIONS = 1_000_000;

describe("Bitset Benchmarks", () => {
  it("benchmark: add and has", () => {
    const b = new Bitset();
    const start = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
      b.add(i % 1024);
      b.has(i % 1024);
    }
    const end = performance.now();
    process.stdout.write(`[Benchmark] add/has: ${end - start}ms\n`);
  });

  it("benchmark: addBit and hasBit", () => {
    const b = new Bitset();
    const ptrs = Array.from({ length: 1024 }, (_, i) => new BitPtr(i));
    const start = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
      const ptr = ptrs[i % 1024];
      b.addBit(ptr);
      b.hasBit(ptr);
    }
    const end = performance.now();
    process.stdout.write(`[Benchmark] addBit/hasBit: ${end - start}ms\n`);
  });

  it("benchmark: hasBitset", () => {
    const a = new Bitset();
    const b = new Bitset();
    for (let i = 0; i < 1024; i += 2) {
      a.add(i);
    }
    for (let i = 0; i < 512; i++) {
      b.add(i * 2);
    }

    const start = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
      a.hasBitset(b);
    }
    const end = performance.now();
    process.stdout.write(`[Benchmark] hasBitset: ${end - start}ms\n`);
  });

  it("benchmark: forEach", () => {
    const b = new Bitset();
    for (let i = 0; i < 1024; i++) {
      b.add(i);
    }

    const start = performance.now();
    for (let i = 0; i < ITERATIONS / 10; i++) {
      b.forEach(() => {});
    }
    const end = performance.now();
    process.stdout.write(`[Benchmark] forEach: ${end - start}ms\n`);
  });
});
