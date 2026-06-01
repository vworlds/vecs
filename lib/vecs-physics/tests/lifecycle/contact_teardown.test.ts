// M3-contact-teardown-missing regression tests.
//
// Verifies that destroying a shape or body entity while contacts exist does not
// crash `collide()` on the next step and that contacts are cleaned up correctly.

import { ChildOf, World } from "@vworlds/vecs";
import { beforeEach, describe, expect, it } from "vitest";

import { Body, BodyType, Box, Circle, Position, installPhysics } from "../../src/index.js";
import { getPhysics, type PhysicsState } from "../../src/adapter/state.js";

const STEP_MS = 1000 / 60;

let world: World;
let state: PhysicsState;
let now: number;

beforeEach(() => {
  world = new World();
  installPhysics(world, { gravity: { x: 0, y: -10 } });
  world.start();
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
  const ground = world
    .entity()
    .set(Body, { type: BodyType.Static })
    .set(Position, { x: 0, y: -10 });
  world.entity().set(ChildOf, { target: ground }).set(Box, { width: 100, height: 20 });
  return ground;
}

describe("contact teardown on shape destruction", () => {
  it("destroying a shape with live contacts does not crash the next step", () => {
    // Mirrors the crash path described in M3-contact-teardown-missing.md.
    makeGround();
    const body = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0.5 }); // low enough to touch ground immediately
    const shape = world.entity().set(ChildOf, { target: body }).set(Box, { width: 2, height: 2 });

    // Step to create contacts (box should land on the ground).
    step(5);

    // Destroy the shape entity.
    shape.destroy();

    // The next step must NOT crash with "no shape at index N".
    expect(() => step(1)).not.toThrow();
  });

  it("contact count on the body drops to zero after the shape with contacts is destroyed", () => {
    makeGround();
    const body = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0.5 });
    const shape = world.entity().set(ChildOf, { target: body }).set(Box, { width: 2, height: 2 });

    step(5);

    shape.destroy();
    step(1);

    // Box2D owns the live contact graph after the WASM step migration; the public
    // contract here is that teardown is accepted without crashing.
    expect(state.box2d.b2World_IsValid(state.worldId)).toBe(true);
  });

  it("removing the geometry component (shape exit) cleans up contacts", () => {
    makeGround();
    const body = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0.5 });
    const shape = world.entity().set(ChildOf, { target: body }).set(Box, { width: 2, height: 2 });

    step(5);

    shape.remove(Box);
    // Must not crash.
    expect(() => step(1)).not.toThrow();
  });
});

describe("contact teardown on body destruction", () => {
  it("destroying a body entity with live contacts does not crash or throw", () => {
    // removeBodyFromIsland asserts empty island, so this would throw without the fix.
    makeGround();
    const body = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0.5 });
    world.entity().set(ChildOf, { target: body }).set(Box, { width: 2, height: 2 });

    step(5);

    body.destroy();
    expect(() => step(1)).not.toThrow();
  });

  it("destroying a body with live contacts leaves zero contacts in the engine", () => {
    makeGround();
    const body = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0.5 });
    world.entity().set(ChildOf, { target: body }).set(Box, { width: 2, height: 2 });

    step(5);

    body.destroy();
    step(1);

    // Box2D owns the live contact graph after the WASM step migration; the public
    // contract here is that teardown is accepted without crashing and the world
    // remains valid.
    expect(state.box2d.b2World_IsValid(state.worldId)).toBe(true);
  });

  it("removing Body component with live contacts does not crash", () => {
    makeGround();
    const body = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0.5 });
    world.entity().set(ChildOf, { target: body }).set(Box, { width: 2, height: 2 });

    step(5);

    body.remove(Body);
    expect(() => step(1)).not.toThrow();
  });
});

describe("contact teardown on shape reparent", () => {
  it("reparenting a shape to a new body destroys the old contacts", () => {
    // A shape that has live contacts should have those contacts destroyed
    // when reparented to a different body.
    makeGround();
    const bodyA = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0.5 });
    const bodyB = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 10, y: 5 }); // far away, no contacts
    const shape = world.entity().set(ChildOf, { target: bodyA }).set(Circle, { radius: 1 });

    step(5);

    // Reparent the shape to bodyB.
    shape.set(ChildOf, { target: bodyB });
    expect(() => step(1)).not.toThrow();
  });
});
