import type { Entity } from "@vworlds/vecs";
import { describe, expect, it } from "vitest";

import { DYNAMIC_BODY, STATIC_BODY } from "../../src/engine/body.js";
import {
  createContact,
  destroyContact,
  mixFriction,
  mixRestitution,
  shouldShapesCollide,
  OVERFLOW_COLOR,
  type InternalContact,
} from "../../src/engine/contact.js";
import { emptyManifold, emptyManifoldPoint } from "../../src/engine/manifold/types.js";
import { createShape, makeCircleShape, type InternalShape } from "../../src/engine/shape.js";
import { AWAKE_SET, createBody } from "../../src/engine/solver_set.js";
import { PhysicsState, type ResolvedPhysicsOptions } from "../../src/engine/state.js";
import { IDENTITY } from "../../src/math/transform.js";
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

/** Create a dynamic body (awake set) and return its handle. */
function makeBody(state: PhysicsState, type = DYNAMIC_BODY): BodyHandle {
  return createBody(state.bodies, state.solverSets[AWAKE_SET]!, ENTITY, type);
}

/** Create a default circle shape attached to `bodyHandle`, optionally tweaking
 * material/filter/event fields, and return its handle index. */
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

const DEFAULT_FILTER = { categoryBits: 1, maskBits: 0xffffffff, groupIndex: 0 };

describe("shouldShapesCollide", () => {
  it("collides by default filter", () => {
    expect(shouldShapesCollide(DEFAULT_FILTER, DEFAULT_FILTER)).toBe(true);
  });

  it("requires category/mask intersection both ways", () => {
    const a = { categoryBits: 0x0001, maskBits: 0x0002, groupIndex: 0 };
    const b = { categoryBits: 0x0002, maskBits: 0x0001, groupIndex: 0 };
    expect(shouldShapesCollide(a, b)).toBe(true);

    // b's mask no longer includes a's category → no collide.
    const c = { categoryBits: 0x0002, maskBits: 0x0004, groupIndex: 0 };
    expect(shouldShapesCollide(a, c)).toBe(false);
    expect(shouldShapesCollide(c, a)).toBe(false);
  });

  it("never collides for a negative shared group index", () => {
    const a = { categoryBits: 1, maskBits: 0xffffffff, groupIndex: -5 };
    const b = { categoryBits: 1, maskBits: 0xffffffff, groupIndex: -5 };
    expect(shouldShapesCollide(a, b)).toBe(false);
  });

  it("always collides for a positive shared group index, even with disjoint masks", () => {
    const a = { categoryBits: 0x0001, maskBits: 0x0000, groupIndex: 7 };
    const b = { categoryBits: 0x0002, maskBits: 0x0000, groupIndex: 7 };
    expect(shouldShapesCollide(a, b)).toBe(true);
  });

  it("falls back to mask test when group indices differ", () => {
    const a = { categoryBits: 1, maskBits: 0xffffffff, groupIndex: 3 };
    const b = { categoryBits: 1, maskBits: 0xffffffff, groupIndex: 4 };
    expect(shouldShapesCollide(a, b)).toBe(true);
  });
});

describe("mixing rules", () => {
  it("mixes friction as sqrt(a*b)", () => {
    expect(mixFriction(0.4, 0.9)).toBeCloseTo(Math.sqrt(0.36), 10);
  });
  it("mixes restitution as max(a,b)", () => {
    expect(mixRestitution(0.2, 0.7)).toBe(0.7);
  });
});

describe("manifold factories", () => {
  it("emptyManifoldPoint zeroes the solver fields", () => {
    const p = emptyManifoldPoint();
    expect(p.baseSeparation).toBe(0);
    expect(p.normalImpulse).toBe(0);
    expect(p.tangentImpulse).toBe(0);
    expect(p.totalNormalImpulse).toBe(0);
    expect(p.normalVelocity).toBe(0);
    expect(p.persisted).toBe(false);
  });

  it("emptyManifold zeroes rollingImpulse and all point solver fields", () => {
    const m = emptyManifold();
    expect(m.rollingImpulse).toBe(0);
    for (const p of m.points) {
      expect(p.normalImpulse).toBe(0);
      expect(p.persisted).toBe(false);
    }
  });
});

describe("createContact", () => {
  it("links edges into both bodies, increments counts, pushes a non-touching sim", () => {
    const state = makeState();
    const bodyA = makeBody(state);
    const bodyB = makeBody(state);
    const shapeA = makeShapeOn(state, bodyA, { friction: 0.4, restitution: 0.2 });
    const shapeB = makeShapeOn(state, bodyB, { friction: 0.9, restitution: 0.7 });

    createContact(state, shapeA, shapeB);

    const internalA = state.bodies.get(bodyA.index);
    const internalB = state.bodies.get(bodyB.index);

    // contactCount incremented on both bodies.
    expect(internalA.contactCount).toBe(1);
    expect(internalB.contactCount).toBe(1);

    // head keys encode (contactId << 1) | edge.
    const contactId = 0;
    expect(internalA.headContactKey).toBe((contactId << 1) | 0);
    expect(internalB.headContactKey).toBe((contactId << 1) | 1);

    const contact = state.contacts.get(contactId);
    expect(contact.edges[0].bodyId).toBe(bodyA.index);
    expect(contact.edges[1].bodyId).toBe(bodyB.index);
    expect(contact.edges[0].prevKey).toBe(NULL_INDEX);
    expect(contact.edges[0].nextKey).toBe(NULL_INDEX);
    expect(contact.colorIndex).toBe(NULL_INDEX);
    expect(contact.setIndex).toBe(AWAKE_SET);

    // A non-touching sim landed in the awake set's contactSims.
    const set = state.solverSets[AWAKE_SET]!;
    expect(set.contactSims).toHaveLength(1);
    const sim = set.contactSims[0]!;
    expect(sim.contactId).toBe(contactId);
    expect(sim.friction).toBeCloseTo(Math.sqrt(0.4 * 0.9), 10);
    expect(sim.restitution).toBe(0.7);

    // pairKey added to the broad phase.
    expect(state.broadPhase.hasPair(shapeA, shapeB)).toBe(true);
  });

  it("does not create a contact for an unregistered (segment-segment) pair", () => {
    // makeShapeOn always builds circles; force the type to Segment to hit the
    // canCollide() == false branch (segment-segment is unregistered).
    const state = makeState();
    const bodyA = makeBody(state);
    const bodyB = makeBody(state);
    const shapeA = makeShapeOn(state, bodyA, { type: 2 as InternalShape["type"] });
    const shapeB = makeShapeOn(state, bodyB, { type: 2 as InternalShape["type"] });

    createContact(state, shapeA, shapeB);
    expect(state.contacts.records.filter((c) => c !== undefined)).toHaveLength(0);
    expect(state.solverSets[AWAKE_SET]!.contactSims).toHaveLength(0);
  });

  it("sets the contact-events flag iff a shape opted in", () => {
    const state = makeState();
    const a = makeBody(state);
    const b = makeBody(state);
    const sA = makeShapeOn(state, a);
    const sB = makeShapeOn(state, b, { enableContactEvents: true });
    createContact(state, sA, sB);
    // CONTACT_ENABLE_CONTACT_EVENTS = 0x4
    expect(state.contacts.get(0).flags & 0x4).toBe(0x4);
  });
});

describe("contact linked list (two contacts on one body)", () => {
  it("maintains head/prev/next and re-links on destroy", () => {
    const state = makeState();
    const center = makeBody(state);
    const otherA = makeBody(state);
    const otherB = makeBody(state);

    const sCenter = makeShapeOn(state, center);
    const sA = makeShapeOn(state, otherA);
    const sB = makeShapeOn(state, otherB);

    createContact(state, sCenter, sA); // contact 0
    createContact(state, sCenter, sB); // contact 1

    const c0 = state.contacts.get(0);
    const c1 = state.contacts.get(1);
    const internalCenter = state.bodies.get(center.index);

    // The center body now has 2 contacts; head is the most-recently-added (c1).
    expect(internalCenter.contactCount).toBe(2);
    // Edge 0 of each contact is the center side (sCenter is shapeA).
    const headKey = internalCenter.headContactKey;
    expect(headKey).toBe((1 << 1) | 0); // contact 1, edge 0

    // c1's center edge points next to c0's center edge.
    expect(c1.edges[0].nextKey).toBe((0 << 1) | 0);
    expect(c0.edges[0].prevKey).toBe((1 << 1) | 0);
    expect(c0.edges[0].nextKey).toBe(NULL_INDEX);

    // Destroy the head (c1): head re-links to c0, count drops.
    destroyContact(state, c1, false);
    expect(internalCenter.headContactKey).toBe((0 << 1) | 0);
    expect(state.contacts.get(0).edges[0].prevKey).toBe(NULL_INDEX);
    expect(internalCenter.contactCount).toBe(1);
  });

  it("re-links correctly when destroying the tail", () => {
    const state = makeState();
    const center = makeBody(state);
    const a = makeBody(state);
    const b = makeBody(state);
    const sCenter = makeShapeOn(state, center);
    createContact(state, sCenter, makeShapeOn(state, a)); // c0 (tail)
    createContact(state, sCenter, makeShapeOn(state, b)); // c1 (head)

    destroyContact(state, state.contacts.get(0), false);
    const internalCenter = state.bodies.get(center.index);
    // head stays c1; c1's nextKey is now NULL (c0 removed).
    expect(internalCenter.headContactKey).toBe((1 << 1) | 0);
    expect(state.contacts.get(1).edges[0].nextKey).toBe(NULL_INDEX);
    expect(internalCenter.contactCount).toBe(1);
  });
});

describe("destroyContact", () => {
  it("unlinks edges, decrements counts, swap-removes the sim, repairs localIndex, removes the pair", () => {
    const state = makeState();
    const a = makeBody(state);
    const b = makeBody(state);
    const c = makeBody(state);
    const sA = makeShapeOn(state, a);
    const sB = makeShapeOn(state, b);
    const sC = makeShapeOn(state, c);

    createContact(state, sA, sB); // contact 0, localIndex 0
    createContact(state, sA, sC); // contact 1, localIndex 1

    const set = state.solverSets[AWAKE_SET]!;
    expect(set.contactSims).toHaveLength(2);

    // Destroy contact 0 (not the last sim): contact 1's sim swaps into slot 0
    // and its localIndex must be repaired to 0.
    const c0 = state.contacts.get(0);
    destroyContact(state, c0, false);

    expect(set.contactSims).toHaveLength(1);
    const moved = set.contactSims[0]!;
    expect(moved.contactId).toBe(1);
    expect(state.contacts.get(1).localIndex).toBe(0);

    // Body A had both contacts; now down to 1. Bodies B is now contact-free.
    expect(state.bodies.get(a.index).contactCount).toBe(1);
    expect(state.bodies.get(b.index).contactCount).toBe(0);
    expect(state.bodies.get(b.index).headContactKey).toBe(NULL_INDEX);

    // pairKey removed; the freed contact slot is gone.
    expect(state.broadPhase.hasPair(sA, sB)).toBe(false);
    expect(state.contacts.records[0]).toBeUndefined();
  });

  it("swap-removes from the overflow graph color when the contact is touching", () => {
    const state = makeState();
    const a = makeBody(state);
    const b = makeBody(state);
    createContact(state, makeShapeOn(state, a), makeShapeOn(state, b));

    // Simulate the touching state VP-15b/VP-17 would set: move the sim into the
    // overflow graph color and mark the contact's colorIndex.
    const set = state.solverSets[AWAKE_SET]!;
    const sim = set.contactSims.pop()!;
    const contact: InternalContact = state.contacts.get(0);
    contact.localIndex = state.graphContactSims.length;
    contact.colorIndex = OVERFLOW_COLOR;
    state.graphContactSims.push(sim);

    expect(state.graphContactSims).toHaveLength(1);
    destroyContact(state, contact, false);
    expect(state.graphContactSims).toHaveLength(0);
    expect(state.contacts.records[0]).toBeUndefined();
  });

  it("places a contact between two static bodies' shapes in the disabled set", () => {
    // Static-static cannot happen in practice (box2d asserts), but a kinematic
    // pair (both non-awake) exercises the disabled-set branch. Use static here
    // since neither lands in AWAKE_SET.
    const state = makeState();
    const a = createBody(state.bodies, state.solverSets[0]!, ENTITY, STATIC_BODY);
    const b = createBody(state.bodies, state.solverSets[0]!, ENTITY, STATIC_BODY);
    const sA = makeShapeOn(state, a);
    const sB = makeShapeOn(state, b);
    createContact(state, sA, sB);
    // setIndex is DISABLED_SET (1) since neither body is awake.
    expect(state.contacts.get(0).setIndex).toBe(1);
    expect(state.solverSets[1]!.contactSims).toHaveLength(1);
  });
});
