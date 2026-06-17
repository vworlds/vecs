// Regression: a ContactEvents shape created the SAME frame another body is
// destroyed must keep its contact-event opt-in.
//
// This pins the hook-driven half of the deferred-teardown invariant. ContactEvents
// opt-in is toggled by component onAdd/onRemove hooks (setEventFlag), which are NOT
// phase-ordered like the lifecycle exits -- so their safety does not come from
// "system X runs before Y" but from the stronger property that PhysicsReaper is the
// ONLY thing that frees a Box2D slot, and it runs once per pass. Nothing is freed
// mid-pass, so a destroyed shape's slot is never recycled by a same-frame create,
// and the victim's ContactEvents onRemove can never clobber the fresh shape.
//
// If the reaper ordering regresses (e.g. body destroy moves back into the body
// exit), the fresh shape recycles the victim's freed slot and -- with the stale-id
// guard now gone -- loses its contact flag, so this test goes red.

import { World, type Entity } from "@vworlds/vecs";
import { describe, expect, it } from "vitest";

import {
  Body,
  BodyType,
  Circle,
  ContactEvents,
  GravityScale,
  PhysicsModule,
  Position,
} from "../../src/index.js";

const STEP_MS = 1000 / 60;

function makeWorld() {
  const world = new World();
  world.module(PhysicsModule, { gravity: { x: 0, y: 0 }, subSteps: 4 });
  return world;
}

let _now = 0;
function step(world: World) {
  _now += STEP_MS;
  world.progress(_now, STEP_MS);
}

function makeContactSolid(world: World): { body: Entity; shape: Entity } {
  const body = world
    .entity()
    .set(Body, { type: BodyType.Dynamic })
    .set(Position, { x: 0, y: 0 })
    .add(GravityScale);
  const shape = world.entity().childOf(body).set(Circle, { radius: 0.5 }).add(ContactEvents);
  return { body, shape };
}

describe("contact shape-id slot recycling (regression)", () => {
  it("a ContactEvents solid created the same frame another is destroyed keeps firing begin", () => {
    const world = makeWorld();

    // Stable anvil the fresh body keeps overlapping/contacting at the origin.
    makeContactSolid(world);

    // Victim overlapping the anvil; destroying its body frees its shape slot.
    const victim = makeContactSolid(world);

    step(world);
    step(world);

    // SAME frame, asteroid-split order: create the fresh contact body FIRST (its
    // shape-lifecycle enter is queued), THEN destroy the victim body.
    const fresh = makeContactSolid(world);
    victim.body.destroy();

    // `begin` only holds the most recent step's transitions and is cleared each
    // frame, so accumulate across a few steps.
    let beganEver = false;
    for (let i = 0; i < 5; i++) {
      step(world);
      if (fresh.shape.get(ContactEvents)!.begin.length > 0) {
        beganEver = true;
      }
    }

    // The fresh solid must still report contacts: its contact opt-in must not have
    // been disabled by the victim's onRemove landing on a recycled slot.
    expect(beganEver).toBe(true);
  });
});
