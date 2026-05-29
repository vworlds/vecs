// `PhysicsMassRecompute` — last pre-step system; recomputes mass for every
// body whose `massDirty` flag is set, then clears it.
//
// Runs once per frame in the `physics-pre` phase, after all shape lifecycle /
// material / pose-sync systems have had a chance to mark bodies dirty.
// The system is state-driven (not reactive): it scans `state.bodies.records`
// each frame. For v1 this is acceptable; a dirty-set optimisation is a
// straightforward future improvement.
//
// Mirrors box2d's `b2UpdateBodyMassData` call site in the step: box2d lazily
// re-integrates mass at the start of `b2World_Step` for all flagged bodies.
//
// See PLAN.md → _System And Phase Pipeline → PhysicsMassRecompute_.
// See box2d/src/body.c::b2UpdateBodyMassData.

import { type IPhase, type System, type World } from "@vworlds/vecs";

import { AWAKE_SET, STATIC_SET, DISABLED_SET } from "../engine/solver_set.js";
import { updateBodyMassData } from "../engine/mass.js";
import { type PhysicsState } from "../engine/state.js";

/** Create `PhysicsMassRecompute` on `world`, bound to `state` and `phase`.
 * Returns the system so the caller can tag its entity. */
export function installMassRecompute(world: World, state: PhysicsState, phase: IPhase): System {
  return world
    .system("PhysicsMassRecompute")
    .phase(phase)
    .run(() => {
      const { bodies, shapes, solverSets } = state;

      for (let i = 0; i < bodies.records.length; i++) {
        const body = bodies.records[i];
        if (body === undefined || !body.massDirty) {
          continue;
        }

        // Resolve the body's BodySim from the appropriate solver set.
        const setIndex = body.setIndex;
        const set = solverSets[setIndex];
        if (set === undefined) {
          continue;
        }

        const sim = set.bodySims[body.localIndex];
        if (sim === undefined) {
          continue;
        }

        updateBodyMassData(body, sim, (shapeIndex) => shapes.get(shapeIndex));
      }
    });
}
