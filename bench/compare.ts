/**
 * Interleaved A/B comparison of `bench/sector-tick.ts` between two vecs builds.
 *
 *   node bench/compare.ts <base-checkout> [head-checkout]
 *
 * Both checkouts must already be built (`npm run build`). The head defaults to
 * this checkout. Every round runs the benchmark once per build in a fresh
 * process, alternating which build goes first so machine drift and warm caches
 * hit both sides equally. `BENCH_ROUNDS` sets the number of rounds (default 8);
 * every other `BENCH_*` variable is passed through to the benchmark.
 *
 * The report gives each build's mean tick time per run, and the head/base ratio
 * of every round. It also checks that both builds produced the same checksum,
 * callback trace and network bytes: a pure optimization must not change them.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type BenchResult = {
  tick: { mean: number; median: number; p95: number };
  checksum: string;
  trace: string;
  bytesSent: number;
};

const benchDir = dirname(fileURLToPath(import.meta.url));
const [baseArg, headArg] = process.argv.slice(2);
if (baseArg === undefined) {
  console.error("usage: node bench/compare.ts <base-checkout> [head-checkout]");
  process.exit(2);
}
const variants = [
  { label: "base", root: resolve(baseArg) },
  { label: "head", root: resolve(headArg ?? resolve(benchDir, "..")) },
];
const rounds = Number(process.env.BENCH_ROUNDS ?? 8);

const results = new Map<string, BenchResult[]>(variants.map((v) => [v.label, []]));
for (let round = 0; round < rounds; round++) {
  const order = round % 2 === 0 ? variants : [...variants].reverse();
  for (const variant of order) {
    const result = runOnce(variant.root);
    results.get(variant.label)!.push(result);
    console.log(
      `round ${round + 1}/${rounds} ${variant.label}: mean ${result.tick.mean} ms, ` +
        `median ${result.tick.median} ms, p95 ${result.tick.p95} ms`
    );
  }
}

const base = results.get("base")!;
const head = results.get("head")!;
console.log("");
for (const [label, runs] of results) {
  const means = runs.map((run) => run.tick.mean);
  console.log(
    `${label}: mean tick ${fmt(median(means))} ms median of ${runs.length} runs ` +
      `(min ${fmt(Math.min(...means))}, max ${fmt(Math.max(...means))}, ` +
      `stdev ${fmt(stdev(means))})`
  );
}
const ratios = base.map((run, index) => head[index].tick.mean / run.tick.mean);
const faster = ratios.filter((ratio) => ratio < 1).length;
console.log(
  `head/base per round: median ${fmt(median(ratios), 3)} ` +
    `(min ${fmt(Math.min(...ratios), 3)}, max ${fmt(Math.max(...ratios), 3)}); ` +
    `head faster in ${faster}/${ratios.length} rounds; ` +
    `change ${fmt((median(ratios) - 1) * 100, 1)}%`
);

const fingerprint = (run: BenchResult): string => `${run.checksum}/${run.trace}/${run.bytesSent}`;
const fingerprints = new Set([...base, ...head].map(fingerprint));
if (fingerprints.size === 1) {
  console.log(`behavior: identical checksum/trace/bytes ${[...fingerprints][0]}`);
} else {
  console.log(`behavior: DIFFERENT checksum/trace/bytes: ${[...fingerprints].join(", ")}`);
  process.exitCode = 1;
}

function runOnce(root: string): BenchResult {
  const child = spawnSync(
    process.execPath,
    ["--import", resolve(benchDir, "register-dist.mjs"), resolve(benchDir, "sector-tick.ts")],
    { env: { ...process.env, BENCH_VECS_ROOT: root }, encoding: "utf8" }
  );
  if (child.status !== 0) {
    throw new Error(`benchmark failed for ${root}:\n${child.stderr}`);
  }
  const line = child.stdout.split("\n").find((candidate) => candidate.startsWith("BENCH_RESULT "));
  if (line === undefined) {
    throw new Error(`benchmark printed no BENCH_RESULT for ${root}:\n${child.stdout}`);
  }
  return JSON.parse(line.slice("BENCH_RESULT ".length)) as BenchResult;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function stdev(values: readonly number[]): number {
  const mean = values.reduce((acc, value) => acc + value, 0) / values.length;
  return Math.sqrt(values.reduce((acc, value) => acc + (value - mean) ** 2, 0) / values.length);
}

function fmt(value: number, digits = 2): string {
  return value.toFixed(digits);
}
