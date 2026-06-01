// VP-25: PhysicsDebugValidation system tests.
//
// Cases covered:
//   Each of the six issue codes:
//     1. shape-without-parent-body
//     2. dynamic-body-without-density
//     3. chain-too-few-points
//     4. polygon-invalid
//     5. shape-position-on-body
//     6. position-on-shape-entity
//
//   Cross-cutting behaviour (each code has its own subset):
//     (a) Warning fires once with the expected code when debug: true.
//     (b) Warning does NOT fire when debug: false (even for known-bad structures).
//     (c) Deduplication: 600 steps → exactly ONE warning (docs example).
//     (d) Message contains the issue code AND the entity eid.
//     (e) Re-arm: fix the structure → warning clears; re-break → warns again.
//
//   Test sink: uses the injectable WarnSink on WarnDedupe (via PhysicsOptions.debugSink)
//   instead of spying on console.warn.

import { ChildOf, World } from "@vworlds/vecs";
import { beforeEach, describe, expect, it } from "vitest";

import {
  Body,
  BodyType,
  Box,
  Chain,
  Circle,
  Material,
  Polygon,
  Position,
  Sensor,
  ShapePosition,
  ShapeRotation,
  installPhysics,
} from "../../src/index.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DT = 1 / 60;
const STEP_MS = DT * 1000;

/** Create a world with debug validation enabled and a capture sink. */
function makeDebugWorld() {
  const messages: string[] = [];
  const world = new World();
  installPhysics(world, {
    gravity: { x: 0, y: 0 },
    fixedTimeStep: DT,
    subSteps: 1,
    debug: true,
    debugSink: (msg) => messages.push(msg),
  });
  world.start();
  return { world, messages };
}

/** Create a world with debug: false (normal mode). */
function makeNormalWorld() {
  const world = new World();
  installPhysics(world, {
    gravity: { x: 0, y: 0 },
    fixedTimeStep: DT,
    subSteps: 1,
  });
  world.start();
  return world;
}

let world: World;
let messages: string[];
let now: number;

beforeEach(() => {
  const result = makeDebugWorld();
  world = result.world;
  messages = result.messages;
  now = 0;
});

function step(n = 1): void {
  for (let i = 0; i < n; i++) {
    now += STEP_MS;
    world.progress(now, STEP_MS);
  }
}

// ─── 1. shape-without-parent-body ─────────────────────────────────────────────

describe("shape-without-parent-body", () => {
  it("warns once when a geometry entity has no parent", () => {
    world.entity().set(Box, { hx: 0.5, hy: 0.5 });
    step();
    expect(messages.filter((m) => m.includes("shape-without-parent-body"))).toHaveLength(1);
  });

  it("warns once when the immediate parent lacks Body", () => {
    const container = world.entity();
    world.entity().set(ChildOf, { target: container }).set(Box, { hx: 0.5, hy: 0.5 });
    step();
    expect(messages.filter((m) => m.includes("shape-without-parent-body"))).toHaveLength(1);
  });

  it("does NOT warn when debug: false", () => {
    const normalWorld = makeNormalWorld();
    normalWorld.entity().set(Box, { hx: 0.5, hy: 0.5 });
    let now2 = 0;
    // Spy console.warn only for this test.
    const orig = console.warn;
    const captured: string[] = [];
    console.warn = (msg: string) => captured.push(msg);
    try {
      for (let i = 0; i < 5; i++) {
        now2 += STEP_MS;
        normalWorld.progress(now2, STEP_MS);
      }
    } finally {
      console.warn = orig;
    }
    expect(captured.filter((m) => m.includes("shape-without-parent-body"))).toHaveLength(0);
  });

  it("600 steps produce exactly ONE warning (deduplication — docs example)", () => {
    world.entity().set(Box, { hx: 0.5, hy: 0.5 });
    step(600);
    expect(messages.filter((m) => m.includes("shape-without-parent-body"))).toHaveLength(1);
  });

  it("message contains the issue code and entity eid", () => {
    const shape = world.entity().set(Box, { hx: 0.5, hy: 0.5 });
    step();
    const warning = messages.find((m) => m.includes("shape-without-parent-body"))!;
    expect(warning).toBeDefined();
    expect(warning).toContain("shape-without-parent-body");
    expect(warning).toContain(`Entity${shape.eid}`);
  });

  it("re-arms when the structure is fixed: adding a Body parent stops the warning", () => {
    const shape = world.entity().set(Box, { hx: 0.5, hy: 0.5 });
    step(); // Warns once (no parent with Body).
    const beforeCount = messages.filter((m) => m.includes("shape-without-parent-body")).length;
    expect(beforeCount).toBe(1);

    // Fix: give the shape a proper Body parent.
    const bodyEnt = world.entity().set(Body, { type: BodyType.Static });
    shape.set(ChildOf, { target: bodyEnt });

    step(5); // Should not warn now.
    expect(messages.filter((m) => m.includes("shape-without-parent-body"))).toHaveLength(1); // still only 1

    // Re-break: move to a non-body parent.
    const container = world.entity();
    shape.set(ChildOf, { target: container });

    step(); // Should warn again now that the structure is bad again.
    expect(messages.filter((m) => m.includes("shape-without-parent-body"))).toHaveLength(2);
  });
});

// ─── 2. dynamic-body-without-density ─────────────────────────────────────────

describe("dynamic-body-without-density", () => {
  it("warns when a dynamic body has no shape children", () => {
    world.entity().set(Body, { type: BodyType.Dynamic });
    step();
    expect(messages.filter((m) => m.includes("dynamic-body-without-density"))).toHaveLength(1);
  });

  it("warns when all non-sensor shapes have density 0", () => {
    const body = world.entity().set(Body, { type: BodyType.Dynamic });
    world
      .entity()
      .set(ChildOf, { target: body })
      .set(Box, { hx: 0.5, hy: 0.5 })
      .set(Material, { density: 0 });
    step();
    expect(messages.filter((m) => m.includes("dynamic-body-without-density"))).toHaveLength(1);
  });

  it("does NOT warn when default Material (density 1) is used", () => {
    const body = world.entity().set(Body, { type: BodyType.Dynamic });
    world.entity().set(ChildOf, { target: body }).set(Box, { hx: 0.5, hy: 0.5 });
    step();
    expect(messages.filter((m) => m.includes("dynamic-body-without-density"))).toHaveLength(0);
  });

  it("does NOT warn when a non-sensor shape has explicit positive density", () => {
    const body = world.entity().set(Body, { type: BodyType.Dynamic });
    world
      .entity()
      .set(ChildOf, { target: body })
      .set(Box, { hx: 0.5, hy: 0.5 })
      .set(Material, { density: 2 });
    step();
    expect(messages.filter((m) => m.includes("dynamic-body-without-density"))).toHaveLength(0);
  });

  it("does NOT warn for static bodies without density", () => {
    world.entity().set(Body, { type: BodyType.Static });
    step();
    expect(messages.filter((m) => m.includes("dynamic-body-without-density"))).toHaveLength(0);
  });

  it("does NOT warn for kinematic bodies without density", () => {
    world.entity().set(Body, { type: BodyType.Kinematic });
    step();
    expect(messages.filter((m) => m.includes("dynamic-body-without-density"))).toHaveLength(0);
  });

  it("does NOT warn when only sensor shapes exist with positive density (sensors contribute mass)", () => {
    const body = world.entity().set(Body, { type: BodyType.Dynamic });
    // Sensor shape with positive density — contributes mass per Box2D parity
    // (b2UpdateBodyMassData skips only density === 0, not isSensor shapes).
    world
      .entity()
      .set(ChildOf, { target: body })
      .set(Circle, { radius: 0.5 })
      .add(Sensor)
      .set(Material, { density: 1 });
    step();
    expect(messages.filter((m) => m.includes("dynamic-body-without-density"))).toHaveLength(0);
  });

  it("warns when only sensor shapes exist with density 0 (still zero mass)", () => {
    const body = world.entity().set(Body, { type: BodyType.Dynamic });
    world
      .entity()
      .set(ChildOf, { target: body })
      .set(Circle, { radius: 0.5 })
      .add(Sensor)
      .set(Material, { density: 0 });
    step();
    expect(messages.filter((m) => m.includes("dynamic-body-without-density"))).toHaveLength(1);
  });

  it("re-arms: warn → fix density → warn stops → remove density → warn fires again", () => {
    const body = world.entity().set(Body, { type: BodyType.Dynamic });
    const shape = world
      .entity()
      .set(ChildOf, { target: body })
      .set(Box, { hx: 0.5, hy: 0.5 })
      .set(Material, { density: 0 });
    step(); // density 0 → warns once
    expect(messages.filter((m) => m.includes("dynamic-body-without-density"))).toHaveLength(1);

    // Fix: give the shape a positive density.
    shape.set(Material, { density: 1 });
    step(5); // valid → no new warning
    expect(messages.filter((m) => m.includes("dynamic-body-without-density"))).toHaveLength(1);

    // Regress: remove density back to 0.
    shape.set(Material, { density: 0 });
    step(); // re-arm fired, so warns again
    expect(messages.filter((m) => m.includes("dynamic-body-without-density"))).toHaveLength(2);
  });

  it("does NOT warn when debug: false", () => {
    const normalWorld = makeNormalWorld();
    normalWorld.entity().set(Body, { type: BodyType.Dynamic });
    let now2 = 0;
    const orig = console.warn;
    const captured: string[] = [];
    console.warn = (msg: string) => captured.push(msg);
    try {
      for (let i = 0; i < 3; i++) {
        now2 += STEP_MS;
        normalWorld.progress(now2, STEP_MS);
      }
    } finally {
      console.warn = orig;
    }
    expect(captured.filter((m) => m.includes("dynamic-body-without-density"))).toHaveLength(0);
  });

  it("600 steps produce exactly ONE warning", () => {
    world.entity().set(Body, { type: BodyType.Dynamic });
    step(600);
    expect(messages.filter((m) => m.includes("dynamic-body-without-density"))).toHaveLength(1);
  });

  it("message contains the issue code and entity eid", () => {
    const body = world.entity().set(Body, { type: BodyType.Dynamic });
    step();
    const warning = messages.find((m) => m.includes("dynamic-body-without-density"))!;
    expect(warning).toBeDefined();
    expect(warning).toContain("dynamic-body-without-density");
    expect(warning).toContain(`Entity${body.eid}`);
  });
});

// ─── 3. chain-too-few-points ─────────────────────────────────────────────────

describe("chain-too-few-points", () => {
  it("warns when Chain has fewer than 4 points", () => {
    world.entity().set(Chain, {
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ],
      loop: false,
    });
    step();
    expect(messages.filter((m) => m.includes("chain-too-few-points"))).toHaveLength(1);
  });

  it("does NOT warn when Chain has exactly 4 points", () => {
    world.entity().set(Chain, {
      points: [
        { x: -2, y: 0 },
        { x: -1, y: 1 },
        { x: 1, y: 1 },
        { x: 2, y: 0 },
      ],
      loop: false,
    });
    step();
    expect(messages.filter((m) => m.includes("chain-too-few-points"))).toHaveLength(0);
  });

  it("does NOT warn when debug: false", () => {
    const normalWorld = makeNormalWorld();
    normalWorld.entity().set(Chain, {
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ],
      loop: false,
    });
    let now2 = 0;
    const orig = console.warn;
    const captured: string[] = [];
    console.warn = (msg: string) => captured.push(msg);
    try {
      for (let i = 0; i < 3; i++) {
        now2 += STEP_MS;
        normalWorld.progress(now2, STEP_MS);
      }
    } finally {
      console.warn = orig;
    }
    expect(captured.filter((m) => m.includes("chain-too-few-points"))).toHaveLength(0);
  });

  it("600 steps produce exactly ONE warning", () => {
    world.entity().set(Chain, {
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ],
      loop: false,
    });
    step(600);
    expect(messages.filter((m) => m.includes("chain-too-few-points"))).toHaveLength(1);
  });

  it("message contains the issue code and entity eid", () => {
    const shape = world.entity().set(Chain, {
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ],
      loop: false,
    });
    step();
    const warning = messages.find((m) => m.includes("chain-too-few-points"))!;
    expect(warning).toBeDefined();
    expect(warning).toContain("chain-too-few-points");
    expect(warning).toContain(`Entity${shape.eid}`);
  });

  it("re-arms when Chain is updated to have enough points", () => {
    const shape = world.entity().set(Chain, {
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ],
      loop: false,
    });
    step(); // warns once
    expect(messages.filter((m) => m.includes("chain-too-few-points"))).toHaveLength(1);

    // Fix: update to 4 points.
    shape.set(Chain, {
      points: [
        { x: -2, y: 0 },
        { x: -1, y: 1 },
        { x: 1, y: 1 },
        { x: 2, y: 0 },
      ],
      loop: false,
    });
    step(5); // should not warn
    expect(messages.filter((m) => m.includes("chain-too-few-points"))).toHaveLength(1);

    // Re-break: back to 2 points.
    shape.set(Chain, {
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ],
      loop: false,
    });
    step(); // warns again
    expect(messages.filter((m) => m.includes("chain-too-few-points"))).toHaveLength(2);
  });
});

// ─── 4. polygon-invalid ───────────────────────────────────────────────────────

describe("polygon-invalid", () => {
  it("warns when Polygon has fewer than 3 vertices", () => {
    world.entity().set(Polygon, {
      vertices: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ],
      radius: 0,
    });
    step();
    expect(messages.filter((m) => m.includes("polygon-invalid"))).toHaveLength(1);
  });

  it("warns when Polygon vertices are collinear (degenerate)", () => {
    world.entity().set(Polygon, {
      vertices: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 2, y: 0 },
      ],
      radius: 0,
    });
    step();
    expect(messages.filter((m) => m.includes("polygon-invalid"))).toHaveLength(1);
  });

  it("does NOT warn for a valid convex polygon", () => {
    world.entity().set(Polygon, {
      vertices: [
        { x: -0.5, y: -0.5 },
        { x: 0.5, y: -0.5 },
        { x: 0.5, y: 0.5 },
        { x: -0.5, y: 0.5 },
      ],
      radius: 0,
    });
    step();
    expect(messages.filter((m) => m.includes("polygon-invalid"))).toHaveLength(0);
  });

  it("does NOT warn when debug: false", () => {
    const normalWorld = makeNormalWorld();
    normalWorld.entity().set(Polygon, {
      vertices: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ],
      radius: 0,
    });
    let now2 = 0;
    const orig = console.warn;
    const captured: string[] = [];
    console.warn = (msg: string) => captured.push(msg);
    try {
      for (let i = 0; i < 3; i++) {
        now2 += STEP_MS;
        normalWorld.progress(now2, STEP_MS);
      }
    } finally {
      console.warn = orig;
    }
    expect(captured.filter((m) => m.includes("polygon-invalid"))).toHaveLength(0);
  });

  it("600 steps produce exactly ONE warning", () => {
    world.entity().set(Polygon, {
      vertices: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ],
      radius: 0,
    });
    step(600);
    expect(messages.filter((m) => m.includes("polygon-invalid"))).toHaveLength(1);
  });

  it("message contains the issue code and entity eid", () => {
    const shape = world.entity().set(Polygon, {
      vertices: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ],
      radius: 0,
    });
    step();
    const warning = messages.find((m) => m.includes("polygon-invalid"))!;
    expect(warning).toBeDefined();
    expect(warning).toContain("polygon-invalid");
    expect(warning).toContain(`Entity${shape.eid}`);
  });

  it("re-arms when Polygon is updated to a valid shape", () => {
    const shape = world.entity().set(Polygon, {
      vertices: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ],
      radius: 0,
    });
    step(); // warns once
    expect(messages.filter((m) => m.includes("polygon-invalid"))).toHaveLength(1);

    // Fix: update to a valid square.
    shape.set(Polygon, {
      vertices: [
        { x: -0.5, y: -0.5 },
        { x: 0.5, y: -0.5 },
        { x: 0.5, y: 0.5 },
        { x: -0.5, y: 0.5 },
      ],
      radius: 0,
    });
    step(5); // should not warn
    expect(messages.filter((m) => m.includes("polygon-invalid"))).toHaveLength(1);

    // Re-break: back to invalid.
    shape.set(Polygon, {
      vertices: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ],
      radius: 0,
    });
    step(); // warns again
    expect(messages.filter((m) => m.includes("polygon-invalid"))).toHaveLength(2);
  });
});

// ─── 5. shape-position-on-body ────────────────────────────────────────────────

describe("shape-position-on-body", () => {
  it("warns when ShapePosition is on a Body entity", () => {
    world.entity().set(Body, { type: BodyType.Static }).set(ShapePosition, { x: 0, y: -0.25 });
    step();
    expect(messages.filter((m) => m.includes("shape-position-on-body"))).toHaveLength(1);
  });

  it("warns when ShapeRotation is on a Body entity", () => {
    world.entity().set(Body, { type: BodyType.Static }).set(ShapeRotation, { angle: 0.1 });
    step();
    expect(messages.filter((m) => m.includes("shape-position-on-body"))).toHaveLength(1);
  });

  it("warns when both ShapePosition and ShapeRotation are on a Body entity", () => {
    world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(ShapePosition, { x: 1, y: 0 })
      .set(ShapeRotation, { angle: 0 });
    step();
    expect(messages.filter((m) => m.includes("shape-position-on-body"))).toHaveLength(1);
  });

  it("does NOT warn when ShapePosition is on a child entity (correct usage)", () => {
    const body = world.entity().set(Body, { type: BodyType.Static });
    world
      .entity()
      .set(ChildOf, { target: body })
      .set(Box, { hx: 0.5, hy: 0.5 })
      .set(ShapePosition, { x: 0, y: -0.25 });
    step();
    expect(messages.filter((m) => m.includes("shape-position-on-body"))).toHaveLength(0);
  });

  it("does NOT warn when debug: false", () => {
    const normalWorld = makeNormalWorld();
    normalWorld
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(ShapePosition, { x: 0, y: -0.25 });
    let now2 = 0;
    const orig = console.warn;
    const captured: string[] = [];
    console.warn = (msg: string) => captured.push(msg);
    try {
      for (let i = 0; i < 3; i++) {
        now2 += STEP_MS;
        normalWorld.progress(now2, STEP_MS);
      }
    } finally {
      console.warn = orig;
    }
    expect(captured.filter((m) => m.includes("shape-position-on-body"))).toHaveLength(0);
  });

  it("600 steps produce exactly ONE warning", () => {
    world.entity().set(Body, { type: BodyType.Static }).set(ShapePosition, { x: 0, y: 0 });
    step(600);
    expect(messages.filter((m) => m.includes("shape-position-on-body"))).toHaveLength(1);
  });

  it("message contains the issue code and entity eid", () => {
    const body = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(ShapePosition, { x: 0, y: -0.25 });
    step();
    const warning = messages.find((m) => m.includes("shape-position-on-body"))!;
    expect(warning).toBeDefined();
    expect(warning).toContain("shape-position-on-body");
    expect(warning).toContain(`Entity${body.eid}`);
  });

  it("re-arms via entity leaving+re-entering the filter: add ShapePosition → warn → remove → stops → re-add → warns again", () => {
    // This exercises the "entity leaves+re-enters the filter" re-arm path:
    // removing ShapePosition drops the entity from bodyPoseFilter; re-adding it
    // brings it back as a fresh entry, which triggers a new warnOnce.
    const body = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(ShapePosition, { x: 0, y: 0 });
    step(); // entity is in filter → warns once
    expect(messages.filter((m) => m.includes("shape-position-on-body"))).toHaveLength(1);

    // Fix: remove the offending component — entity leaves bodyPoseFilter.
    body.remove(ShapePosition);
    step(5); // entity not in filter → no new warning
    expect(messages.filter((m) => m.includes("shape-position-on-body"))).toHaveLength(1);

    // Regress: re-add ShapePosition — entity re-enters bodyPoseFilter fresh.
    body.set(ShapePosition, { x: 0, y: 0 });
    step(); // warns again
    expect(messages.filter((m) => m.includes("shape-position-on-body"))).toHaveLength(2);
  });
});

// ─── 6. position-on-shape-entity ─────────────────────────────────────────────

describe("position-on-shape-entity", () => {
  it("warns when a geometry entity carries Position", () => {
    world.entity().set(Box, { hx: 0.5, hy: 0.5 }).set(Position, { x: 0, y: -0.25 });
    step();
    expect(messages.filter((m) => m.includes("position-on-shape-entity"))).toHaveLength(1);
  });

  it("does NOT warn when Position is on the body entity (correct usage)", () => {
    world.entity().set(Body, { type: BodyType.Static }).set(Position, { x: 0, y: 0 });
    step();
    expect(messages.filter((m) => m.includes("position-on-shape-entity"))).toHaveLength(0);
  });

  it("does NOT warn when debug: false", () => {
    const normalWorld = makeNormalWorld();
    normalWorld.entity().set(Box, { hx: 0.5, hy: 0.5 }).set(Position, { x: 0, y: -0.25 });
    let now2 = 0;
    const orig = console.warn;
    const captured: string[] = [];
    console.warn = (msg: string) => captured.push(msg);
    try {
      for (let i = 0; i < 3; i++) {
        now2 += STEP_MS;
        normalWorld.progress(now2, STEP_MS);
      }
    } finally {
      console.warn = orig;
    }
    expect(captured.filter((m) => m.includes("position-on-shape-entity"))).toHaveLength(0);
  });

  it("600 steps produce exactly ONE warning", () => {
    world.entity().set(Box, { hx: 0.5, hy: 0.5 }).set(Position, { x: 1, y: 0 });
    step(600);
    expect(messages.filter((m) => m.includes("position-on-shape-entity"))).toHaveLength(1);
  });

  it("message contains the issue code and entity eid", () => {
    const shape = world.entity().set(Box, { hx: 0.5, hy: 0.5 }).set(Position, { x: 0, y: -0.25 });
    step();
    const warning = messages.find((m) => m.includes("position-on-shape-entity"))!;
    expect(warning).toBeDefined();
    expect(warning).toContain("position-on-shape-entity");
    expect(warning).toContain(`Entity${shape.eid}`);
  });

  it("re-arms when Position is removed from the shape entity", () => {
    const shape = world.entity().set(Box, { hx: 0.5, hy: 0.5 }).set(Position, { x: 0, y: 0 });
    step(); // warns once
    expect(messages.filter((m) => m.includes("position-on-shape-entity"))).toHaveLength(1);

    // Fix: remove Position from the shape entity.
    shape.remove(Position);
    step(5); // should not warn
    expect(messages.filter((m) => m.includes("position-on-shape-entity"))).toHaveLength(1);

    // Re-break: add Position back.
    shape.set(Position, { x: 0, y: 0 });
    step(); // warns again
    expect(messages.filter((m) => m.includes("position-on-shape-entity"))).toHaveLength(2);
  });
});
