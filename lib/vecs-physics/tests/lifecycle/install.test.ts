import { World } from "@vworlds/vecs";
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
  installPhysics,
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
import { getPhysics } from "../../src/engine/state.js";

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

describe("installPhysics", () => {
  it("registers every public component", () => {
    const world = new World();
    installPhysics(world);
    for (const C of PUBLIC_COMPONENTS) {
      expect(world._classRegistry.has(C)).toBe(true);
    }
  });

  it("marks every geometry component mutually exclusive", () => {
    const world = new World();
    installPhysics(world);
    for (const C of GEOMETRY) {
      const meta = world.component(C).ownMeta;
      const others = GEOMETRY.filter((G) => G !== C).map((G) => world.component(G).ownMeta);
      expect(meta._exclusive).not.toContain(meta);
      for (const otherMeta of others) {
        expect(meta._exclusive).toContain(otherMeta);
      }
    }
  });

  it("creates the three default physics phases", () => {
    const world = new World();
    installPhysics(world);
    expect(world._pipeline.has("physics-pre")).toBe(true);
    expect(world._pipeline.has("physics-step")).toBe(true);
    expect(world._pipeline.has("physics-post")).toBe(true);
  });

  it("reuses an existing phase passed by name and creates it under that name", () => {
    const world = new World();
    const input = world.addPhase("input");
    installPhysics(world, { preStepPhase: "input", stepPhase: "sim" });
    // Existing "input" phase is reused, not duplicated.
    expect(world._pipeline.get("input")).toBe(input);
    // A new name is created.
    expect(world._pipeline.has("sim")).toBe(true);
    // The default pre/step names are not created when overridden.
    expect(world._pipeline.has("physics-pre")).toBe(false);
    expect(world._pipeline.has("physics-step")).toBe(false);
    // The non-overridden phase still defaults.
    expect(world._pipeline.has("physics-post")).toBe(true);
  });

  it("attaches a PhysicsState reachable via getPhysics, with resolved defaults", () => {
    const world = new World();
    installPhysics(world);
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
    expect(state.bodyByEntity.size).toBe(0);
    expect(state.shapeByEntity.size).toBe(0);
    expect(state.stepIndex).toBe(0);
  });

  it("applies overridden options onto the PhysicsState", () => {
    const world = new World();
    installPhysics(world, {
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

  it("lets the world start without errors after install", () => {
    const world = new World();
    installPhysics(world);
    expect(() => world.start()).not.toThrow();
    // State is still reachable after start.
    expect(getPhysics(world).stepIndex).toBe(0);
  });

  it("throws if installed twice on the same world", () => {
    const world = new World();
    installPhysics(world);
    expect(() => installPhysics(world)).toThrow(/already been called/);
  });

  it("throws if installed after world.start()", () => {
    const world = new World();
    world.start();
    expect(() => installPhysics(world)).toThrow(/before world\.start/);
  });
});
