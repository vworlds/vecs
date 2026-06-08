// Stacking benchmark — 200-body scene: 20 columns × 10 boxes stacked.
// Measures ms/step over 500 steps with a standard gravity world.
//
// World setup mirrors the HelloWorld / contacts.test.ts patterns:
//   - Static ground (1 body, 1 large box shape)
//   - 200 dynamic boxes in a 20×10 grid, stacked above the ground
//   - 500 steps at 1/60 s, 4 sub-steps (the default)
//
// Output: total scene time (ms) and ms/step.

import { World } from "@vworlds/vecs";

import {
  Body,
  BodyType,
  Box,
  PhysicsModule,
  Material,
  Position,
  Rotation,
} from "../../src/index.js";

const COLUMNS = 20;
const ROWS = 10;
const STEPS = 500;
const DT_MS = 1000 / 60;

export function runStacking(): { totalMs: number; msPerStep: number; steps: number } {
  const world = new World();
  world.module(
    PhysicsModule.configure({
      gravity: { x: 0, y: -10 },
      fixedTimeStep: 1 / 60,
      subSteps: 4,
    })
  );
  // ── Ground ────────────────────────────────────────────────────────────────
  const ground = world.entity().set(Body, { type: BodyType.Static });
  world
    .entity()
    .childOf(ground)
    .set(Box, { hx: 50, hy: 1 })
    .set(Material, { friction: 0.6, density: 0 });

  // ── Stacked boxes (20 columns × 10 rows) ────────────────────────────────
  const boxHalfSize = 0.5;
  const groundTop = 1.0; // top of ground box (at y=0 with box hy=1)
  const startY = groundTop + boxHalfSize; // first row centre

  for (let col = 0; col < COLUMNS; col++) {
    const x = (col - COLUMNS / 2 + 0.5) * (boxHalfSize * 2 + 0.01); // slight gap
    for (let row = 0; row < ROWS; row++) {
      const y = startY + row * (boxHalfSize * 2 + 0.01);
      const body = world.entity().set(Body, { type: BodyType.Dynamic }).set(Position, { x, y });
      world
        .entity()
        .childOf(body)
        .set(Box, { hx: boxHalfSize, hy: boxHalfSize })
        .set(Material, { friction: 0.3, density: 1 });
    }
  }

  // ── Warm-up: 1 step (world setup, query compilation, etc.) ───────────────
  world.progress(DT_MS, DT_MS);

  // ── Timed run ────────────────────────────────────────────────────────────
  const t0 = performance.now();
  let now = DT_MS;
  for (let i = 0; i < STEPS; i++) {
    now += DT_MS;
    world.progress(now, DT_MS);
  }
  const totalMs = performance.now() - t0;

  return { totalMs, msPerStep: totalMs / STEPS, steps: STEPS };
}
