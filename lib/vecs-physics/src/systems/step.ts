import { type IPhase, type System, type World } from "@vworlds/vecs";

import { type PhysicsState } from "../adapter/state.js";
import { WarnDedupe } from "../util/warn.js";

export function installStep(world: World, state: PhysicsState, phase: IPhase): System {
  const warn = new WarnDedupe();

  return world
    .system("PhysicsStep")
    .phase(phase)
    .run((_now, delta) => {
      if (state.debug && Math.abs(delta / 1000 - state.fixedTimeStep) > 1e-4) {
        warn.warnOnce(
          0,
          "delta-mismatch",
          `frame delta ${delta}ms does not match fixedTimeStep ${state.fixedTimeStep * 1000}ms; ` +
            `physics expects a fixed delta.`
        );
      }
      state.box2d.b2World_Step(state.worldId, state.fixedTimeStep, state.subSteps);
    });
}
