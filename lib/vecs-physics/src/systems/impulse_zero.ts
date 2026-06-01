import { type IPhase, type System, type World } from "@vworlds/vecs";

import { AngularImpulse, Impulse } from "../components/force.js";
import { type PhysicsState } from "../adapter/state.js";

export function installImpulseZero(world: World, state: PhysicsState, phase: IPhase): System {
  return world
    .system("PhysicsImpulseZero")
    .phase(phase)
    .run(() => {
      for (const eid of state.impulseEntitiesThisStep) {
        const entity = world.getEntity(eid);
        if (entity === undefined) {
          continue;
        }

        const imp = entity.get(Impulse) as Impulse | undefined;
        if (imp !== undefined) {
          imp.x = 0;
          imp.y = 0;
        }

        const ai = entity.get(AngularImpulse) as AngularImpulse | undefined;
        if (ai !== undefined) {
          ai.value = 0;
        }
      }

      state.impulseEntitiesThisStep.clear();
    });
}
