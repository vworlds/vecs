// `PhysicsModule` wires the physics engine into a Vecs world. It registers every
// public component, declares each geometry component as a `Shape` implementer
// (mutually exclusive: setting one evicts any previous geometry), ensures the
// three physics phases exist, creates the Box2D world, installs the physics
// systems (each tagged with `PhysicsSystemTag`), and attaches the private
// `PhysicsEngine`.
//
// Registration order matters: Vecs assigns component type ids in registration
// order, so keeping the order stable keeps ids deterministic across worlds.

import {
  Implements,
  insertPhaseAfter,
  Module,
  ON_UPDATE,
  Phase,
  type Entity,
  type World,
} from "@vworlds/vecs";

import { AngularVelocity, Body, LinearVelocity, Position, Rotation } from "./components/body.js";
import { Damping, GravityScale, MotionLocks, Sleep } from "./components/body_tuning.js";
import {
  Box,
  Capsule,
  Chain,
  Circle,
  Polygon,
  Segment,
  Shape,
  SingleShape,
} from "./components/geometry.js";
import { AngularImpulse, Force, Impulse, Torque } from "./components/force.js";
import {
  DistanceJoint,
  FilterJoint,
  Joint,
  JointAngularSpring,
  JointBodyA,
  JointBodyB,
  JointFrame,
  JointLimit,
  JointLinearSpring,
  JointMotor,
  JointSettings,
  RevoluteJoint,
  WeldJoint,
} from "./components/joint.js";
import { CollisionFilter, Detectable, Material, Sensor } from "./components/material.js";
import { ContactEvents, HitEvents, SensorEvents } from "./components/events.js";
import { KinematicTargetPosition, KinematicTargetRotation } from "./components/target.js";
import { ShapePosition, ShapeRotation } from "./components/shape_pose.js";
import { getBox2D } from "./adapter/runtime.js";
import { withAllocated } from "./adapter/disposal.js";
import {
  attachPhysicsEngine,
  hasPhysicsEngine,
  PhysicsEngine,
  registerInternalComponents,
  type ResolvedPhysicsOptions,
} from "./adapter/engine.js";
import { registerImpulseHooks } from "./systems/impulse_accumulate.js";
import { registerPhysicsSystems } from "./systems/index.js";

/** Options for {@link PhysicsModule}. Every field is optional; omitted fields
 * fall back to Box2D-aligned defaults. */
export type PhysicsOptions = {
  gravity?: { x: number; y: number }; // default { x: 0, y: -10 }
  fixedTimeStep?: number; // seconds, default 1/60
  subSteps?: number; // default 4
  debug?: boolean; // default false
  /** Override the warning sink used by `PhysicsDebugValidation` when
   * `debug: true`. Accepts any `(message: string) => void` callback.
   * Primarily for tests; defaults to `console.warn`. */
  debugSink?: (message: string) => void;

  // Optional phase placement. Either pass an entity or a name (created if missing).
  preStepPhase?: Entity | string;
  stepPhase?: Entity | string;
  postStepPhase?: Entity | string;

  // Optional thresholds and tunables, all with Box2D-aligned defaults.
  restitutionThreshold?: number; // m/s, default 1.0
  hitEventThreshold?: number; // m/s, default 1.0
  contactHertz?: number; // default 30
  contactDampingRatio?: number; // default 10
  contactSpeed?: number; // m/s, default 3.0
  maximumLinearSpeed?: number; // m/s, default 400
  enableSleep?: boolean; // default true
  enableContinuous?: boolean; // default true
};

const DEFAULT_PRE_STEP_PHASE = "physics-pre";
const DEFAULT_STEP_PHASE = "physics-step";
const DEFAULT_POST_STEP_PHASE = "physics-post";

/** World module that installs physics when registered with `world.module`. */
export class PhysicsModule extends Module<PhysicsOptions | undefined> {
  public init(options: PhysicsOptions | undefined): void {
    registerPhysics(this.world, options ?? {});
  }
}

function registerPhysics(world: World, opts: PhysicsOptions): void {
  if (hasPhysicsEngine(world)) {
    throw new Error("PhysicsModule has already been registered on this world");
  }

  // 1. Register every public component, in a stable order (see file header).
  //    `ChildOf` is built into Vecs: referenced, never registered.
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

  world.component(Shape);
  world.component(SingleShape);
  world.component(Box);
  world.component(Circle);
  world.component(Capsule);
  world.component(Segment);
  world.component(Polygon);
  world.component(Chain);

  world.component(Material);
  world.component(CollisionFilter);
  world.component(Sensor);
  world.component(Detectable);

  world.component(Force);
  world.component(Torque);
  world.component(Impulse);
  world.component(AngularImpulse);

  world.component(KinematicTargetPosition);
  world.component(KinematicTargetRotation);

  world.component(ContactEvents);
  world.component(SensorEvents);
  world.component(HitEvents);

  // Joints: relationships to the two connected bodies, the exclusive joint-type
  // umbrella + concrete types, the shared frame, and the optional feature/base
  // components. Appended after events so existing component type ids are stable.
  world.component(JointBodyA);
  world.component(JointBodyB);
  world.component(Joint);
  world.component(RevoluteJoint);
  world.component(DistanceJoint);
  world.component(WeldJoint);
  world.component(FilterJoint);
  world.component(JointFrame);
  world.component(JointMotor);
  world.component(JointLimit);
  world.component(JointLinearSpring);
  world.component(JointAngularSpring);
  world.component(JointSettings);

  // 2. Internal, non-exported components (`PhysicsEngine`, `PhysicsSystemTag`),
  //    registered in their documented order for deterministic type ids.
  registerInternalComponents(world);

  // 3. Geometry components implement `Shape` through either the internal
  //    `SingleShape` tier or Chain's direct umbrella implementation. This keeps
  //    geometry exclusivity while letting b2Shape-only systems query only singles.
  world.component(SingleShape).set(Implements, { interfaces: [Shape] });
  world.component(Box).set(Implements, { interfaces: [SingleShape] });
  world.component(Circle).set(Implements, { interfaces: [SingleShape] });
  world.component(Capsule).set(Implements, { interfaces: [SingleShape] });
  world.component(Segment).set(Implements, { interfaces: [SingleShape] });
  world.component(Polygon).set(Implements, { interfaces: [SingleShape] });
  world.component(Chain).set(Implements, { interfaces: [Shape] });

  // 3b. Concrete joint types implement the `Joint` umbrella, so they are mutually
  //     exclusive (one joint type per joint entity) and `entity.get(Joint)`
  //     resolves whichever concrete type is present.
  world.component(RevoluteJoint).set(Implements, { interfaces: [Joint] });
  world.component(DistanceJoint).set(Implements, { interfaces: [Joint] });
  world.component(WeldJoint).set(Implements, { interfaces: [Joint] });
  world.component(FilterJoint).set(Implements, { interfaces: [Joint] });

  // 3c. Joint→body relationships keep the default `CleanupPolicy.Remove`:
  //     destroying a connected body detaches the joint (its Box2D constraint is
  //     torn down by the lifecycle membership exit when the body loses `Body`) and
  //     leaves the joint entity for the user to manage. Destroying a body is not
  //     meant to destroy the joint entity, so `CleanupPolicy.Delete` is not used.

  // 4. Ensure the three physics phase entities exist and are ordered after update.
  const preStep = resolvePhase(world, opts.preStepPhase, DEFAULT_PRE_STEP_PHASE);
  const step = resolvePhase(world, opts.stepPhase, DEFAULT_STEP_PHASE);
  const postStep = resolvePhase(world, opts.postStepPhase, DEFAULT_POST_STEP_PHASE);
  const updatePhase = world.entity(ON_UPDATE);
  insertPhaseAfter(preStep, updatePhase);
  insertPhaseAfter(step, preStep);
  insertPhaseAfter(postStep, step);

  // 5. Allocate WASM engine, create the Box2D world, register the systems (bound
  //    to it), then attach it.
  const box2d = getBox2D();
  const options = resolveOptions(opts);
  const engine = new PhysicsEngine(box2d, options, opts.debugSink);
  engine.worldId = createWorldId(engine, options);
  registerImpulseHooks(world, engine);
  registerPhysicsSystems(
    world,
    engine,
    { preStep, step, postStep },
    {
      debug: opts.debug ?? false,
    }
  );
  attachPhysicsEngine(world, engine);
}

function createWorldId(
  engine: PhysicsEngine,
  options: ResolvedPhysicsOptions
): PhysicsEngine["worldId"] {
  const box2d = engine.box2d;
  return withAllocated(box2d.b2DefaultWorldDef, (def) => {
    def.gravity.x = options.gravityX;
    def.gravity.y = options.gravityY;
    def.restitutionThreshold = options.restitutionThreshold;
    def.hitEventThreshold = options.hitEventThreshold;
    def.contactHertz = options.contactHertz;
    def.contactDampingRatio = options.contactDampingRatio;
    def.maximumLinearSpeed = options.maximumLinearSpeed;
    def.enableSleep = options.enableSleep;
    def.enableContinuous = options.enableContinuous;
    const worldId = box2d.b2CreateWorld(def);
    box2d.b2World_SetContactTuning(
      worldId,
      options.contactHertz,
      options.contactDampingRatio,
      options.contactSpeed
    );
    return worldId;
  });
}

/** Resolve a phase placement option to a concrete phase entity. */
function resolvePhase(
  world: World,
  given: Entity | string | undefined,
  defaultName: string
): Entity {
  const phase =
    typeof given === "string" || given === undefined ? world.entity(given ?? defaultName) : given;
  phase.add(Phase);
  return phase;
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
    // box2d b2DefaultWorldDef: def.hitEventThreshold = 1.0f * lengthUnits (types.c:16).
    hitEventThreshold: opts.hitEventThreshold ?? 1.0,
    contactHertz: opts.contactHertz ?? 30,
    contactDampingRatio: opts.contactDampingRatio ?? 10,
    // box2d b2DefaultWorldDef: def.contactSpeed = 3.0f * lengthUnits (types.c:18).
    contactSpeed: opts.contactSpeed ?? 3.0,
    maximumLinearSpeed: opts.maximumLinearSpeed ?? 400,
    enableSleep: opts.enableSleep ?? true,
    enableContinuous: opts.enableContinuous ?? true,
  };
}
