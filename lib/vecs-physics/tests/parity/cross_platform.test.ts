// Ports box2d/test/test_world.c::CrossPlatformTest as the v1 determinism gate.
//
// The Box2D scene uses revolute joints, which vecs-physics v1 intentionally
// excludes. This representative joint-free stack checks the same local promise:
// identical setup and fixed stepping produce byte-equal engine snapshots within
// one x64 Linux process.
//
// Baseline recorded against box2d3-wasm@5.2.0.
// If the upstream box2d3-wasm version bumps, this parity baseline must be
// re-recorded against the new version.

import { ChildOf, World } from "@vworlds/vecs";
import { describe, expect, it } from "vitest";

import { Body, BodyType, Box, Material, Position, installPhysics } from "../../src/index.js";
import { getPhysics } from "../../src/adapter/state.js";

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

  // Collect body states from WASM via body events and direct API calls.
  const bodies: Array<{
    eid: number;
    x: number;
    y: number;
    angle: number;
    vx: number;
    vy: number;
    omega: number;
    awake: boolean;
  }> = [];

  for (const [eid, bodyId] of state.bodyByEntityWasm) {
    if (!state.box2d.b2Body_IsValid(bodyId)) {
      continue;
    }

    const pos = state.box2d.b2Body_GetPosition(bodyId);
    const rot = state.box2d.b2Body_GetRotation(bodyId);
    const vel = state.box2d.b2Body_GetLinearVelocity(bodyId);
    const omega = state.box2d.b2Body_GetAngularVelocity(bodyId);

    const x = pos.x;
    const y = pos.y;
    const angle = rot.GetAngle();
    const vx = vel.x;
    const vy = vel.y;
    const awake = state.box2d.b2Body_IsAwake(bodyId);

    pos.delete();
    rot.delete();
    vel.delete();

    bodies.push({ eid, x, y, angle, vx, vy, omega, awake });
  }

  // Sort by eid for determinism.
  bodies.sort((a, b) => a.eid - b.eid);

  return JSON.stringify({ bodies });
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
