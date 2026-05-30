// VP-22: engine-side hit event scan (raw `state.contactHitEvents` array).
//
// Tests verify that `state.contactHitEvents` is populated by `gatherHitEvents`
// (called after `solve` inside `engineStep`) and that:
//   - opt-in: no `HitEvents` on either shape → no hit event;
//             with `HitEvents` on at least one shape → hit event fires.
//   - threshold: a fast body impact (approach speed > threshold) produces an event;
//                a slow/settling contact (approach speed < threshold) does NOT.
//   - payload: approachSpeed ≥ threshold; normal is approximately unit length;
//              impact point is near the contact region between the two shapes;
//              shape handles resolve to the colliding shapes.
//   - arrays cleared at start of each step.
//
// Asserts on RAW `state.contactHitEvents` array only (ECS publishing is VP-21b).

import { ChildOf, World } from "@vworlds/vecs";
import { describe, expect, it } from "vitest";

import {
  Body,
  BodyType,
  Box,
  HitEvents,
  installPhysics,
  LinearVelocity,
  Position,
} from "../../src/index.js";
import { getPhysics } from "../../src/engine/state.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const STEP_MS = 1000 / 60;

/** Create a world with zero gravity and the given hitEventThreshold. */
function makeWorld(hitEventThreshold = 1.0) {
  const world = new World();
  installPhysics(world, {
    gravity: { x: 0, y: 0 },
    hitEventThreshold,
  });
  world.start();
  return world;
}

let _now = 0;
function step(world: World, n = 1): void {
  for (let i = 0; i < n; i++) {
    _now += STEP_MS;
    world.progress(_now, STEP_MS);
  }
}

// ─── Opt-in: HitEvents on shape ───────────────────────────────────────────────

describe("hit event opt-in", () => {
  it("fires a hit event when at least one shape has HitEvents and impact is fast", () => {
    // Use a low threshold so a modest impact qualifies.
    const world = makeWorld(0.5);
    const state = getPhysics(world);

    // Static wall.
    const wallBody = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 });
    world
      .entity()
      .set(ChildOf, { target: wallBody })
      .set(Box, { width: 2, height: 2 })
      .add(HitEvents);

    // Fast dynamic body heading toward the wall at speed 10 (well above 0.5 threshold).
    const movingBody = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 3, y: 0 })
      .set(LinearVelocity, { x: -10, y: 0 });
    world.entity().set(ChildOf, { target: movingBody }).set(Box, { width: 2, height: 2 });

    // Run until first contact.
    let hitEventFound = false;
    for (let i = 0; i < 200; i++) {
      step(world);
      if (state.contactHitEvents.length > 0) {
        hitEventFound = true;
        break;
      }
    }

    expect(hitEventFound).toBe(true);
  });

  it("does NOT fire a hit event when neither shape has HitEvents, even on fast impact", () => {
    const world = makeWorld(0.5);
    const state = getPhysics(world);

    // Same geometry but no HitEvents on either shape.
    const wallBody = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 });
    world.entity().set(ChildOf, { target: wallBody }).set(Box, { width: 2, height: 2 });

    const movingBody = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 3, y: 0 })
      .set(LinearVelocity, { x: -10, y: 0 });
    world.entity().set(ChildOf, { target: movingBody }).set(Box, { width: 2, height: 2 });

    let hitEventFound = false;
    for (let i = 0; i < 200; i++) {
      step(world);
      if (state.contactHitEvents.length > 0) {
        hitEventFound = true;
        break;
      }
    }

    expect(hitEventFound).toBe(false);
  });

  it("fires a hit event when only the visitor shape (not wall) has HitEvents", () => {
    const world = makeWorld(0.5);
    const state = getPhysics(world);

    // Wall — no HitEvents.
    const wallBody = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 });
    world.entity().set(ChildOf, { target: wallBody }).set(Box, { width: 2, height: 2 });

    // Moving body — has HitEvents.
    const movingBody = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 3, y: 0 })
      .set(LinearVelocity, { x: -10, y: 0 });
    world
      .entity()
      .set(ChildOf, { target: movingBody })
      .set(Box, { width: 2, height: 2 })
      .add(HitEvents);

    let hitEventFound = false;
    for (let i = 0; i < 200; i++) {
      step(world);
      if (state.contactHitEvents.length > 0) {
        hitEventFound = true;
        break;
      }
    }

    expect(hitEventFound).toBe(true);
  });
});

// ─── Threshold gating ─────────────────────────────────────────────────────────

describe("hit event threshold", () => {
  it("approach speed above threshold produces a hit event", () => {
    // threshold = 2.0; impact speed ≈ 10 (well above).
    const world = makeWorld(2.0);
    const state = getPhysics(world);

    const wallBody = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 });
    world
      .entity()
      .set(ChildOf, { target: wallBody })
      .set(Box, { width: 2, height: 2 })
      .add(HitEvents);

    const movingBody = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 3, y: 0 })
      .set(LinearVelocity, { x: -10, y: 0 });
    world.entity().set(ChildOf, { target: movingBody }).set(Box, { width: 2, height: 2 });

    let hitEventFound = false;
    for (let i = 0; i < 200; i++) {
      step(world);
      if (state.contactHitEvents.length > 0) {
        hitEventFound = true;
        break;
      }
    }

    expect(hitEventFound).toBe(true);
  });

  it("slow contact (settling under gravity, no fast impact) does NOT produce a hit event", () => {
    // A box slowly settling: it falls a very short distance (gravity -10, one step
    // of ~16 ms → approach ≈ 0.16 m/s), well below threshold = 1.0.
    const world = new World();
    installPhysics(world, {
      gravity: { x: 0, y: -10 },
      hitEventThreshold: 1.0,
    });
    world.start();

    const groundBody = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 });
    world
      .entity()
      .set(ChildOf, { target: groundBody })
      .set(Box, { width: 20, height: 0.2 })
      .add(HitEvents);

    // A box placed just barely above the ground so it contacts on the first step.
    // Position y=0.6 → bottom at 0.6-0.5=0.1, ground top at 0.1; barely touching.
    // Very low drop height → very low impact speed.
    const fallingBody = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0.6 });
    world.entity().set(ChildOf, { target: fallingBody }).set(Box, { width: 1, height: 1 });

    const state = getPhysics(world);

    let hitEventFound = false;
    for (let i = 0; i < 60; i++) {
      _now += STEP_MS;
      world.progress(_now, STEP_MS);
      if (state.contactHitEvents.length > 0) {
        hitEventFound = true;
        break;
      }
    }

    // Low approach speed from a 0.1 m drop → no hit event with threshold = 1.0.
    expect(hitEventFound).toBe(false);
  });

  it("approachSpeed in the event is >= hitEventThreshold", () => {
    const world = makeWorld(0.5);
    const state = getPhysics(world);

    const wallBody = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 });
    world
      .entity()
      .set(ChildOf, { target: wallBody })
      .set(Box, { width: 2, height: 2 })
      .add(HitEvents);

    const movingBody = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 3, y: 0 })
      .set(LinearVelocity, { x: -10, y: 0 });
    world.entity().set(ChildOf, { target: movingBody }).set(Box, { width: 2, height: 2 });

    for (let i = 0; i < 200; i++) {
      step(world);
      if (state.contactHitEvents.length > 0) {
        break;
      }
    }

    expect(state.contactHitEvents.length).toBeGreaterThan(0);
    const evt = state.contactHitEvents[0]!;
    expect(evt.approachSpeed).toBeGreaterThanOrEqual(0.5);
  });
});

// ─── Payload correctness ──────────────────────────────────────────────────────

describe("hit event payload", () => {
  it("normal is approximately unit length", () => {
    const world = makeWorld(0.5);
    const state = getPhysics(world);

    const wallBody = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 });
    world
      .entity()
      .set(ChildOf, { target: wallBody })
      .set(Box, { width: 2, height: 2 })
      .add(HitEvents);

    const movingBody = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 3, y: 0 })
      .set(LinearVelocity, { x: -10, y: 0 });
    world.entity().set(ChildOf, { target: movingBody }).set(Box, { width: 2, height: 2 });

    for (let i = 0; i < 200; i++) {
      step(world);
      if (state.contactHitEvents.length > 0) {
        break;
      }
    }

    expect(state.contactHitEvents.length).toBeGreaterThan(0);
    const evt = state.contactHitEvents[0]!;
    const len = Math.sqrt(evt.normalX * evt.normalX + evt.normalY * evt.normalY);
    expect(len).toBeCloseTo(1.0, 2);
  });

  it("contact point is near the contact region (between the two shapes)", () => {
    // Wall box center at x=0, half-width=1 → right edge at x=1.
    // Moving box center at x=3, half-width=1 → left edge at x=2.
    // Impact point expected near x=1..2 range.
    const world = makeWorld(0.5);
    const state = getPhysics(world);

    const wallBody = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 });
    world
      .entity()
      .set(ChildOf, { target: wallBody })
      .set(Box, { width: 2, height: 2 })
      .add(HitEvents);

    const movingBody = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 3, y: 0 })
      .set(LinearVelocity, { x: -10, y: 0 });
    world.entity().set(ChildOf, { target: movingBody }).set(Box, { width: 2, height: 2 });

    for (let i = 0; i < 200; i++) {
      step(world);
      if (state.contactHitEvents.length > 0) {
        break;
      }
    }

    expect(state.contactHitEvents.length).toBeGreaterThan(0);
    const evt = state.contactHitEvents[0]!;
    // Contact point should be in the x-range around the wall's right edge.
    expect(evt.pointX).toBeGreaterThan(-2);
    expect(evt.pointX).toBeLessThan(4);
    // y should be near the impact plane (both boxes at y=0, height 1 each).
    expect(Math.abs(evt.pointY)).toBeLessThan(2);
  });

  it("shape handles resolve to the two colliding shapes", () => {
    const world = makeWorld(0.5);
    const state = getPhysics(world);

    const wallBody = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 });
    const wallShapeEnt = world
      .entity()
      .set(ChildOf, { target: wallBody })
      .set(Box, { width: 2, height: 2 })
      .add(HitEvents);

    const movingBody = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 3, y: 0 })
      .set(LinearVelocity, { x: -10, y: 0 });
    const movingShapeEnt = world
      .entity()
      .set(ChildOf, { target: movingBody })
      .set(Box, { width: 2, height: 2 });

    for (let i = 0; i < 200; i++) {
      step(world);
      if (state.contactHitEvents.length > 0) {
        break;
      }
    }

    expect(state.contactHitEvents.length).toBeGreaterThan(0);
    const evt = state.contactHitEvents[0]!;

    const wallHandle = state.shapeByEntity.get(wallShapeEnt.eid)!;
    const movingHandle = state.shapeByEntity.get(movingShapeEnt.eid)!;

    const indicesInEvent = new Set([evt.shapeA.index, evt.shapeB.index]);
    expect(indicesInEvent.has(wallHandle.index)).toBe(true);
    expect(indicesInEvent.has(movingHandle.index)).toBe(true);
  });
});

// ─── Array cleared each step ──────────────────────────────────────────────────

describe("contactHitEvents cleared each step", () => {
  it("hit events from step N are gone at step N+1 (contact persists but speed drops below threshold)", () => {
    // After the initial impact the contact settles; subsequent steps should not
    // re-emit (once approach speed drops below threshold). Verify the array is
    // empty on the step after the first hit event.
    const world = makeWorld(0.5);
    const state = getPhysics(world);

    const wallBody = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 });
    world
      .entity()
      .set(ChildOf, { target: wallBody })
      .set(Box, { width: 2, height: 2 })
      .add(HitEvents);

    const movingBody = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 3, y: 0 })
      .set(LinearVelocity, { x: -10, y: 0 });
    world.entity().set(ChildOf, { target: movingBody }).set(Box, { width: 2, height: 2 });

    // Run until we see the first hit event.
    let hitStep = -1;
    for (let i = 0; i < 200; i++) {
      step(world);
      if (state.contactHitEvents.length > 0) {
        hitStep = i;
        break;
      }
    }
    expect(hitStep).toBeGreaterThanOrEqual(0);

    // The array must be cleared at the start of the NEXT step.
    step(world);
    // After impact the body bounces/settles. The array may have 0 or more events,
    // but the key invariant is that it was CLEARED (i.e., the length is a fresh
    // count for this step only, not accumulated). We verify the clearing by
    // running a few more steps after a FAST contact and confirming the array
    // is NOT persistently growing (length stays bounded):
    let maxLen = 0;
    for (let i = 0; i < 30; i++) {
      step(world);
      if (state.contactHitEvents.length > maxLen) {
        maxLen = state.contactHitEvents.length;
      }
    }
    // With restitution=0 (default) the body rests quickly; after a few steps
    // the approach speed is below threshold → 0 hit events.
    expect(state.contactHitEvents.length).toBe(0);
  });
});
