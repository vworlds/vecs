// M3-body-type-enable-bookkeeping regression tests.
//
// Verifies that runtime type and enabled changes correctly update:
//   - DYNAMIC_FLAG on sim.flags and state.flags
//   - massDirty (so mass recomputes on next frame)
//   - island membership (createIslandForBody / removeBodyFromIsland)

import { ChildOf, World } from "@vworlds/vecs";
import { beforeEach, describe, expect, it } from "vitest";

import { Body, BodyType, Box, Circle, Position, Sleep, installPhysics } from "../../src/index.js";
import { DYNAMIC_BODY, DYNAMIC_FLAG, KINEMATIC_BODY, STATIC_BODY } from "../../src/engine/body.js";
import { AWAKE_SET, DISABLED_SET, STATIC_SET } from "../../src/engine/solver_set.js";
import { getPhysics, type PhysicsState } from "../../src/adapter/state.js";
import { NULL_INDEX } from "../../src/util/handle.js";

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

// ─── Dynamic flag synchronisation ─────────────────────────────────────────────

describe("DYNAMIC_FLAG on type change", () => {
  it("static→dynamic: sets DYNAMIC_FLAG on sim.flags and bodyState.flags", () => {
    const e = world.entity().set(Body, { type: BodyType.Static });
    step();

    const handle = state.bodyByEntity.get(e.eid)!;
    const record = state.bodies.get(handle.index);
    const sim = state.solverSets[STATIC_SET]!.bodySims[record.localIndex]!;
    expect(sim.flags & DYNAMIC_FLAG).toBe(0); // static: no dynamic flag

    // Change to dynamic.
    e.set(Body, { type: BodyType.Dynamic });
    step();

    expect(record.type).toBe(DYNAMIC_BODY);
    expect(record.setIndex).toBe(AWAKE_SET);
    const newSim = state.solverSets[AWAKE_SET]!.bodySims[record.localIndex]!;
    expect(newSim.flags & DYNAMIC_FLAG).toBe(DYNAMIC_FLAG);
    const newState = state.solverSets[AWAKE_SET]!.bodyStates[record.localIndex]!;
    expect(newState.flags & DYNAMIC_FLAG).toBe(DYNAMIC_FLAG);
  });

  it("dynamic→static: clears DYNAMIC_FLAG on sim.flags", () => {
    const e = world.entity().set(Body, { type: BodyType.Dynamic });
    step();

    const handle = state.bodyByEntity.get(e.eid)!;
    const record = state.bodies.get(handle.index);
    const sim = state.solverSets[AWAKE_SET]!.bodySims[record.localIndex]!;
    expect(sim.flags & DYNAMIC_FLAG).toBe(DYNAMIC_FLAG);

    e.set(Body, { type: BodyType.Static });
    step();

    expect(record.type).toBe(STATIC_BODY);
    const newSim = state.solverSets[STATIC_SET]!.bodySims[record.localIndex]!;
    expect(newSim.flags & DYNAMIC_FLAG).toBe(0);
  });

  it("dynamic→kinematic: clears DYNAMIC_FLAG", () => {
    const e = world.entity().set(Body, { type: BodyType.Dynamic });
    step();

    const handle = state.bodyByEntity.get(e.eid)!;
    const record = state.bodies.get(handle.index);
    e.set(Body, { type: BodyType.Kinematic });
    step();

    expect(record.type).toBe(KINEMATIC_BODY);
    const sim = state.solverSets[AWAKE_SET]!.bodySims[record.localIndex]!;
    expect(sim.flags & DYNAMIC_FLAG).toBe(0);
    const st = state.solverSets[AWAKE_SET]!.bodyStates[record.localIndex]!;
    expect(st.flags & DYNAMIC_FLAG).toBe(0);
  });

  it("type change on disabled body updates DYNAMIC_FLAG without island change", () => {
    const e = world.entity().set(Body, { type: BodyType.Static, enabled: false });
    step();

    const handle = state.bodyByEntity.get(e.eid)!;
    const record = state.bodies.get(handle.index);
    expect(record.setIndex).toBe(DISABLED_SET);
    expect(record.islandId).toBe(NULL_INDEX);

    e.set(Body, { type: BodyType.Dynamic, enabled: false });
    step();

    // Still disabled, no island.
    expect(record.setIndex).toBe(DISABLED_SET);
    expect(record.islandId).toBe(NULL_INDEX);
    // But DYNAMIC_FLAG is set on the sim.
    const sim = state.solverSets[DISABLED_SET]!.bodySims[record.localIndex]!;
    expect(sim.flags & DYNAMIC_FLAG).toBe(DYNAMIC_FLAG);
  });
});

// ─── Mass dirty on type change ─────────────────────────────────────────────────

describe("massDirty on type change", () => {
  it("static→dynamic: marks massDirty so invMass recomputes from shapes", () => {
    const e = world.entity().set(Body, { type: BodyType.Static }).set(Position, { x: 0, y: 5 });
    world.entity().set(ChildOf, { target: e }).set(Box, { width: 2, height: 2 });

    step(); // static: invMass stays 0 (no mass computation for static)

    const handle = state.bodyByEntity.get(e.eid)!;
    const record = state.bodies.get(handle.index);

    // Change to dynamic. Should mark massDirty.
    e.set(Body, { type: BodyType.Dynamic });
    step(); // lifecycle marks dirty; PhysicsMassRecompute clears it

    // invMass should now be non-zero (density=1, box 2×2=area4, mass=4).
    const sim = state.solverSets[record.setIndex]!.bodySims[record.localIndex]!;
    expect(sim.invMass).toBeGreaterThan(0);
  });

  it("dynamic→static: marks massDirty so mass becomes 0 (static infinite mass)", () => {
    const e = world.entity().set(Body, { type: BodyType.Dynamic }).set(Position, { x: 0, y: 5 });
    world.entity().set(ChildOf, { target: e }).set(Circle, { radius: 1 });

    step(); // VP-12 sets invMass from shape

    const handle = state.bodyByEntity.get(e.eid)!;
    const record = state.bodies.get(handle.index);
    const simBefore = state.solverSets[AWAKE_SET]!.bodySims[record.localIndex]!;
    expect(simBefore.invMass).toBeGreaterThan(0); // dynamic: has mass

    e.set(Body, { type: BodyType.Static });
    step(); // lifecycle marks dirty; PhysicsMassRecompute recomputes (static → invMass=0)

    const newSim = state.solverSets[STATIC_SET]!.bodySims[record.localIndex]!;
    // Box2D: static/kinematic bodies have invMass=0 after b2UpdateBodyMassData.
    expect(newSim.invMass).toBe(0);
  });
});

// ─── Island membership ────────────────────────────────────────────────────────

describe("island membership on type/enable transitions", () => {
  it("static body has no island; changing to dynamic creates one", () => {
    const e = world.entity().set(Body, { type: BodyType.Static });
    step();

    const handle = state.bodyByEntity.get(e.eid)!;
    const record = state.bodies.get(handle.index);
    expect(record.islandId).toBe(NULL_INDEX); // static: no island

    e.set(Body, { type: BodyType.Dynamic });
    step();

    // Now awake and dynamic: should have an island.
    expect(record.islandId).not.toBe(NULL_INDEX);
  });

  it("dynamic body has island; changing to static removes it", () => {
    const e = world.entity().set(Body, { type: BodyType.Dynamic });
    step();

    const handle = state.bodyByEntity.get(e.eid)!;
    const record = state.bodies.get(handle.index);
    expect(record.islandId).not.toBe(NULL_INDEX); // dynamic: has island

    e.set(Body, { type: BodyType.Static });
    step();

    expect(record.islandId).toBe(NULL_INDEX); // static: no island
  });

  it("disabling a dynamic body removes it from its island", () => {
    const e = world.entity().set(Body, { type: BodyType.Dynamic });
    step();

    const handle = state.bodyByEntity.get(e.eid)!;
    const record = state.bodies.get(handle.index);
    expect(record.islandId).not.toBe(NULL_INDEX);

    e.set(Body, { type: BodyType.Dynamic, enabled: false });
    step();

    // Disabled body has no island.
    expect(record.setIndex).toBe(DISABLED_SET);
    expect(record.islandId).toBe(NULL_INDEX);
  });

  it("enabling a non-static body creates an island for it", () => {
    const e = world.entity().set(Body, { type: BodyType.Dynamic, enabled: false });
    step();

    const handle = state.bodyByEntity.get(e.eid)!;
    const record = state.bodies.get(handle.index);
    expect(record.islandId).toBe(NULL_INDEX); // disabled: no island

    e.set(Body, { type: BodyType.Dynamic, enabled: true });
    step();

    expect(record.setIndex).toBe(AWAKE_SET);
    expect(record.islandId).not.toBe(NULL_INDEX);
  });

  it("enabling a static body does NOT create an island", () => {
    const e = world.entity().set(Body, { type: BodyType.Static, enabled: false });
    step();

    const handle = state.bodyByEntity.get(e.eid)!;
    const record = state.bodies.get(handle.index);

    e.set(Body, { type: BodyType.Static, enabled: true });
    step();

    expect(record.setIndex).toBe(STATIC_SET);
    expect(record.islandId).toBe(NULL_INDEX); // static: no island
  });
});

// ─── Contact teardown on type/disable ─────────────────────────────────────────

describe("contact teardown on body type/disable changes", () => {
  function makeGround() {
    const g = world.entity().set(Body, { type: BodyType.Static }).set(Position, { x: 0, y: -10 });
    world.entity().set(ChildOf, { target: g }).set(Box, { width: 100, height: 20 });
  }

  it("disabling a shaped body updates the WASM body without crashing", () => {
    makeGround();
    const body = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0.5 });
    world.entity().set(ChildOf, { target: body }).set(Box, { width: 2, height: 2 });

    step(5); // create contacts

    // Disable — Box2D owns contact teardown internally after M7.
    body.set(Body, { type: BodyType.Dynamic, enabled: false });
    expect(() => step()).not.toThrow();
    const bodyId = state.bodyByEntityWasm.get(body.eid)!;
    expect(state.box2d.b2Body_IsEnabled(bodyId)).toBe(false);
  });

  it("changing body type on a shaped body updates the WASM body without crashing", () => {
    makeGround();
    const body = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0.5 });
    world.entity().set(ChildOf, { target: body }).set(Box, { width: 2, height: 2 });

    step(5);

    body.set(Body, { type: BodyType.Static });
    expect(() => step()).not.toThrow();
    const bodyId = state.bodyByEntityWasm.get(body.eid)!;
    expect(state.box2d.b2Body_GetType(bodyId)).toBe(state.box2d.b2BodyType.b2_staticBody);
  });
});

// ─── WASM sleep/type bookkeeping ───────────────────────────────────────────────

describe("WASM awake bookkeeping on type/enable transitions", () => {
  function wasmBodyId(eid: number) {
    const bodyId = state.bodyByEntityWasm.get(eid);
    if (bodyId === undefined) {
      throw new Error("missing wasm body");
    }
    return bodyId;
  }

  it("disabled bodies do not wake on input", () => {
    const e = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0 })
      .set(Sleep, { enabled: true, awake: false, threshold: 0.05 });

    step();
    expect(state.box2d.b2Body_IsAwake(wasmBodyId(e.eid))).toBe(false);

    e.set(Body, { type: BodyType.Dynamic, enabled: false });
    step();
    expect(state.box2d.b2Body_IsEnabled(wasmBodyId(e.eid))).toBe(false);

    e.set(Position, { x: 1, y: 0 });
    step();

    expect(state.box2d.b2Body_IsEnabled(wasmBodyId(e.eid))).toBe(false);
    expect(state.box2d.b2Body_IsAwake(wasmBodyId(e.eid))).toBe(false);
  });

  it("type swaps preserve the body awake state", () => {
    const e = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0 })
      .set(Sleep, { enabled: true, awake: false, threshold: 0.05 });

    step();
    expect(state.box2d.b2Body_IsAwake(wasmBodyId(e.eid))).toBe(false);

    e.set(Body, { type: BodyType.Static });
    step();

    expect(state.box2d.b2Body_GetType(wasmBodyId(e.eid))).toBe(
      state.box2d.b2BodyType.b2_staticBody
    );
    expect(state.box2d.b2Body_IsAwake(wasmBodyId(e.eid))).toBe(false);
  });
});
