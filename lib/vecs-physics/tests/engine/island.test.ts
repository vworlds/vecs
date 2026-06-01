// Island graph (VP-16): create / merge / link / unlink + body-island hooks.
// Engine-level — exercised straight on the PhysicsState, no systems layer.

import type { Entity } from "@vworlds/vecs";
import { describe, expect, it } from "vitest";

import { DYNAMIC_BODY, type InternalBody } from "../../src/engine/body.js";
import { createContact, type InternalContact } from "../../src/engine/contact.js";
import {
  addContactToIsland,
  createIsland,
  createIslandForBody,
  destroyIsland,
  linkContact,
  mergeIslands,
  removeBodyFromIsland,
  unlinkContact,
} from "../../src/engine/island.js";
import { createShape, makeCircleShape, type InternalShape } from "../../src/engine/shape.js";
import { AWAKE_SET, createBody, destroyBody } from "../../src/engine/solver_set.js";
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

/** Create a dynamic body in the awake set (auto-creates its singleton island)
 * and return its handle. */
function makeBody(state: PhysicsState): BodyHandle {
  return createBody(state, state.solverSets[AWAKE_SET]!, ENTITY, DYNAMIC_BODY);
}

/** Attach a default circle shape to `bodyHandle`, return its handle index. */
function makeShapeOn(state: PhysicsState, bodyHandle: BodyHandle): number {
  const shape: InternalShape = makeCircleShape(0.5, IDENTITY);
  shape.bodyHandle = bodyHandle;
  return createShape(state.shapes, shape).index;
}

/** Create a touching contact between two bodies (via their shapes) and return
 * the InternalContact, with islandId pre-set as if it had begun touching.
 * Mirrors what the narrow phase (VP-15b) would do before calling linkContact. */
function makeContactBetween(
  state: PhysicsState,
  bodyA: BodyHandle,
  bodyB: BodyHandle
): InternalContact {
  const sA = makeShapeOn(state, bodyA);
  const sB = makeShapeOn(state, bodyB);
  createContact(state, sA, sB);
  // The most recently created contact is at the highest live id; with a single
  // contact per test it is id 0, but resolve via the body's contact list head.
  const contact = state.contacts.get(state.bodies.get(bodyA.index).headContactKey >> 1);
  return contact;
}

describe("createIslandForBody", () => {
  it("gives a dynamic body a singleton island", () => {
    const state = makeState();
    const h = makeBody(state);
    const body = state.bodies.get(h.index);

    expect(body.islandId).not.toBe(NULL_INDEX);
    expect(body.islandIndex).toBe(0);

    const island = state.islands.get(body.islandId);
    expect(island.bodies).toEqual([h.index]);
    expect(island.setIndex).toBe(AWAKE_SET);

    // One islandSim registered in the awake set.
    expect(state.solverSets[AWAKE_SET]!.islandSims).toHaveLength(1);
    expect(state.solverSets[AWAKE_SET]!.islandSims[0]!.islandId).toBe(body.islandId);
    expect(island.localIndex).toBe(0);
  });
});

describe("createIsland / destroyIsland", () => {
  it("registers and swap-removes islandSims, fixing the moved island's localIndex", () => {
    const state = makeState();
    const i0 = createIsland(state, AWAKE_SET);
    const i1 = createIsland(state, AWAKE_SET);
    const i2 = createIsland(state, AWAKE_SET);
    const sims = state.solverSets[AWAKE_SET]!.islandSims;
    expect(sims.map((s) => s.islandId)).toEqual([i0.islandId, i1.islandId, i2.islandId]);
    expect([i0.localIndex, i1.localIndex, i2.localIndex]).toEqual([0, 1, 2]);

    // Destroy the middle island: i2 swaps into slot 1.
    destroyIsland(state, i1.islandId);
    expect(sims).toHaveLength(2);
    expect(sims.map((s) => s.islandId)).toEqual([i0.islandId, i2.islandId]);
    expect(i2.localIndex).toBe(1);
    expect(state.islands.records[i1.islandId]).toBeUndefined();
  });
});

describe("linkContact / mergeIslands", () => {
  it("merges two singleton islands into one carrying both bodies and the link", () => {
    const state = makeState();
    const a = makeBody(state);
    const b = makeBody(state);
    const islandA = state.bodies.get(a.index).islandId;
    const islandB = state.bodies.get(b.index).islandId;
    expect(islandA).not.toBe(islandB);

    const contact = makeContactBetween(state, a, b);
    linkContact(state, contact);

    // One island destroyed; the survivor is one of the two.
    const survivor = state.bodies.get(a.index).islandId;
    expect(survivor).toBe(state.bodies.get(b.index).islandId);
    expect([islandA, islandB]).toContain(survivor);
    const destroyed = survivor === islandA ? islandB : islandA;
    expect(state.islands.records[destroyed]).toBeUndefined();
    expect(state.solverSets[AWAKE_SET]!.islandSims).toHaveLength(1);

    const island = state.islands.get(survivor);
    expect(island.bodies).toHaveLength(2);
    expect(island.bodies).toContain(a.index);
    expect(island.bodies).toContain(b.index);

    // Both bodies point at the survivor with consistent indices.
    for (const h of [a, b]) {
      const body = state.bodies.get(h.index);
      expect(body.islandId).toBe(survivor);
      expect(island.bodies[body.islandIndex]).toBe(h.index);
    }

    // The contact link is recorded with cached body ids.
    expect(island.contacts).toHaveLength(1);
    expect(contact.islandId).toBe(survivor);
    expect(contact.islandIndex).toBe(0);
    expect(island.contacts[0]).toMatchObject({
      contactId: contact.contactId,
      bodyIdA: a.index,
      bodyIdB: b.index,
    });
  });

  it("just adds the link when both bodies already share an island", () => {
    const state = makeState();
    const a = makeBody(state);
    const b = makeBody(state);

    const c1 = makeContactBetween(state, a, b);
    linkContact(state, c1);
    const survivor = state.bodies.get(a.index).islandId;
    const islandSimsAfterFirst = state.solverSets[AWAKE_SET]!.islandSims.length;

    // A second contact between the same (now merged) bodies just appends a link;
    // no island is created or destroyed.
    const sA = makeShapeOn(state, a);
    const sB = makeShapeOn(state, b);
    createContact(state, sA, sB);
    // The second contact is the new list head on body A.
    const c2 = state.contacts.get(state.bodies.get(a.index).headContactKey >> 1);
    expect(c2.contactId).not.toBe(c1.contactId);

    linkContact(state, c2);

    expect(state.solverSets[AWAKE_SET]!.islandSims).toHaveLength(islandSimsAfterFirst);
    const island = state.islands.get(survivor);
    expect(island.contacts).toHaveLength(2);
    expect(c2.islandId).toBe(survivor);
    expect(c2.islandIndex).toBe(1);
  });

  it("keeps the bigger island when merging asymmetric islands", () => {
    const state = makeState();
    // Build a 2-body island (a+b) and a singleton (c).
    const a = makeBody(state);
    const b = makeBody(state);
    const c = makeBody(state);

    const cAB = makeContactBetween(state, a, b);
    linkContact(state, cAB);
    const bigId = state.bodies.get(a.index).islandId; // 2 bodies
    const smallId = state.bodies.get(c.index).islandId; // 1 body
    expect(state.islands.get(bigId).bodies).toHaveLength(2);
    expect(state.islands.get(smallId).bodies).toHaveLength(1);

    // Link a contact between b (in big) and c (singleton): big survives.
    const cBC = makeContactBetween(state, b, c);
    const survivor = mergeIslands(state, bigId, smallId);
    expect(survivor).toBe(bigId);
    addContactToIsland(state, survivor, cBC);

    expect(state.islands.records[smallId]).toBeUndefined();
    expect(state.islands.get(bigId).bodies).toHaveLength(3);
    expect(state.bodies.get(c.index).islandId).toBe(bigId);
  });

  it("mergeIslands handles null ids and identical ids", () => {
    const state = makeState();
    const a = makeBody(state);
    const islandA = state.bodies.get(a.index).islandId;
    expect(mergeIslands(state, islandA, islandA)).toBe(islandA);
    expect(mergeIslands(state, NULL_INDEX, islandA)).toBe(islandA);
    expect(mergeIslands(state, islandA, NULL_INDEX)).toBe(islandA);
  });
});

describe("unlinkContact", () => {
  it("removes the link and increments constraintRemoveCount (no split)", () => {
    const state = makeState();
    const a = makeBody(state);
    const b = makeBody(state);
    const contact = makeContactBetween(state, a, b);
    linkContact(state, contact);
    const survivor = state.bodies.get(a.index).islandId;
    const island = state.islands.get(survivor);
    expect(island.contacts).toHaveLength(1);
    expect(island.constraintRemoveCount).toBe(0);

    unlinkContact(state, contact);

    expect(island.contacts).toHaveLength(0);
    expect(island.constraintRemoveCount).toBe(1);
    expect(contact.islandId).toBe(NULL_INDEX);
    expect(contact.islandIndex).toBe(NULL_INDEX);
    // No split: the island is NOT destroyed even though it has no contacts.
    expect(state.islands.records[survivor]).toBeDefined();
  });

  it("swap-removes a link and fixes the moved link's islandIndex", () => {
    const state = makeState();
    const a = makeBody(state);
    const b = makeBody(state);

    const c1 = makeContactBetween(state, a, b);
    linkContact(state, c1);
    const survivor = state.bodies.get(a.index).islandId;

    const sA = makeShapeOn(state, a);
    const sB = makeShapeOn(state, b);
    createContact(state, sA, sB);
    const c2 = state.contacts.get(state.bodies.get(a.index).headContactKey >> 1);
    linkContact(state, c2);

    const island = state.islands.get(survivor);
    expect(island.contacts).toHaveLength(2);
    expect(c1.islandIndex).toBe(0);
    expect(c2.islandIndex).toBe(1);

    // Remove c1 (index 0): c2 swaps into slot 0 and its islandIndex must follow.
    unlinkContact(state, c1);
    expect(island.contacts).toHaveLength(1);
    expect(island.contacts[0]!.contactId).toBe(c2.contactId);
    expect(c2.islandIndex).toBe(0);
    expect(island.constraintRemoveCount).toBe(1);
  });
});

describe("removeBodyFromIsland", () => {
  it("destroys the island when the last body is removed", () => {
    const state = makeState();
    const a = makeBody(state);
    const body = state.bodies.get(a.index);
    const islandId = body.islandId;
    expect(state.solverSets[AWAKE_SET]!.islandSims).toHaveLength(1);

    removeBodyFromIsland(state, body);

    expect(body.islandId).toBe(NULL_INDEX);
    expect(body.islandIndex).toBe(NULL_INDEX);
    expect(state.islands.records[islandId]).toBeUndefined();
    expect(state.solverSets[AWAKE_SET]!.islandSims).toHaveLength(0);
  });

  it("swap-removes and fixes the moved body's islandIndex with two bodies", () => {
    const state = makeState();
    const a = makeBody(state);
    const b = makeBody(state);
    // Merge into one island holding [a, b].
    const contact = makeContactBetween(state, a, b);
    linkContact(state, contact);
    unlinkContact(state, contact); // drop the contact so the island can empty
    const survivor = state.bodies.get(a.index).islandId;
    const island = state.islands.get(survivor);
    expect(island.bodies).toHaveLength(2);

    // Remove the body at island index 0: the body at index 1 swaps into slot 0
    // and its islandIndex must be repaired to 0.
    const firstBody = state.bodies.get(island.bodies[0]!);
    const secondId = island.bodies[1]!;
    removeBodyFromIsland(state, firstBody);

    expect(island.bodies).toHaveLength(1);
    expect(island.bodies[0]).toBe(secondId);
    expect(state.bodies.get(secondId).islandIndex).toBe(0);
    expect(state.islands.records[survivor]).toBeDefined();
    expect(firstBody.islandId).toBe(NULL_INDEX);
    expect(firstBody.islandIndex).toBe(NULL_INDEX);
  });
});

describe("createBody / destroyBody island wiring", () => {
  it("createBody auto-creates a singleton island; destroyBody removes it", () => {
    const state = makeState();
    const h = makeBody(state);
    const body: InternalBody = state.bodies.get(h.index);
    const islandId = body.islandId;
    expect(islandId).not.toBe(NULL_INDEX);
    expect(state.solverSets[AWAKE_SET]!.islandSims).toHaveLength(1);

    // destroyBody (no attached contacts → singleton island) removes the island.
    destroyBody(state, state.solverSets[AWAKE_SET]!, h);

    expect(state.islands.records[islandId]).toBeUndefined();
    expect(state.solverSets[AWAKE_SET]!.islandSims).toHaveLength(0);
  });

  it("static bodies do not get an island", () => {
    const state = makeState();
    const h = createBody(state, state.solverSets[AWAKE_SET]!, ENTITY, 0 /* STATIC_BODY */);
    expect(state.bodies.get(h.index).islandId).toBe(NULL_INDEX);
    expect(state.solverSets[AWAKE_SET]!.islandSims).toHaveLength(0);
  });
});
