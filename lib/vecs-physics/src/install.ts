// `installPhysics` — the single entry point that wires the physics engine into a
// Vecs world. It registers every public component, declares geometry
// exclusivity, ensures the three physics phases exist, creates the Box2D world,
// installs the physics systems (each tagged with `PhysicsSystemTag`), and
// attaches the private `PhysicsState`. See PLAN.md → _installPhysics Signature_
// and _Component registration order_.
//
// Registration order matters — Vecs assigns component type ids in registration
// order, so keeping the order stable keeps ids deterministic across installs.

import { insertPhaseAfter, ON_UPDATE, Phase, type Entity, type World } from "@vworlds/vecs";

import { AngularVelocity, Body, LinearVelocity, Position, Rotation } from "./components/body.js";
import { Damping, GravityScale, MotionLocks, Sleep } from "./components/body_tuning.js";
import { Box, Capsule, Chain, Circle, Polygon, Segment } from "./components/geometry.js";
import { AngularImpulse, Force, Impulse, Torque } from "./components/force.js";
import { CollisionFilter, Material, Sensor } from "./components/material.js";
import { ContactEvents, HitEvents, SensorEvents } from "./components/events.js";
import { KinematicTargetPosition, KinematicTargetRotation } from "./components/target.js";
import { ShapePosition, ShapeRotation } from "./components/shape_pose.js";
import { getBox2D } from "./adapter/runtime.js";
import { withAllocated } from "./adapter/disposal.js";
import {
  attachPhysics,
  hasPhysics,
  PhysicsState,
  registerInternalComponents,
  type ResolvedPhysicsOptions,
} from "./adapter/state.js";
import { registerImpulseHooks } from "./systems/impulse_accumulate.js";
import { installPhysicsSystems } from "./systems/index.js";

/** Options for {@link installPhysics}. Every field is optional; omitted fields
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

  // 2. Internal, non-exported components (`PhysicsRoot`, `PhysicsSystemTag`),
  //    registered in their documented order for deterministic type ids.
  registerInternalComponents(world);

  // 3. Geometry components are mutually exclusive: an entity holds at most one.
  world.setExclusiveComponents(Box, Circle, Capsule, Segment, Polygon, Chain);

  // 4. Ensure the three physics phase entities exist and are ordered after update.
  const preStep = resolvePhase(world, opts.preStepPhase, DEFAULT_PRE_STEP_PHASE);
  const step = resolvePhase(world, opts.stepPhase, DEFAULT_STEP_PHASE);
  const postStep = resolvePhase(world, opts.postStepPhase, DEFAULT_POST_STEP_PHASE);
  const updatePhase = world.entity(ON_UPDATE);
  insertPhaseAfter(preStep, updatePhase);
  insertPhaseAfter(step, preStep);
  insertPhaseAfter(postStep, step);

  // 5. Allocate WASM state, create the Box2D world, install the systems (bound
  //    to it), then attach it.
  const box2d = getBox2D();
  const options = resolveOptions(opts);
  const state = new PhysicsState(box2d, options, opts.debugSink);
  state.worldId = createWorldId(state, options);
  registerImpulseHooks(world, state);
  installPhysicsSystems(
    world,
    state,
    { preStep, step, postStep },
    {
      debug: opts.debug ?? false,
    }
  );
  attachPhysics(world, state);
}

function createWorldId(
  state: PhysicsState,
  options: ResolvedPhysicsOptions
): PhysicsState["worldId"] {
  const box2d = state.box2d;
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

/** Whether `world.start()` has already run. Reads the world's internal started
 * flag; there is no public accessor. */
function isWorldStarted(world: World): boolean {
  return (world as unknown as { _started?: boolean })._started === true;
}
