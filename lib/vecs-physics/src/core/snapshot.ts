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
function captureDeclarative(instance: object, owner: string): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  const seen = new Map<object, unknown>();
  for (const key of Object.keys(instance)) {
    if (!key.startsWith("_")) {
      data[key] = detach(
        (instance as Record<string, unknown>)[key],
        `${owner}.${key}`,
        owner,
        seen
      );
    }
  }
  return data;
}

/**
 * Copy only declarative nested values. Physics components accept primitives,
 * arrays, and plain records; Box2D wrappers and other class instances must not
 * cross worlds disguised as data.
 */
function detach(value: unknown, path: string, owner: string, seen: Map<object, unknown>): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }

  const existing = seen.get(value);
  if (existing !== undefined) {
    return existing;
  }

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (let i = 0; i < value.length; i++) {
      copy.push(detach(value[i], `${path}[${i}]`, owner, seen));
    }
    return copy;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype === Object.prototype || prototype === null) {
    const copy: Record<string, unknown> = Object.create(prototype);
    seen.set(value, copy);
    for (const [key, entry] of Object.entries(value)) {
      copy[key] = detach(entry, `${path}.${key}`, owner, seen);
    }
    return copy;
  }

  const name = value.constructor?.name ?? Object.prototype.toString.call(value);
  throw new Error(
    `snapshotSubtree: ${path} holds a ${name}, which the physics CustomSnapshot policy cannot copy; ` +
      `use only primitives, arrays, and plain objects in ${owner} declarative fields`
  );
}

/** Declare "drop the engine handles, keep the declarative fields" for `Class`. */
function declareDeclarative(world: World, Class: PhysicsComponent): void {
  world.component(Class).snapshotPolicy(CustomSnapshot, {
    capture: (instance) => captureDeclarative(instance, Class.name),
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
    ].forEach((Class) => declareDeclarative(world, Class));
  }
}
