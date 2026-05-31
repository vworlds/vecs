// Ports box2d/test/test_world.c::DestroyAllBodiesWorld.
//
// Builds bodies and shapes, lets contacts form, destroys every shape/body in one
// frame, and verifies the engine has no live contacts, proxies, or islands after
// the next step.

import { type Entity, ChildOf, World } from "@vworlds/vecs";
import { describe, expect, it } from "vitest";

import { Body, BodyType, Box, Material, Position, installPhysics } from "../../src/index.js";
import { getPhysics } from "../../src/engine/state.js";

const STEP_MS = 1000 / 60;

describe("test_world.c::DestroyAllBodiesWorld", () => {
  it("destroys every body and shape without leaving contacts, proxies, or islands", () => {
    const world = new World();
    installPhysics(world, { gravity: { x: 0, y: -10 } });
    world.start();
    const state = getPhysics(world);
    const step = makeStepper(world);

    const { bodies, shapes } = makeContactingWorld(world);
    step(5);
    expect(liveContactCount(state)).toBeGreaterThan(0);

    for (const shape of shapes) {
      shape.destroy();
    }
    for (const body of bodies) {
      body.destroy();
    }
    step(1);

    expect(state.bodyByEntity.size).toBe(0);
    expect(state.shapeByEntity.size).toBe(0);
    expect(state.bodies.records.filter(Boolean)).toHaveLength(0);
    expect(state.shapes.records.filter(Boolean)).toHaveLength(0);
    expect(state.contacts.records.filter(Boolean)).toHaveLength(0);
    expect(state.graphContactSims).toHaveLength(0);
    expect(nonTouchingContactCount(state)).toBe(0);
    expect(state.islands.records.filter(Boolean)).toHaveLength(0);
    expect(queryAllProxyShapeIndices(state)).toEqual([]);
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
    .set(ChildOf, { target: ground })
    .set(Box, { width: 100, height: 20 })
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
      .set(ChildOf, { target: body })
      .set(Box, { width: 1.5, height: 1.5 })
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

function liveContactCount(state: ReturnType<typeof getPhysics>): number {
  return state.contacts.records.filter(Boolean).length;
}

function nonTouchingContactCount(state: ReturnType<typeof getPhysics>): number {
  return state.solverSets.reduce((count, set) => count + set.contactSims.length, 0);
}

function queryAllProxyShapeIndices(state: ReturnType<typeof getPhysics>): number[] {
  const shapeIndices: number[] = [];
  state.broadPhase.queryAll(
    { lowerBound: { x: -1e6, y: -1e6 }, upperBound: { x: 1e6, y: 1e6 } },
    0xffffffff,
    (_proxyId, shapeIndex) => {
      shapeIndices.push(shapeIndex);
      return true;
    }
  );
  return shapeIndices;
}
