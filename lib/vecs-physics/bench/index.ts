#!/usr/bin/env node
// vecs-physics benchmark harness (VP-26).
//
// Runs all registered scenarios and prints a results table.
// Execute via: npm run bench
//
// Scenarios:
//   stacking     — 200-body scene (20 cols × 10 rows of boxes), 500 steps
//   falling_balls — 100 circles falling onto a static floor, 300 steps
//
// Output format:
//   scenario       | steps |  total (ms) | ms/step
//   ─────────────────────────────────────────────────
//   stacking       |   500 |       xxx.x |    x.xx
//   falling_balls  |   300 |       xxx.x |    x.xx
//
// Numbers are reference baselines only — no CI gate. Append to PROGRESS.md
// when establishing a new baseline.

import { runStacking } from "./scenarios/stacking.bench.js";
import { runFallingBalls } from "./scenarios/falling_balls.bench.js";

interface BenchResult {
  name: string;
  steps: number;
  totalMs: number;
  msPerStep: number;
}

async function main(): Promise<void> {
  const results: BenchResult[] = [];

  console.log("vecs-physics benchmark harness");
  console.log("=".repeat(50));

  // ── Stacking (200 bodies, 500 steps) ─────────────────────────────────────
  process.stdout.write("Running stacking (200 bodies × 500 steps)... ");
  const stacking = runStacking();
  results.push({ name: "stacking", ...stacking });
  console.log(`done (${stacking.totalMs.toFixed(1)} ms)`);

  // ── Falling balls (100 circles, 300 steps) ────────────────────────────────
  process.stdout.write("Running falling_balls (100 circles × 300 steps)... ");
  const fallingBalls = runFallingBalls();
  results.push({ name: "falling_balls", ...fallingBalls });
  console.log(`done (${fallingBalls.totalMs.toFixed(1)} ms)`);

  // ── Results table ──────────────────────────────────────────────────────────
  console.log("");
  console.log(
    `${"scenario".padEnd(16)} | ${"steps".padStart(5)} | ${"total (ms)".padStart(10)} | ${"ms/step".padStart(8)}`
  );
  console.log(
    "-".repeat(16) + "-+-" + "-".repeat(5) + "-+-" + "-".repeat(10) + "-+-" + "-".repeat(8)
  );
  for (const r of results) {
    console.log(
      `${r.name.padEnd(16)} | ${String(r.steps).padStart(5)} | ${r.totalMs.toFixed(1).padStart(10)} | ${r.msPerStep.toFixed(3).padStart(8)}`
    );
  }
  console.log("");
  console.log(
    "Note: these are wall-clock numbers on this machine. " + "Paste into PROGRESS.md as a baseline."
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
