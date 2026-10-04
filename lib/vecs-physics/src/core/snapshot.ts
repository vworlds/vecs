// Snapshot policies for @vworlds/vecs-physics.
//
// A physics component mixes declarative state (geometry, pose, tuning) with
// engine-owned state (Box2D handles). Only the declarative half can be
// reconstructed in another world, so this module drops the handles and lets the
// destination lifecycle systems allocate fresh ones.
//
// Nothing here needs to know about captures: the policies are declared during
// `PhysicsModule` installation. Every capture binds the materializer it
// resolved, so later policy changes do not alter existing snapshots.

import { CustomSnapshot, DontSnapshot, Module, type World } from "@vworlds/vecs";

import { PhysicsEngine } from "../adapter/engine.js";
import { Body } from "../body/components.js";
import { ContactEvents, HitEvents, SensorEvents } from "../events/components.js";
import {
  DistanceJoint,
  FilterJoint,
  JointAngularSpring,
  JointFrame,
  JointLimit,
  JointLinearSpring,
  JointMotor,
  JointSettings,
  MotorJoint,
  PrismaticJoint,
  RevoluteJoint,
  WeldJoint,
  WheelJoint,
} from "../joints/components.js";
import { Box, Capsule, Chain, Circle, Polygon, Segment } from "../shapes/components.js";

/** A vecs-physics component class: zero-arg constructible, plain data. */
type PhysicsComponent = new () => object;

/**
 * Capture the declarative fields of a physics component, dropping every
 * engine-owned handle.
 *
 * Every physics component names its Box2D state with a leading underscore —
 * `Body._bodyId`, `SingleShape._shapeId`, `Chain._chainId` and
 * `Chain._segmentIndices`, `Joint._jointId` — so the underscore prefix is the
 * package-wide convention this relies on.
 */
function captureDeclarative(instance: object): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const key of Object.keys(instance)) {
    if (!key.startsWith("_")) {
      data[key] = detach((instance as Record<string, unknown>)[key]);
    }
  }
  return data;
}

/**
 * Copy nested arrays and objects into declarative values so a snapshot never
 * aliases source geometry or retains Box2D's Embind wrapper instances. Physics
 * components only expose data fields, so copying every object's enumerable
 * fields into a record intentionally strips its prototype.
 */
function detach(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(detach);
  }
  if (typeof value === "object" && value !== null) {
    const clone: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      clone[key] = detach(entry);
    }
    // Embind's b2Vec2 exposes coordinates through prototype accessors rather
    // than own enumerable fields. Read them explicitly before dropping that
    // prototype along with the rest of the wrapper.
    if ("x" in value && !("x" in clone)) {
      clone.x = detach((value as { x: unknown }).x);
    }
    if ("y" in value && !("y" in clone)) {
      clone.y = detach((value as { y: unknown }).y);
    }
    return clone;
  }
  return value;
}

/** Declare "drop the engine handles, keep the declarative fields" for `Class`. */
function declareDeclarative(world: World, Class: PhysicsComponent): void {
  world.component(Class).snapshotPolicy(CustomSnapshot, {
    capture: captureDeclarative,
    materialize: (data) => Object.assign(new Class(), data),
  });
}

/**
 * Installs {@link DontSnapshot} and {@link CustomSnapshot} policies for the
 * vecs-physics component set.
 *
 * Registered automatically by {@link import("../module.js").PhysicsModule}, which
 * owns the physics component registry. It is not part of the public API: nothing
 * outside the package assembles physics from individual feature modules.
 */
export class PhysicsSnapshotModule extends Module {
  public init(): void {
    const world = this.world;

    // World-bound resources. The engine owns Box2D's world, its phases, and the
    // reaper queue; the event components hold `Entity` references reported by
    // this world's solver. Neither can be reconstructed elsewhere, and an event
    // buffer is a report about the world that produced it, not state to carry.
    world.component(PhysicsEngine).snapshotPolicy(DontSnapshot);
    [ContactEvents, SensorEvents, HitEvents].forEach((Class) =>
      world.component(Class).snapshotPolicy(DontSnapshot)
    );

    // Declarative components whose engine handle is not worth copying.
    [Body, Box, Circle, Capsule, Segment, Polygon, Chain].forEach((Class) =>
      declareDeclarative(world, Class)
    );
    [
      RevoluteJoint,
      DistanceJoint,
      PrismaticJoint,
      WheelJoint,
      WeldJoint,
      FilterJoint,
      MotorJoint,
      JointFrame,
      JointMotor,
      JointLimit,
      JointLinearSpring,
      JointAngularSpring,
      JointSettings,
    ].forEach((Class) => declareDeclarative(world, Class));
  }
}
