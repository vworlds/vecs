// `PhysicsPoseSyncOut` — simulated pose flows back to the entity's components.
//
// Runs in the post-step phase. For every dynamic body it writes the engine's
// transform (and velocity, when those components are present) back with
// `entity.set(...)`, so user systems watching `Position`/`Rotation`/velocity see
// the simulation result. Kinematic and static poses are user-owned and never
// written back. See PLAN.md → _Pose And Velocity Synchronization_.
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
import { DYNAMIC_BODY } from "../engine/body.js";
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
        if (record.type !== DYNAMIC_BODY) {
          // Kinematic poses are user-owned; static bodies never get move events.
          //
          // FOLLOW-UP (M1 review): this drops kinematic motion that the engine
          // *did* produce — `PhysicsPoseSyncIn` accepts kinematic velocity and
          // the integrator advances it, so a kinematic body moves internally but
          // is never written back (a silent no-op). box2d moves and reports
          // kinematic bodies. Settle the contract when kinematic drive lands
          // (M4 / PhysicsKinematicTargets): write kinematic poses back, or
          // reject kinematic velocity input in PhysicsPoseSyncIn.
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
