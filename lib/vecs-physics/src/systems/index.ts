// Physics system installation. Creates all physics systems in their canonical
// run order and tags each one with `PhysicsSystemTag` so the pose-sync feedback
// suppression (`PhysicsPoseSyncIn.ignoreSource([PhysicsSystemTag])`) can filter
// the engine's own write-back. This is registration step 12 (PLAN.md →
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
//   8. PhysicsForceGather        — accumulates Force/Torque into BodySim each step (VP-19)
//   9. PhysicsImpulseAccumulate  — drains Impulse/AngularImpulse into pendingImpulses (VP-19)
//  10. PhysicsMassRecompute      — recomputes mass for dirty bodies (last pre-step)
//  11. PhysicsDebugValidation    — structural validation (ONLY when debug: true, VP-25)
//
// Physics-post phase order:
//   1. PhysicsPoseSyncOut  — write simulated pose back to ECS
//   2. PhysicsEvents       — fan raw event arrays out to ContactEvents/SensorEvents/HitEvents (VP-21b)
//   3. PhysicsImpulseZero  — silently zero consumed Impulse/AngularImpulse (VP-19)

import { type IPhase, type World } from "@vworlds/vecs";

import { PhysicsSystemTag, type PhysicsState } from "../adapter/state.js";
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
import type { WarnSink } from "../util/warn.js";

/** The three phases the physics systems split across. */
export interface PhysicsPhases {
  preStep: IPhase;
  step: IPhase;
  postStep: IPhase;
}

/** Options forwarded to {@link installPhysicsSystems} from {@link installPhysics}. */
export interface PhysicsSystemsOptions {
  /** Install `PhysicsDebugValidation` when `true`. Default `false`. */
  debug?: boolean;
  /** Override the warning sink used by `PhysicsDebugValidation` (default
   * `console.warn`). Primarily for tests. Only used when `debug` is `true`. */
  debugSink?: WarnSink;
}

/** Install every physics system into `world`, bound to `state`, and tag each
 * system entity with {@link PhysicsSystemTag}. Must run before `world.start()`. */
export function installPhysicsSystems(
  world: World,
  state: PhysicsState,
  phases: PhysicsPhases,
  opts: PhysicsSystemsOptions = {}
): void {
  const systems = [
    // physics-pre: lifecycle + sync systems in dependency order.
    installBodyLifecycle(world, state, phases.preStep),
    installShapeLifecycle(world, state, phases.preStep),
    installMaterialFilterSync(world, state, phases.preStep),
    // physics-pre: keep event opt-in flags in sync when ContactEvents/HitEvents/
    // SensorEvents are added/removed on a shape after creation (hook-based).
    installEventOptInSync(world, state, phases.preStep),
    installShapePoseSync(world, state, phases.preStep),
    installPoseSyncIn(world, state, phases.preStep),
    // physics-pre: kinematic target drive after PoseSyncIn, before ForceGather (VP-20).
    installKinematicTargets(world, state, phases.preStep),
    // physics-pre: force/impulse systems after KinematicTargets, before MassRecompute (VP-19).
    installForceGather(world, state, phases.preStep),
    installImpulseAccumulate(world, state, phases.preStep),
    // physics-pre: mass recompute — last pre-step, after all lifecycle/sync/force.
    installMassRecompute(world, state, phases.preStep),
    // physics-step: integrator.
    installStep(world, state, phases.step),
    // physics-post: write simulated pose back to ECS.
    installPoseSyncOut(world, state, phases.postStep),
    // physics-post: fan raw event arrays out to ECS event components (VP-21b).
    // Must run AFTER PoseSyncOut (so positions are up to date) and BEFORE ImpulseZero.
    installEvents(world, state, phases.postStep),
    // physics-post: silently zero consumed Impulse/AngularImpulse (last in post).
    installImpulseZero(world, state, phases.postStep),
  ];

  // physics-pre: debug validation — LAST in physics-pre, ONLY when debug: true.
  // Runs after all lifecycle/sync/mass so the world is fully wired for the step.
  if (opts.debug === true) {
    const debugSystem = installDebugValidation(world, state, phases.preStep, {
      sink: opts.debugSink,
    });
    systems.push(debugSystem);
  }

  // Tag every physics system entity for the `ignoreSource` silence domain.
  for (const system of systems) {
    system.entity.add(PhysicsSystemTag);
  }
}
