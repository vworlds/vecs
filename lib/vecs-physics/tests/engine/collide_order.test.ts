// M3-contact-state-change-order regression test.
//
// Box2D's `b2Collide` processes touch-state changes in ASCENDING contact-id
// order (it peels the lowest set bit of a per-contact bitset). Our `collide`
// tracks changes in a `Set` and must sort them to the same order before
// applying them, otherwise the post-loop `graphContactSims` order — which the
// solver iterates — diverges from Box2D once sims have swap-moved between the
// awake set and the graph.
//
// This test forces the awake-set `contactSims` array order to differ from
// ascending contact-id order (by freeing a contact id and reusing it out of
// position), then makes every contact start touching in one `collide` pass and
// asserts the graph ends up in ascending contact-id order.

import type { Entity } from "@vworlds/vecs";
import { describe, expect, it } from "vitest";

import { DYNAMIC_BODY } from "../../src/engine/body.js";
import { collide } from "../../src/engine/collide.js";
import { createContact, destroyContact } from "../../src/engine/contact.js";
import { makeStepContext } from "../../src/engine/solver.js";
import { createShape, makeCircleShape, type InternalShape } from "../../src/engine/shape.js";
import { AWAKE_SET, createBody } from "../../src/engine/solver_set.js";
import { PhysicsState, type ResolvedPhysicsOptions } from "../../src/engine/state.js";
import { IDENTITY } from "../../src/math/transform.js";
import type { BodyHandle } from "../../src/util/handle.js";

const ENTITY = { eid: 1 } as unknown as Entity;

const OPTIONS: ResolvedPhysicsOptions = {
  gravityX: 0,
  gravityY: -10,
  fixedTimeStep: 1 / 60,
  subSteps: 4,
  debug: false,
  restitutionThreshold: 1,
  hitEventThreshold: 1,
  contactHertz: 30,
  contactDampingRatio: 10,
  contactSpeed: 3,
  maximumLinearSpeed: 400,
  enableSleep: true,
  enableContinuous: true,
};

// A fat AABB that overlaps everything else placed near the origin, so collide's
// broad-phase disjoint pre-check always passes and the narrow phase decides.
const WIDE_FAT = { fatAabbMinX: -10, fatAabbMinY: -10, fatAabbMaxX: 10, fatAabbMaxY: 10 };

function makeBody(state: PhysicsState, x: number): BodyHandle {
  const handle = createBody(state, state.solverSets[AWAKE_SET]!, ENTITY, DYNAMIC_BODY);
  const rec = state.bodies.get(handle.index);
  state.solverSets[AWAKE_SET]!.bodySims[rec.localIndex]!.transformX = x;
  return handle;
}

function makeShapeOn(state: PhysicsState, bodyHandle: BodyHandle): number {
  const shape = makeCircleShape(0.5, IDENTITY);
  shape.bodyHandle = bodyHandle;
  Object.assign(shape, WIDE_FAT as Partial<InternalShape>);
  return createShape(state.shapes, shape).index;
}

describe("collide state-change processing order", () => {
  it("moves newly-touching contacts into the graph in ascending contact-id order", () => {
    const state = new PhysicsState(OPTIONS);

    // A central body plus three satellites, each overlapping the centre (circle
    // radius 0.5, centres 0.2 apart → distance < 1.0 → touching) at distinct,
    // non-coincident positions so every manifold normal is well defined.
    const centre = makeBody(state, 0);
    const centreShape = makeShapeOn(state, centre);
    const satShapes = [
      makeShapeOn(state, makeBody(state, 0.2)),
      makeShapeOn(state, makeBody(state, -0.2)),
      makeShapeOn(state, makeBody(state, 0.3)),
    ];

    // Create the three contacts in order → ids 0,1,2, array order [0,1,2].
    createContact(state, centreShape, satShapes[0]!); // id 0
    createContact(state, centreShape, satShapes[1]!); // id 1
    createContact(state, centreShape, satShapes[2]!); // id 2

    const awake = state.solverSets[AWAKE_SET]!;

    // Free the middle contact (id 1). swap-remove leaves array order [0, 2].
    destroyContact(state, state.contacts.get(1), false);

    // Recreate the same pair → the id pool hands back id 1, appended at the end.
    // Array order is now [id0, id2, id1] — gather order no longer ascending.
    createContact(state, centreShape, satShapes[1]!); // reuses id 1
    expect(awake.contactSims.map((s) => s.contactId)).toEqual([0, 2, 1]);

    // One collide pass: all three start touching in the same step.
    collide(state, makeStepContext(state, OPTIONS.fixedTimeStep, OPTIONS.subSteps));

    // All three moved into the graph, and — matching Box2D — in ascending
    // contact-id order, regardless of the scrambled awake-set order they came
    // from. Before the sort fix this was [0, 2, 1] (gather order).
    expect(state.graphContactSims.map((s) => s.contactId)).toEqual([0, 1, 2]);
  });
});
