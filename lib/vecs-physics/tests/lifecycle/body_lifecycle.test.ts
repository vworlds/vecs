// `PhysicsBodyLifecycle` (VP-6): body create/destroy and solver-set placement /
// transfers driven by `Body` enter/exit/update events.

import { ChildOf, World } from "@vworlds/vecs";
import { beforeEach, describe, expect, it } from "vitest";

import {
  AngularVelocity,
  Body,
  BodyType,
  Box,
  Damping,
  GravityScale,
  LinearVelocity,
  Position,
  Rotation,
  installPhysics,
} from "../../src/index.js";
import { DYNAMIC_BODY, KINEMATIC_BODY, STATIC_BODY } from "../../src/engine/body.js";
import { proxyType } from "../../src/engine/broad_phase.js";
import { AWAKE_SET, DISABLED_SET, STATIC_SET } from "../../src/engine/solver_set.js";
import { getPhysics, type PhysicsState } from "../../src/engine/state.js";

let world: World;
let state: PhysicsState;

beforeEach(() => {
  world = new World();
  installPhysics(world);
  world.start();
  state = getPhysics(world);
});

/** The internal body record for an entity, looked up through the engine state. */
function record(eid: number) {
  const handle = state.bodyByEntity.get(eid)!;
  return state.bodies.get(handle.index);
}

describe("PhysicsBodyLifecycle.enter", () => {
  it("creates a dynamic body in the awake set with its pose", () => {
    const e = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 2, y: 3 })
      .set(Rotation, { angle: 0 });
    world.progress(0, 16);

    const r = record(e.eid);
    expect(r.setIndex).toBe(AWAKE_SET);
    expect(r.type).toBe(DYNAMIC_BODY);
    const sim = state.solverSets[AWAKE_SET]!.bodySims[r.localIndex]!;
    expect(sim.transformX).toBe(2);
    expect(sim.transformY).toBe(3);
    expect(state.solverSets[AWAKE_SET]!.bodyStates).toHaveLength(1);
  });

  it("places a static body in the static set with no body state", () => {
    const e = world.entity().set(Body, { type: BodyType.Static });
    world.progress(0, 16);

    expect(record(e.eid).setIndex).toBe(STATIC_SET);
    expect(record(e.eid).type).toBe(STATIC_BODY);
    expect(state.solverSets[STATIC_SET]!.bodyStates).toHaveLength(0);
  });

  it("places a kinematic body in the awake set", () => {
    const e = world.entity().set(Body, { type: BodyType.Kinematic });
    world.progress(0, 16);

    expect(record(e.eid).setIndex).toBe(AWAKE_SET);
    expect(record(e.eid).type).toBe(KINEMATIC_BODY);
  });

  it("places a disabled body in the disabled set whatever its type", () => {
    const e = world.entity().set(Body, { type: BodyType.Dynamic, enabled: false });
    world.progress(0, 16);

    expect(record(e.eid).setIndex).toBe(DISABLED_SET);
  });

  it("reads damping and gravity scale into the sim", () => {
    const e = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Damping, { linear: 0.5, angular: 0.25 })
      .set(GravityScale, { value: 2 });
    world.progress(0, 16);

    // These are integration coefficients on the sim — the step reads them but
    // does not mutate them, so they are stable after a progress.
    const r = record(e.eid);
    const sim = state.solverSets[AWAKE_SET]!.bodySims[r.localIndex]!;
    expect(sim.linearDamping).toBe(0.5);
    expect(sim.angularDamping).toBe(0.25);
    expect(sim.gravityScale).toBe(2);
  });

  it("reads initial velocity into the body state", () => {
    // No mass (invMass 0 until VP-12) and no damping, so the step leaves the
    // velocity untouched — what we read back is what the lifecycle wrote.
    const e = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(LinearVelocity, { x: 1, y: -1 })
      .set(AngularVelocity, { value: 4 });
    world.progress(0, 16);

    const r = record(e.eid);
    const bodyState = state.solverSets[AWAKE_SET]!.bodyStates[r.localIndex]!;
    expect(bodyState.vx).toBe(1);
    expect(bodyState.vy).toBe(-1);
    expect(bodyState.omega).toBe(4);
  });
});

describe("PhysicsBodyLifecycle.exit", () => {
  it("destroys the internal body when Body is removed", () => {
    const e = world.entity().set(Body, { type: BodyType.Dynamic });
    world.progress(0, 16);
    expect(state.bodyByEntity.has(e.eid)).toBe(true);

    e.remove(Body);
    world.progress(16, 16);

    expect(state.bodyByEntity.has(e.eid)).toBe(false);
    expect(state.solverSets[AWAKE_SET]!.bodySims).toHaveLength(0);
  });

  it("destroys the internal body when the entity is destroyed", () => {
    const e = world.entity().set(Body, { type: BodyType.Dynamic });
    world.progress(0, 16);

    e.destroy();
    world.progress(16, 16);

    expect(state.bodyByEntity.has(e.eid)).toBe(false);
    expect(state.solverSets[AWAKE_SET]!.bodySims).toHaveLength(0);
  });
});

describe("PhysicsBodyLifecycle.update(Body)", () => {
  it("moves a body to the disabled set and back on the enabled toggle", () => {
    const e = world.entity().set(Body, { type: BodyType.Dynamic });
    world.progress(0, 16);
    expect(record(e.eid).setIndex).toBe(AWAKE_SET);

    e.set(Body, { type: BodyType.Dynamic, enabled: false });
    world.progress(16, 16);
    expect(record(e.eid).setIndex).toBe(DISABLED_SET);

    e.set(Body, { type: BodyType.Dynamic, enabled: true });
    world.progress(32, 16);
    expect(record(e.eid).setIndex).toBe(AWAKE_SET);
  });

  it("moves a body between awake and static sets on a type change", () => {
    const e = world.entity().set(Body, { type: BodyType.Dynamic });
    world.progress(0, 16);
    expect(record(e.eid).setIndex).toBe(AWAKE_SET);

    e.set(Body, { type: BodyType.Static });
    world.progress(16, 16);
    expect(record(e.eid).setIndex).toBe(STATIC_SET);
    expect(record(e.eid).type).toBe(STATIC_BODY);
  });

  it("updates the recorded type for a kinematic↔dynamic change without moving sets", () => {
    const e = world.entity().set(Body, { type: BodyType.Dynamic });
    world.progress(0, 16);

    e.set(Body, { type: BodyType.Kinematic });
    world.progress(16, 16);
    expect(record(e.eid).setIndex).toBe(AWAKE_SET);
    expect(record(e.eid).type).toBe(KINEMATIC_BODY);
  });
});

// ─── Proxy synchronisation on enable / disable / type change ─────────────────

describe("PhysicsBodyLifecycle — body proxy synchronisation", () => {
  it("disabled body creation: shapes have no proxy (proxyKey = -1)", () => {
    // Box2D: b2CreateShape skips proxy creation when body is in disabled set.
    const e = world.entity().set(Body, { type: BodyType.Dynamic, enabled: false });
    world.entity().set(ChildOf, { target: e }).set(Box, { hx: 0.5, hy: 0.5 });
    world.progress(0, 16);

    const bodyHandle = state.bodyByEntity.get(e.eid)!;
    const bodyRec = state.bodies.get(bodyHandle.index);
    expect(bodyRec.setIndex).toBe(DISABLED_SET);

    const shapeIndex = bodyRec.shapeHead;
    expect(shapeIndex).not.toBe(-1); // shape record was created
    const shape = state.shapes.get(shapeIndex);
    expect(shape.proxyKey).toBe(-1); // but no proxy
  });

  it("enable after disabled creation: proxies are created for all shapes", () => {
    const e = world.entity().set(Body, { type: BodyType.Dynamic, enabled: false });
    world.entity().set(ChildOf, { target: e }).set(Box, { hx: 0.5, hy: 0.5 });
    world.progress(0, 16);

    // Verify no proxy yet.
    const bodyHandle = state.bodyByEntity.get(e.eid)!;
    const bodyRec = state.bodies.get(bodyHandle.index);
    expect(state.shapes.get(bodyRec.shapeHead).proxyKey).toBe(-1);

    // Enable the body.
    e.set(Body, { type: BodyType.Dynamic, enabled: true });
    world.progress(16, 16);

    // Now the body is in the awake set and its shape should have a proxy.
    expect(bodyRec.setIndex).toBe(AWAKE_SET);
    const shape = state.shapes.get(bodyRec.shapeHead);
    expect(shape.proxyKey).toBeGreaterThanOrEqual(0);
    // Proxy should be in the dynamic tree (bodyType = DYNAMIC_BODY = 2).
    expect(proxyType(shape.proxyKey)).toBe(DYNAMIC_BODY);
  });

  it("disable after enabled: all shape proxies are destroyed", () => {
    const e = world.entity().set(Body, { type: BodyType.Dynamic });
    world.entity().set(ChildOf, { target: e }).set(Box, { hx: 0.5, hy: 0.5 });
    world.progress(0, 16);

    const bodyHandle = state.bodyByEntity.get(e.eid)!;
    const bodyRec = state.bodies.get(bodyHandle.index);
    const shapeIdx = bodyRec.shapeHead;
    // Initially has a proxy.
    expect(state.shapes.get(shapeIdx).proxyKey).toBeGreaterThanOrEqual(0);

    // Disable.
    e.set(Body, { type: BodyType.Dynamic, enabled: false });
    world.progress(16, 16);

    expect(bodyRec.setIndex).toBe(DISABLED_SET);
    expect(state.shapes.get(shapeIdx).proxyKey).toBe(-1);
  });

  it("static→dynamic type change: proxy migrates to the dynamic tree", () => {
    const e = world.entity().set(Body, { type: BodyType.Static });
    world.entity().set(ChildOf, { target: e }).set(Box, { hx: 0.5, hy: 0.5 });
    world.progress(0, 16);

    const bodyHandle = state.bodyByEntity.get(e.eid)!;
    const bodyRec = state.bodies.get(bodyHandle.index);
    const shapeIdx = bodyRec.shapeHead;
    // Initially in static tree (bodyType = STATIC_BODY = 0).
    expect(proxyType(state.shapes.get(shapeIdx).proxyKey)).toBe(STATIC_BODY);

    // Change to dynamic.
    e.set(Body, { type: BodyType.Dynamic });
    world.progress(16, 16);

    expect(bodyRec.type).toBe(DYNAMIC_BODY);
    // Proxy now in the dynamic tree.
    expect(proxyType(state.shapes.get(shapeIdx).proxyKey)).toBe(DYNAMIC_BODY);
  });

  it("dynamic→static type change: proxy migrates to the static tree", () => {
    const e = world.entity().set(Body, { type: BodyType.Dynamic });
    world.entity().set(ChildOf, { target: e }).set(Box, { hx: 0.5, hy: 0.5 });
    world.progress(0, 16);

    const bodyHandle = state.bodyByEntity.get(e.eid)!;
    const bodyRec = state.bodies.get(bodyHandle.index);
    const shapeIdx = bodyRec.shapeHead;
    expect(proxyType(state.shapes.get(shapeIdx).proxyKey)).toBe(DYNAMIC_BODY);

    e.set(Body, { type: BodyType.Static });
    world.progress(16, 16);

    expect(bodyRec.type).toBe(STATIC_BODY);
    expect(proxyType(state.shapes.get(shapeIdx).proxyKey)).toBe(STATIC_BODY);
  });
});
