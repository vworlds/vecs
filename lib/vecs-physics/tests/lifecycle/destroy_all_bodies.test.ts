// Ports box2d/test/test_world.c::DestroyAllBodiesWorld.
//
// Builds bodies and shapes, lets contacts form, destroys every shape/body in one
// frame, and verifies the WASM world is still valid with no registered entities.

import { type Entity, World } from "@vworlds/vecs";
import { describe, expect, it } from "vitest";

import { Body, BodyType, Box, Material, Position, installPhysics } from "../../src/index.js";
import { getPhysics } from "../../src/adapter/state.js";

const STEP_MS = 1000 / 60;

describe("test_world.c::DestroyAllBodiesWorld", () => {
  it("destroys every body and shape without leaving registered entities", () => {
    const world = new World();
    installPhysics(world, { gravity: { x: 0, y: -10 } });
    world.start();
    const state = getPhysics(world);
    const step = makeStepper(world);

    const { bodies, shapes } = makeContactingWorld(world);
    step(5);

    // Some contacts should have formed.
    expect(state.bodyByEntityWasm.size).toBeGreaterThan(0);

    for (const shape of shapes) {
      shape.destroy();
    }
    for (const body of bodies) {
      body.destroy();
    }
    step(1);

    // All entity → WASM mappings must be cleared.
    expect(state.bodyByEntityWasm.size).toBe(0);
    expect(state.shapeByEntityWasm.size).toBe(0);
    expect(state.entityByBodyIndex.size).toBe(0);
    expect(state.entityByShapeIndex.size).toBe(0);
    // The WASM world remains valid after all bodies are destroyed.
    expect(state.box2d.b2World_IsValid(state.worldId)).toBe(true);
  });
});

function makeContactingWorld(world: World): { bodies: Entity[]; shapes: Entity[] } {
  const bodies: Entity[] = [];
  const shapes: Entity[] = [];
  const ground = world
    .entity()
    .set(Body, { type: BodyType.Static })
    .set(Position, { x: 0, y: -10 });
  const groundShape = world
    .entity()
    .childOf(ground)
    .set(Box, { hx: 50, hy: 10 })
    .set(Material, { friction: 0.6, density: 0 });
  bodies.push(ground);
  shapes.push(groundShape);

  for (let i = 0; i < 8; i++) {
    const body = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: i * 1.5 - 5.25, y: 0.5 });
    const shape = world
      .entity()
      .childOf(body)
      .set(Box, { hx: 0.75, hy: 0.75 })
      .set(Material, { density: 1, friction: 0.3 });
    bodies.push(body);
    shapes.push(shape);
  }

  return { bodies, shapes };
}

function makeStepper(world: World): (count: number) => void {
  let now = 0;
  return (count) => {
    for (let i = 0; i < count; i++) {
      now += STEP_MS;
      world.progress(now, STEP_MS);
    }
  };
}
