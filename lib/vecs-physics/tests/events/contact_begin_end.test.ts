// VP-21a / VP-21b: contact begin/end event recording — raw engine arrays and ECS
// publishing.
//
// Two test layers:
//   1. World-level integration — the full Vecs world pipeline. Now that VP-21b
//      (PhysicsEvents) is wired, the raw `state.contactBeginEvents` /
//      `state.contactEndEvents` are CLEARED at the END of PhysicsEvents.run
//      (ARCHITECT RESOLUTION from PROGRESS.md). World-level tests therefore check
//      the ECS `ContactEvents` component arrays (the user-facing surface), not the
//      raw engine arrays, which are always empty after world.progress.
//   2. Engine-level unit — directly calls destroyContact to validate the teardown
//      path without fighting the Vecs pipeline (these bypass world.progress entirely
//      so the raw arrays are visible before the PhysicsEvents clear).

import type { Entity } from "@vworlds/vecs";
import { ChildOf, World } from "@vworlds/vecs";
import { beforeEach, describe, expect, it } from "vitest";

import { Body, BodyType, Box, ContactEvents, Position, installPhysics } from "../../src/index.js";
import {
  CONTACT_ENABLE_CONTACT_EVENTS,
  CONTACT_TOUCHING_FLAG,
  createContact,
  destroyContact,
} from "../../src/engine/contact.js";
import { makeCircleShape, createShape } from "../../src/engine/shape.js";
import { AWAKE_SET, createBody } from "../../src/engine/solver_set.js";
import { getPhysics, PhysicsState, type ResolvedPhysicsOptions } from "../../src/engine/state.js";
import { IDENTITY } from "../../src/math/transform.js";
import { NULL_INDEX, type BodyHandle } from "../../src/util/handle.js";
import { DYNAMIC_BODY } from "../../src/engine/body.js";

// ─── Engine-level helpers ─────────────────────────────────────────────────────

const ENTITY = { eid: 99 } as unknown as Entity;

const OPTIONS: ResolvedPhysicsOptions = {
  gravityX: 0,
  gravityY: 0,
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

function makeEngineState(): PhysicsState {
  return new PhysicsState(OPTIONS);
}

function makeBodyEngine(state: PhysicsState): BodyHandle {
  return createBody(state, state.solverSets[AWAKE_SET]!, ENTITY, DYNAMIC_BODY);
}

function makeShapeOnBody(
  state: PhysicsState,
  bodyHandle: BodyHandle,
  enableContactEvents = false
): number {
  const shape = makeCircleShape(0.5, IDENTITY);
  shape.bodyHandle = bodyHandle;
  shape.enableContactEvents = enableContactEvents;
  const handle = createShape(state.shapes, shape);
  return handle.index;
}

// ─── World-level helpers ──────────────────────────────────────────────────────

const STEP_MS = 1000 / 60;

let world: World;
let state: PhysicsState;
let now: number;

beforeEach(() => {
  world = new World();
  installPhysics(world, { gravity: { x: 0, y: 0 } });
  world.start();
  state = getPhysics(world);
  now = 0;
});

function step(n = 1): void {
  for (let i = 0; i < n; i++) {
    now += STEP_MS;
    world.progress(now, STEP_MS);
  }
}

/** A dynamic 2×2 box at (x, y) with optional ContactEvents. */
function makeBox(x: number, y: number, withEvents = false) {
  const body = world.entity().set(Body, { type: BodyType.Dynamic }).set(Position, { x, y });
  const shapeEnt = world.entity().set(ChildOf, { target: body }).set(Box, { width: 2, height: 2 });
  if (withEvents) {
    shapeEnt.set(ContactEvents, {});
  }
  return { body, shapeEnt };
}

// ─── Opt-in: begin event (ECS ContactEvents component) ───────────────────────
//
// After VP-21b, the raw `state.contactBeginEvents` are cleared at the END of
// PhysicsEvents.run. World-level tests check the ECS ContactEvents component.

describe("contact begin events (opt-in)", () => {
  it("fires exactly one begin event when two overlapping boxes collide and one has ContactEvents", () => {
    // Place two boxes overlapping at creation so they contact on the first step.
    const { shapeEnt: shapeA } = makeBox(-0.5, 0, true);
    const { shapeEnt: shapeB } = makeBox(0.5, 0, false);

    step(1);

    // shapeA has ContactEvents — it should receive a begin event with other = shapeB.
    const eventsA = shapeA.get(ContactEvents)!;
    expect(eventsA.begin).toHaveLength(1);
    expect(eventsA.begin[0]!.other.eid).toBe(shapeB.eid);
    expect(eventsA.end).toHaveLength(0);

    // shapeB has no ContactEvents — it receives nothing.
    expect(shapeB.get(ContactEvents)).toBeUndefined();
  });

  it("fires a begin event when both shapes have ContactEvents", () => {
    const { shapeEnt: shapeA } = makeBox(-0.5, 0, true);
    const { shapeEnt: shapeB } = makeBox(0.5, 0, true);

    step(1);

    // Both sides should receive a begin event with the other as `other`.
    const eventsA = shapeA.get(ContactEvents)!;
    const eventsB = shapeB.get(ContactEvents)!;
    expect(eventsA.begin).toHaveLength(1);
    expect(eventsA.begin[0]!.other.eid).toBe(shapeB.eid);
    expect(eventsB.begin).toHaveLength(1);
    expect(eventsB.begin[0]!.other.eid).toBe(shapeA.eid);
  });

  it("does NOT fire a begin event when neither shape has ContactEvents", () => {
    // Same geometry but neither shape opts in.
    const { shapeEnt: shapeA } = makeBox(-0.5, 0, false);
    const { shapeEnt: shapeB } = makeBox(0.5, 0, false);

    step(1);

    // No ContactEvents on either entity — both remain undefined.
    expect(shapeA.get(ContactEvents)).toBeUndefined();
    expect(shapeB.get(ContactEvents)).toBeUndefined();
  });
});

// ─── Arrays cleared each step (ECS component) ────────────────────────────────

describe("event arrays cleared each step", () => {
  it("begin events are in ContactEvents after step N, and cleared in step N+1 when contact persists", () => {
    const { shapeEnt: shapeA } = makeBox(-0.5, 0, true);
    makeBox(0.5, 0, false);

    step(1);
    // Step N: begin event populated.
    expect(shapeA.get(ContactEvents)!.begin).toHaveLength(1);

    // Step again — boxes still touching, no new begin event; array silently cleared.
    step(1);
    expect(shapeA.get(ContactEvents)!.begin).toHaveLength(0);
    expect(shapeA.get(ContactEvents)!.end).toHaveLength(0);
  });
});

// ─── End event: stopped-touching path (SIM_STOPPED_TOUCHING in collide.ts) ───

describe("contact end events — separation", () => {
  it("fires an end event when separated boxes stop touching", () => {
    // Start overlapping, let contact form and become touching.
    const { body: bodyB, shapeEnt: shapeB } = makeBox(0.5, 0, true);
    makeBox(-0.5, 0, false);

    step(3); // contacts form and become touching

    // Teleport body B far away so the fat AABBs separate next step.
    bodyB.set(Position, { x: 100, y: 100 });

    step(1); // refit happens in pose_sync_in; pair should go disjoint

    // Either stopped-touching or disjoint path; shapeB should get an end event.
    const eventsB = shapeB.get(ContactEvents)!;
    expect(eventsB.end).toHaveLength(1);
    expect(eventsB.begin).toHaveLength(0);
  });
});

// ─── Handle correctness (ECS component payload) ──────────────────────────────

describe("event entity correctness", () => {
  it("ContactEvents.begin[0].other is the other shape entity", () => {
    const { shapeEnt: shapeA } = makeBox(-0.5, 0, true);
    const { shapeEnt: shapeB } = makeBox(0.5, 0, false);

    step(1);

    const eventsA = shapeA.get(ContactEvents)!;
    expect(eventsA.begin).toHaveLength(1);
    expect(eventsA.begin[0]!.other.eid).toBe(shapeB.eid);
  });
});

// ─── No double-emit for SIM_DISJOINT path ────────────────────────────────────

describe("no double end-event for disjoint contacts", () => {
  it("disjoint destroy delivers exactly one end event to ContactEvents", () => {
    // Two overlapping boxes; let them form a touching contact.
    const { body: bodyB, shapeEnt: shapeB } = makeBox(0.5, 0, true);
    makeBox(-0.5, 0, false);

    step(3); // contact becomes touching

    // Teleport far enough that fat AABBs clearly don't overlap → SIM_DISJOINT.
    bodyB.set(Position, { x: 1000, y: 0 });

    step(1);

    // Exactly one end event in shapeB's ContactEvents.
    const eventsB = shapeB.get(ContactEvents)!;
    expect(eventsB.end).toHaveLength(1);
    expect(eventsB.begin).toHaveLength(0);
  });
});

// ─── Engine-level: destroyContact teardown path ───────────────────────────────
//
// These tests bypass the Vecs pipeline entirely and call destroyContact directly
// on a PhysicsState. They verify the raw contactEndEvents emission path in the
// engine, independent of the PhysicsEvents publish/clear cycle.

describe("destroyContact — engine-level end event recording", () => {
  it("pushes an end event when destroying a touching contact with ContactEvents opted in", () => {
    const s = makeEngineState();
    const bodyA = makeBodyEngine(s);
    const bodyB = makeBodyEngine(s);
    const shapeA = makeShapeOnBody(s, bodyA, true); // opted in
    const shapeB = makeShapeOnBody(s, bodyB, false);

    createContact(s, shapeA, shapeB);

    // Manually mark the contact as touching + enable-contact-events (mirrors
    // what collide.ts does when SIM_STARTED_TOUCHING fires).
    const contactId = s.contacts.idPool.allocate().index - 1; // last allocated
    // The last created contact is at the most-recently-allocated id.
    // Re-find it: contactId is the record index.
    let foundContact = null;
    for (const rec of s.contacts.records) {
      if (rec !== undefined && rec.shapeIdA === shapeA && rec.shapeIdB === shapeB) {
        foundContact = rec;
        break;
      }
    }
    expect(foundContact).not.toBeNull();
    void contactId;

    // Set the TOUCHING flag (mirrors what linkContact + STARTED_TOUCHING does).
    foundContact!.flags |= CONTACT_TOUCHING_FLAG;
    // CONTACT_ENABLE_CONTACT_EVENTS is already set by createContact (shapeA has
    // enableContactEvents=true).
    expect(foundContact!.flags & CONTACT_ENABLE_CONTACT_EVENTS).not.toBe(0);

    expect(s.contactEndEvents).toHaveLength(0);

    destroyContact(s, foundContact!, false);

    // End event must have been pushed.
    expect(s.contactEndEvents).toHaveLength(1);
    const evt = s.contactEndEvents[0]!;
    const indicesInEvent = new Set([evt.shapeA.index, evt.shapeB.index]);
    expect(indicesInEvent.has(shapeA)).toBe(true);
    expect(indicesInEvent.has(shapeB)).toBe(true);
  });

  it("does NOT push an end event when the contact was non-touching", () => {
    const s = makeEngineState();
    const bodyA = makeBodyEngine(s);
    const bodyB = makeBodyEngine(s);
    const shapeA = makeShapeOnBody(s, bodyA, true);
    const shapeB = makeShapeOnBody(s, bodyB, false);

    createContact(s, shapeA, shapeB);

    let foundContact = null;
    for (const rec of s.contacts.records) {
      if (rec !== undefined && rec.shapeIdA === shapeA && rec.shapeIdB === shapeB) {
        foundContact = rec;
        break;
      }
    }
    expect(foundContact).not.toBeNull();

    // Do NOT set TOUCHING flag — contact stays non-touching.
    expect(foundContact!.flags & CONTACT_TOUCHING_FLAG).toBe(0);

    destroyContact(s, foundContact!, false);

    // No end event for a non-touching contact.
    expect(s.contactEndEvents).toHaveLength(0);
  });

  it("does NOT push an end event when neither shape opted in (no CONTACT_ENABLE_CONTACT_EVENTS)", () => {
    const s = makeEngineState();
    const bodyA = makeBodyEngine(s);
    const bodyB = makeBodyEngine(s);
    const shapeA = makeShapeOnBody(s, bodyA, false); // not opted in
    const shapeB = makeShapeOnBody(s, bodyB, false);

    createContact(s, shapeA, shapeB);

    let foundContact = null;
    for (const rec of s.contacts.records) {
      if (rec !== undefined && rec.shapeIdA === shapeA && rec.shapeIdB === shapeB) {
        foundContact = rec;
        break;
      }
    }
    expect(foundContact).not.toBeNull();

    // Mark touching but NOT opted in (neither shape has enableContactEvents).
    foundContact!.flags |= CONTACT_TOUCHING_FLAG;
    expect(foundContact!.flags & CONTACT_ENABLE_CONTACT_EVENTS).toBe(0);

    destroyContact(s, foundContact!, false);

    // No end event — neither shape opted in.
    expect(s.contactEndEvents).toHaveLength(0);
  });
});
