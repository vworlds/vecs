// Falling-balls benchmark — 100 dynamic circles falling onto a static floor.
// Tests broad-phase performance and many simultaneous contact pairs.
//
// 100 circles dropped in a 10×10 grid, each with a unique radius (0.3–0.5).
// Run 300 steps at 1/60 s. The circles pile up at the bottom.

import { World } from "@vworlds/vecs";

import { Body, BodyType, Circle, installPhysics, Material, Position } from "../../src/index.js";

const GRID_COLS = 10;
const GRID_ROWS = 10;
const STEPS = 300;
const DT_MS = 1000 / 60;

export function runFallingBalls(): { totalMs: number; msPerStep: number; steps: number } {
  const world = new World();
  installPhysics(world, {
    gravity: { x: 0, y: -10 },
    fixedTimeStep: 1 / 60,
    subSteps: 4,
  });
  world.start();

  // ── Static floor ──────────────────────────────────────────────────────────
  const floor = world.entity().set(Body, { type: BodyType.Static });
  world
    .entity()
    .childOf(floor)
    .set(Circle, { radius: 30 }) // large circle as floor
    .set(Material, { friction: 0.3, density: 0 });
  // Place floor circle so its top is at y=0.
  floor.set(Position, { x: 0, y: -30 });

  // ── 100 falling circles ───────────────────────────────────────────────────
  for (let col = 0; col < GRID_COLS; col++) {
    for (let row = 0; row < GRID_ROWS; row++) {
      const radius = 0.3 + 0.2 * ((col * GRID_ROWS + row) % 5) * 0.1;
      const x = (col - GRID_COLS / 2 + 0.5) * 1.2;
      const y = 2 + row * 1.5;
      const body = world.entity().set(Body, { type: BodyType.Dynamic }).set(Position, { x, y });
      world
        .entity()
        .childOf(body)
        .set(Circle, { radius })
        .set(Material, { friction: 0.2, density: 1 });
    }
  }

  // Warm-up.
  world.progress(DT_MS, DT_MS);

  const t0 = performance.now();
  let now = DT_MS;
  for (let i = 0; i < STEPS; i++) {
    now += DT_MS;
    world.progress(now, DT_MS);
  }
  const totalMs = performance.now() - t0;

  return { totalMs, msPerStep: totalMs / STEPS, steps: STEPS };
}
