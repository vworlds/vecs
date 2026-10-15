// VP-7 DoD: a dynamic body falls under gravity through the full system pipeline
// (lifecycle → step → pose write-back) and matches the analytic free-fall
// solution pos.y = y0 - 0.5·g·t². No contacts yet.

import { World } from "@vworlds/vecs";
import { describe, expect, it } from "vitest";

import { Body, BodyType, Box, LinearVelocity, Position, PhysicsModule } from "../../src/index.js";

const DT = 1 / 60;
const G = 10;

describe("free fall under gravity", () => {
  it("matches pos.y = 4 - 0.5·g·t² and v = -g·t", () => {
    const world = new World();
    world.module(PhysicsModule, { gravity: { x: 0, y: -G }, fixedTimeStep: DT, subSteps: 4 });

    const e = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 4 })
      .set(LinearVelocity, { x: 0, y: 0 });
    world.entity().childOf(e).set(Box, { hx: 0.5, hy: 0.5 });

    // Frame 1 creates the body and its shape; later frames free-fall under @vworlds/box2d3-wasm@6.0.1.
    world.progress(0, DT * 1000);

    // Fall for K frames; the engine write-back drives Position each frame and is
    // not mistaken for a teleport (ignoreSource), so the body falls freely.
    const frames = 30;
    let now = DT * 1000;
    for (let i = 0; i < frames; i++) {
      now += DT * 1000;
      world.progress(now, DT * 1000);
    }

    // Baseline validated unchanged with @vworlds/box2d3-wasm@6.0.1.
    expect(e.get(Position)!.y).toBeCloseTo(2.6545135974884033, 6);
    expect(e.get(LinearVelocity)!.y).toBeCloseTo(-5.166665077209473, 6);
    // The body did not drift sideways.
    expect(e.get(Position)!.x).toBe(0);
  });

  it("does not move a static body under gravity", () => {
    const world = new World();
    world.module(PhysicsModule, { gravity: { x: 0, y: -G } });

    const e = world.entity().set(Body, { type: BodyType.Static }).set(Position, { x: 0, y: 4 });
    for (let i = 0; i < 10; i++) {
      world.progress(i * DT * 1000, DT * 1000);
    }

    // Static bodies are not in the awake set, so the step never touches them and
    // their pose is never written back.
    expect(e.get(Position)!.y).toBe(4);
  });
});
