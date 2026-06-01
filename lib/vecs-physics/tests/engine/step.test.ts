// `engineStep` (VP-7): the gravity/damping integration core, exercised directly
// on the engine state. Bodies are placed straight into the awake set with
// createBody and seeded with mass; the systems layer is not involved here.

import { Entity, World } from "@vworlds/vecs";
import { beforeEach, describe, expect, it } from "vitest";

import { installPhysics } from "../../src/index.js";
import {
  DYNAMIC_BODY,
  HAD_TIME_OF_IMPACT,
  IS_SPEED_CAPPED,
  KINEMATIC_BODY,
  type BodySim,
  type BodyState,
} from "../../src/engine/body.js";
import { AWAKE_SET, createBody } from "../../src/engine/solver_set.js";
import { engineStep } from "../../src/engine/step.js";
import { getPhysics, type PhysicsState } from "../../src/engine/state.js";

const ENTITY = { eid: 1 } as unknown as Entity;
const DT = 1 / 60;
const SUB_STEPS = 4;
const H = DT / SUB_STEPS;
const GY = -10;

let state: PhysicsState;

beforeEach(() => {
  const world = new World();
  installPhysics(world, { gravity: { x: 0, y: GY }, fixedTimeStep: DT, subSteps: SUB_STEPS });
  world.start();
  state = getPhysics(world);
});

/** Add a dynamic body straight to the awake set and return its sim + state. */
function addDynamic(type = DYNAMIC_BODY): { sim: BodySim; bodyState: BodyState } {
  const awake = state.solverSets[AWAKE_SET]!;
  const handle = createBody(state, awake, ENTITY, type);
  const r = state.bodies.get(handle.index);
  return { sim: awake.bodySims[r.localIndex]!, bodyState: awake.bodyStates[r.localIndex]! };
}

describe("engineStep gravity integration", () => {
  it("integrates gravity with semi-implicit Euler over one step", () => {
    const { sim, bodyState } = addDynamic();
    sim.invMass = 1;
    sim.centerY = 4;

    engineStep(state, DT, SUB_STEPS);

    // Velocity is g·t regardless of sub-stepping: v = n·h·g = dt·g.
    expect(bodyState.vy).toBeCloseTo(DT * GY, 12);
    // Semi-implicit position drop after n equal sub-steps: h²·g·n(n+1)/2.
    const drop = H * H * GY * ((SUB_STEPS * (SUB_STEPS + 1)) / 2);
    expect(sim.centerY).toBeCloseTo(4 + drop, 12);
    // The origin transform follows the centre (local centre is zero).
    expect(sim.transformY).toBeCloseTo(4 + drop, 12);
    expect(state.stepIndex).toBe(1);
  });

  it("does not apply gravity to a massless body (invMass 0)", () => {
    const { sim, bodyState } = addDynamic();
    sim.centerY = 4; // invMass stays 0 (no mass computed yet)

    engineStep(state, DT, SUB_STEPS);

    expect(bodyState.vy).toBe(0);
    expect(sim.centerY).toBe(4);
  });

  it("advances position by an existing velocity with no gravity", () => {
    const { sim, bodyState } = addDynamic();
    bodyState.vy = -6; // invMass 0 → gravity off, but position still integrates

    engineStep(state, DT, SUB_STEPS);

    expect(bodyState.vy).toBe(-6); // unchanged: no gravity, no damping
    expect(sim.centerY).toBeCloseTo(DT * -6, 12); // moved by dt·v
  });

  it("applies Pade-approximated linear damping", () => {
    const { sim, bodyState } = addDynamic();
    sim.linearDamping = 1;
    bodyState.vx = 10; // invMass 0 → only damping acts

    engineStep(state, DT, SUB_STEPS);

    // Per sub-step v *= 1/(1+h·c); after n sub-steps v = v0 / (1+h·c)^n.
    const expected = 10 / Math.pow(1 + H * 1, SUB_STEPS);
    expect(bodyState.vx).toBeCloseTo(expected, 12);
  });

  it("clamps to the maximum linear speed", () => {
    const { sim, bodyState } = addDynamic();
    bodyState.vx = state.maximumLinearSpeed * 10;

    engineStep(state, DT, SUB_STEPS);

    expect(Math.abs(bodyState.vx)).toBeCloseTo(state.maximumLinearSpeed, 6);
  });

  it("resets accumulated force after the step", () => {
    const { sim } = addDynamic();
    sim.invMass = 1;
    sim.forceX = 50;
    sim.torque = 5;

    engineStep(state, DT, SUB_STEPS);

    expect(sim.forceX).toBe(0);
    expect(sim.torque).toBe(0);
  });
});

describe("engineStep move events", () => {
  it("records one move event per awake body, in finalize order", () => {
    const a = addDynamic();
    const b = addDynamic();

    engineStep(state, DT, SUB_STEPS);

    expect(state.bodyMoveEvents).toEqual([a.sim.bodyId, b.sim.bodyId]);
  });

  it("is rebuilt each step", () => {
    addDynamic();
    engineStep(state, DT, SUB_STEPS);
    engineStep(state, DT, SUB_STEPS);
    expect(state.bodyMoveEvents).toHaveLength(1);
  });

  it("does no work and emits no events with no awake bodies", () => {
    engineStep(state, DT, SUB_STEPS);
    expect(state.bodyMoveEvents).toHaveLength(0);
    expect(state.stepIndex).toBe(1); // step counter still advances
  });

  it("emits a move event for a kinematic body but gravity never acts on it", () => {
    const { sim, bodyState } = addDynamic(KINEMATIC_BODY);
    sim.centerY = 4;

    engineStep(state, DT, SUB_STEPS);

    expect(bodyState.vy).toBe(0); // invMass 0 → no gravity
    expect(state.bodyMoveEvents).toHaveLength(1);
  });
});

describe("finalizeBodies flag propagation (M5 regression)", () => {
  // box2d solver.c:622-626 — body->flags receives IS_SPEED_CAPPED |
  // HAD_TIME_OF_IMPACT from sim->flags / state->flags before those fields are
  // cleared. Without this, debug-draw consumers reading body.flags see no events.

  it("propagates IS_SPEED_CAPPED from bodyState.flags to body.flags after a step", () => {
    const { sim, bodyState } = addDynamic();
    // Seed the per-substep working flag as the solver would (solver.ts:710,717).
    bodyState.flags |= IS_SPEED_CAPPED;

    engineStep(state, DT, SUB_STEPS);

    // The flag must be on InternalBody.flags (retained for debug draw).
    const body = state.bodies.records[sim.bodyId]!;
    expect(body.flags & IS_SPEED_CAPPED).toBeTruthy();

    // The working copy on bodyState must be cleared.
    expect(bodyState.flags & IS_SPEED_CAPPED).toBe(0);
  });

  it("propagates IS_SPEED_CAPPED from sim.flags to body.flags after a step", () => {
    const { sim, bodyState } = addDynamic();
    sim.flags |= IS_SPEED_CAPPED;

    engineStep(state, DT, SUB_STEPS);

    const body = state.bodies.records[sim.bodyId]!;
    expect(body.flags & IS_SPEED_CAPPED).toBeTruthy();
    expect(sim.flags & IS_SPEED_CAPPED).toBe(0);
  });

  it("propagates HAD_TIME_OF_IMPACT from sim.flags to body.flags after a step", () => {
    const { sim } = addDynamic();
    sim.flags |= HAD_TIME_OF_IMPACT;

    engineStep(state, DT, SUB_STEPS);

    const body = state.bodies.records[sim.bodyId]!;
    expect(body.flags & HAD_TIME_OF_IMPACT).toBeTruthy();
    expect(sim.flags & HAD_TIME_OF_IMPACT).toBe(0);
  });

  it("clears stale IS_SPEED_CAPPED on body.flags when not set this step", () => {
    const { sim } = addDynamic();
    // Pre-seed body.flags as if from a previous step.
    const body = state.bodies.records[sim.bodyId]!;
    body.flags |= IS_SPEED_CAPPED;

    // No speed-cap this step.
    engineStep(state, DT, SUB_STEPS);

    expect(body.flags & IS_SPEED_CAPPED).toBe(0);
  });
});
