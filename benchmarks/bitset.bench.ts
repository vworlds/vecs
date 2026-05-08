import { Bitset, BitPtr } from "../src/util/bitset.js";
import { performance } from "perf_hooks";

function runBenchmark(name: string, fn: () => void, iterations: number = 1_000_000) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const end = performance.now();
  console.log(`${name}: ${(end - start).toFixed(3)}ms`);
}

const b1 = new Bitset();
const b2 = new Bitset();
const ptr1 = new BitPtr(10);
const ptr2 = new BitPtr(100);

console.log("--- Bitset Baselines ---");

runBenchmark("add(n)", () => {
  b1.add(10);
});

runBenchmark("addBit(ptr)", () => {
  b1.addBit(ptr1);
});

runBenchmark("has(n)", () => {
  b1.has(10);
});

runBenchmark("hasBit(ptr)", () => {
  b1.hasBit(ptr1);
});

const largeB1 = new Bitset();
const largeB2 = new Bitset();
for (let i = 0; i < 1000; i++) {
  largeB1.add(i);
  largeB2.add(i);
}

runBenchmark("equal(other)", () => {
  largeB1.equal(largeB2);
});

runBenchmark("hasBitset(other)", () => {
  largeB1.hasBitset(largeB2);
});

const b3 = new Bitset();
for (let i = 0; i < 100; i++) b3.add(i);
runBenchmark("forEach", () => {
  b3.forEach(() => {});
});
