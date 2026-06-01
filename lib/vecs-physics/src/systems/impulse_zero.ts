// `PhysicsImpulseZero` — silently zeroes consumed Impulse/AngularImpulse after
// the physics step.
//
// Phase: `physics-post`, after `PhysicsPoseSyncOut` (and after `PhysicsEvents`
// once VP-21b lands — this system is registered last in post per PLAN.md).
//
// After `engineStep` applies pending impulses (velocity += invMass * acc),
// the ECS Impulse/AngularImpulse components still hold the user-set values.
// We zero them SILENTLY — direct property assignment, no `entity.modified(...)` —
// so no query's update inbox receives a notification for the reset. This is the
// "silent zero" contract (PLAN.md → PhysicsImpulseZero):
//   "direct write + no modified = invisible to update-watchers"
//
// We walk only `state.impulseEntitiesThisStep` (populated by
// `PhysicsImpulseAccumulate`), not every entity in the world. Then we clear the
// set for the next step.
//
// Box2D does not have an equivalent: it applies impulses immediately in
// `b2Body_ApplyLinearImpulseToCenter` (body.c:1048) and the caller holds no
// "applied impulse" component. The silent-zero is a Vecs-specific mechanism to
// satisfy the ECS contract (user can read Impulse; after it is consumed it is
// zero).
//
// Note on `ignoreSource` vs silent zero (PLAN.md ~837): `ignoreSource` lets a
// consumer system opt out of updates from a group; it cannot stop user watchers
// from observing a write. The silent-zero requirement is that NO watcher — physics
// or user — observes the reset, so direct property assignment is the only safe
// approach.

import { type IPhase, type System, type World } from "@vworlds/vecs";

import { AngularImpulse, Impulse } from "../components/force.js";
import { type PhysicsState } from "../engine/state.js";

/** Create `PhysicsImpulseZero` on `world`, bound to `state` and `phase`.
 * Returns the system so the caller can tag its entity. */
export function installImpulseZero(world: World, state: PhysicsState, phase: IPhase): System {
  return world
    .system("PhysicsImpulseZero")
    .phase(phase)
    .run(() => {
      for (const eid of state.impulseEntitiesThisStep) {
        // Look up the entity by eid. `getEntity` returns undefined when the
        // entity was destroyed this step, which is a valid no-op.
        const e = world.getEntity(eid);
        if (e === undefined) {
          continue;
        }

        // Zero Impulse silently: direct property write, no entity.modified(Impulse).
        const imp = e.get(Impulse) as Impulse | undefined;
        if (imp !== undefined) {
          imp.x = 0;
          imp.y = 0;
          // Do NOT call entity.modified — this must be invisible to watchers.
        }

        // Zero AngularImpulse silently.
        const ai = e.get(AngularImpulse) as AngularImpulse | undefined;
        if (ai !== undefined) {
          ai.value = 0;
          // Do NOT call entity.modified.
        }
      }

      state.impulseEntitiesThisStep.clear();
    });
}
