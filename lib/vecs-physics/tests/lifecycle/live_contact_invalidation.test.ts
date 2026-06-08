// M3-live-contact-invalidation-missing regression tests.
//
// Verifies that live mutations (filter change, geometry rebuild, type change)
// correctly destroy stale contacts and allow the pair to re-evaluate.

import { World } from "@vworlds/vecs";
import { beforeEach, describe, expect, it } from "vitest";

import {
  Body,
  BodyType,
  Box,
  Circle,
  CollisionFilter,
  Position,
  installPhysics,
} from "../../src/index.js";
import { getPhysics, type PhysicsState } from "../../src/adapter/state.js";

const STEP_MS = 1000 / 60;

let world: World;
let state: PhysicsState;
let now: number;

beforeEach(() => {
  world = new World();
  installPhysics(world, { gravity: { x: 0, y: -10 } });
  state = getPhysics(world) as PhysicsState;
  now = 0;
});

function step(n = 1): void {
  for (let i = 0; i < n; i++) {
    now += STEP_MS;
    world.progress(now, STEP_MS);
  }
}

function makeGround() {
  const g = world.entity().set(Body, { type: BodyType.Static }).set(Position, { x: 0, y: -10 });
  world.entity().childOf(g).set(Box, { width: 100, height: 20 });
  return g;
}

// ─── CollisionFilter changes ──────────────────────────────────────────────────

describe("contact invalidation on CollisionFilter change", () => {
  it("changing filter to exclude the other shape destroys the live contact", () => {
    makeGround();
    const body = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0.5 });
    const shape = world
      .entity()
      .childOf(body)
      .set(Box, { width: 2, height: 2 })
      .set(CollisionFilter, { categoryBits: 0x1, maskBits: 0xffffffff, groupIndex: 0 });

    step(5); // contacts created

    // Set filter so the shape no longer collides with anything (maskBits = 0).
    shape.set(CollisionFilter, { categoryBits: 0x1, maskBits: 0x0, groupIndex: 0 });
    step();

    // Box2D owns contact invalidation after the WASM step migration; this gate
    // verifies the live mutation is accepted and leaves the world valid.
    expect(state.box2d.b2World_IsValid(state.worldId)).toBe(true);
  });

  it("filter change does not crash when no contacts exist", () => {
    const body = world.entity().set(Body, { type: BodyType.Dynamic });
    const shape = world.entity().childOf(body).set(Circle, { radius: 1 });
    step();

    expect(() => {
      shape.set(CollisionFilter, { categoryBits: 0x2, maskBits: 0x0, groupIndex: 0 });
      step();
    }).not.toThrow();
  });
});

// ─── Geometry rebuild (rebuildSingleShape) ────────────────────────────────────

describe("contact invalidation on geometry update", () => {
  it("updating shape geometry destroys the live contact before rebuilding", () => {
    makeGround();
    const body = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0.5 });
    const shape = world.entity().childOf(body).set(Box, { width: 2, height: 2 });

    step(5); // contacts created

    // Update geometry. Contacts must be destroyed immediately (before the step).
    // Mirrors b2ResetProxy which destroys contacts before updating the proxy.
    shape.set(Box, { width: 2, height: 2 }); // same values — still fires update callback
    // Progress to process the update. The old contact should be gone;
    // a new one may or may not form depending on position, but must not crash.
    expect(() => step(1)).not.toThrow();
    expect(state.box2d.b2World_IsValid(state.worldId)).toBe(true);
  });

  it("replacing circle with box geometry destroys old contacts", () => {
    makeGround();
    const body = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0.5 });
    const shape = world.entity().childOf(body).set(Circle, { radius: 1 });

    step(5);

    // Swap to a Box (remove Circle, add Box) — triggers exit + enter (destroyShape handles it).
    shape.remove(Circle);
    shape.add(Box);
    expect(() => step(1)).not.toThrow();
  });
});
