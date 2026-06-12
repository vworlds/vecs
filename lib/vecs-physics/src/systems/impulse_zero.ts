import { type Entity, type World } from "@vworlds/vecs";

import { AngularImpulse, Impulse } from "../components/force.js";
import { PhysicsSystemTag, type PhysicsState } from "../adapter/state.js";

export function installImpulseZero(world: World, state: PhysicsState, phase: Entity): void {
  const system = world
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
  system.entity.add(PhysicsSystemTag);
}
