// `PhysicsPoseSyncIn` / `PhysicsPoseSyncOut` (VP-6): user teleports flow into the
// engine, simulated pose flows back out, and the engine's own write-back is not
// mistaken for a teleport (`ignoreSource([PhysicsSystemTag])`).
//
// VP-6 has no solver, so "the engine moved the body" is simulated by writing the
// body sim directly; the systems under test are the pose-sync ones.

import { Entity, World } from "@vworlds/vecs";
import { beforeEach, describe, expect, it } from "vitest";

import {
  AngularVelocity,
  Body,
  BodyType,
  LinearVelocity,
  Position,
  Rotation,
  installPhysics,
} from "../../src/index.js";
import { AWAKE_SET, STATIC_SET } from "../../src/engine/solver_set.js";
import { getPhysics, type PhysicsState } from "../../src/engine/state.js";

let world: World;
let state: PhysicsState;

beforeEach(() => {
  world = new World();
  installPhysics(world);
  world.start();
  state = getPhysics(world);
});

function awakeSim(eid: number) {
  const handle = state.bodyByEntity.get(eid)!;
  const r = state.bodies.get(handle.index);
  return state.solverSets[r.setIndex]!.bodySims[r.localIndex]!;
}

function awakeState(eid: number) {
  const handle = state.bodyByEntity.get(eid)!;
  const r = state.bodies.get(handle.index);
  return state.solverSets[r.setIndex]!.bodyStates[r.localIndex]!;
}

describe("PhysicsPoseSyncIn (user → engine)", () => {
  it("teleports the body origin when the user writes Position", () => {
    const e = world.entity().set(Body, { type: BodyType.Dynamic }).set(Position, { x: 0, y: 0 });
    world.progress(0, 16);

    e.set(Position, { x: 5, y: 6 });
    world.progress(16, 16);

    const sim = awakeSim(e.eid);
    expect(sim.transformX).toBe(5);
    expect(sim.transformY).toBe(6);
    // Centre tracks the origin (local centre is zero until shapes/mass land).
    expect(sim.centerX).toBe(5);
    expect(sim.center0X).toBe(5);
  });

  it("teleports the body rotation when the user writes Rotation", () => {
    const e = world.entity().set(Body, { type: BodyType.Dynamic }).set(Rotation, { angle: 0 });
    world.progress(0, 16);

    e.set(Rotation, { angle: Math.PI / 2 });
    world.progress(16, 16);

    const sim = awakeSim(e.eid);
    expect(sim.cos).toBeCloseTo(0, 12);
    expect(sim.sin).toBeCloseTo(1, 12);
  });

  it("applies user linear and angular velocity to the body state", () => {
    // Canonical velocity components are present from creation (so they're caught
    // on query entry); here the user modifies them to drive the teleport path.
    const e = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(LinearVelocity, { x: 0, y: 0 })
      .set(AngularVelocity, { value: 0 });
    world.progress(0, 16);

    e.set(LinearVelocity, { x: 3, y: 4 });
    e.set(AngularVelocity, { value: 7 });
    world.progress(16, 16);

    const bodyState = awakeState(e.eid);
    expect(bodyState.vx).toBe(3);
    expect(bodyState.vy).toBe(4);
    expect(bodyState.omega).toBe(7);
  });

  it("ignores velocity writes on a static body (no body state exists)", () => {
    const e = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(LinearVelocity, { x: 0, y: 0 });
    world.progress(0, 16);

    e.set(LinearVelocity, { x: 3, y: 4 });
    expect(() => world.progress(16, 16)).not.toThrow();
    expect(state.solverSets[STATIC_SET]!.bodyStates).toHaveLength(0);
    expect(state.bodyByEntity.has(e.eid)).toBe(true);
  });
});

describe("PhysicsPoseSyncOut (engine → user)", () => {
  it("writes the simulated pose back to a dynamic body's components", () => {
    const e = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0 })
      .set(LinearVelocity, { x: 0, y: 0 });
    world.progress(0, 16);

    // Simulate the engine moving the body (no solver yet in VP-6).
    const sim = awakeSim(e.eid);
    sim.transformX = 9;
    sim.transformY = -1;
    awakeState(e.eid).vx = 2;
    world.progress(16, 16);

    expect(e.get(Position)!.x).toBe(9);
    expect(e.get(Position)!.y).toBe(-1);
    expect(e.get(LinearVelocity)!.x).toBe(2);
  });

  it("does not write back a kinematic body (its pose is user-owned)", () => {
    const e = world.entity().set(Body, { type: BodyType.Kinematic }).set(Position, { x: 0, y: 0 });
    world.progress(0, 16);

    awakeSim(e.eid).transformX = 9;
    world.progress(16, 16);

    expect(e.get(Position)!.x).toBe(0);
  });
});

describe("pose-sync feedback suppression", () => {
  it("does not re-apply the engine's own write-back as a teleport", () => {
    const e = world.entity().set(Body, { type: BodyType.Dynamic }).set(Position, { x: 0, y: 0 });
    world.progress(0, 16); // PhysicsPoseSyncOut writes Position(0,0) — must be ignored next frame.

    // Simulate the engine having moved the body after that write-back.
    const sim = awakeSim(e.eid);
    sim.transformX = 7;

    world.progress(16, 16);

    // If the (0,0) write-back had been mistaken for a user teleport,
    // PhysicsPoseSyncIn would have reset the body to the origin this frame.
    expect(awakeSim(e.eid).transformX).toBe(7);
    expect(e.get(Position)!.x).toBe(7);
  });

  it("delivers the engine write-back to a non-physics user system", () => {
    const userWorld = new World();
    installPhysics(userWorld);
    userWorld.addPhase("render"); // after physics-post in registration order

    let lastSeenX: number | undefined;
    let count = 0;
    userWorld
      .system("UserRender")
      .requires(Body)
      .phase("render")
      .update(Position, (_e: Entity, pos: Position) => {
        lastSeenX = pos.x;
        count++;
      });

    userWorld.start();
    const us = getPhysics(userWorld);

    const e = userWorld
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0 });
    userWorld.progress(0, 16); // settle (entry-init + first write-back)

    // Move the body and observe the write-back reach the user system.
    count = 0;
    const handle = us.bodyByEntity.get(e.eid)!;
    const r = us.bodies.get(handle.index);
    us.solverSets[AWAKE_SET]!.bodySims[r.localIndex]!.transformX = 4;
    userWorld.progress(16, 16);

    expect(count).toBe(1);
    expect(lastSeenX).toBe(4);
  });
});
