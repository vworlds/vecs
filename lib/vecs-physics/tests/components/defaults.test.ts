import { describe, expect, it } from "vitest";

import {
  AngularImpulse,
  AngularVelocity,
  Body,
  BodyType,
  Box,
  Capsule,
  Chain,
  Circle,
  CollisionFilter,
  ContactEvents,
  Damping,
  Force,
  GravityScale,
  HitEvents,
  Impulse,
  KinematicTargetPosition,
  KinematicTargetRotation,
  LinearVelocity,
  Material,
  MotionLocks,
  Polygon,
  Position,
  Rotation,
  Segment,
  Sensor,
  SensorEvents,
  ShapePosition,
  ShapeRotation,
  Sleep,
  Torque,
} from "../../src/index.js";

// Every component must construct valid and default-shaped with `new C()` — the
// Vecs zero-arg contract. These defaults are part of the public API and must
// match Box2D's b2Default{Body,Shape}Def / b2DefaultFilter /
// b2DefaultSurfaceMaterial (see architecture/PLAN.md → Authoritative Component
// Defaults).

describe("body component defaults", () => {
  it("Body matches b2DefaultBodyDef", () => {
    expect({ ...new Body() }).toEqual({
      type: BodyType.Static,
      bullet: false,
      enabled: true,
      allowFastRotation: false,
    });
  });

  it("BodyType is the static/kinematic/dynamic string enum", () => {
    expect(BodyType.Static).toBe("static");
    expect(BodyType.Kinematic).toBe("kinematic");
    expect(BodyType.Dynamic).toBe("dynamic");
  });

  it("Position defaults to the origin", () => {
    expect({ ...new Position() }).toEqual({ x: 0, y: 0 });
  });

  it("Rotation defaults to zero angle", () => {
    expect({ ...new Rotation() }).toEqual({ angle: 0 });
  });

  it("LinearVelocity defaults to zero", () => {
    expect({ ...new LinearVelocity() }).toEqual({ x: 0, y: 0 });
  });

  it("AngularVelocity defaults to zero", () => {
    expect({ ...new AngularVelocity() }).toEqual({ value: 0 });
  });
});

describe("body tunable defaults", () => {
  it("Damping defaults to no damping", () => {
    expect({ ...new Damping() }).toEqual({ linear: 0, angular: 0 });
  });

  it("GravityScale defaults to full gravity", () => {
    expect({ ...new GravityScale() }).toEqual({ value: 1 });
  });

  it("MotionLocks default to unlocked", () => {
    expect({ ...new MotionLocks() }).toEqual({ x: false, y: false, rotation: false });
  });

  it("Sleep matches b2DefaultBodyDef sleep settings", () => {
    expect({ ...new Sleep() }).toEqual({ enabled: true, awake: true, threshold: 0.05 });
  });
});

describe("shape pose defaults", () => {
  it("ShapePosition defaults to the local origin", () => {
    expect({ ...new ShapePosition() }).toEqual({ x: 0, y: 0 });
  });

  it("ShapeRotation defaults to zero angle", () => {
    expect({ ...new ShapeRotation() }).toEqual({ angle: 0 });
  });
});

describe("geometry defaults", () => {
  it("Box defaults to a 1x1 box (half extents 0.5)", () => {
    const box = new Box();
    expect(box.hx).toBe(0.5);
    expect(box.hy).toBe(0.5);
  });

  it("Circle defaults to radius 0.5", () => {
    expect({ ...new Circle() }).toEqual({ radius: 0.5 });
  });

  it("Capsule matches the documented default endpoints and radius", () => {
    expect({ ...new Capsule() }).toEqual({ x1: -0.5, y1: 0, x2: 0.5, y2: 0, radius: 0.25 });
  });

  it("Segment matches the documented default endpoints", () => {
    expect({ ...new Segment() }).toEqual({ x1: -0.5, y1: 0, x2: 0.5, y2: 0 });
  });

  it("Polygon defaults to empty vertices and zero radius", () => {
    const poly = new Polygon();
    expect(poly.vertices).toEqual([]);
    expect(poly.radius).toBe(0);
  });

  it("Chain defaults to empty points and non-loop", () => {
    const chain = new Chain();
    expect(chain.points).toEqual([]);
    expect(chain.loop).toBe(false);
  });
});

describe("material and filter defaults", () => {
  it("Material matches b2DefaultShapeDef / b2DefaultSurfaceMaterial", () => {
    expect({ ...new Material() }).toEqual({
      density: 1,
      friction: 0.6,
      restitution: 0,
      rollingResistance: 0,
      tangentSpeed: 0,
      userMaterialId: 0,
    });
  });

  it("CollisionFilter uses 32-bit number bitfields (default mask all-ones)", () => {
    expect({ ...new CollisionFilter() }).toEqual({
      categoryBits: 1,
      maskBits: 0xffffffff,
      groupIndex: 0,
    });
  });

  it("Sensor is an empty marker", () => {
    expect({ ...new Sensor() }).toEqual({});
  });
});

describe("force and impulse defaults", () => {
  it("Force defaults to zero, waking", () => {
    expect({ ...new Force() }).toEqual({ x: 0, y: 0, wake: true });
  });

  it("Torque defaults to zero, waking", () => {
    expect({ ...new Torque() }).toEqual({ value: 0, wake: true });
  });

  it("Impulse defaults to zero, waking", () => {
    expect({ ...new Impulse() }).toEqual({ x: 0, y: 0, wake: true });
  });

  it("AngularImpulse defaults to zero, waking", () => {
    expect({ ...new AngularImpulse() }).toEqual({ value: 0, wake: true });
  });
});

describe("kinematic target defaults", () => {
  it("KinematicTargetPosition defaults match the contract", () => {
    expect({ ...new KinematicTargetPosition() }).toEqual({
      x: 0,
      y: 0,
      tolerance: 0.001,
      wake: true,
    });
  });

  it("KinematicTargetRotation defaults match the contract", () => {
    expect({ ...new KinematicTargetRotation() }).toEqual({
      angle: 0,
      tolerance: 0.001,
      wake: true,
    });
  });
});

describe("event component defaults", () => {
  it("ContactEvents starts with empty begin/end arrays", () => {
    const e = new ContactEvents();
    expect(e.begin).toEqual([]);
    expect(e.end).toEqual([]);
    // Distinct array instances, not a shared reference.
    expect(e.begin).not.toBe(e.end);
  });

  it("SensorEvents starts with empty begin/end arrays", () => {
    const e = new SensorEvents();
    expect(e.begin).toEqual([]);
    expect(e.end).toEqual([]);
    expect(e.begin).not.toBe(e.end);
  });

  it("HitEvents starts with an empty hits array", () => {
    expect(new HitEvents().hits).toEqual([]);
  });

  it("event arrays are per-instance, not shared on the prototype", () => {
    const a = new ContactEvents();
    const b = new ContactEvents();
    expect(a.begin).not.toBe(b.begin);
  });
});
