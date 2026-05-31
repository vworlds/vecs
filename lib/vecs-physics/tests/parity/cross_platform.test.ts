// Ports box2d/test/test_world.c::CrossPlatformTest as the v1 determinism gate.
//
// The Box2D scene uses revolute joints, which vecs-physics v1 intentionally
// excludes. This representative joint-free stack checks the same local promise:
// identical setup and fixed stepping produce byte-equal engine snapshots within
// one x64 Linux process.

import { ChildOf, World } from "@vworlds/vecs";
import { describe, expect, it } from "vitest";

import { Body, BodyType, Box, Material, Position, installPhysics } from "../../src/index.js";
import { AWAKE_SET, FIRST_SLEEPING_SET } from "../../src/engine/solver_set.js";
import { getPhysics } from "../../src/engine/state.js";

const COLUMNS = 20;
const ROWS = 10;
const STEPS = 360;
const STEP_MS = 1000 / 60;

describe("test_world.c::CrossPlatformTest", () => {
  it("produces byte-equal snapshots for identical joint-free scenes", () => {
    expect(runStackingSnapshot()).toBe(runStackingSnapshot());
  });
});

function runStackingSnapshot(): string {
  const world = new World();
  installPhysics(world, {
    gravity: { x: 0, y: -10 },
    fixedTimeStep: 1 / 60,
    subSteps: 4,
  });
  world.start();

  makeGround(world);
  makeStack(world);
  step(world, STEPS);

  const state = getPhysics(world);
  const bodies = state.bodies.records.flatMap((body, bodyId) => {
    if (body === undefined) {
      return [];
    }

    const set = state.solverSets[body.setIndex]!;
    const sim = set.bodySims[body.localIndex]!;
    const bodyState = body.setIndex === AWAKE_SET ? set.bodyStates[body.localIndex] : undefined;

    return [
      {
        bodyId,
        x: sim.transformX,
        y: sim.transformY,
        rotation: Math.atan2(sim.sin, sim.cos),
        vx: bodyState?.vx ?? 0,
        vy: bodyState?.vy ?? 0,
        omega: bodyState?.omega ?? 0,
        sleeping: body.setIndex >= FIRST_SLEEPING_SET,
      },
    ];
  });

  return JSON.stringify({ stepIndex: state.stepIndex, bodies });
}

function makeGround(world: World): void {
  const ground = world.entity().set(Body, { type: BodyType.Static });
  world
    .entity()
    .set(ChildOf, { target: ground })
    .set(Box, { hx: 50, hy: 1 })
    .set(Material, { friction: 0.6, density: 0 });
}

function makeStack(world: World): void {
  const boxHalfSize = 0.5;
  const groundTop = 1.0;
  const startY = groundTop + boxHalfSize;

  for (let col = 0; col < COLUMNS; col++) {
    const x = (col - COLUMNS / 2 + 0.5) * (boxHalfSize * 2 + 0.01);
    for (let row = 0; row < ROWS; row++) {
      const y = startY + row * (boxHalfSize * 2 + 0.01);
      const body = world.entity().set(Body, { type: BodyType.Dynamic }).set(Position, { x, y });
      world
        .entity()
        .set(ChildOf, { target: body })
        .set(Box, { hx: boxHalfSize, hy: boxHalfSize })
        .set(Material, { friction: 0.3, density: 1 });
    }
  }
}

function step(world: World, count: number): void {
  let now = 0;
  for (let i = 0; i < count; i++) {
    now += STEP_MS;
    world.progress(now, STEP_MS);
  }
}
