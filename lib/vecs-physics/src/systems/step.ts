// `PhysicsStep` — the single system in the `physics-step` phase. It drives the
// engine forward one fixed step per frame by calling `engineStep`. See PLAN.md →
// _`PhysicsStep`_.
//
// Physics runs on a fixed time step (`fixedTimeStep`), independent of the frame
// delta. In debug mode a mismatch between the frame delta and the fixed step is
// warned once, since a wrong delta silently desyncs the simulation.

import { type IPhase, type System, type World } from "@vworlds/vecs";

import { engineStep } from "../engine/step.js";
import { type PhysicsState } from "../engine/state.js";
import { WarnDedupe } from "../util/warn.js";

/** Create `PhysicsStep` on `world`, bound to `state` and `phase`. Returns the
 * system so the caller can tag its entity. */
export function installStep(world: World, state: PhysicsState, phase: IPhase): System {
  // Closure-scoped dedupe for the world-global delta-mismatch warning (the
  // per-entity debug-validation warnings land with their own system later).
  const warn = new WarnDedupe();

  return world
    .system("PhysicsStep")
    .phase(phase)
    .run((_now, delta) => {
      const dt = state.fixedTimeStep;
      if (state.debug && Math.abs(delta / 1000 - dt) > 1e-4) {
        warn.warnOnce(
          0,
          "delta-mismatch",
          `frame delta ${delta}ms does not match fixedTimeStep ${dt * 1000}ms; ` +
            `physics expects a fixed delta.`
        );
      }
      engineStep(state, dt, state.subSteps);
    });
}
