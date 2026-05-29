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
// VP-6 has no solver step yet, so there is no per-body move-event list to drive
// this: it writes back every dynamic body each frame. VP-7's engine step
// produces a move-event list and this narrows to the bodies that actually moved.

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
      for (let i = 0; i < awake.bodySims.length; i++) {
        const sim = awake.bodySims[i]!;
        const record = state.bodies.get(sim.bodyId);
        if (record.type !== DYNAMIC_BODY) {
          continue;
        }
        const entity = record.entity;
        // Position is the canonical body pose, written unconditionally.
        entity.set(Position, { x: sim.transformX, y: sim.transformY });
        if (entity.get(Rotation) !== undefined) {
          entity.set(Rotation, { angle: getAngle({ c: sim.cos, s: sim.sin }) });
        }
        const bodyState = awake.bodyStates[i]!;
        if (entity.get(LinearVelocity) !== undefined) {
          entity.set(LinearVelocity, { x: bodyState.vx, y: bodyState.vy });
        }
        if (entity.get(AngularVelocity) !== undefined) {
          entity.set(AngularVelocity, { value: bodyState.omega });
        }
      }
    });
}
