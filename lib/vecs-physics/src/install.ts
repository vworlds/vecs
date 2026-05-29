// `installPhysics` — the single entry point that wires the physics engine into a
// Vecs world. It registers every public component, declares geometry
// exclusivity, ensures the three physics phases exist, and attaches the private
// `PhysicsState`. See PLAN.md → _installPhysics Signature_ and
// _Component registration order_.
//
// VP-4 is wiring only: no systems are installed and the engine is a no-op. The
// physics systems (and the `PhysicsSystemTag` marker they carry) land in VP-6.
// Registration order still matters — Vecs assigns component type ids in
// registration order, so keeping the order stable keeps ids deterministic.

import { type IPhase, type World } from "@vworlds/vecs";

import { AngularVelocity, Body, LinearVelocity, Position, Rotation } from "./components/body.js";
import { Damping, GravityScale, MotionLocks, Sleep } from "./components/body_tuning.js";
import { Box, Capsule, Chain, Circle, Polygon, Segment } from "./components/geometry.js";
import { AngularImpulse, Force, Impulse, Torque } from "./components/force.js";
import { CollisionFilter, Material, Sensor } from "./components/material.js";
import { ContactEvents, HitEvents, SensorEvents } from "./components/events.js";
import { KinematicTargetPosition, KinematicTargetRotation } from "./components/target.js";
import { ShapePosition, ShapeRotation } from "./components/shape_pose.js";
import {
  attachPhysics,
  hasPhysics,
  PhysicsState,
  type ResolvedPhysicsOptions,
} from "./engine/state.js";

/** Options for {@link installPhysics}. Every field is optional; omitted fields
 * fall back to Box2D-aligned defaults. */
export type PhysicsOptions = {
  gravity?: { x: number; y: number }; // default { x: 0, y: -10 }
  fixedTimeStep?: number; // seconds, default 1/60
  subSteps?: number; // default 4
  debug?: boolean; // default false

  // Optional phase placement. Either pass an IPhase or a name (created if missing).
  preStepPhase?: IPhase | string;
  stepPhase?: IPhase | string;
  postStepPhase?: IPhase | string;

  // Optional thresholds and tunables, all with Box2D-aligned defaults.
  restitutionThreshold?: number; // m/s, default 1.0
  hitEventThreshold?: number; // m/s, default 10.0
  contactHertz?: number; // default 30
  contactDampingRatio?: number; // default 10
  maximumLinearSpeed?: number; // m/s, default 400
  enableSleep?: boolean; // default true
  enableContinuous?: boolean; // default true
};

const DEFAULT_PRE_STEP_PHASE = "physics-pre";
const DEFAULT_STEP_PHASE = "physics-step";
const DEFAULT_POST_STEP_PHASE = "physics-post";

/** Wire the physics engine into `world`. Must be called before `world.start()`
 * and at most once per world. */
export function installPhysics(world: World, opts: PhysicsOptions = {}): void {
  if (isWorldStarted(world)) {
    throw new Error("installPhysics must be called before world.start()");
  }
  if (hasPhysics(world)) {
    throw new Error("installPhysics has already been called on this world");
  }

  // 1. Register every public component, in a stable order (see file header).
  //    `ChildOf` is built into Vecs — referenced, never registered.
  world.component(Position);
  world.component(Rotation);
  world.component(LinearVelocity);
  world.component(AngularVelocity);
  world.component(Body);

  world.component(Damping);
  world.component(GravityScale);
  world.component(MotionLocks);
  world.component(Sleep);

  world.component(ShapePosition);
  world.component(ShapeRotation);

  world.component(Box);
  world.component(Circle);
  world.component(Capsule);
  world.component(Segment);
  world.component(Polygon);
  world.component(Chain);

  world.component(Material);
  world.component(CollisionFilter);
  world.component(Sensor);

  world.component(Force);
  world.component(Torque);
  world.component(Impulse);
  world.component(AngularImpulse);

  world.component(KinematicTargetPosition);
  world.component(KinematicTargetRotation);

  world.component(ContactEvents);
  world.component(SensorEvents);
  world.component(HitEvents);

  // 2. Geometry components are mutually exclusive: an entity holds at most one.
  world.setExclusiveComponents(Box, Circle, Capsule, Segment, Polygon, Chain);

  // 3. Ensure the three physics phases exist (created if missing). VP-6 installs
  //    the systems into them; for now they are empty buckets.
  resolvePhase(world, opts.preStepPhase, DEFAULT_PRE_STEP_PHASE);
  resolvePhase(world, opts.stepPhase, DEFAULT_STEP_PHASE);
  resolvePhase(world, opts.postStepPhase, DEFAULT_POST_STEP_PHASE);

  // 4. Allocate and attach the private engine state.
  attachPhysics(world, new PhysicsState(resolveOptions(opts)));
}

/** Resolve a phase placement option to a concrete phase. An `IPhase` is used
 * as-is; a name (or the default name) is looked up and created if missing. */
function resolvePhase(
  world: World,
  given: IPhase | string | undefined,
  defaultName: string
): IPhase {
  if (given !== undefined && typeof given !== "string") {
    return given;
  }
  const name = given ?? defaultName;
  return world._pipeline.get(name) ?? world.addPhase(name);
}

/** Apply Box2D-aligned defaults to `opts`. */
function resolveOptions(opts: PhysicsOptions): ResolvedPhysicsOptions {
  return {
    gravityX: opts.gravity?.x ?? 0,
    gravityY: opts.gravity?.y ?? -10,
    fixedTimeStep: opts.fixedTimeStep ?? 1 / 60,
    subSteps: opts.subSteps ?? 4,
    debug: opts.debug ?? false,
    restitutionThreshold: opts.restitutionThreshold ?? 1.0,
    hitEventThreshold: opts.hitEventThreshold ?? 10.0,
    contactHertz: opts.contactHertz ?? 30,
    contactDampingRatio: opts.contactDampingRatio ?? 10,
    maximumLinearSpeed: opts.maximumLinearSpeed ?? 400,
    enableSleep: opts.enableSleep ?? true,
    enableContinuous: opts.enableContinuous ?? true,
  };
}

/** Whether `world.start()` has already run. Reads the world's internal started
 * flag; there is no public accessor. */
function isWorldStarted(world: World): boolean {
  return (world as unknown as { _started?: boolean })._started === true;
}
