import { DependsOn, ON_UPDATE, ON_VALIDATE, Phase, World } from "@vworlds/vecs";
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
  ShapePosition,
  ShapeRotation,
  Sleep,
  Torque,
} from "../../src/index.js";
import { getPhysics } from "../../src/adapter/state.js";

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

  it("marks every geometry component mutually exclusive", () => {
    const world = new World();
    world.module(PhysicsModule);
    for (const C of GEOMETRY) {
      const componentMeta = world.component(C).meta;
      const others = GEOMETRY.filter((G) => G !== C).map((G) => world.component(G).meta);
      expect(componentMeta._exclusive).not.toContain(componentMeta);
      for (const otherMeta of others) {
        expect(componentMeta._exclusive).toContain(otherMeta);
      }
    }
  });

  it("creates the three default physics phases", () => {
    const world = new World();
    world.module(PhysicsModule);
    expect(world.entity("physics-pre").has(Phase)).toBe(true);
    expect(world.entity("physics-step").has(Phase)).toBe(true);
    expect(world.entity("physics-post").has(Phase)).toBe(true);
    expect(world.entity("physics-pre").parent(DependsOn)).toBe(world.entity(ON_UPDATE));
    expect(world.entity("physics-step").parent(DependsOn)).toBe(world.entity("physics-pre"));
    expect(world.entity("physics-post").parent(DependsOn)).toBe(world.entity("physics-step"));
    expect(world.entity(ON_VALIDATE).parent(DependsOn)).toBe(world.entity("physics-post"));
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

  it("attaches a PhysicsState reachable via getPhysics, with resolved defaults", () => {
    const world = new World();
    world.module(PhysicsModule);
    const state = getPhysics(world);
    expect(state.gravityX).toBe(0);
    expect(state.gravityY).toBe(-10);
    expect(state.fixedTimeStep).toBeCloseTo(1 / 60);
    expect(state.subSteps).toBe(4);
    expect(state.debug).toBe(false);
    // World-def tunables must match box2d's b2DefaultWorldDef (types.c). These
    // are NOT covered by the per-component defaults test, which is how the
    // hitEventThreshold 10x error (M0-hitEventThreshold-default) slipped through.
    expect(state.restitutionThreshold).toBe(1.0);
    expect(state.hitEventThreshold).toBe(1.0);
    expect(state.contactHertz).toBe(30);
    expect(state.contactDampingRatio).toBe(10);
    expect(state.contactSpeed).toBe(3.0);
    expect(state.maximumLinearSpeed).toBe(400);
    expect(state.enableSleep).toBe(true);
    expect(state.enableContinuous).toBe(true);
    expect(state.entityByBodyIndex.size).toBe(0);
    expect(state.shapeByEntityWasm.size).toBe(0);
  });

  it("applies overridden options onto the PhysicsState", () => {
    const world = new World();
    world.module(PhysicsModule, {
      gravity: { x: 1, y: -3 },
      fixedTimeStep: 1 / 120,
      subSteps: 8,
      debug: true,
      enableSleep: false,
    });
    const state = getPhysics(world);
    expect(state.gravityX).toBe(1);
    expect(state.gravityY).toBe(-3);
    expect(state.fixedTimeStep).toBeCloseTo(1 / 120);
    expect(state.subSteps).toBe(8);
    expect(state.debug).toBe(true);
    expect(state.enableSleep).toBe(false);
  });

  it("keeps physics state reachable after module registration", () => {
    const world = new World();
    world.module(PhysicsModule);
    expect(getPhysics(world).worldId).toBeDefined();
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
