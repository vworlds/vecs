// VP-7 DoD: a dynamic body falls under gravity through the full system pipeline
// (lifecycle → step → pose write-back) and matches the analytic free-fall
// solution pos.y = y0 - 0.5·g·t². No contacts yet.

import { World } from "@vworlds/vecs";
import { describe, expect, it } from "vitest";

import { Body, BodyType, LinearVelocity, Position, installPhysics } from "../../src/index.js";
import { AWAKE_SET } from "../../src/engine/solver_set.js";
import { getPhysics } from "../../src/engine/state.js";

const DT = 1 / 60;
const G = 10;

describe("free fall under gravity", () => {
  it("matches pos.y = 4 - 0.5·g·t² and v = -g·t", () => {
    const world = new World();
    installPhysics(world, { gravity: { x: 0, y: -G }, fixedTimeStep: DT, subSteps: 4 });
    world.start();

    const e = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 4 })
      .set(LinearVelocity, { x: 0, y: 0 });

    // Frame 1 creates the body. It does not fall yet: mass is not computed until
    // VP-12, so invMass is 0 (infinite mass). Seed a unit mass to stand in for
    // that — free fall is mass-independent, so any positive mass gives g·t².
    world.progress(0, DT * 1000);
    const state = getPhysics(world);
    const handle = state.bodyByEntity.get(e.eid)!;
    const sim = state.solverSets[AWAKE_SET]!.bodySims[state.bodies.get(handle.index).localIndex]!;
    sim.invMass = 1;

    // Fall for K frames; the engine write-back drives Position each frame and is
    // not mistaken for a teleport (ignoreSource), so the body falls freely.
    const frames = 30;
    let now = DT * 1000;
    for (let i = 0; i < frames; i++) {
      now += DT * 1000;
      world.progress(now, DT * 1000);
    }

    const t = frames * DT;
    expect(e.get(Position)!.y).toBeCloseTo(4 - 0.5 * G * t * t, 1);
    expect(e.get(LinearVelocity)!.y).toBeCloseTo(-G * t, 6);
    // The body did not drift sideways.
    expect(e.get(Position)!.x).toBe(0);
  });

  it("does not move a static body under gravity", () => {
    const world = new World();
    installPhysics(world, { gravity: { x: 0, y: -G } });
    world.start();

    const e = world.entity().set(Body, { type: BodyType.Static }).set(Position, { x: 0, y: 4 });
    for (let i = 0; i < 10; i++) {
      world.progress(i * DT * 1000, DT * 1000);
    }

    // Static bodies are not in the awake set, so the step never touches them and
    // their pose is never written back.
    expect(e.get(Position)!.y).toBe(4);
  });
});
