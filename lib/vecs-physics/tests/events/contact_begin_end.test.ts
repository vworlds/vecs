// VP-21a / VP-21b: contact begin/end event recording — ECS publishing.
//
// World-level integration tests: the full Vecs world pipeline verifies
// ContactEvents component arrays (the user-facing surface).
// The raw contactBeginEvents / contactEndEvents arrays on PhysicsState were
// engine-internal; they have been removed in M7-10.

import { World } from "@vworlds/vecs";
import { beforeEach, describe, expect, it } from "vitest";

import { Body, BodyType, Box, ContactEvents, Position, PhysicsModule } from "../../src/index.js";

const STEP_MS = 1000 / 60;

let world: World;
let now: number;

beforeEach(() => {
  world = new World();
  world.module(PhysicsModule, { gravity: { x: 0, y: 0 } });
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
  const shapeEnt = world.entity().childOf(body).set(Box, { hx: 1, hy: 1 });
  if (withEvents) {
    shapeEnt.set(ContactEvents, {});
  }
  return { body, shapeEnt };
}

// ─── Opt-in: begin event (ECS ContactEvents component) ───────────────────────

describe("contact begin events (opt-in)", () => {
  it("fires exactly one begin event when two overlapping boxes collide and one has ContactEvents", () => {
    const { shapeEnt: shapeA } = makeBox(-0.5, 0, true);
    const { shapeEnt: shapeB } = makeBox(0.5, 0, false);

    step(1);

    const eventsA = shapeA.get(ContactEvents)!;
    expect(eventsA.begin).toHaveLength(1);
    expect(eventsA.begin[0]!.other.eid).toBe(shapeB.eid);
    expect(eventsA.end).toHaveLength(0);

    expect(shapeB.get(ContactEvents)).toBeUndefined();
  });

  it("fires a begin event when both shapes have ContactEvents", () => {
    const { shapeEnt: shapeA } = makeBox(-0.5, 0, true);
    const { shapeEnt: shapeB } = makeBox(0.5, 0, true);

    step(1);

    const eventsA = shapeA.get(ContactEvents)!;
    const eventsB = shapeB.get(ContactEvents)!;
    expect(eventsA.begin).toHaveLength(1);
    expect(eventsA.begin[0]!.other.eid).toBe(shapeB.eid);
    expect(eventsB.begin).toHaveLength(1);
    expect(eventsB.begin[0]!.other.eid).toBe(shapeA.eid);
  });

  it("does NOT fire a begin event when neither shape has ContactEvents", () => {
    const { shapeEnt: shapeA } = makeBox(-0.5, 0, false);
    const { shapeEnt: shapeB } = makeBox(0.5, 0, false);

    step(1);

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
    expect(shapeA.get(ContactEvents)!.begin).toHaveLength(1);

    step(1);
    expect(shapeA.get(ContactEvents)!.begin).toHaveLength(0);
    expect(shapeA.get(ContactEvents)!.end).toHaveLength(0);
  });
});

// ─── End event: stopped-touching path ────────────────────────────────────────

describe("contact end events — separation", () => {
  it("fires an end event when separated boxes stop touching", () => {
    const { body: bodyB, shapeEnt: shapeB } = makeBox(0.5, 0, true);
    makeBox(-0.5, 0, false);

    step(3);

    bodyB.set(Position, { x: 100, y: 100 });

    step(1);

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

// ─── No double-emit for disjoint contacts ────────────────────────────────────

describe("no double end-event for disjoint contacts", () => {
  it("disjoint destroy delivers exactly one end event to ContactEvents", () => {
    const { body: bodyB, shapeEnt: shapeB } = makeBox(0.5, 0, true);
    makeBox(-0.5, 0, false);

    step(3);

    bodyB.set(Position, { x: 1000, y: 0 });

    step(1);

    const eventsB = shapeB.get(ContactEvents)!;
    expect(eventsB.end).toHaveLength(1);
    expect(eventsB.begin).toHaveLength(0);
  });
});
