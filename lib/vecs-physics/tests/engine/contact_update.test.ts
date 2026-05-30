// Tests for the VP-15b narrow-phase contact update + graph add/remove
// (engine/contact.ts: updateContact / addContactToGraph / removeContactFromGraph).
//
// Mirrors the body/shape setup of tests/engine/contact.test.ts and
// tests/engine/narrow_phase.test.ts. Each contact's manifold is refreshed by
// updateContact (ported from b2UpdateContact), then moved into / out of the
// single overflow graph color.

import type { Entity } from "@vworlds/vecs";
import { describe, expect, it } from "vitest";

import { DYNAMIC_BODY, STATIC_BODY } from "../../src/engine/body.js";
import {
  addContactToGraph,
  makeContactSim,
  mixFriction,
  mixRestitution,
  removeContactFromGraph,
  updateContact,
  OVERFLOW_COLOR,
  SIM_TOUCHING_FLAG,
  type ContactSim,
} from "../../src/engine/contact.js";
import { createShape, makeCircleShape, type InternalShape } from "../../src/engine/shape.js";
import { AWAKE_SET, STATIC_SET, createBody } from "../../src/engine/solver_set.js";
import { PhysicsState, type ResolvedPhysicsOptions } from "../../src/engine/state.js";
import { IDENTITY, type Transform } from "../../src/math/transform.js";
import type { Vec2 } from "../../src/math/vec2.js";
import { NULL_INDEX, type BodyHandle } from "../../src/util/handle.js";

const ENTITY = { eid: 1 } as unknown as Entity;

const OPTIONS: ResolvedPhysicsOptions = {
  gravityX: 0,
  gravityY: -10,
  fixedTimeStep: 1 / 60,
  subSteps: 4,
  debug: false,
  restitutionThreshold: 1,
  hitEventThreshold: 10,
  contactHertz: 30,
  contactDampingRatio: 10,
  contactSpeed: 3,
  maximumLinearSpeed: 400,
  enableSleep: true,
  enableContinuous: true,
};

function makeState(): PhysicsState {
  return new PhysicsState(OPTIONS);
}

function makeBody(state: PhysicsState, type = DYNAMIC_BODY): BodyHandle {
  const set = state.solverSets[type === STATIC_BODY ? STATIC_SET : AWAKE_SET]!;
  return createBody(state, set, ENTITY, type);
}

/** Create a circle shape (radius 0.5) on `bodyHandle`, with optional patches. */
function makeShapeOn(
  state: PhysicsState,
  bodyHandle: BodyHandle,
  patch: Partial<InternalShape> = {}
): number {
  const shape = makeCircleShape(0.5, IDENTITY);
  shape.bodyHandle = bodyHandle;
  Object.assign(shape, patch);
  const handle = createShape(state.shapes, shape);
  return handle.index;
}

function xfAt(x: number, y: number): Transform {
  return { p: { x, y }, q: { c: 1, s: 0 } };
}

const ZERO: Vec2 = { x: 0, y: 0 };

describe("updateContact — touching status", () => {
  it("two overlapping circles → touching, points, SIM_TOUCHING_FLAG set", () => {
    const state = makeState();
    const a = makeBody(state);
    const b = makeBody(state);
    const sA = state.shapes.get(makeShapeOn(state, a));
    const sB = state.shapes.get(makeShapeOn(state, b));

    const sim = makeContactSim(0);
    // Centers 0.5 apart, radii 0.5+0.5 = 1 → overlapping.
    const touching = updateContact(state, sim, sA, xfAt(0, 0), ZERO, sB, xfAt(0.5, 0), ZERO);

    expect(touching).toBe(true);
    expect(sim.manifold.pointCount).toBeGreaterThan(0);
    expect(sim.simFlags & SIM_TOUCHING_FLAG).toBe(SIM_TOUCHING_FLAG);
  });

  it("separated shapes → not touching, flag cleared", () => {
    const state = makeState();
    const a = makeBody(state);
    const b = makeBody(state);
    const sA = state.shapes.get(makeShapeOn(state, a));
    const sB = state.shapes.get(makeShapeOn(state, b));

    const sim = makeContactSim(0);
    sim.simFlags |= SIM_TOUCHING_FLAG; // pre-set to prove it gets cleared.

    // Centers 5 apart, radii sum 1 → far apart.
    const touching = updateContact(state, sim, sA, xfAt(0, 0), ZERO, sB, xfAt(5, 0), ZERO);

    expect(touching).toBe(false);
    expect(sim.manifold.pointCount).toBe(0);
    expect(sim.simFlags & SIM_TOUCHING_FLAG).toBe(0);
  });

  it("shifts anchors to center-of-mass-relative", () => {
    const state = makeState();
    const a = makeBody(state);
    const b = makeBody(state);
    const sA = state.shapes.get(makeShapeOn(state, a));
    const sB = state.shapes.get(makeShapeOn(state, b));

    const offsetA: Vec2 = { x: 0.1, y: 0.2 };
    const offsetB: Vec2 = { x: -0.3, y: 0.05 };

    // Reference: same call with zero offsets gives body-origin-relative anchors.
    const ref = makeContactSim(0);
    updateContact(state, ref, sA, xfAt(0, 0), ZERO, sB, xfAt(0.5, 0), ZERO);

    const sim = makeContactSim(0);
    updateContact(state, sim, sA, xfAt(0, 0), offsetA, sB, xfAt(0.5, 0), offsetB);

    expect(sim.manifold.pointCount).toBe(ref.manifold.pointCount);
    for (let i = 0; i < sim.manifold.pointCount; i++) {
      const p = sim.manifold.points[i]!;
      const r = ref.manifold.points[i]!;
      expect(p.anchorA.x).toBeCloseTo(r.anchorA.x - offsetA.x, 10);
      expect(p.anchorA.y).toBeCloseTo(r.anchorA.y - offsetA.y, 10);
      expect(p.anchorB.x).toBeCloseTo(r.anchorB.x - offsetB.x, 10);
      expect(p.anchorB.y).toBeCloseTo(r.anchorB.y - offsetB.y, 10);
    }
  });
});

describe("updateContact — material refresh", () => {
  it("refreshes friction/restitution via the mixing formulae and sums tangentSpeed", () => {
    const state = makeState();
    const a = makeBody(state);
    const b = makeBody(state);
    const sA = state.shapes.get(
      makeShapeOn(state, a, { friction: 0.4, restitution: 0.2, tangentSpeed: 1.5 })
    );
    const sB = state.shapes.get(
      makeShapeOn(state, b, { friction: 0.9, restitution: 0.7, tangentSpeed: -0.5 })
    );

    const sim = makeContactSim(0);
    updateContact(state, sim, sA, xfAt(0, 0), ZERO, sB, xfAt(0.5, 0), ZERO);

    expect(sim.friction).toBeCloseTo(mixFriction(0.4, 0.9), 10);
    expect(sim.restitution).toBe(mixRestitution(0.2, 0.7));
    expect(sim.tangentSpeed).toBeCloseTo(1.0, 10);
  });

  it("rolling resistance is max(rrA,rrB) * max(radius) when either is set, else 0", () => {
    const state = makeState();
    const a = makeBody(state);
    const b = makeBody(state);
    // Circle radius 0.5; rrA = 0.3, rrB = 0.1.
    const sA = state.shapes.get(makeShapeOn(state, a, { rollingResistance: 0.3 }));
    const sB = state.shapes.get(makeShapeOn(state, b, { rollingResistance: 0.1 }));

    const sim = makeContactSim(0);
    updateContact(state, sim, sA, xfAt(0, 0), ZERO, sB, xfAt(0.5, 0), ZERO);
    expect(sim.rollingResistance).toBeCloseTo(0.3 * 0.5, 10);

    // Neither set → 0.
    const sC = state.shapes.get(makeShapeOn(state, a));
    const sD = state.shapes.get(makeShapeOn(state, b));
    const sim2 = makeContactSim(0);
    updateContact(state, sim2, sC, xfAt(0, 0), ZERO, sD, xfAt(0.5, 0), ZERO);
    expect(sim2.rollingResistance).toBe(0);
  });

  it("sets/clears SIM_ENABLE_HIT_EVENT from the shapes' enableHitEvents", () => {
    const state = makeState();
    const a = makeBody(state);
    const b = makeBody(state);
    const sA = state.shapes.get(makeShapeOn(state, a, { enableHitEvents: true }));
    const sB = state.shapes.get(makeShapeOn(state, b));

    const sim = makeContactSim(0);
    // Touching + a shape opted in → flag set. SIM_ENABLE_HIT_EVENT = 0x00100000.
    updateContact(state, sim, sA, xfAt(0, 0), ZERO, sB, xfAt(0.5, 0), ZERO);
    expect(sim.simFlags & 0x00100000).toBe(0x00100000);

    // Not touching → flag cleared.
    updateContact(state, sim, sA, xfAt(0, 0), ZERO, sB, xfAt(5, 0), ZERO);
    expect(sim.simFlags & 0x00100000).toBe(0);
  });
});

describe("updateContact — warm-start carry", () => {
  it("carries normalImpulse/tangentImpulse onto id-matched points and zeroes unmatched", () => {
    const state = makeState();
    const a = makeBody(state);
    const b = makeBody(state);
    const sA = state.shapes.get(makeShapeOn(state, a));
    const sB = state.shapes.get(makeShapeOn(state, b));

    const sim = makeContactSim(0);

    // First update establishes the manifold + point ids.
    updateContact(state, sim, sA, xfAt(0, 0), ZERO, sB, xfAt(0.5, 0), ZERO);
    expect(sim.manifold.pointCount).toBeGreaterThan(0);

    // Stand in for the solver: store impulses on the existing points so the
    // second update can carry them onto id-matched new points.
    const p0 = sim.manifold.points[0]!;
    const matchedId = p0.id;
    p0.normalImpulse = 12.5;
    p0.tangentImpulse = -3.25;

    // Second update with the same geometry → same point id → carry.
    updateContact(state, sim, sA, xfAt(0, 0), ZERO, sB, xfAt(0.5, 0), ZERO);

    const carried = sim.manifold.points.find(
      (p, i) => i < sim.manifold.pointCount && p.id === matchedId
    )!;
    expect(carried.persisted).toBe(true);
    expect(carried.normalImpulse).toBeCloseTo(12.5, 10);
    expect(carried.tangentImpulse).toBeCloseTo(-3.25, 10);
  });

  it("does not carry impulses when the contact id no longer matches", () => {
    const state = makeState();
    const a = makeBody(state);
    const b = makeBody(state);
    const sA = state.shapes.get(makeShapeOn(state, a));
    const sB = state.shapes.get(makeShapeOn(state, b));

    const sim = makeContactSim(0);
    updateContact(state, sim, sA, xfAt(0, 0), ZERO, sB, xfAt(0.5, 0), ZERO);

    // Forge an old impulse under an id that the next manifold won't produce.
    const p0 = sim.manifold.points[0]!;
    p0.id = 0xfeed;
    p0.normalImpulse = 99;
    p0.tangentImpulse = 99;

    updateContact(state, sim, sA, xfAt(0, 0), ZERO, sB, xfAt(0.5, 0), ZERO);

    for (let i = 0; i < sim.manifold.pointCount; i++) {
      const p = sim.manifold.points[i]!;
      expect(p.persisted).toBe(false);
      expect(p.normalImpulse).toBe(0);
      expect(p.tangentImpulse).toBe(0);
    }
  });
});

describe("addContactToGraph / removeContactFromGraph (overflow path)", () => {
  /** Build a touching contact + sim ready to add to the graph. */
  function makeTouching(
    state: PhysicsState,
    bodyA: BodyHandle,
    bodyB: BodyHandle
  ): { sim: ContactSim; contactId: number } {
    const sA = state.shapes.get(makeShapeOn(state, bodyA));
    const sB = state.shapes.get(makeShapeOn(state, bodyB));

    // A minimal cold contact record with both edges wired to the bodies.
    const contactId = state.contacts.idPool.allocate().index;
    const contact = {
      edges: [
        { bodyId: bodyA.index, prevKey: NULL_INDEX, nextKey: NULL_INDEX },
        { bodyId: bodyB.index, prevKey: NULL_INDEX, nextKey: NULL_INDEX },
      ] as [
        { bodyId: number; prevKey: number; nextKey: number },
        { bodyId: number; prevKey: number; nextKey: number },
      ],
      islandId: NULL_INDEX,
      islandIndex: NULL_INDEX,
      setIndex: AWAKE_SET,
      colorIndex: NULL_INDEX,
      localIndex: NULL_INDEX,
      shapeIdA: NULL_INDEX,
      shapeIdB: NULL_INDEX,
      contactId,
      flags: 0,
    };
    state.contacts.records[contactId] = contact;

    const sim = makeContactSim(contactId);
    updateContact(state, sim, sA, xfAt(0, 0), ZERO, sB, xfAt(0.5, 0), ZERO);
    return { sim, contactId };
  }

  it("pushes the sim, sets colorIndex/localIndex, refreshes indices + inverse masses", () => {
    const state = makeState();
    const a = makeBody(state, DYNAMIC_BODY);
    const b = makeBody(state, STATIC_BODY);

    // Seed an inverse mass on the dynamic body's sim.
    state.solverSets[AWAKE_SET]!.bodySims[state.bodies.get(a.index).localIndex]!.invMass = 4;
    state.solverSets[AWAKE_SET]!.bodySims[state.bodies.get(a.index).localIndex]!.invInertia = 9;

    const { sim, contactId } = makeTouching(state, a, b);
    const contact = state.contacts.get(contactId);

    addContactToGraph(state, sim, contact);

    expect(state.graphContactSims).toHaveLength(1);
    expect(state.graphContactSims[0]).toBe(sim); // move-the-reference.
    expect(contact.colorIndex).toBe(OVERFLOW_COLOR);
    expect(contact.localIndex).toBe(0);

    // Dynamic side A: index = localIndex, inverse masses from the body sim.
    expect(sim.bodySimIndexA).toBe(state.bodies.get(a.index).localIndex);
    expect(sim.invMassA).toBe(4);
    expect(sim.invIA).toBe(9);

    // Static side B: NULL_INDEX, zeroed.
    expect(sim.bodySimIndexB).toBe(NULL_INDEX);
    expect(sim.invMassB).toBe(0);
    expect(sim.invIB).toBe(0);
  });

  it("throws if the contact is not touching", () => {
    const state = makeState();
    const a = makeBody(state);
    const b = makeBody(state);
    const sA = state.shapes.get(makeShapeOn(state, a));
    const sB = state.shapes.get(makeShapeOn(state, b));
    const contactId = state.contacts.idPool.allocate().index;
    const contact = {
      edges: [
        { bodyId: a.index, prevKey: NULL_INDEX, nextKey: NULL_INDEX },
        { bodyId: b.index, prevKey: NULL_INDEX, nextKey: NULL_INDEX },
      ] as [
        { bodyId: number; prevKey: number; nextKey: number },
        { bodyId: number; prevKey: number; nextKey: number },
      ],
      islandId: NULL_INDEX,
      islandIndex: NULL_INDEX,
      setIndex: AWAKE_SET,
      colorIndex: NULL_INDEX,
      localIndex: NULL_INDEX,
      shapeIdA: NULL_INDEX,
      shapeIdB: NULL_INDEX,
      contactId,
      flags: 0,
    };
    state.contacts.records[contactId] = contact;

    const sim = makeContactSim(contactId);
    // Separated → not touching.
    updateContact(state, sim, sA, xfAt(0, 0), ZERO, sB, xfAt(5, 0), ZERO);

    expect(() => addContactToGraph(state, sim, contact)).toThrow();
  });

  it("swap-removes and repairs the moved contact's localIndex", () => {
    const state = makeState();
    const a0 = makeBody(state);
    const b0 = makeBody(state);
    const a1 = makeBody(state);
    const b1 = makeBody(state);

    const c0 = makeTouching(state, a0, b0);
    const c1 = makeTouching(state, a1, b1);

    addContactToGraph(state, c0.sim, state.contacts.get(c0.contactId)); // localIndex 0
    addContactToGraph(state, c1.sim, state.contacts.get(c1.contactId)); // localIndex 1

    expect(state.graphContactSims).toHaveLength(2);
    expect(state.contacts.get(c1.contactId).localIndex).toBe(1);

    // Remove index 0: c1's sim swaps into slot 0; its localIndex must be repaired.
    removeContactFromGraph(state, 0);

    expect(state.graphContactSims).toHaveLength(1);
    expect(state.graphContactSims[0]).toBe(c1.sim);
    expect(state.contacts.get(c1.contactId).localIndex).toBe(0);
  });
});
