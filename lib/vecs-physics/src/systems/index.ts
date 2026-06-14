// Physics system installation. Creates all physics systems in their canonical
// run order and tags each one with `PhysicsSystemTag` so the pose-sync feedback
// suppression (`PhysicsPoseSyncIn.ignoreSource([PhysicsSystemTag])`) can filter
// the engine's own write-back. This is registration step 12 (ARCHITECTURE.md →
// _Component registration order_).
//
// Physics-pre phase order (creation order = run order within a phase):
//   1. PhysicsBodyLifecycle      — body must exist before any shape is inserted
//   2. PhysicsShapeLifecycle     — creates/destroys shape records + broad-phase proxies
//   3. PhysicsMaterialFilterSync — propagates Material/Filter/Sensor updates
//   4. PhysicsEventOptInSync     — runtime ContactEvents/HitEvents/SensorEvents add/remove (hooks)
//   5. PhysicsShapePoseSync      — propagates ShapePosition/ShapeRotation updates
//   6. PhysicsPoseSyncIn         — syncs Position/Rotation/Velocity into body sims
//   7. PhysicsKinematicTargets   — sets target-convergence velocity on kinematic bodies (VP-20)
//   8. PhysicsForceGather:*      — applies Force and Torque to body sims each step (VP-19)
//   9. PhysicsImpulseAccumulate  — drains Impulse/AngularImpulse into pendingImpulses (VP-19)
//  10. PhysicsMassRecompute      — recomputes mass for dirty bodies (last pre-step)
//  11. PhysicsDebugValidation    — structural validation (ONLY when debug: true, VP-25)
//
// Physics-post phase order:
//   1. PhysicsPoseSyncOut  — write simulated pose back to ECS
//   2. PhysicsEvents       — fan raw event arrays out to ContactEvents/SensorEvents/HitEvents (VP-21b)
//   3. PhysicsImpulseZero  — silently zero consumed Impulse/AngularImpulse (VP-19)

import { type Entity, type World } from "@vworlds/vecs";

import { type PhysicsEngine } from "../adapter/engine.js";
import { installDebugValidation } from "./debug.js";
import { installEventOptInSync } from "./event_opt_in_sync.js";
import { installEvents } from "./events.js";
import { installForceGather } from "./forces.js";
import { installImpulseAccumulate } from "./impulse_accumulate.js";
import { installImpulseZero } from "./impulse_zero.js";
import { installKinematicTargets } from "./kinematic.js";
import { installBodyLifecycle } from "./lifecycle.js";
import { installMassRecompute } from "./mass_recompute.js";
import { installMaterialFilterSync } from "./material_filter_sync.js";
import { installPoseSyncIn } from "./pose_sync_in.js";
import { installPoseSyncOut } from "./pose_sync_out.js";
import { installShapeLifecycle } from "./shape_lifecycle.js";
import { installShapePoseSync } from "./shape_pose_sync.js";
import { installStep } from "./step.js";

/** The three phases the physics systems split across. */
export interface PhysicsPhases {
  preStep: Entity;
  step: Entity;
  postStep: Entity;
}

/** Options forwarded to {@link registerPhysicsSystems} from {@link PhysicsModule}. */
export interface PhysicsSystemsOptions {
  /** Install `PhysicsDebugValidation` when `true`. Default `false`. */
  debug?: boolean;
}

/** Register every physics system into `world`, bound to `engine`. */
export function registerPhysicsSystems(
  world: World,
  engine: PhysicsEngine,
  phases: PhysicsPhases,
  opts: PhysicsSystemsOptions = {}
): void {
  // physics-pre: lifecycle + sync systems in dependency order.
  installBodyLifecycle(world, engine, phases.preStep);
  installShapeLifecycle(world, engine, phases.preStep);
  installMaterialFilterSync(world, engine, phases.preStep);
  // physics-pre: keep event opt-in flags in sync when ContactEvents/HitEvents/
  // SensorEvents are added/removed on a shape after creation (hook-based).
  installEventOptInSync(world, engine, phases.preStep);
  installShapePoseSync(world, engine, phases.preStep);
  installPoseSyncIn(world, engine, phases.preStep);
  // physics-pre: kinematic target drive after PoseSyncIn, before ForceGather (VP-20).
  installKinematicTargets(world, engine, phases.preStep);
  // physics-pre: force/impulse systems after KinematicTargets, before MassRecompute (VP-19).
  installForceGather(world, engine, phases.preStep);
  installImpulseAccumulate(world, engine, phases.preStep);
  // physics-pre: mass recompute — last pre-step, after all lifecycle/sync/force.
  installMassRecompute(world, engine, phases.preStep);
  // physics-step: integrator.
  installStep(world, engine, phases.step);
  // physics-post: write simulated pose back to ECS.
  installPoseSyncOut(world, engine, phases.postStep);
  // physics-post: fan raw event arrays out to ECS event components (VP-21b).
  // Must run AFTER PoseSyncOut (so positions are up to date) and BEFORE ImpulseZero.
  installEvents(world, engine, phases.postStep);
  // physics-post: silently zero consumed Impulse/AngularImpulse (last in post).
  installImpulseZero(world, engine, phases.postStep);

  // physics-pre: debug validation — LAST in physics-pre, ONLY when debug: true.
  // Runs after all lifecycle/sync/mass so the world is fully wired for the step.
  if (opts.debug === true) {
    installDebugValidation(world, engine, phases.preStep);
  }
}
