import { describe, expect, it } from "vitest";
import { _compile, type QueryDSL } from "../src/dsl.js";
import { World } from "../src/world.js";
import { Entity } from "../src/entity.js";

const runBench = process.env.RUN_QUERY_BENCH === "1" ? it : it.skip;

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

// Create a world with enough registered components to drive the queries
// below across multiple 32-bit words. The component IDs match the index,
// so a query for `[1, 67, 130]` requires bits at those exact positions.
function world(): World {
  const w = new World();
  for (let i = 0; i < 200; i++) {
    class C {}
    Object.defineProperty(C, "name", { value: `C${i}` });
    w.registerComponent(C, i);
  }
  return w;
}

function entityWith(w: World, types: number[]): Entity {
  const e = w.entity();
  for (const t of types) {
    e.componentBitmask.addBit(w.getComponentMeta(t).bitPtr);
  }
  return e;
}

function runScenario(name: string, dsl: QueryDSL, entityTypes: number[]): BenchResult {
  const w = world();
  const predicate = _compile(w, dsl);
  const e = entityWith(w, entityTypes);
  return bench(name, OPS, () => {
    let found = 0;
    for (let i = 0; i < OPS; i++) {
      if (predicate(e)) {
        found++;
      }
    }
    return found;
  });
}

describe("Query predicate benchmark", () => {
  runBench("measures compiled-belongs hot paths", () => {
    const entityTypes = [0, 1, 2, 3, 31, 33, 67, 128, 130, 131];

    const results = [
      runScenario("belongs.has-single", 0, entityTypes),
      runScenario("belongs.has-3-same-word", [0, 1, 2], entityTypes),
      runScenario("belongs.has-3-spread", [1, 67, 130], entityTypes),
      runScenario("belongs.and-or-mix", { AND: [0, { OR: [1, 2] }] }, entityTypes),
      runScenario("belongs.not", { NOT: 99 }, entityTypes),
      runScenario("belongs.deep-and", { AND: [0, 1, 31, 33, 67, 130, 131] }, entityTypes),
    ];

    console.info("\nQuery predicate benchmark results");
    for (const r of results) {
      console.info(
        `${r.name}: ${r.medianMs.toFixed(2)} ms, ${r.opsPerSec.toLocaleString()} ops/sec, checksum ${r.checksum}`
      );
    }

    expect(results.every((r) => r.checksum !== 0)).toBe(true);
  });
});
