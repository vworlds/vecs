import { DependsOn, Exclusive, ON_UPDATE, ON_VALIDATE, Phase, World } from "@vworlds/vecs";
import { describe, expect, it } from "vitest";

import {
  AngularImpulse,
  AngularVelocity,
  Body,
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
  JointBodyA,
  JointBodyB,
  PhysicsModule,
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
  Shape,
  ShapePosition,
  ShapeRotation,
  Sleep,
  Torque,
} from "../../src/index.js";
import { getPhysicsEngine } from "../../src/adapter/engine.js";

const PUBLIC_COMPONENTS = [
  Position,
  Rotation,
  LinearVelocity,
  AngularVelocity,
  Body,
  Damping,
  GravityScale,
  MotionLocks,
  Sleep,
  ShapePosition,
  ShapeRotation,
  Box,
  Circle,
  Capsule,
  Segment,
  Polygon,
  Chain,
  Material,
  CollisionFilter,
  Sensor,
  Force,
  Torque,
  Impulse,
  AngularImpulse,
  KinematicTargetPosition,
  KinematicTargetRotation,
  ContactEvents,
  SensorEvents,
  HitEvents,
];

const GEOMETRY = [Box, Circle, Capsule, Segment, Polygon, Chain];

describe("PhysicsModule", () => {
  it("registers every public component", () => {
    const world = new World();
    world.module(PhysicsModule);
    for (const C of PUBLIC_COMPONENTS) {
      expect(world._classRegistry.has(C)).toBe(true);
    }
  });

  it("declares every geometry component as a Shape implementer", () => {
    const world = new World();
    world.module(PhysicsModule);
    const shapeMeta = world.component(Shape).meta;
    for (const C of GEOMETRY) {
      const componentMeta = world.component(C).meta;
      expect(componentMeta._implementsClosure).toContain(shapeMeta);
    }
  });

  it("setting one geometry component evicts a previously-set geometry component", () => {
    const world = new World();
    world.module(PhysicsModule);
    const entity = world.entity().set(Box, { hx: 1, hy: 1 });

    entity.set(Circle, { radius: 2 });

    expect(entity.has(Box)).toBe(false);
    expect(entity.has(Circle)).toBe(true);
    expect(entity.get(Shape)).toBe(entity.get(Circle));
  });

  it("marks joint body relationships as exclusive", () => {
    const world = new World();
    world.module(PhysicsModule);

    expect(world.component(JointBodyA).has(Exclusive)).toBe(true);
    expect(world.component(JointBodyB).has(Exclusive)).toBe(true);
  });

  it("creates the three default physics phases", () => {
    const world = new World();
    world.module(PhysicsModule);
    expect(world.entity("physics-pre").has(Phase)).toBe(true);
    expect(world.entity("physics-step").has(Phase)).toBe(true);
    expect(world.entity("physics-post").has(Phase)).toBe(true);
    expect(world.entity("physics-pre").target(DependsOn)).toBe(world.entity(ON_UPDATE));
    expect(world.entity("physics-cleanup").target(DependsOn)).toBe(world.entity("physics-pre"));
    expect(world.entity("physics-step").target(DependsOn)).toBe(world.entity("physics-cleanup"));
    expect(world.entity("physics-post").target(DependsOn)).toBe(world.entity("physics-step"));
    expect(world.entity(ON_VALIDATE).target(DependsOn)).toBe(world.entity("physics-post"));
  });

  it("reuses an existing phase passed by name and creates it under that name", () => {
    const world = new World();
    const input = world.entity("input").add(Phase);
    world.module(PhysicsModule, { preStepPhase: "input", stepPhase: "sim" });
    // Existing "input" phase is reused, not duplicated.
    expect(world.entity("input")).toBe(input);
    // A new name is created.
    expect(world.entity("sim").has(Phase)).toBe(true);
    // The default pre/step names are not created when overridden.
    expect(world.getEntity("physics-pre")).toBeUndefined();
    expect(world.getEntity("physics-step")).toBeUndefined();
    // The non-overridden phase still defaults.
    expect(world.entity("physics-post").has(Phase)).toBe(true);
  });

  it("attaches a PhysicsEngine reachable via getPhysicsEngine, with resolved defaults", () => {
    const world = new World();
    world.module(PhysicsModule);
    const engine = getPhysicsEngine(world);
    expect(engine.gravityX).toBe(0);
    expect(engine.gravityY).toBe(-10);
    expect(engine.fixedTimeStep).toBeCloseTo(1 / 60);
    expect(engine.subSteps).toBe(4);
    expect(engine.debug).toBe(false);
    // World-def tunables must match box2d's b2DefaultWorldDef (types.c). These
    // are NOT covered by the per-component defaults test, which is how the
    // hitEventThreshold 10x error (M0-hitEventThreshold-default) slipped through.
    expect(engine.restitutionThreshold).toBe(1.0);
    expect(engine.hitEventThreshold).toBe(1.0);
    expect(engine.contactHertz).toBe(30);
    expect(engine.contactDampingRatio).toBe(10);
    expect(engine.contactSpeed).toBe(3.0);
    expect(engine.maximumLinearSpeed).toBe(400);
    expect(engine.enableSleep).toBe(true);
    expect(engine.enableContinuous).toBe(true);
    expect(engine.entityByBodyIndex.size).toBe(0);
    expect(engine.entityByShapeIndex.size).toBe(0);
  });

  it("applies overridden options onto the PhysicsEngine", () => {
    const world = new World();
    world.module(PhysicsModule, {
      gravity: { x: 1, y: -3 },
      fixedTimeStep: 1 / 120,
      subSteps: 8,
      debug: true,
      enableSleep: false,
    });
    const engine = getPhysicsEngine(world);
    expect(engine.gravityX).toBe(1);
    expect(engine.gravityY).toBe(-3);
    expect(engine.fixedTimeStep).toBeCloseTo(1 / 120);
    expect(engine.subSteps).toBe(8);
    expect(engine.debug).toBe(true);
    expect(engine.enableSleep).toBe(false);
  });

  it("keeps physics engine reachable after module registration", () => {
    const world = new World();
    world.module(PhysicsModule);
    expect(getPhysicsEngine(world).worldId).toBeDefined();
  });

  it("is idempotent for the same module class", () => {
    const world = new World();
    const first = world.module(PhysicsModule);

    expect(world.module(PhysicsModule)).toBe(first);
  });

  it("throws if a configured physics module is registered after physics exists", () => {
    const world = new World();
    world.module(PhysicsModule);

    expect(() => world.module(PhysicsModule, { gravity: { x: 0, y: 0 } })).toThrow(
      /configuration is only accepted on first registration/
    );
  });

  it("can register after the world has already progressed", () => {
    const world = new World();
    world.progress(0, 0);

    expect(() => world.module(PhysicsModule)).not.toThrow();
  });
});
