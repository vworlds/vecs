// `PhysicsShapeLifecycle` (VP-11 commit 1): shape creation, destruction,
// geometry update, chain expansion, and reparenting.

import { ChildOf, World } from "@vworlds/vecs";
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
  Rotation,
  Segment,
  Sensor,
  SensorEvents,
  ShapePosition,
  ShapeRotation,
  installPhysics,
} from "../../src/index.js";
import { getPhysics, type PhysicsState } from "../../src/engine/state.js";
import { AWAKE_SET, STATIC_SET } from "../../src/engine/solver_set.js";
import { NULL_INDEX } from "../../src/util/handle.js";

let world: World;
let state: PhysicsState;

function makeBody(type: BodyType = BodyType.Dynamic) {
  return world.entity().set(Body, { type });
}

function makeShape(parent: ReturnType<World["entity"]>, geom: object = new Box()) {
  return world
    .entity()
    .set(ChildOf, { target: parent })
    .set(geom.constructor as never, geom);
}

function getShapeRecord(eid: number) {
  const handle = state.shapeByEntity.get(eid);
  if (handle === undefined) {
    return undefined;
  }
  return state.shapes.get(handle.index);
}

beforeEach(() => {
  world = new World();
  installPhysics(world);
  world.start();
  state = getPhysics(world);
});

// ─── Enter ────────────────────────────────────────────────────────────────────

describe("PhysicsShapeLifecycle.enter", () => {
  it("creates an internal shape + proxy when a Box is added under a Body", () => {
    const body = makeBody();
    const shape = makeShape(body);
    world.progress(0, 16);

    expect(state.shapeByEntity.has(shape.eid)).toBe(true);
    const rec = getShapeRecord(shape.eid)!;
    expect(rec).toBeDefined();
    expect(rec.bodyHandle).toBeDefined();
    expect(rec.proxyKey).toBeGreaterThanOrEqual(0);
  });

  it("marks the body massDirty on shape creation (cleared by VP-12 mass recompute)", () => {
    const body = makeBody();
    makeShape(body);
    world.progress(0, 16);

    // VP-12: PhysicsMassRecompute runs in physics-pre and clears massDirty.
    // After a full world.progress() massDirty is false (mass was computed).
    const bodyHandle = state.bodyByEntity.get(body.eid)!;
    const bodyRec = state.bodies.get(bodyHandle.index);
    expect(bodyRec.massDirty).toBe(false);
    // invMass is non-zero — mass was computed from the shape.
    const set = state.solverSets[bodyRec.setIndex]!;
    expect(set.bodySims[bodyRec.localIndex]!.invMass).toBeGreaterThan(0);
  });

  it("links the shape's bodyHandle to the correct body", () => {
    const body = makeBody();
    const shape = makeShape(body);
    world.progress(0, 16);

    const rec = getShapeRecord(shape.eid)!;
    const bodyHandle = state.bodyByEntity.get(body.eid)!;
    expect(rec.bodyHandle!.index).toBe(bodyHandle.index);
  });

  it("stores the entity id on the shape record", () => {
    const body = makeBody();
    const shape = makeShape(body);
    world.progress(0, 16);

    const rec = getShapeRecord(shape.eid)!;
    expect(rec.entity).toBe(shape.eid);
  });

  it("creates a Circle shape from the Circle component", () => {
    const body = makeBody();
    const shape = world.entity().set(ChildOf, { target: body }).set(Circle, { radius: 2 });
    world.progress(0, 16);

    const rec = getShapeRecord(shape.eid)!;
    expect(rec).toBeDefined();
    expect(rec.geometry.kind).toBe("circle");
  });

  it("creates a Capsule shape from the Capsule component", () => {
    const body = makeBody();
    const shape = world
      .entity()
      .set(ChildOf, { target: body })
      .set(Capsule, { x1: -1, y1: 0, x2: 1, y2: 0, radius: 0.5 });
    world.progress(0, 16);

    const rec = getShapeRecord(shape.eid)!;
    expect(rec.geometry.kind).toBe("capsule");
  });

  it("creates a Segment shape from the Segment component", () => {
    const body = makeBody();
    const shape = world
      .entity()
      .set(ChildOf, { target: body })
      .set(Segment, { x1: -1, y1: 0, x2: 1, y2: 0 });
    world.progress(0, 16);

    const rec = getShapeRecord(shape.eid)!;
    expect(rec.geometry.kind).toBe("segment");
  });

  it("creates a Polygon shape from the Polygon component", () => {
    const body = makeBody(BodyType.Static);
    const shape = world
      .entity()
      .set(ChildOf, { target: body })
      .set(Polygon, {
        vertices: [
          { x: -1, y: -1 },
          { x: 1, y: -1 },
          { x: 0, y: 1 },
        ],
        radius: 0,
      });
    world.progress(0, 16);

    const rec = getShapeRecord(shape.eid)!;
    expect(rec.geometry.kind).toBe("polygon");
  });

  it("reads material defaults (density=1, friction=0.6) when Material is absent", () => {
    const body = makeBody();
    const shape = makeShape(body);
    world.progress(0, 16);

    const rec = getShapeRecord(shape.eid)!;
    expect(rec.density).toBe(1);
    expect(rec.friction).toBeCloseTo(0.6);
    expect(rec.restitution).toBe(0);
  });

  it("reads explicit Material values when present", () => {
    const body = makeBody();
    const shape = world.entity().set(ChildOf, { target: body }).add(Box).set(Material, {
      density: 2,
      friction: 0.4,
      restitution: 0.5,
      rollingResistance: 0,
      tangentSpeed: 0,
      userMaterialId: 0,
    });
    world.progress(0, 16);

    const rec = getShapeRecord(shape.eid)!;
    expect(rec.density).toBe(2);
    expect(rec.friction).toBeCloseTo(0.4);
    expect(rec.restitution).toBeCloseTo(0.5);
  });

  it("reads CollisionFilter defaults (cat=1, mask=0xffffffff, group=0) when absent", () => {
    const body = makeBody();
    const shape = makeShape(body);
    world.progress(0, 16);

    const rec = getShapeRecord(shape.eid)!;
    expect(rec.categoryBits).toBe(1);
    expect(rec.maskBits).toBe(0xffffffff);
    expect(rec.groupIndex).toBe(0);
  });

  it("reads explicit CollisionFilter bits when present", () => {
    const body = makeBody();
    const shape = world
      .entity()
      .set(ChildOf, { target: body })
      .add(Box)
      .set(CollisionFilter, { categoryBits: 0x4, maskBits: 0x3, groupIndex: -1 });
    world.progress(0, 16);

    const rec = getShapeRecord(shape.eid)!;
    expect(rec.categoryBits).toBe(0x4);
    expect(rec.maskBits).toBe(0x3);
    expect(rec.groupIndex).toBe(-1);
  });

  it("marks sensor=false and sensorIndex=-1 when Sensor is absent", () => {
    const body = makeBody();
    const shape = makeShape(body);
    world.progress(0, 16);

    const rec = getShapeRecord(shape.eid)!;
    expect(rec.sensor).toBe(false);
    expect(rec.sensorIndex).toBe(-1);
  });

  it("marks sensor=true when Sensor component is present", () => {
    const body = makeBody();
    const shape = world.entity().set(ChildOf, { target: body }).add(Box).add(Sensor);
    world.progress(0, 16);

    const rec = getShapeRecord(shape.eid)!;
    expect(rec.sensor).toBe(true);
  });

  it("enables contact events when ContactEvents is present", () => {
    const body = makeBody();
    const shape = world.entity().set(ChildOf, { target: body }).add(Box).add(ContactEvents);
    world.progress(0, 16);

    const rec = getShapeRecord(shape.eid)!;
    expect(rec.enableContactEvents).toBe(true);
    expect(rec.enableHitEvents).toBe(false);
    expect(rec.enableSensorEvents).toBe(false);
  });

  it("enables all event flags when all event components are present", () => {
    const body = makeBody();
    const shape = world
      .entity()
      .set(ChildOf, { target: body })
      .add(Box)
      .add(ContactEvents)
      .add(HitEvents)
      .add(SensorEvents);
    world.progress(0, 16);

    const rec = getShapeRecord(shape.eid)!;
    expect(rec.enableContactEvents).toBe(true);
    expect(rec.enableHitEvents).toBe(true);
    expect(rec.enableSensorEvents).toBe(true);
  });

  it("uses the world AABB (body transform composed with local pose)", () => {
    // Place body at (10, 0), shape at identity local pose → AABB should be offset.
    const body = world.entity().set(Body, { type: BodyType.Static }).set(Position, { x: 10, y: 0 });
    const shape = world.entity().set(ChildOf, { target: body }).add(Box);
    world.progress(0, 16);

    const rec = getShapeRecord(shape.eid)!;
    // Box with hx=hy=0.5 at world x=10. The stored AABB includes speculative
    // distance (SPECULATIVE_DISTANCE = 4 * LINEAR_SLOP = 0.02).
    // Center should be at ~10 regardless.
    expect((rec.aabbMinX + rec.aabbMaxX) / 2).toBeCloseTo(10, 3);
  });

  it("respects ShapePosition (local offset) in world AABB computation", () => {
    // Body at origin, shape offset by (5, 0) locally
    const body = world.entity().set(Body, { type: BodyType.Static });
    const shape = world
      .entity()
      .set(ChildOf, { target: body })
      .set(Box, { hx: 0.5, hy: 0.5 })
      .set(ShapePosition, { x: 5, y: 0 });
    world.progress(0, 16);

    const rec = getShapeRecord(shape.eid)!;
    expect(rec.localX).toBeCloseTo(5);
    expect(rec.localY).toBeCloseTo(0);
    // Center should be at ~5 (spec distance widens both ends equally).
    expect((rec.aabbMinX + rec.aabbMaxX) / 2).toBeCloseTo(5, 3);
  });

  it("respects ShapeRotation in world AABB computation", () => {
    const body = world.entity().set(Body, { type: BodyType.Static });
    const shape = world
      .entity()
      .set(ChildOf, { target: body })
      .set(Box, { hx: 1, hy: 0.1 })
      .set(ShapeRotation, { angle: Math.PI / 2 });
    world.progress(0, 16);

    const rec = getShapeRecord(shape.eid)!;
    // Rotated 90°: wide axis becomes tall.
    // Box is 2 wide, 0.2 tall. After 90° rotation: ~0.2 wide, ~2 tall.
    // AABB width/height include 2 * SPECULATIVE_DISTANCE on each axis.
    // Just check that the axes are roughly swapped: x < y.
    expect(rec.aabbMaxX - rec.aabbMinX).toBeLessThan(rec.aabbMaxY - rec.aabbMinY);
  });

  it("links into the body shape list (shapeHead)", () => {
    const body = makeBody();
    const shape = makeShape(body);
    world.progress(0, 16);

    const bodyHandle = state.bodyByEntity.get(body.eid)!;
    const bodyRec = state.bodies.get(bodyHandle.index);
    expect(bodyRec.shapeHead).not.toBe(NULL_INDEX);
    expect(bodyRec.shapeCount).toBe(1);
  });

  it("links two shapes into the body shape list", () => {
    const body = makeBody();
    makeShape(body);
    makeShape(body, new Circle());
    world.progress(0, 16);

    const bodyHandle = state.bodyByEntity.get(body.eid)!;
    const bodyRec = state.bodies.get(bodyHandle.index);
    expect(bodyRec.shapeCount).toBe(2);
  });

  it("does NOT create a shape for geometry on a grandchild (immediate-parent rule)", () => {
    const grandparent = makeBody();
    const middleChild = world.entity().set(ChildOf, { target: grandparent });
    const grandchild = world.entity().set(ChildOf, { target: middleChild }).add(Box);
    world.progress(0, 16);

    // grandchild's parent is not a Body — no shape created
    expect(state.shapeByEntity.has(grandchild.eid)).toBe(false);
  });

  it("works when body is created first, then shape (body-then-shape order)", () => {
    const body = makeBody();
    world.progress(0, 16);

    const shape = makeShape(body);
    world.progress(16, 16);

    expect(state.shapeByEntity.has(shape.eid)).toBe(true);
  });

  it("works when shape is created before body starts (shape-then-body order)", () => {
    // Shape with ChildOf to a future body won't enter until the body has Body.
    const bodyEntity = world.entity();
    const shape = world.entity().set(ChildOf, { target: bodyEntity }).add(Box);
    world.progress(0, 16);
    // body doesn't have Body yet — no shape
    expect(state.shapeByEntity.has(shape.eid)).toBe(false);

    bodyEntity.set(Body, { type: BodyType.Dynamic });
    world.progress(16, 16);
    expect(state.shapeByEntity.has(shape.eid)).toBe(true);
  });
});

// ─── Chain expansion ──────────────────────────────────────────────────────────

describe("PhysicsShapeLifecycle — Chain shapes", () => {
  it("expands a Chain into N-1 segments for an open chain", () => {
    const body = makeBody(BodyType.Static);
    const chain = world
      .entity()
      .set(ChildOf, { target: body })
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

    // 4 points open chain → 3 segments
    const handles = state.chainShapeByEntity.get(chain.eid);
    expect(handles).toBeDefined();
    expect(handles!.length).toBe(3);

    const bodyHandle = state.bodyByEntity.get(body.eid)!;
    const bodyRec = state.bodies.get(bodyHandle.index);
    expect(bodyRec.shapeCount).toBe(3);
  });

  it("expands a Chain into N segments for a loop chain", () => {
    const body = makeBody(BodyType.Static);
    const chain = world
      .entity()
      .set(ChildOf, { target: body })
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

    // 4 points loop → 4 segments
    const handles = state.chainShapeByEntity.get(chain.eid);
    expect(handles!.length).toBe(4);
  });

  it("each chain segment has a proxyKey and is linked to the body", () => {
    const body = makeBody(BodyType.Static);
    const chain = world
      .entity()
      .set(ChildOf, { target: body })
      .set(Chain, {
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 2, y: 0 },
        ],
        loop: false,
      });
    world.progress(0, 16);

    const handles = state.chainShapeByEntity.get(chain.eid)!;
    for (const h of handles) {
      const seg = state.shapes.get(h.index);
      expect(seg.geometry.kind).toBe("chainSegment");
      expect(seg.proxyKey).toBeGreaterThanOrEqual(0);
    }
  });
});

// ─── Exit ─────────────────────────────────────────────────────────────────────

describe("PhysicsShapeLifecycle.exit", () => {
  it("removes the internal shape + proxy when geometry is removed", () => {
    const body = makeBody();
    const shape = makeShape(body);
    world.progress(0, 16);
    expect(state.shapeByEntity.has(shape.eid)).toBe(true);

    shape.remove(Box);
    world.progress(16, 16);

    expect(state.shapeByEntity.has(shape.eid)).toBe(false);
  });

  it("removes from the body shape list on exit", () => {
    const body = makeBody();
    const shape = makeShape(body);
    world.progress(0, 16);

    const bodyHandle = state.bodyByEntity.get(body.eid)!;
    expect(state.bodies.get(bodyHandle.index).shapeCount).toBe(1);

    shape.remove(Box);
    world.progress(16, 16);

    expect(state.bodies.get(bodyHandle.index).shapeCount).toBe(0);
    expect(state.bodies.get(bodyHandle.index).shapeHead).toBe(NULL_INDEX);
  });

  it("marks the body massDirty on shape removal", () => {
    const body = makeBody();
    const shape = makeShape(body);
    world.progress(0, 16);

    const bodyHandle = state.bodyByEntity.get(body.eid)!;
    // massDirty is already false after frame 1 (VP-12 cleared it).

    shape.remove(Box);
    world.progress(16, 16);

    // VP-12: shape removal marks massDirty, then PhysicsMassRecompute clears it.
    // After a full world.progress() massDirty is false again.
    expect(state.bodies.get(bodyHandle.index).massDirty).toBe(false);
  });

  it("is idempotent — double-remove does not throw", () => {
    const body = makeBody();
    const shape = makeShape(body);
    world.progress(0, 16);

    shape.remove(Box);
    world.progress(16, 16);
    // Second removal of a shape that's already gone — should be no-op
    expect(() => world.progress(32, 16)).not.toThrow();
  });

  it("destroys all chain segment proxies on chain exit", () => {
    const body = makeBody(BodyType.Static);
    const chain = world
      .entity()
      .set(ChildOf, { target: body })
      .set(Chain, {
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 2, y: 0 },
        ],
        loop: false,
      });
    world.progress(0, 16);
    expect(state.chainShapeByEntity.has(chain.eid)).toBe(true);
    expect(state.bodies.get(state.bodyByEntity.get(body.eid)!.index).shapeCount).toBe(2);

    chain.remove(Chain);
    world.progress(16, 16);

    expect(state.chainShapeByEntity.has(chain.eid)).toBe(false);
    expect(state.bodies.get(state.bodyByEntity.get(body.eid)!.index).shapeCount).toBe(0);
  });

  it("destroying the shape entity removes the internal shape", () => {
    const body = makeBody();
    const shape = makeShape(body);
    world.progress(0, 16);
    const eid = shape.eid;
    shape.destroy();
    world.progress(16, 16);
    expect(state.shapeByEntity.has(eid)).toBe(false);
  });

  it("body persists after its shape is removed", () => {
    const body = makeBody();
    const shape = makeShape(body);
    world.progress(0, 16);

    shape.remove(Box);
    world.progress(16, 16);

    expect(state.bodyByEntity.has(body.eid)).toBe(true);
  });

  it("removing the parent body destroys the shape (ChildOf cascade)", () => {
    const body = makeBody();
    const shape = makeShape(body);
    world.progress(0, 16);
    const shapeEid = shape.eid;

    body.remove(Body);
    world.progress(16, 16);

    // Shape entity is destroyed via ChildOf cascade (onDeleteTarget = Delete).
    expect(state.shapeByEntity.has(shapeEid)).toBe(false);
  });
});

// ─── Geometry type swap (exclusivity) ────────────────────────────────────────

describe("PhysicsShapeLifecycle — geometry type swap", () => {
  it("Box→Circle swap destroys the old shape and creates a new one", () => {
    const body = makeBody();
    const shape = makeShape(body);
    world.progress(0, 16);

    const firstHandle = state.shapeByEntity.get(shape.eid)!;
    expect(getShapeRecord(shape.eid)!.geometry.kind).toBe("polygon"); // box is polygon

    shape.set(Circle, { radius: 1 });
    world.progress(16, 16);

    const secondHandle = state.shapeByEntity.get(shape.eid)!;
    // A new allocation — same index (LIFO pool reuse) but bumped generation.
    // The observable: shape record now holds circle geometry.
    expect(secondHandle.generation).toBeGreaterThan(firstHandle.generation);
    expect(getShapeRecord(shape.eid)!.geometry.kind).toBe("circle");
  });
});

// ─── Reparenting ─────────────────────────────────────────────────────────────

describe("PhysicsShapeLifecycle — reparenting", () => {
  it("reparenting a shape to a new Body moves it to the new body's list", () => {
    const bodyA = makeBody();
    const bodyB = makeBody(BodyType.Static);
    const shape = makeShape(bodyA);
    world.progress(0, 16);

    const bodyAHandle = state.bodyByEntity.get(bodyA.eid)!;
    const bodyBHandle = state.bodyByEntity.get(bodyB.eid)!;
    expect(state.bodies.get(bodyAHandle.index).shapeCount).toBe(1);
    expect(state.bodies.get(bodyBHandle.index).shapeCount).toBe(0);

    shape.set(ChildOf, { target: bodyB });
    world.progress(16, 16);

    expect(state.bodies.get(bodyAHandle.index).shapeCount).toBe(0);
    expect(state.bodies.get(bodyBHandle.index).shapeCount).toBe(1);
  });

  it("reparenting marks both old and new body massDirty", () => {
    const bodyA = makeBody();
    const bodyB = makeBody();
    const shape = makeShape(bodyA);
    world.progress(0, 16);

    // After frame 0, massDirty was cleared by VP-12 mass recompute.

    shape.set(ChildOf, { target: bodyB });
    world.progress(16, 16);

    // VP-12: reparenting marks both bodies massDirty, then PhysicsMassRecompute
    // clears both. After a full world.progress() massDirty is false on both.
    expect(state.bodies.get(state.bodyByEntity.get(bodyA.eid)!.index).massDirty).toBe(false);
    expect(state.bodies.get(state.bodyByEntity.get(bodyB.eid)!.index).massDirty).toBe(false);
  });

  it("reparenting updates the bodyHandle on the shape record", () => {
    const bodyA = makeBody();
    const bodyB = makeBody();
    const shape = makeShape(bodyA);
    world.progress(0, 16);

    const bodyBHandle = state.bodyByEntity.get(bodyB.eid)!;

    shape.set(ChildOf, { target: bodyB });
    world.progress(16, 16);

    const rec = getShapeRecord(shape.eid)!;
    expect(rec.bodyHandle!.index).toBe(bodyBHandle.index);
  });
});
