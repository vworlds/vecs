// VP-21a: raw contact begin/end event recording (engine half).
//
// Tests verify that `state.contactBeginEvents` and `state.contactEndEvents`
// are populated by the collide pass and by `destroyContact`, and that:
//   - events only fire when at least one shape has `ContactEvents` (opt-in)
//   - events do NOT fire when neither shape opted in
//   - handles recorded match the shape handles in `shapeByEntity`
//   - the destroyContact path fires an end event for touching+enabled contacts
//   - arrays are cleared at the top of each step
//
// Does NOT assert on ECS `ContactEvents` component arrays (VP-21b).
//
// Two test layers:
//   1. World-level integration (tests/events/contact_begin_end.test.ts) —
//      the full Vecs world pipeline verifying begin events from collide.ts.
//   2. Engine-level unit (below "destroyContact engine-level tests") —
//      directly calls destroyContact to validate the teardown path without
//      fighting the Vecs inbox-buffering timing (the exit callback is deferred
//      to the system's next _run, which is physics-pre, before engineStep clears
//      the events in physics-step — so the teardown event is always cleared before
//      VP-21b can read it in physics-post; a double-buffer fixes this in VP-21b).

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

// ─── Opt-in: begin event ──────────────────────────────────────────────────────

describe("contact begin events (opt-in)", () => {
  it("fires exactly one begin event when two overlapping boxes collide and one has ContactEvents", () => {
    // Place two boxes overlapping at creation so they contact on the first step.
    // With zero gravity there is no tunnelling concern.
    const { shapeEnt: shapeA } = makeBox(-0.5, 0, true);
    const { shapeEnt: shapeB } = makeBox(0.5, 0, false);

    step(1);

    expect(state.contactBeginEvents).toHaveLength(1);
    expect(state.contactEndEvents).toHaveLength(0);

    // Confirm the handles recorded match the shape entries.
    const handleA = state.shapeByEntity.get(shapeA.eid)!;
    const handleB = state.shapeByEntity.get(shapeB.eid)!;
    const evt = state.contactBeginEvents[0]!;

    // The contact stores shapes in canonical (primary) order — verify both
    // handles appear in the event (order depends on canonical ordering).
    const indicesInEvent = new Set([evt.shapeA.index, evt.shapeB.index]);
    expect(indicesInEvent.has(handleA.index)).toBe(true);
    expect(indicesInEvent.has(handleB.index)).toBe(true);
  });

  it("fires a begin event when both shapes have ContactEvents", () => {
    makeBox(-0.5, 0, true);
    makeBox(0.5, 0, true);

    step(1);

    expect(state.contactBeginEvents).toHaveLength(1);
  });

  it("does NOT fire a begin event when neither shape has ContactEvents", () => {
    // Same geometry but neither shape opts in.
    makeBox(-0.5, 0, false);
    makeBox(0.5, 0, false);

    step(1);

    expect(state.contactBeginEvents).toHaveLength(0);
    expect(state.contactEndEvents).toHaveLength(0);
  });
});

// ─── Arrays cleared each step ────────────────────────────────────────────────

describe("event arrays cleared each step", () => {
  it("begin events from step N are gone by step N+1 when contact persists", () => {
    makeBox(-0.5, 0, true);
    makeBox(0.5, 0, false);

    step(1);
    expect(state.contactBeginEvents).toHaveLength(1);

    // Step again — boxes still touching, no new begin event, array is cleared.
    step(1);
    expect(state.contactBeginEvents).toHaveLength(0);
  });
});

// ─── End event: stopped-touching path (SIM_STOPPED_TOUCHING in collide.ts) ───

describe("contact end events — separation", () => {
  it("fires an end event when separated boxes stop touching", () => {
    // Start overlapping, let contact form and become touching.
    const { body: bodyB } = makeBox(0.5, 0, true);
    makeBox(-0.5, 0, false);

    step(3); // contacts form and become touching

    // Teleport body B far away so the fat AABBs separate next step.
    bodyB.set(Position, { x: 100, y: 100 });

    step(1); // refit happens in pose_sync_in; pair should go disjoint

    // Either stopped-touching or disjoint (depending on separation distance);
    // both paths must emit an end event.
    expect(state.contactEndEvents).toHaveLength(1);
    expect(state.contactBeginEvents).toHaveLength(0);
  });
});

// ─── Handle correctness ───────────────────────────────────────────────────────

describe("event handle correctness", () => {
  it("recorded handle indices match shapeByEntity entries", () => {
    const { shapeEnt: shapeA } = makeBox(-0.5, 0, true);
    const { shapeEnt: shapeB } = makeBox(0.5, 0, false);

    step(1);

    expect(state.contactBeginEvents).toHaveLength(1);

    const evt = state.contactBeginEvents[0]!;
    const handleA = state.shapeByEntity.get(shapeA.eid)!;
    const handleB = state.shapeByEntity.get(shapeB.eid)!;

    // Both handle indices must be present in the event (canonical order may vary).
    const indices = new Set([evt.shapeA.index, evt.shapeB.index]);
    expect(indices.has(handleA.index)).toBe(true);
    expect(indices.has(handleB.index)).toBe(true);

    // Generations must match the current pool generations (valid at emit time).
    const pool = state.shapes.idPool;
    expect(evt.shapeA.generation).toBe(pool.generationOf(evt.shapeA.index));
    expect(evt.shapeB.generation).toBe(pool.generationOf(evt.shapeB.index));
  });
});

// ─── No double-emit for SIM_DISJOINT path ────────────────────────────────────

describe("no double end-event for disjoint contacts", () => {
  it("disjoint destroy emits exactly one end event (via destroyContact, not both paths)", () => {
    // Two overlapping boxes; let them form a touching contact.
    const { body: bodyB } = makeBox(0.5, 0, true);
    makeBox(-0.5, 0, false);

    step(3); // contact becomes touching

    // Teleport far enough that fat AABBs clearly don't overlap → SIM_DISJOINT.
    bodyB.set(Position, { x: 1000, y: 0 });

    step(1);

    // Exactly one end event — the SIM_DISJOINT path calls destroyContact which
    // emits the event. The collide.ts SIM_DISJOINT branch does NOT also emit.
    expect(state.contactEndEvents).toHaveLength(1);
  });
});

// ─── Engine-level: destroyContact teardown path ───────────────────────────────
//
// The Vecs inbox-buffering timing means that body lifecycle exit (physics-pre)
// pushes the end event to contactEndEvents, then engineStep (physics-step)
// clears it before VP-21b (physics-post) can read it. This is a known gap
// addressed by a double-buffer in VP-21b. Here we validate the destroyContact
// implementation directly at the engine level, bypassing the Vecs pipeline.

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
