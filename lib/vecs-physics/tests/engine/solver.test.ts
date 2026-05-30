// VP-17: the TGS soft-step constraint solver, exercised directly on the engine
// state. Bodies are placed straight into the awake set with createBody; touching
// contacts are seeded by hand into state.graphContactSims (no Vecs world, no
// broad/narrow phase). Covers makeSoft, the gravity consistency check, a resting
// contact, restitution, friction, and warm-start.

import { Entity, World } from "@vworlds/vecs";
import { beforeEach, describe, expect, it } from "vitest";

import { installPhysics } from "../../src/index.js";
import { DYNAMIC_BODY, STATIC_BODY, type BodySim, type BodyState } from "../../src/engine/body.js";
import { makeContactSim, type ContactSim } from "../../src/engine/contact.js";
import { emptyManifoldPoint } from "../../src/engine/manifold/types.js";
import { AWAKE_SET, STATIC_SET, createBody } from "../../src/engine/solver_set.js";
import { getPhysics, type PhysicsState } from "../../src/engine/state.js";
import {
  makeSoft,
  makeStepContext,
  solve,
  warmStartContacts,
  prepareContacts,
  type ContactConstraint,
} from "../../src/engine/solver.js";

const ENTITY = { eid: 1 } as unknown as Entity;
const DT = 1 / 60;
const SUB_STEPS = 4;
const GY = -10;

let state: PhysicsState;

beforeEach(() => {
  const world = new World();
  installPhysics(world, { gravity: { x: 0, y: GY }, fixedTimeStep: DT, subSteps: SUB_STEPS });
  world.start();
  state = getPhysics(world);
});

/** Add a body straight to a solver set and return its handle index, sim, and
 * (for awake bodies) its state. */
function addBody(type: number, set = AWAKE_SET): { index: number; sim: BodySim; st?: BodyState } {
  const solverSet = state.solverSets[set]!;
  const handle = createBody(state.bodies, solverSet, ENTITY, type);
  const r = state.bodies.get(handle.index);
  return {
    index: handle.index,
    sim: solverSet.bodySims[r.localIndex]!,
    st: set === AWAKE_SET ? solverSet.bodyStates[r.localIndex]! : undefined,
  };
}

/** Seed a touching contact sim into the overflow graph color with a single
 * penetrating manifold point. `bodySimIndexA/B` are awake-set local indices
 * (NULL via -1). The normal points A->B. */
function seedContact(opts: {
  indexA: number;
  indexB: number;
  invMassA: number;
  invIA: number;
  invMassB: number;
  invIB: number;
  normalX: number;
  normalY: number;
  separation: number;
  anchorA: { x: number; y: number };
  anchorB: { x: number; y: number };
  friction?: number;
  restitution?: number;
  relativeVelocity?: number;
}): ContactSim {
  const sim = makeContactSim(0);
  sim.bodySimIndexA = opts.indexA;
  sim.bodySimIndexB = opts.indexB;
  sim.invMassA = opts.invMassA;
  sim.invIA = opts.invIA;
  sim.invMassB = opts.invMassB;
  sim.invIB = opts.invIB;
  sim.friction = opts.friction ?? 0;
  sim.restitution = opts.restitution ?? 0;

  const m = sim.manifold;
  m.normal.x = opts.normalX;
  m.normal.y = opts.normalY;
  m.pointCount = 1;
  const p = emptyManifoldPoint();
  p.anchorA = { x: opts.anchorA.x, y: opts.anchorA.y };
  p.anchorB = { x: opts.anchorB.x, y: opts.anchorB.y };
  p.separation = opts.separation;
  m.points[0] = p;

  // The solver reads only graphContactSims; no cold InternalContact record is
  // needed for these engine-level tests.
  state.graphContactSims.push(sim);
  return sim;
}

describe("makeSoft (b2MakeSoft)", () => {
  it("matches the hand-computed coefficients for a sample (hertz, zeta, h)", () => {
    const hertz = 30;
    const zeta = 10;
    const h = DT / SUB_STEPS;

    const omega = 2 * Math.PI * hertz;
    const a1 = 2 * zeta + h * omega;
    const a2 = h * omega * a1;
    const a3 = 1 / (1 + a2);

    const s = makeSoft(hertz, zeta, h);
    expect(s.biasRate).toBeCloseTo(omega / a1, 10);
    expect(s.massScale).toBeCloseTo(a2 * a3, 10);
    expect(s.impulseScale).toBeCloseTo(a3, 10);
  });

  it("returns the zero softness when hertz == 0", () => {
    const s = makeSoft(0, 10, 0.01);
    expect(s).toEqual({ biasRate: 0, massScale: 0, impulseScale: 0 });
  });

  it("satisfies massScale + impulseScale == 1 for non-zero hertz", () => {
    const s = makeSoft(60, 2, 0.004);
    expect(s.massScale + s.impulseScale).toBeCloseTo(1, 12);
  });
});

describe("makeStepContext", () => {
  it("sets h, invH, and softness from the world tunables", () => {
    const ctx = makeStepContext(state, DT, SUB_STEPS);
    expect(ctx.h).toBeCloseTo(DT / SUB_STEPS, 12);
    expect(ctx.invH).toBeCloseTo(SUB_STEPS / DT, 8);
    expect(ctx.subStepCount).toBe(SUB_STEPS);
    expect(ctx.contactSpeed).toBe(state.contactSpeed);
    expect(ctx.maxLinearVelocity).toBe(state.maximumLinearSpeed);
    expect(ctx.enableWarmStarting).toBe(true);
    // Static softness uses 2x the contact hertz so it must be stiffer (larger
    // biasRate) than the dynamic contact softness.
    expect(ctx.staticSoftness.biasRate).toBeGreaterThan(ctx.contactSoftness.biasRate);
  });

  it("zeroes the inverse step sizes when dt <= 0", () => {
    const ctx = makeStepContext(state, 0, SUB_STEPS);
    expect(ctx.h).toBe(0);
    expect(ctx.invH).toBe(0);
    expect(ctx.invDt).toBe(0);
  });
});

describe("solve with no contacts", () => {
  it("reproduces gravity free-fall on the body state (v = -g·h·subSteps)", () => {
    const { sim, st } = addBody(DYNAMIC_BODY);
    sim.invMass = 1;

    const ctx = makeStepContext(state, DT, SUB_STEPS);
    solve(state, ctx);

    // v = n·h·g = dt·g, matching the existing gravity integrator.
    expect(st!.vy).toBeCloseTo(DT * GY, 12);
    expect(st!.vx).toBe(0);
    // Delta-pose accumulated (solve does not finalize, so centre is untouched).
    expect(st!.deltaPosY).toBeLessThan(0);
    expect(sim.centerY).toBe(0);
  });

  it("early-returns on an empty awake set", () => {
    const ctx = makeStepContext(state, DT, SUB_STEPS);
    expect(() => solve(state, ctx)).not.toThrow();
  });
});

describe("solve with a resting contact", () => {
  it("arrests a dynamic body falling onto a static body and stores an impulse", () => {
    // Dynamic body (awake index 0) resting on a static body (null in solver).
    const dyn = addBody(DYNAMIC_BODY);
    dyn.sim.invMass = 1;
    dyn.sim.invInertia = 1;
    addBody(STATIC_BODY, STATIC_SET);

    // Give it a downward velocity as if it had been falling.
    dyn.st!.vy = -2;

    // Contact: dynamic is A, static is B (indexB = -1 = null). Normal points
    // A->B = downward. Penetrating (separation < 0).
    const contact = seedContact({
      indexA: 0,
      indexB: -1,
      invMassA: 1,
      invIA: 1,
      invMassB: 0,
      invIB: 0,
      normalX: 0,
      normalY: -1,
      separation: -0.01,
      anchorA: { x: 0, y: 0 },
      anchorB: { x: 0, y: 0 },
    });

    const ctx = makeStepContext(state, DT, SUB_STEPS);
    solve(state, ctx);

    // The downward fall is arrested (no longer falling through).
    expect(dyn.st!.vy).toBeGreaterThan(-0.5);
    expect(dyn.st!.vy).toBeLessThanOrEqual(0.0001);
    // A normal impulse was stored back on the manifold.
    expect(contact.manifold.points[0]!.normalImpulse).toBeGreaterThan(0);
  });

  it("does not write back to a static body's state", () => {
    // Static body is A (awake-set static stand-in via null index), dynamic is B.
    const dyn = addBody(DYNAMIC_BODY);
    dyn.sim.invMass = 1;
    dyn.sim.invInertia = 1;
    dyn.st!.vy = -3;

    seedContact({
      indexA: -1, // static / null
      indexB: 0, // dynamic
      invMassA: 0,
      invIA: 0,
      invMassB: 1,
      invIB: 1,
      normalX: 0,
      normalY: 1, // A(static) -> B(dynamic) points up
      separation: -0.02,
      anchorA: { x: 0, y: 0 },
      anchorB: { x: 0, y: 0 },
    });

    const ctx = makeStepContext(state, DT, SUB_STEPS);
    solve(state, ctx);

    // The dynamic body B is pushed up (its downward fall arrested).
    expect(dyn.st!.vy).toBeGreaterThan(-1);
    // The static body has no awake state at all — there is exactly one awake
    // body, the dynamic one. The solver never created or touched a static state.
    expect(state.solverSets[AWAKE_SET]!.bodyStates.length).toBe(1);
  });
});

describe("solve with restitution", () => {
  it("reverses the normal velocity for a fast approach with restitution 1", () => {
    const dyn = addBody(DYNAMIC_BODY);
    dyn.sim.invMass = 1;
    dyn.sim.invInertia = 0;

    const approach = 5; // well beyond restitutionThreshold (default 1)
    dyn.st!.vy = -approach;

    seedContact({
      indexA: 0,
      indexB: -1,
      invMassA: 1,
      invIA: 0,
      invMassB: 0,
      invIB: 0,
      normalX: 0,
      normalY: -1, // A->B downward
      separation: -0.005,
      anchorA: { x: 0, y: 0 },
      anchorB: { x: 0, y: 0 },
      restitution: 1,
    });

    const ctx = makeStepContext(state, DT, SUB_STEPS);
    solve(state, ctx);

    // Bouncing: leaves with an upward (positive) velocity near the approach
    // speed (gravity over one step is small relative to the bounce).
    expect(dyn.st!.vy).toBeGreaterThan(0);
    expect(dyn.st!.vy).toBeGreaterThan(approach * 0.5);
  });
});

describe("solve with friction", () => {
  it("reduces tangential velocity, clamped to friction * normalImpulse", () => {
    const dyn = addBody(DYNAMIC_BODY);
    dyn.sim.invMass = 1;
    dyn.sim.invInertia = 0;

    // Moving sideways (tangential) and pressing down into the surface.
    dyn.st!.vx = 4;
    dyn.st!.vy = -2;

    seedContact({
      indexA: 0,
      indexB: -1,
      invMassA: 1,
      invIA: 0,
      invMassB: 0,
      invIB: 0,
      normalX: 0,
      normalY: -1, // A->B downward; tangent = rightPerp(normal) = (-1, 0)
      separation: -0.01,
      anchorA: { x: 0, y: 0 },
      anchorB: { x: 0, y: 0 },
      friction: 0.3,
    });

    const before = dyn.st!.vx;
    const ctx = makeStepContext(state, DT, SUB_STEPS);
    solve(state, ctx);

    // Friction opposes the slide: tangential speed is reduced.
    expect(Math.abs(dyn.st!.vx)).toBeLessThan(Math.abs(before));
    expect(dyn.st!.vx).toBeGreaterThan(0); // not over-corrected past zero
  });
});

describe("warmStartContacts", () => {
  it("applies the stored impulse to body velocities", () => {
    const dyn = addBody(DYNAMIC_BODY);
    dyn.sim.invMass = 1;
    dyn.sim.invInertia = 0;

    seedContact({
      indexA: 0,
      indexB: -1,
      invMassA: 1,
      invIA: 0,
      invMassB: 0,
      invIB: 0,
      normalX: 0,
      normalY: -1, // A->B downward
      separation: -0.01,
      anchorA: { x: 0, y: 0 },
      anchorB: { x: 0, y: 0 },
    });

    const ctx = makeStepContext(state, DT, SUB_STEPS);

    // Build constraints and prepare, then plant a stored normal impulse and
    // warm-start: the body A gets pushed by -mA * (impulse * normal).
    const c = makeFreshConstraint();
    const constraints: ContactConstraint[] = [c];
    prepareContacts(state, ctx, constraints);

    // Plant a stored impulse on the (already-prepared) constraint point.
    c.points[0]!.normalImpulse = 1.5;
    dyn.st!.vx = 0;
    dyn.st!.vy = 0;

    warmStartContacts(state, ctx, constraints);

    // P = normalImpulse * normal = 1.5 * (0,-1); vA += -mA * P = -(0,-1.5) = (0, +1.5)
    expect(dyn.st!.vy).toBeCloseTo(1.5, 6);
  });
});

/** Allocate an empty ContactConstraint shaped object for prepare to fill. */
function makeFreshConstraint(): ContactConstraint {
  const pt = () => ({
    anchorAx: 0,
    anchorAy: 0,
    anchorBx: 0,
    anchorBy: 0,
    baseSeparation: 0,
    normalImpulse: 0,
    tangentImpulse: 0,
    totalNormalImpulse: 0,
    normalMass: 0,
    tangentMass: 0,
    relativeVelocity: 0,
  });
  return {
    indexA: 0,
    indexB: 0,
    normalX: 0,
    normalY: 0,
    friction: 0,
    restitution: 0,
    rollingResistance: 0,
    rollingImpulse: 0,
    tangentSpeed: 0,
    pointCount: 0,
    softness: { biasRate: 0, massScale: 0, impulseScale: 0 },
    invMassA: 0,
    invIA: 0,
    invMassB: 0,
    invIB: 0,
    rollingMass: 0,
    points: [pt(), pt()],
  };
}
