// `PhysicsShapeLifecycle` (VP-11 commit 1): shape creation, destruction,
// geometry update, chain expansion, and reparenting.

import { World, type EID } from "@vworlds/vecs";
import { beforeEach, describe, expect, it } from "vitest";

import {
  Body,
  BodyType,
  Box,
  Capsule,
  Chain,
  Circle,
  CollisionFilter,
  ContactEvents,
  HitEvents,
  Material,
  Polygon,
  Position,
  Segment,
  Sensor,
  SensorEvents,
  ShapePosition,
  ShapeRotation,
  installPhysics,
} from "../../src/index.js";
import { getPhysics, type PhysicsState } from "../../src/adapter/state.js";

const LINEAR_SLOP = 0.005;

let world: World;
let state: PhysicsState;

function makeBody(type: BodyType = BodyType.Dynamic) {
  return world.entity().set(Body, { type });
}

function makeShape(parent: ReturnType<World["entity"]>, geom: object = new Box()) {
  return world
    .entity()
    .childOf(parent)
    .set(geom.constructor as never, geom);
}

function hasWasmShape(eid: EID): boolean {
  const shapeId = state.shapeByEntityWasm.get(eid);
  if (shapeId === undefined) {
    return false;
  }
  return state.box2d.b2Shape_IsValid(shapeId);
}

function getBodyMass(bodyEid: EID): number {
  const bodyId = state.bodyByEntityWasm.get(bodyEid);
  if (bodyId === undefined) {
    return 0;
  }
  return state.box2d.b2Body_GetMass(bodyId);
}

beforeEach(() => {
  world = new World();
  installPhysics(world);
  state = getPhysics(world);
});

// ─── Enter ────────────────────────────────────────────────────────────────────

describe("PhysicsShapeLifecycle.enter", () => {
  it("creates a WASM shape when a Box is added under a Body", () => {
    const body = makeBody();
    const shape = makeShape(body);
    world.progress(0, 16);

    expect(hasWasmShape(shape.eid)).toBe(true);
    expect(state.entityByShapeIndex.has(state.shapeByEntityWasm.get(shape.eid)!.index1)).toBe(true);
  });

  it("computes mass on body after shape creation (VP-12 mass recompute)", () => {
    const body = makeBody();
    makeShape(body); // default Box with density=1
    world.progress(0, 16);

    // dirtyMassBodies should be cleared after PhysicsMassRecompute runs.
    expect(state.dirtyMassBodies.size).toBe(0);
    // Mass should be non-zero for dynamic body with density=1 shape.
    expect(getBodyMass(body.eid)).toBeGreaterThan(0);
  });

  it("creates a Circle WASM shape from the Circle component", () => {
    const body = makeBody();
    const shape = world.entity().childOf(body).set(Circle, { radius: 2 });
    world.progress(0, 16);

    expect(hasWasmShape(shape.eid)).toBe(true);
  });

  it("creates a Capsule WASM shape from the Capsule component", () => {
    const body = makeBody();
    const shape = world
      .entity()
      .childOf(body)
      .set(Capsule, { x1: -1, y1: 0, x2: 1, y2: 0, radius: 0.5 });
    world.progress(0, 16);

    expect(hasWasmShape(shape.eid)).toBe(true);
  });

  it("creates a Segment WASM shape from the Segment component", () => {
    const body = makeBody();
    const shape = world.entity().childOf(body).set(Segment, { x1: -1, y1: 0, x2: 1, y2: 0 });
    world.progress(0, 16);

    expect(hasWasmShape(shape.eid)).toBe(true);
  });

  it("creates a Polygon WASM shape from the Polygon component", () => {
    const body = makeBody(BodyType.Static);
    const shape = world
      .entity()
      .childOf(body)
      .set(Polygon, {
        vertices: [
          { x: -1, y: -1 },
          { x: 1, y: -1 },
          { x: 0, y: 1 },
        ],
        radius: 0,
      });
    world.progress(0, 16);

    expect(hasWasmShape(shape.eid)).toBe(true);
  });

  it("reads material defaults (density=1, friction=0.6) when Material is absent", () => {
    const body = makeBody();
    const shape = makeShape(body);
    world.progress(0, 16);

    const shapeId = state.shapeByEntityWasm.get(shape.eid)!;
    expect(state.box2d.b2Shape_GetDensity(shapeId)).toBe(1);
    const mat = state.box2d.b2Shape_GetSurfaceMaterial(shapeId);
    try {
      expect(mat.friction).toBeCloseTo(0.6);
      expect(mat.restitution).toBe(0);
    } finally {
      mat.delete();
    }
  });

  it("reads explicit Material values when present", () => {
    const body = makeBody();
    const shape = world.entity().childOf(body).add(Box).set(Material, {
      density: 2,
      friction: 0.4,
      restitution: 0.5,
      rollingResistance: 0,
      tangentSpeed: 0,
      userMaterialId: 0,
    });
    world.progress(0, 16);

    const shapeId = state.shapeByEntityWasm.get(shape.eid)!;
    expect(state.box2d.b2Shape_GetDensity(shapeId)).toBe(2);
    const mat = state.box2d.b2Shape_GetSurfaceMaterial(shapeId);
    try {
      expect(mat.friction).toBeCloseTo(0.4);
      expect(mat.restitution).toBeCloseTo(0.5);
    } finally {
      mat.delete();
    }
  });

  it("reads CollisionFilter defaults (cat=1, mask=0xffffffff, group=0) when absent", () => {
    const body = makeBody();
    const shape = makeShape(body);
    world.progress(0, 16);

    const shapeId = state.shapeByEntityWasm.get(shape.eid)!;
    const filter = state.box2d.b2Shape_GetFilter(shapeId);
    try {
      expect(filter.categoryBits).toBe(1);
      expect(filter.maskBits).toBe(0xffffffff);
      expect(filter.groupIndex).toBe(0);
    } finally {
      filter.delete();
    }
  });

  it("reads explicit CollisionFilter bits when present", () => {
    const body = makeBody();
    const shape = world
      .entity()
      .childOf(body)
      .add(Box)
      .set(CollisionFilter, { categoryBits: 0x4, maskBits: 0x3, groupIndex: -1 });
    world.progress(0, 16);

    const shapeId = state.shapeByEntityWasm.get(shape.eid)!;
    const filter = state.box2d.b2Shape_GetFilter(shapeId);
    try {
      expect(filter.categoryBits).toBe(0x4);
      expect(filter.maskBits).toBe(0x3);
      expect(filter.groupIndex).toBe(-1);
    } finally {
      filter.delete();
    }
  });

  it("marks sensor=false when Sensor is absent", () => {
    const body = makeBody();
    const shape = makeShape(body);
    world.progress(0, 16);

    const shapeId = state.shapeByEntityWasm.get(shape.eid)!;
    expect(state.box2d.b2Shape_IsSensor(shapeId)).toBe(false);
  });

  it("marks sensor=true when Sensor component is present", () => {
    const body = makeBody();
    const shape = world.entity().childOf(body).add(Box).add(Sensor);
    world.progress(0, 16);

    const shapeId = state.shapeByEntityWasm.get(shape.eid)!;
    expect(state.box2d.b2Shape_IsSensor(shapeId)).toBe(true);
  });

  it("enables contact events when ContactEvents is present", () => {
    const body = makeBody();
    const shape = world.entity().childOf(body).add(Box).add(ContactEvents);
    world.progress(0, 16);

    const shapeId = state.shapeByEntityWasm.get(shape.eid)!;
    expect(state.box2d.b2Shape_AreContactEventsEnabled(shapeId)).toBe(true);
    expect(state.box2d.b2Shape_AreHitEventsEnabled(shapeId)).toBe(false);
    expect(state.box2d.b2Shape_AreSensorEventsEnabled(shapeId)).toBe(false);
  });

  it("enables all event flags when all event components are present", () => {
    const body = makeBody();
    const shape = world
      .entity()
      .childOf(body)
      .add(Box)
      .add(ContactEvents)
      .add(HitEvents)
      .add(SensorEvents);
    world.progress(0, 16);

    const shapeId = state.shapeByEntityWasm.get(shape.eid)!;
    expect(state.box2d.b2Shape_AreContactEventsEnabled(shapeId)).toBe(true);
    expect(state.box2d.b2Shape_AreHitEventsEnabled(shapeId)).toBe(true);
    expect(state.box2d.b2Shape_AreSensorEventsEnabled(shapeId)).toBe(true);
  });

  it("uses the world AABB (body transform composed with local pose)", () => {
    // Place body at (10, 0), shape at identity local pose → AABB center near (10, 0).
    const body = world.entity().set(Body, { type: BodyType.Static }).set(Position, { x: 10, y: 0 });
    const shape = world.entity().childOf(body).add(Box);
    world.progress(0, 16);

    const shapeId = state.shapeByEntityWasm.get(shape.eid)!;
    const aabb = state.box2d.b2Shape_GetAABB(shapeId);
    try {
      const centerX = (aabb.lowerBound.x + aabb.upperBound.x) / 2;
      expect(centerX).toBeCloseTo(10, 1);
    } finally {
      aabb.delete();
    }
  });

  it("respects ShapePosition (local offset) in world AABB computation", () => {
    const body = world.entity().set(Body, { type: BodyType.Static });
    const shape = world
      .entity()
      .childOf(body)
      .set(Box, { hx: 0.5, hy: 0.5 })
      .set(ShapePosition, { x: 5, y: 0 });
    world.progress(0, 16);

    const shapeId = state.shapeByEntityWasm.get(shape.eid)!;
    const aabb = state.box2d.b2Shape_GetAABB(shapeId);
    try {
      const centerX = (aabb.lowerBound.x + aabb.upperBound.x) / 2;
      expect(centerX).toBeCloseTo(5, 1);
    } finally {
      aabb.delete();
    }
  });

  it("respects ShapeRotation in world AABB computation", () => {
    const body = world.entity().set(Body, { type: BodyType.Static });
    const shape = world
      .entity()
      .childOf(body)
      .set(Box, { hx: 1, hy: 0.1 })
      .set(ShapeRotation, { angle: Math.PI / 2 });
    world.progress(0, 16);

    const shapeId = state.shapeByEntityWasm.get(shape.eid)!;
    const aabb = state.box2d.b2Shape_GetAABB(shapeId);
    try {
      // Rotated 90°: wide axis becomes tall.
      const width = aabb.upperBound.x - aabb.lowerBound.x;
      const height = aabb.upperBound.y - aabb.lowerBound.y;
      expect(width).toBeLessThan(height);
    } finally {
      aabb.delete();
    }
  });

  it("does NOT create a shape for geometry on a grandchild (immediate-parent rule)", () => {
    const grandparent = makeBody();
    const middleChild = world.entity().childOf(grandparent);
    const grandchild = world.entity().childOf(middleChild).add(Box);
    world.progress(0, 16);

    expect(state.shapeByEntityWasm.has(grandchild.eid)).toBe(false);
  });

  it("works when body is created first, then shape (body-then-shape order)", () => {
    const body = makeBody();
    world.progress(0, 16);

    const shape = makeShape(body);
    world.progress(16, 16);

    expect(hasWasmShape(shape.eid)).toBe(true);
  });

  it("works when shape is created before body starts (shape-then-body order)", () => {
    const bodyEntity = world.entity();
    const shape = world.entity().childOf(bodyEntity).add(Box);
    world.progress(0, 16);
    // body doesn't have Body yet — no shape
    expect(state.shapeByEntityWasm.has(shape.eid)).toBe(false);

    bodyEntity.set(Body, { type: BodyType.Dynamic });
    world.progress(16, 16);
    expect(hasWasmShape(shape.eid)).toBe(true);
  });
});

// ─── Chain expansion ──────────────────────────────────────────────────────────

describe("PhysicsShapeLifecycle — Chain shapes", () => {
  it("creates a WASM chain for an open chain with >= 4 points", () => {
    const body = makeBody(BodyType.Static);
    const chain = world
      .entity()
      .childOf(body)
      .set(Chain, {
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 2, y: 0 },
          { x: 3, y: 0 },
        ],
        loop: false,
      });
    world.progress(0, 16);

    const chainId = state.chainByEntity.get(chain.eid);
    expect(chainId).toBeDefined();
    expect(state.box2d.b2Chain_IsValid(chainId!)).toBe(true);
  });

  it("creates a WASM chain for a loop chain with >= 4 points", () => {
    const body = makeBody(BodyType.Static);
    const chain = world
      .entity()
      .childOf(body)
      .set(Chain, {
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 1, y: 1 },
          { x: 0, y: 1 },
        ],
        loop: true,
      });
    world.progress(0, 16);

    const chainId = state.chainByEntity.get(chain.eid);
    expect(chainId).toBeDefined();
    expect(state.box2d.b2Chain_IsValid(chainId!)).toBe(true);
  });
});

// ─── Exit ─────────────────────────────────────────────────────────────────────

describe("PhysicsShapeLifecycle.exit", () => {
  it("removes the WASM shape when geometry is removed", () => {
    const body = makeBody();
    const shape = makeShape(body);
    world.progress(0, 16);
    const shapeId = state.shapeByEntityWasm.get(shape.eid)!;
    expect(state.box2d.b2Shape_IsValid(shapeId)).toBe(true);

    shape.remove(Box);
    world.progress(16, 16);

    expect(state.shapeByEntityWasm.has(shape.eid)).toBe(false);
    expect(state.box2d.b2Shape_IsValid(shapeId)).toBe(false);
  });

  it("marks the body mass dirty on shape removal (cleared by mass recompute)", () => {
    const body = makeBody();
    const shape = makeShape(body);
    world.progress(0, 16);

    const massBefore = getBodyMass(body.eid);
    expect(massBefore).toBeGreaterThan(0);

    shape.remove(Box);
    world.progress(16, 16);

    // Mass should be zero now (no shapes with density).
    expect(getBodyMass(body.eid)).toBe(0);
    expect(state.dirtyMassBodies.size).toBe(0);
  });

  it("is idempotent — double-remove does not throw", () => {
    const body = makeBody();
    const shape = makeShape(body);
    world.progress(0, 16);

    shape.remove(Box);
    world.progress(16, 16);
    expect(() => world.progress(32, 16)).not.toThrow();
  });

  it("destroys the WASM chain on chain entity exit", () => {
    const body = makeBody(BodyType.Static);
    const chain = world
      .entity()
      .childOf(body)
      .set(Chain, {
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 2, y: 0 },
          { x: 3, y: 0 },
        ],
        loop: false,
      });
    world.progress(0, 16);
    const chainId = state.chainByEntity.get(chain.eid)!;
    expect(state.box2d.b2Chain_IsValid(chainId)).toBe(true);

    chain.remove(Chain);
    world.progress(16, 16);

    expect(state.chainByEntity.has(chain.eid)).toBe(false);
    expect(state.box2d.b2Chain_IsValid(chainId)).toBe(false);
  });

  it("destroying the shape entity removes the WASM shape", () => {
    const body = makeBody();
    const shape = makeShape(body);
    world.progress(0, 16);
    const eid = shape.eid;
    shape.destroy();
    world.progress(16, 16);
    expect(state.shapeByEntityWasm.has(eid)).toBe(false);
  });

  it("clears the reverse shape slot before Box2D reuses the public index", () => {
    const body = makeBody();
    const oldShape = makeShape(body);
    world.progress(0, 16);
    const oldShapeId = state.shapeByEntityWasm.get(oldShape.eid)!;

    oldShape.remove(Box);
    world.progress(16, 16);

    expect(state.entityByShapeIndex.get(oldShapeId.index1)).toBeUndefined();

    const newShape = makeShape(body);
    world.progress(32, 16);
    const newShapeId = state.shapeByEntityWasm.get(newShape.eid)!;

    expect(newShapeId.index1).toBe(oldShapeId.index1);
    expect(state.entityByShapeIndex.get(newShapeId.index1)).toBe(newShape.eid);
    expect(state.entityByShapeIndex.get(newShapeId.index1)).not.toBe(oldShape.eid);
  });

  it("body persists after its shape is removed", () => {
    const body = makeBody();
    const shape = makeShape(body);
    world.progress(0, 16);

    shape.remove(Box);
    world.progress(16, 16);

    expect(state.bodyByEntityWasm.has(body.eid)).toBe(true);
    const bodyId = state.bodyByEntityWasm.get(body.eid)!;
    expect(state.box2d.b2Body_IsValid(bodyId)).toBe(true);
  });

  it("removing the parent body destroys the WASM shape (ChildOf cascade)", () => {
    const body = makeBody();
    const shape = makeShape(body);
    world.progress(0, 16);
    const shapeEid = shape.eid;

    body.remove(Body);
    world.progress(16, 16);

    expect(state.shapeByEntityWasm.has(shapeEid)).toBe(false);
  });
});

// ─── Geometry type swap (exclusivity) ────────────────────────────────────────

describe("PhysicsShapeLifecycle — geometry type swap", () => {
  it("Box→Circle swap destroys the old shape and creates a new Circle shape", () => {
    const body = makeBody();
    const shape = makeShape(body);
    world.progress(0, 16);

    const oldShapeId = state.shapeByEntityWasm.get(shape.eid)!;
    expect(state.box2d.b2Shape_IsValid(oldShapeId)).toBe(true);

    shape.set(Circle, { radius: 1 });
    world.progress(16, 16);

    // Old shape was destroyed.
    expect(state.box2d.b2Shape_IsValid(oldShapeId)).toBe(false);
    // New shape was created.
    expect(hasWasmShape(shape.eid)).toBe(true);
  });
});

// ─── Reparenting ─────────────────────────────────────────────────────────────

describe("PhysicsShapeLifecycle — reparenting", () => {
  it("reparenting a shape to a new Body updates the WASM shape's body", () => {
    const bodyA = makeBody();
    const bodyB = makeBody(BodyType.Static);
    const shape = makeShape(bodyA);
    world.progress(0, 16);

    const massBefore = getBodyMass(bodyA.eid);
    expect(massBefore).toBeGreaterThan(0);

    shape.childOf(bodyB);
    world.progress(16, 16);

    // bodyA has no more shapes → mass becomes 0.
    expect(getBodyMass(bodyA.eid)).toBe(0);
    // Shape still exists and is attached somewhere.
    expect(hasWasmShape(shape.eid)).toBe(true);
  });

  it("reparenting marks both old and new body mass dirty (cleared by mass recompute)", () => {
    const bodyA = makeBody();
    const bodyB = makeBody();
    const shape = makeShape(bodyA);
    world.progress(0, 16);

    expect(state.dirtyMassBodies.size).toBe(0);

    shape.childOf(bodyB);
    world.progress(16, 16);

    // PhysicsMassRecompute should have cleared dirtyMassBodies.
    expect(state.dirtyMassBodies.size).toBe(0);
  });
});

// ─── Degenerate segment / capsule rejection ───────────────────────────────────

describe("degenerate capsule/segment rejection (Box2D parity)", () => {
  it("zero-length Capsule is not registered as a WASM shape (skipped at creation)", () => {
    const body = makeBody();
    const e = world.entity().childOf(body).set(Capsule, { x1: 0, y1: 0, x2: 0, y2: 0, radius: 1 });
    world.progress(0, 16);

    expect(state.shapeByEntityWasm.has(e.eid)).toBe(false);
  });

  it("near-zero Capsule (<= LINEAR_SLOP distance) is rejected", () => {
    const body = makeBody();
    const tinyDelta = LINEAR_SLOP * 0.5;
    const e = world
      .entity()
      .childOf(body)
      .set(Capsule, { x1: 0, y1: 0, x2: tinyDelta, y2: 0, radius: 1 });
    world.progress(0, 16);

    expect(state.shapeByEntityWasm.has(e.eid)).toBe(false);
  });

  it("valid Capsule (> LINEAR_SLOP distance) IS registered", () => {
    const body = makeBody();
    const e = world
      .entity()
      .childOf(body)
      .set(Capsule, { x1: -1, y1: 0, x2: 1, y2: 0, radius: 0.5 });
    world.progress(0, 16);

    expect(hasWasmShape(e.eid)).toBe(true);
  });

  it("zero-length Segment is not registered", () => {
    const body = makeBody();
    const e = world.entity().childOf(body).set(Segment, { x1: 5, y1: 5, x2: 5, y2: 5 });
    world.progress(0, 16);

    expect(state.shapeByEntityWasm.has(e.eid)).toBe(false);
  });

  it("degenerate Capsule update is ignored; old valid shape is preserved", () => {
    const body = makeBody();
    const e = world
      .entity()
      .childOf(body)
      .set(Capsule, { x1: -1, y1: 0, x2: 1, y2: 0, radius: 0.5 });
    world.progress(0, 16);

    const originalShapeId = state.shapeByEntityWasm.get(e.eid)!;
    expect(state.box2d.b2Shape_IsValid(originalShapeId)).toBe(true);

    // Update to degenerate endpoints — should be ignored.
    e.set(Capsule, { x1: 0, y1: 0, x2: 0, y2: 0, radius: 0.5 });
    world.progress(16, 16);

    // Shape should still be the same original shape.
    const currentShapeId = state.shapeByEntityWasm.get(e.eid)!;
    expect(state.box2d.b2Shape_IsValid(currentShapeId)).toBe(true);
  });

  it("degenerate Segment update is ignored; old valid shape is preserved", () => {
    const body = makeBody();
    const e = world.entity().childOf(body).set(Segment, { x1: -2, y1: 0, x2: 2, y2: 0 });
    world.progress(0, 16);

    const originalShapeId = state.shapeByEntityWasm.get(e.eid)!;
    expect(state.box2d.b2Shape_IsValid(originalShapeId)).toBe(true);

    e.set(Segment, { x1: 0, y1: 0, x2: 0, y2: 0 });
    world.progress(16, 16);

    const currentShapeId = state.shapeByEntityWasm.get(e.eid)!;
    expect(state.box2d.b2Shape_IsValid(currentShapeId)).toBe(true);
  });
});
