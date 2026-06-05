// VP-18 scenario tests: the wired collision step loop driven through the full
// Vecs world. These assert geometric / stability properties over longer runs
// (per PLAN: "assert geometric properties for longer runs"), not exact
// transforms — the HelloWorld parity gate pins the exact resting transform.

import { World } from "@vworlds/vecs";
import { beforeEach, describe, expect, it } from "vitest";

import {
  AngularVelocity,
  Body,
  BodyType,
  Box,
  LinearVelocity,
  Material,
  Position,
  installPhysics,
} from "../../src/index.js";

const STEP_MS = 1000 / 60;

let world: World;
let now: number;

beforeEach(() => {
  world = new World();
  installPhysics(world, { gravity: { x: 0, y: -10 } });
  world.start();
  now = 0;
});

/** A static ground box. Top surface at y = 0 (centre at -10, half-height 10). */
function makeGround(): void {
  const ground = world
    .entity()
    .set(Body, { type: BodyType.Static })
    .set(Position, { x: 0, y: -10 });
  world.entity().childOf(ground).set(Box, { width: 100, height: 20 });
}

/** A dynamic unit box (half-extents 1×1) at `(x, y)` with the given material. */
function makeBox(x: number, y: number, mat?: { density?: number; restitution?: number }) {
  const e = world.entity().set(Body, { type: BodyType.Dynamic }).set(Position, { x, y });
  const shape = world.entity().childOf(e).set(Box, { width: 2, height: 2 });
  if (mat) {
    shape.set(Material, { density: mat.density ?? 1, restitution: mat.restitution ?? 0 });
  }
  return e;
}

function step(n: number): void {
  for (let i = 0; i < n; i++) {
    now += STEP_MS;
    world.progress(now, STEP_MS);
  }
}

describe("a dynamic box dropped on a static floor", () => {
  it("comes to rest in a small band and stays there (no exploding, no tunneling)", () => {
    makeGround();
    const box = makeBox(0, 5);

    // Drop and settle.
    step(120);

    const settled = box.get(Position)!;
    // Resting centre is y = 1 (floor top 0 + half-height 1).
    expect(settled.y).toBeGreaterThan(0.9);
    expect(settled.y).toBeLessThan(1.1);
    // Did not tunnel through the floor.
    expect(settled.y).toBeGreaterThan(0.0);

    // Run much longer: it must STAY resting (stable, not drifting/exploding).
    let minY = settled.y;
    let maxY = settled.y;
    for (let i = 0; i < 240; i++) {
      step(1);
      const p = box.get(Position)!;
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    expect(maxY - minY).toBeLessThan(0.02);
    expect(Math.abs(box.get(Position)!.x)).toBeLessThan(0.05);
  });
});

describe("restitution bounce", () => {
  it("a fully-elastic body rebounds upward with a large fraction of its impact speed", () => {
    makeGround();
    // restitution 1 → (nearly) elastic. Start low so it hits within a few steps,
    // and give it a LinearVelocity component so the rebound velocity is visible.
    const box = makeBox(0, 2, { restitution: 1 });
    box.set(LinearVelocity, { x: 0, y: 0 });

    // Track the downward impact speed and the upward rebound speed.
    let impactSpeed = 0; // most-negative vy seen (fastest fall)
    let reboundSpeed = 0; // most-positive vy seen after impact

    let sawImpact = false;
    for (let i = 0; i < 120; i++) {
      step(1);
      const v = box.get(LinearVelocity)!;
      if (v.y < impactSpeed) {
        impactSpeed = v.y;
      }
      // A clear upward velocity after the body has been falling = a rebound.
      if (impactSpeed < -2 && v.y > 0) {
        sawImpact = true;
        reboundSpeed = Math.max(reboundSpeed, v.y);
      }
    }

    expect(sawImpact).toBe(true);
    // Elastic-ish: the rebound keeps a large fraction of the impact speed.
    expect(reboundSpeed).toBeGreaterThan(0.5 * Math.abs(impactSpeed));
  });
});

describe("a 2-box stack", () => {
  it("settles without the top box sinking through the bottom box", () => {
    makeGround();
    // Bottom box centre ~1 (rests on floor); top box centre ~3 (rests on bottom).
    const bottom = makeBox(0, 1.2);
    const top = makeBox(0, 3.4);

    step(240);

    const pb = bottom.get(Position)!;
    const pt = top.get(Position)!;

    // Bottom rests on the floor (~y=1).
    expect(pb.y).toBeGreaterThan(0.9);
    expect(pb.y).toBeLessThan(1.2);

    // Top rests on the bottom (~y=3): separation between centres ≈ 2 (sum of
    // half-heights). It must NOT have sunk through (separation well above ~1.8).
    const separation = pt.y - pb.y;
    expect(separation).toBeGreaterThan(1.8);
    expect(separation).toBeLessThan(2.2);

    // The stack is stable: top stays above the bottom, neither tunnels.
    expect(pt.y).toBeGreaterThan(pb.y);
    expect(pb.y).toBeGreaterThan(0.0);

    // Angles stay small (stack did not topple). Use AngularVelocity proxy: both
    // should be near rest. (Rotation may be absent; check via velocity.)
    const wTop = top.get(AngularVelocity)?.value ?? 0;
    const wBottom = bottom.get(AngularVelocity)?.value ?? 0;
    expect(Math.abs(wTop)).toBeLessThan(0.05);
    expect(Math.abs(wBottom)).toBeLessThan(0.05);
  });
});
