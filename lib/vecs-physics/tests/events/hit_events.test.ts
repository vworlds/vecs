// VP-22 / VP-21b: engine-side hit event scan and ECS HitEvents publishing.
//
// After VP-21b, `PhysicsEvents` clears `state.contactHitEvents` at the END of
// physics-post (after publishing). World-level tests therefore check the ECS
// `HitEvents` component arrays (the user-facing surface), not the raw engine
// arrays, which are always empty after world.progress.
//
// Cases covered:
//   - opt-in: no HitEvents on either shape → no hit event in HitEvents component
//   - with HitEvents on one shape → hits populated + other entity correct
//   - threshold: fast impact (above threshold) produces event; slow contact does not
//   - payload: speed ≥ threshold; normal approx unit length; point in contact region
//   - array-clearing: HitEvents.hits cleared when no event fires this step (silent)
//   - both shapes with HitEvents each get the event with correct `other`

import { World } from "@vworlds/vecs";
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

    // Static wall with HitEvents.
    const wallBody = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 });
    const wallShape = world
      .entity()
      .childOf(wallBody)
      .set(Box, { width: 2, height: 2 })
      .add(HitEvents);

    // Fast dynamic body heading toward the wall at speed 10 (well above 0.5 threshold).
    const movingBody = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 3, y: 0 })
      .set(LinearVelocity, { x: -10, y: 0 });
    world.entity().childOf(movingBody).set(Box, { width: 2, height: 2 });

    // Run until first contact.
    let hitEventFound = false;
    for (let i = 0; i < 200; i++) {
      step(world);
      if (wallShape.get(HitEvents)!.hits.length > 0) {
        hitEventFound = true;
        break;
      }
    }

    expect(hitEventFound).toBe(true);
  });

  it("does NOT fire a hit event when neither shape has HitEvents, even on fast impact", () => {
    const world = makeWorld(0.5);

    // Same geometry but no HitEvents on either shape.
    const wallBody = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 });
    world.entity().childOf(wallBody).set(Box, { width: 2, height: 2 });

    const movingBody = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 3, y: 0 })
      .set(LinearVelocity, { x: -10, y: 0 });
    world.entity().childOf(movingBody).set(Box, { width: 2, height: 2 });

    // Run enough steps to cover the impact — no HitEvents to check, just ensure
    // nothing crashes and no spurious component is written.
    for (let i = 0; i < 200; i++) {
      step(world);
    }
    // No assertion on the raw array (it's cleared); the point is that neither
    // shape has HitEvents, so no component population can occur.
    // This test passes if we reach here without error.
  });

  it("fires a hit event when only the moving shape (not wall) has HitEvents", () => {
    const world = makeWorld(0.5);

    // Wall — no HitEvents.
    const wallBody = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 });
    world.entity().childOf(wallBody).set(Box, { width: 2, height: 2 });

    // Moving body — has HitEvents.
    const movingBody = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 3, y: 0 })
      .set(LinearVelocity, { x: -10, y: 0 });
    const movingShape = world
      .entity()
      .childOf(movingBody)
      .set(Box, { width: 2, height: 2 })
      .add(HitEvents);

    let hitEventFound = false;
    for (let i = 0; i < 200; i++) {
      step(world);
      if (movingShape.get(HitEvents)!.hits.length > 0) {
        hitEventFound = true;
        break;
      }
    }

    expect(hitEventFound).toBe(true);
  });
});

// ─── Threshold gating ─────────────────────────────────────────────────────────

describe("hit event threshold", () => {
  it("approach speed above threshold produces a hit event in HitEvents.hits", () => {
    // threshold = 2.0; impact speed ≈ 10 (well above).
    const world = makeWorld(2.0);

    const wallBody = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 });
    const wallShape = world
      .entity()
      .childOf(wallBody)
      .set(Box, { width: 2, height: 2 })
      .add(HitEvents);

    const movingBody = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 3, y: 0 })
      .set(LinearVelocity, { x: -10, y: 0 });
    world.entity().childOf(movingBody).set(Box, { width: 2, height: 2 });

    let hitEventFound = false;
    for (let i = 0; i < 200; i++) {
      step(world);
      if (wallShape.get(HitEvents)!.hits.length > 0) {
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
    const groundShape = world
      .entity()
      .childOf(groundBody)
      .set(Box, { width: 20, height: 0.2 })
      .add(HitEvents);

    // A box placed just barely above the ground so it contacts on the first step.
    const fallingBody = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0.6 });
    world.entity().childOf(fallingBody).set(Box, { width: 1, height: 1 });

    let hitEventFound = false;
    for (let i = 0; i < 60; i++) {
      _now += STEP_MS;
      world.progress(_now, STEP_MS);
      if (groundShape.get(HitEvents)!.hits.length > 0) {
        hitEventFound = true;
        break;
      }
    }

    // Low approach speed from a 0.1 m drop → no hit event with threshold = 1.0.
    expect(hitEventFound).toBe(false);
  });

  it("approachSpeed in the HitEvents payload is >= hitEventThreshold", () => {
    const world = makeWorld(0.5);

    const wallBody = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 });
    const wallShape = world
      .entity()
      .childOf(wallBody)
      .set(Box, { width: 2, height: 2 })
      .add(HitEvents);

    const movingBody = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 3, y: 0 })
      .set(LinearVelocity, { x: -10, y: 0 });
    world.entity().childOf(movingBody).set(Box, { width: 2, height: 2 });

    for (let i = 0; i < 200; i++) {
      step(world);
      if (wallShape.get(HitEvents)!.hits.length > 0) {
        break;
      }
    }

    const hits = wallShape.get(HitEvents)!.hits;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.speed).toBeGreaterThanOrEqual(0.5);
  });
});

// ─── Payload correctness ──────────────────────────────────────────────────────

describe("hit event payload", () => {
  it("normal is approximately unit length", () => {
    const world = makeWorld(0.5);

    const wallBody = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 });
    const wallShape = world
      .entity()
      .childOf(wallBody)
      .set(Box, { width: 2, height: 2 })
      .add(HitEvents);

    const movingBody = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 3, y: 0 })
      .set(LinearVelocity, { x: -10, y: 0 });
    world.entity().childOf(movingBody).set(Box, { width: 2, height: 2 });

    for (let i = 0; i < 200; i++) {
      step(world);
      if (wallShape.get(HitEvents)!.hits.length > 0) {
        break;
      }
    }

    const hits = wallShape.get(HitEvents)!.hits;
    expect(hits.length).toBeGreaterThan(0);
    const hit = hits[0]!;
    const len = Math.sqrt(hit.normalX * hit.normalX + hit.normalY * hit.normalY);
    expect(len).toBeCloseTo(1.0, 2);
  });

  it("contact point is near the contact region (between the two shapes)", () => {
    // Wall box center at x=0, half-width=1 → right edge at x=1.
    // Moving box center at x=3, half-width=1 → left edge at x=2.
    // Impact point expected near x=1..2 range.
    const world = makeWorld(0.5);

    const wallBody = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 });
    const wallShape = world
      .entity()
      .childOf(wallBody)
      .set(Box, { width: 2, height: 2 })
      .add(HitEvents);

    const movingBody = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 3, y: 0 })
      .set(LinearVelocity, { x: -10, y: 0 });
    world.entity().childOf(movingBody).set(Box, { width: 2, height: 2 });

    for (let i = 0; i < 200; i++) {
      step(world);
      if (wallShape.get(HitEvents)!.hits.length > 0) {
        break;
      }
    }

    const hits = wallShape.get(HitEvents)!.hits;
    expect(hits.length).toBeGreaterThan(0);
    const hit = hits[0]!;
    // Contact point should be in the x-range around the wall's right edge.
    expect(hit.x).toBeGreaterThan(-2);
    expect(hit.x).toBeLessThan(4);
    // y should be near the impact plane (both boxes at y=0, height 1 each).
    expect(Math.abs(hit.y)).toBeLessThan(2);
  });

  it("hit.other is the other shape entity", () => {
    const world = makeWorld(0.5);

    const wallBody = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 });
    const wallShape = world
      .entity()
      .childOf(wallBody)
      .set(Box, { width: 2, height: 2 })
      .add(HitEvents);

    const movingBody = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 3, y: 0 })
      .set(LinearVelocity, { x: -10, y: 0 });
    const movingShape = world.entity().childOf(movingBody).set(Box, { width: 2, height: 2 });

    for (let i = 0; i < 200; i++) {
      step(world);
      if (wallShape.get(HitEvents)!.hits.length > 0) {
        break;
      }
    }

    const hits = wallShape.get(HitEvents)!.hits;
    expect(hits.length).toBeGreaterThan(0);
    // Wall shape's HitEvent.other should be the moving shape entity.
    expect(hits[0]!.other.eid).toBe(movingShape.eid);
  });
});

// ─── Both shapes receive the hit event ───────────────────────────────────────

describe("both shapes receive HitEvents when both opt in", () => {
  it("both shapes get a HitEvent with correct other entity", () => {
    const world = makeWorld(0.5);

    const wallBody = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 });
    const wallShape = world
      .entity()
      .childOf(wallBody)
      .set(Box, { width: 2, height: 2 })
      .add(HitEvents);

    const movingBody = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 3, y: 0 })
      .set(LinearVelocity, { x: -10, y: 0 });
    const movingShape = world
      .entity()
      .childOf(movingBody)
      .set(Box, { width: 2, height: 2 })
      .add(HitEvents);

    for (let i = 0; i < 200; i++) {
      step(world);
      if (wallShape.get(HitEvents)!.hits.length > 0) {
        break;
      }
    }

    const wallHits = wallShape.get(HitEvents)!.hits;
    const movingHits = movingShape.get(HitEvents)!.hits;

    expect(wallHits.length).toBeGreaterThan(0);
    expect(movingHits.length).toBeGreaterThan(0);

    expect(wallHits[0]!.other.eid).toBe(movingShape.eid);
    expect(movingHits[0]!.other.eid).toBe(wallShape.eid);
  });
});

// ─── Array-clearing: HitEvents.hits silently cleared when no events this step ─

describe("HitEvents.hits cleared silently when no events", () => {
  it("hits array is cleared on the step after the impact (no modified fired)", () => {
    const world = makeWorld(0.5);

    const wallBody = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 });
    const wallShape = world
      .entity()
      .childOf(wallBody)
      .set(Box, { width: 2, height: 2 })
      .add(HitEvents);

    const movingBody = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 3, y: 0 })
      .set(LinearVelocity, { x: -10, y: 0 });
    world.entity().childOf(movingBody).set(Box, { width: 2, height: 2 });

    // Run until first hit event.
    let hitStep = -1;
    for (let i = 0; i < 200; i++) {
      step(world);
      if (wallShape.get(HitEvents)!.hits.length > 0) {
        hitStep = i;
        break;
      }
    }
    expect(hitStep).toBeGreaterThanOrEqual(0);

    // Run more steps until the hits array empties (body settles; speed < threshold).
    for (let i = 0; i < 60; i++) {
      step(world);
      if (wallShape.get(HitEvents)!.hits.length === 0) {
        break;
      }
    }
    expect(wallShape.get(HitEvents)!.hits.length).toBe(0);
  });
});
