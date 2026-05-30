// `PhysicsPoseSyncOut` — simulated pose flows back to the entity's components.
//
// Runs in the post-step phase. For every dynamic or kinematic body it writes the
// engine's transform (and velocity, when those components are present) back with
// `entity.set(...)`, so user systems watching `Position`/`Rotation`/velocity see
// the simulation result. Static bodies never get move events and are never written
// back. See PLAN.md → _Pose And Velocity Synchronization_.
//
// VP-20 architect decision (resolves M1 kinematic accept-input / drop-output
// asymmetry): box2d moves and reports kinematic bodies. `PhysicsPoseSyncOut` now
// writes back both dynamic AND kinematic bodies. The old VP-6 rule ("kinematic
// poses are user-owned") is superseded: kinematic targets (`PhysicsKinematicTargets`)
// drive velocity onto the body state, the solver integrates position, and this
// system writes the resulting pose back to ECS components so callers see it.
// Static bodies are still never written back (they never receive move events).
//
// These writes are attributed to this system's entity, which carries
// `PhysicsSystemTag`, so `PhysicsPoseSyncIn.ignoreSource([PhysicsSystemTag])`
// discards them next frame — no echo bookkeeping needed.
//
// It iterates `state.bodyMoveEvents` (the bodies the solver finalized this step,
// Box2D's move-event list), so it touches only awake bodies and skips anything
// the step did not move. Until sleep lands the move-event list is every awake
// body; once bodies sleep, sleeping bodies drop out of it automatically.

import { type IPhase, type System, type World } from "@vworlds/vecs";

import { AngularVelocity, LinearVelocity, Position, Rotation } from "../components/body.js";
import { STATIC_BODY } from "../engine/body.js";
import { AWAKE_SET } from "../engine/solver_set.js";
import { type PhysicsState } from "../engine/state.js";
import { getAngle } from "../math/rot.js";

/** Create `PhysicsPoseSyncOut` on `world`, bound to `state` and `phase`. Returns
 * the system so the caller can tag its entity. */
export function installPoseSyncOut(world: World, state: PhysicsState, phase: IPhase): System {
  return world
    .system("PhysicsPoseSyncOut")
    .phase(phase)
    .run(() => {
      const awake = state.solverSets[AWAKE_SET]!;
      for (const bodyId of state.bodyMoveEvents) {
        const record = state.bodies.get(bodyId);
        if (record.type === STATIC_BODY) {
          // Static bodies never receive move events; this branch is a safety guard.
          // Kinematic and dynamic bodies are both written back (VP-20 architect
          // decision: box2d moves and reports kinematic bodies; the M1 asymmetry
          // is resolved by writing kinematic poses back, not by rejecting input).
          continue;
        }
        const entity = record.entity;
        const sim = awake.bodySims[record.localIndex]!;
        // Position is the canonical body pose, written unconditionally.
        entity.set(Position, { x: sim.transformX, y: sim.transformY });
        if (entity.get(Rotation) !== undefined) {
          entity.set(Rotation, { angle: getAngle({ c: sim.cos, s: sim.sin }) });
        }
        const bodyState = awake.bodyStates[record.localIndex]!;
        if (entity.get(LinearVelocity) !== undefined) {
          entity.set(LinearVelocity, { x: bodyState.vx, y: bodyState.vy });
        }
        if (entity.get(AngularVelocity) !== undefined) {
          entity.set(AngularVelocity, { value: bodyState.omega });
        }
      }
    });
}
