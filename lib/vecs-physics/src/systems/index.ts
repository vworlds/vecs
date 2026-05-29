// Physics system installation. Creates the VP-6 systems in their canonical run
// order and tags each one with `PhysicsSystemTag` so the pose-sync feedback
// suppression (`PhysicsPoseSyncIn.ignoreSource([PhysicsSystemTag])`) can filter
// the engine's own write-back. This is registration step 12 (PLAN.md →
// _Component registration order_).
//
// Systems run within a phase in creation order, so `PhysicsBodyLifecycle` is
// created before `PhysicsPoseSyncIn`: a body must exist before a teleport can be
// applied to it.

import { type IPhase, type World } from "@vworlds/vecs";

import { PhysicsSystemTag, type PhysicsState } from "../engine/state.js";
import { installBodyLifecycle } from "./lifecycle.js";
import { installPoseSyncIn } from "./pose_sync_in.js";
import { installPoseSyncOut } from "./pose_sync_out.js";
import { installStep } from "./step.js";

/** The three phases the physics systems split across. */
export interface PhysicsPhases {
  preStep: IPhase;
  step: IPhase;
  postStep: IPhase;
}

/** Install every physics system into `world`, bound to `state`, and tag each
 * system entity with {@link PhysicsSystemTag}. Must run before `world.start()`. */
export function installPhysicsSystems(
  world: World,
  state: PhysicsState,
  phases: PhysicsPhases
): void {
  const systems = [
    installBodyLifecycle(world, state, phases.preStep),
    installPoseSyncIn(world, state, phases.preStep),
    installStep(world, state, phases.step),
    installPoseSyncOut(world, state, phases.postStep),
  ];

  // Tag every physics system entity for the `ignoreSource` silence domain.
  for (const system of systems) {
    system.entity.add(PhysicsSystemTag);
  }
}
