// VP-12 — mass integral + b2UpdateBodyMassData port.
//
// Golden test: ShapeMassTest from box2d/test/test_shape.c (assertions verbatim).
// Unit tests for box (known exact result), compound body (two shapes, parallel
// axis), non-dynamic/massless-dynamic defaults, and the cross-ticket contract
// (localCentroid is geometry-local; local pose must be applied before combining).
//
// Upstream sources:
//   box2d/src/geometry.c   — b2ComputeCircleMass, b2ComputeCapsuleMass, b2ComputePolygonMass
//   box2d/src/body.c       — b2UpdateBodyMassData
//   box2d/test/test_shape.c::ShapeMassTest

import { beforeEach, describe, expect, it } from "vitest";

import { PI } from "../../src/math/constants.js";
import { computeHull, makeBox, makePolygon } from "../../src/engine/geometry.js";
import {
  computeCircleMass,
  computeCapsuleMass,
  computePolygonMass,
  updateBodyMassData,
} from "../../src/engine/mass.js";
import { NULL_INDEX, type BodyHandle, type ShapeHandle } from "../../src/util/handle.js";
import { DYNAMIC_BODY, KINEMATIC_BODY, STATIC_BODY, makeBodySim } from "../../src/engine/body.js";
import { HUGE } from "../../src/math/constants.js";
import { ShapeType } from "../../src/engine/shape.js";
import type { InternalShape } from "../../src/engine/shape.js";
import type { InternalBody } from "../../src/engine/body.js";
import type { BodySim } from "../../src/engine/body.js";
import type { GeometryUnion } from "../../src/engine/geometry.js";

const FLT_EPSILON = 1.192e-7;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeInternalShape(
  type: ShapeType,
  geometry: GeometryUnion,
  density: number,
  opts: {
    localCentroidX?: number;
    localCentroidY?: number;
    // Local pose of this shape relative to the body origin.
    localX?: number;
    localY?: number;
    localCos?: number;
    localSin?: number;
    sensor?: boolean;
    nextShape?: number;
    prevShape?: number;
  } = {}
): InternalShape {
  const placeholder = { index: NULL_INDEX, generation: 0 } as unknown as BodyHandle;
  return {
    type,
    geometry,
    density,
    localCentroidX: opts.localCentroidX ?? 0,
    localCentroidY: opts.localCentroidY ?? 0,
    localX: opts.localX ?? 0,
    localY: opts.localY ?? 0,
    localCos: opts.localCos ?? 1,
    localSin: opts.localSin ?? 0,
    sensor: opts.sensor ?? false,
    // Remaining fields — not read by mass code.
    aabbMinX: 0,
    aabbMinY: 0,
    aabbMaxX: 0,
    aabbMaxY: 0,
    proxyKey: -1,
    fatAabbMinX: 0,
    fatAabbMinY: 0,
    fatAabbMaxX: 0,
    fatAabbMaxY: 0,
    bodyHandle: placeholder,
    entity: 0,
    prevShape: opts.prevShape ?? NULL_INDEX,
    nextShape: opts.nextShape ?? NULL_INDEX,
    friction: 0.6,
    restitution: 0,
    rollingResistance: 0,
    tangentSpeed: 0,
    userMaterialId: 0,
    categoryBits: 1,
    maskBits: 0xffffffff,
    groupIndex: 0,
    enableContactEvents: false,
    enableHitEvents: false,
    enableSensorEvents: false,
    sensorIndex: -1,
  };
}

/** Build an InternalBody + BodySim pair for a given body type and an optional
 * linked list of pre-built InternalShape records (indexed by a fake slot 0…N-1). */
function makeBody(
  type: number,
  shapes: InternalShape[]
): { body: InternalBody; sim: BodySim; shapeRecords: InternalShape[] } {
  // Wire the shapes into a linked list: each shape's nextShape points to the
  // next fake index (0, 1, 2, …), with the last pointing to NULL_INDEX. The
  // mass code walks body.shapeHead → shape.nextShape.
  for (let i = 0; i < shapes.length; i++) {
    shapes[i]!.prevShape = i === 0 ? NULL_INDEX : i - 1;
    shapes[i]!.nextShape = i + 1 < shapes.length ? i + 1 : NULL_INDEX;
  }

  const placeholder = { index: 0, generation: 1 } as unknown as BodyHandle;
  const body: InternalBody = {
    entity: {} as never,
    type,
    setIndex: 0,
    localIndex: 0,
    shapeHead: shapes.length > 0 ? 0 : NULL_INDEX,
    shapeCount: shapes.length,
    massDirty: true,
  };
  const sim = makeBodySim(0);
  // Give the body a concrete transform (identity) + sweep start.
  sim.transformX = 0;
  sim.transformY = 0;
  sim.cos = 1;
  sim.sin = 0;

  return { body, sim, shapeRecords: shapes };
}

/** Lookup function given to updateBodyMassData: returns shapes[index]. */
function makeShapeLookup(shapes: InternalShape[]) {
  return (index: number): InternalShape => {
    const s = shapes[index];
    if (s === undefined) {
      throw new Error(`no shape at index ${index}`);
    }
    return s;
  };
}

// ─── ShapeMassTest (golden, ported from box2d/test/test_shape.c) ──────────────

describe("ShapeMassTest (golden from box2d/test/test_shape.c)", () => {
  // static b2Circle circle = { { 1.0f, 0.0f }, 1.0f };
  it("circle: mass==π, center==(1,0), I==0.5·π", () => {
    const md = computeCircleMass({ kind: "circle", cx: 1, cy: 0, radius: 1 }, 1.0);
    expect(Math.abs(md.mass - PI)).toBeLessThan(FLT_EPSILON);
    expect(md.centerX).toBe(1.0);
    expect(md.centerY).toBe(0.0);
    expect(Math.abs(md.rotationalInertia - 0.5 * PI)).toBeLessThan(FLT_EPSILON);
  });

  // static b2Capsule capsule = { { -1.0f, 0.0f }, { 1.0f, 0.0f }, 1.0f };
  // Bracket: mdLower.mass < md.mass < mdUpper.mass (and same for inertia)
  it("capsule: bracketed by bounding box and approximate polygon hull", () => {
    const capsule = { kind: "capsule" as const, ax: -1, ay: 0, bx: 1, by: 0, radius: 1 };
    const md = computeCapsuleMass(capsule, 1.0);

    // Upper bound: box that fully contains the capsule (radius+0.5*length by radius)
    const boxGeom = makeBox(1 + 0.5 * 2, 1); // halfW = radius + 0.5*length = 1+1 = 2, halfH = radius = 1
    const mdUpper = computePolygonMass(boxGeom, 1.0);

    // Lower bound: N=4 point approximate capsule polygon
    const N = 4;
    const points: { x: number; y: number }[] = [];
    const d = PI / (N - 1);
    let angle = -0.5 * PI;
    for (let i = 0; i < N; i++) {
      points.push({ x: 1 + Math.cos(angle), y: Math.sin(angle) });
      angle += d;
    }
    angle = 0.5 * PI;
    for (let i = N; i < 2 * N; i++) {
      points.push({ x: -1 + Math.cos(angle), y: Math.sin(angle) });
      angle += d;
    }

    // Build an approximate polygon from the hull
    const hull = computeHull(points);
    const polyGeom = makePolygon(hull, 0);
    const mdLower = computePolygonMass(polyGeom, 1.0);

    expect(mdLower.mass).toBeLessThan(md.mass);
    expect(md.mass).toBeLessThan(mdUpper.mass);
    expect(mdLower.rotationalInertia).toBeLessThan(md.rotationalInertia);
    expect(md.rotationalInertia).toBeLessThan(mdUpper.rotationalInertia);
  });

  // box = b2MakeBox(1, 1) → 2×2, density=1 → mass=4, I=8/3
  it("box(1,1): mass==4, center==(0,0), I==8/3", () => {
    const boxGeom = makeBox(1, 1);
    const md = computePolygonMass(boxGeom, 1.0);
    expect(Math.abs(md.mass - 4.0)).toBeLessThan(FLT_EPSILON);
    expect(Math.abs(md.centerX)).toBeLessThan(FLT_EPSILON);
    expect(Math.abs(md.centerY)).toBeLessThan(FLT_EPSILON);
    expect(Math.abs(md.rotationalInertia - 8 / 3)).toBeLessThan(2 * FLT_EPSILON);
  });
});

// ─── Box unit test (exact analytical result) ──────────────────────────────────

describe("computePolygonMass: axis-aligned box", () => {
  it("2×1 box at origin: mass==2, I==7/12", () => {
    // b2MakeBox(1, 0.5) → 2×1 box, density=1 → mass=2
    // I = m*(w²+h²)/12 = 2*(4+1)/12 = 10/12 = 5/6? No…
    // For a uniform rectangle w×h: I_cm = m*(w²+h²)/12
    // w=2, h=1, m=2: I = 2*(4+1)/12 = 10/12 ≈ 0.8333
    const boxGeom = makeBox(1, 0.5); // half-extents 1 and 0.5 → actual 2×1
    const md = computePolygonMass(boxGeom, 1.0);
    expect(md.mass).toBeCloseTo(2.0, 10);
    expect(md.centerX).toBeCloseTo(0, 10);
    expect(md.centerY).toBeCloseTo(0, 10);
    expect(md.rotationalInertia).toBeCloseTo((2 * (4 + 1)) / 12, 10);
  });
});

// ─── updateBodyMassData ────────────────────────────────────────────────────────

describe("updateBodyMassData", () => {
  it("single circle shape: invMass, invInertia, localCenter correct", () => {
    // Circle at geometry origin (cx=0,cy=0), radius=1, density=1
    // localCentroid = (0,0), local pose = identity
    const circleGeom = { kind: "circle" as const, cx: 0, cy: 0, radius: 1 };
    const shape = makeInternalShape(ShapeType.Circle, circleGeom, 1, {
      localCentroidX: 0,
      localCentroidY: 0,
    });
    const { body, sim, shapeRecords } = makeBody(DYNAMIC_BODY, [shape]);
    updateBodyMassData(body, sim, makeShapeLookup(shapeRecords));

    expect(body.massDirty).toBe(false);
    const expectedMass = PI; // density * π * r²
    expect(sim.invMass).toBeCloseTo(1 / expectedMass, 10);
    expect(sim.localCenterX).toBeCloseTo(0, 10);
    expect(sim.localCenterY).toBeCloseTo(0, 10);
    // I_cm = m * 0.5 * r² = π * 0.5 = 0.5π; no parallel-axis shift
    expect(sim.invInertia).toBeCloseTo(1 / (0.5 * PI), 10);
  });

  it("cross-ticket contract: circle offset by local pose → correct body-local center", () => {
    // This is the direct port of the box2d ShapeMassTest circle case.
    // The InternalShape stores geometry with cx=0,cy=0 (shape-local centroid).
    // But the shape's local pose places it at (1,0) relative to the body origin.
    // VP-12 must apply the local pose to get the body-local centroid = (1,0).
    const circleGeom = { kind: "circle" as const, cx: 0, cy: 0, radius: 1 };
    const shape = makeInternalShape(ShapeType.Circle, circleGeom, 1, {
      localCentroidX: 0,
      localCentroidY: 0,
      localX: 1, // shape local pose offset: 1 unit along x
      localY: 0,
      localCos: 1,
      localSin: 0,
    });
    const { body, sim, shapeRecords } = makeBody(DYNAMIC_BODY, [shape]);
    updateBodyMassData(body, sim, makeShapeLookup(shapeRecords));

    // Body-local center should be (1,0) — matches b2ComputeCircleMass center when
    // circle.center = (1,0).
    expect(sim.localCenterX).toBeCloseTo(1, 10);
    expect(sim.localCenterY).toBeCloseTo(0, 10);
    // invMass: 1/(π·1²) = 1/π
    expect(sim.invMass).toBeCloseTo(1 / PI, 10);
    // I about geometry origin = 0.5·π; parallel-axis to body-local center (1,0):
    // I_body = 0.5π + π·(1² + 0²) = 1.5π
    // But localCenter is (1,0) so parallel-axis shift = mass * dist² = π * 1 = π
    // Total I about body-local center: I_geom_origin shifted to CoM =
    // i_cm = 0.5π (circle inertia about its own center = (0,0) in geom-local)
    // After parallel-axis to CoM (1,0): i_cm + mass * |(1,0)-(0,0)|^2 =
    //   Wait — the centroid in body space is (1,0) (after pose transform), and
    //   the geometry centroid was (0,0). So the offset = (1,0)-(1,0)=0.
    //   The inertia returned by computeCircleMass is about (0,0) in geom space.
    //   After applying local pose, geom centroid in body space = (1,0).
    //   The body-local CoM = (1,0). Offset = body-localCenter - geom-centroid-body = 0.
    //   No parallel-axis shift needed. invInertia = 1 / (0.5π).
    expect(sim.invInertia).toBeCloseTo(1 / (0.5 * PI), 10);
  });

  it("static body: invMass=0, invInertia=0, massDirty cleared", () => {
    const circleGeom = { kind: "circle" as const, cx: 0, cy: 0, radius: 1 };
    const shape = makeInternalShape(ShapeType.Circle, circleGeom, 1);
    const { body, sim, shapeRecords } = makeBody(STATIC_BODY, [shape]);
    updateBodyMassData(body, sim, makeShapeLookup(shapeRecords));

    expect(body.massDirty).toBe(false);
    expect(sim.invMass).toBe(0);
    expect(sim.invInertia).toBe(0);
  });

  it("kinematic body: invMass=0, invInertia=0, massDirty cleared, extents computed", () => {
    const circleGeom = { kind: "circle" as const, cx: 0, cy: 0, radius: 0.5 };
    const shape = makeInternalShape(ShapeType.Circle, circleGeom, 1, {
      localCentroidX: 0,
      localCentroidY: 0,
    });
    const { body, sim, shapeRecords } = makeBody(KINEMATIC_BODY, [shape]);
    updateBodyMassData(body, sim, makeShapeLookup(shapeRecords));

    expect(body.massDirty).toBe(false);
    expect(sim.invMass).toBe(0);
    expect(sim.invInertia).toBe(0);
    // Kinematic bodies do get their extents computed (for sleeping).
    // minExtent = radius = 0.5; maxExtent = dist(center, localCenter=0) + radius = 0.5
    expect(sim.minExtent).toBeCloseTo(0.5, 10);
    expect(sim.maxExtent).toBeCloseTo(0.5, 10);
  });

  it("dynamic body with no shapes (zero mass) stays invMass=0, invInertia=0", () => {
    const { body, sim, shapeRecords } = makeBody(DYNAMIC_BODY, []);
    updateBodyMassData(body, sim, makeShapeLookup(shapeRecords));

    expect(body.massDirty).toBe(false);
    // box2d-faithful: a massless dynamic body keeps invMass=0 (infinite mass).
    expect(sim.invMass).toBe(0);
    expect(sim.invInertia).toBe(0);
  });

  it("sensor shape is skipped during mass accumulation", () => {
    const circleGeom = { kind: "circle" as const, cx: 0, cy: 0, radius: 1 };
    const sensor = makeInternalShape(ShapeType.Circle, circleGeom, 1, { sensor: true });
    const { body, sim, shapeRecords } = makeBody(DYNAMIC_BODY, [sensor]);
    updateBodyMassData(body, sim, makeShapeLookup(shapeRecords));

    // Sensor skipped → zero mass → box2d-faithful invMass=0.
    expect(sim.invMass).toBe(0);
    expect(sim.invInertia).toBe(0);
  });

  it("compound body: two offset circles → combined CoM and parallel-axis inertia", () => {
    // Two circles of radius 1 and density 1, each at distance 2 from origin
    // along opposite sides of x-axis. Each has mass π; combined CoM = (0,0).
    // I_each about own center = 0.5π; after parallel-axis (d=2): 0.5π + π*4 = 4.5π
    // Total inertia about CoM = 2 * 4.5π = 9π.
    const circleGeom = { kind: "circle" as const, cx: 0, cy: 0, radius: 1 };
    const shapeA = makeInternalShape(ShapeType.Circle, circleGeom, 1, {
      localX: 2,
      localY: 0,
      localCos: 1,
      localSin: 0,
    });
    const shapeB = makeInternalShape(ShapeType.Circle, circleGeom, 1, {
      localX: -2,
      localY: 0,
      localCos: 1,
      localSin: 0,
    });
    const { body, sim, shapeRecords } = makeBody(DYNAMIC_BODY, [shapeA, shapeB]);
    updateBodyMassData(body, sim, makeShapeLookup(shapeRecords));

    expect(sim.localCenterX).toBeCloseTo(0, 10);
    expect(sim.localCenterY).toBeCloseTo(0, 10);
    expect(sim.invMass).toBeCloseTo(1 / (2 * PI), 10);
    expect(sim.invInertia).toBeCloseTo(1 / (9 * PI), 6);
  });

  it("extents: single box — minExtent and maxExtent computed correctly", () => {
    // 1×1 box (half-extents 0.5, 0.5), density=1.
    // localCenter = (0,0) after mass computation.
    // minExtent: for polygon = min plane-offset from centroid across normals.
    //   Each face is 0.5 from centroid → minExtent = 0.5 (+ radius=0 = 0.5).
    // maxExtent: max dist from localCenter to any vertex = sqrt(0.5²+0.5²) ≈ 0.707.
    const boxGeom = makeBox(0.5, 0.5);
    const shape = makeInternalShape(ShapeType.Polygon, boxGeom, 1, {
      localCentroidX: boxGeom.centroidX,
      localCentroidY: boxGeom.centroidY,
    });
    const { body, sim, shapeRecords } = makeBody(DYNAMIC_BODY, [shape]);
    updateBodyMassData(body, sim, makeShapeLookup(shapeRecords));

    expect(sim.minExtent).toBeCloseTo(0.5, 6);
    expect(sim.maxExtent).toBeCloseTo(Math.sqrt(0.5 * 0.5 + 0.5 * 0.5), 6);
  });

  it("center is updated from transform + new localCenter", () => {
    // Body transform at (3, 5), circle at origin.
    const circleGeom = { kind: "circle" as const, cx: 0, cy: 0, radius: 1 };
    const shape = makeInternalShape(ShapeType.Circle, circleGeom, 1);
    const { body, sim, shapeRecords } = makeBody(DYNAMIC_BODY, [shape]);
    sim.transformX = 3;
    sim.transformY = 5;
    sim.cos = 1;
    sim.sin = 0;
    updateBodyMassData(body, sim, makeShapeLookup(shapeRecords));

    // localCenter = (0,0) → center = transform * (0,0) = (3,5)
    expect(sim.centerX).toBeCloseTo(3, 10);
    expect(sim.centerY).toBeCloseTo(5, 10);
  });
});
