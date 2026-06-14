import { type Entity, type World } from "@vworlds/vecs";

import { AngularImpulse, Impulse } from "../components/force.js";
import { PhysicsSystemTag, type PhysicsEngine } from "../adapter/engine.js";

export function installImpulseZero(world: World, engine: PhysicsEngine, phase: Entity): void {
  const system = world
    .system("PhysicsImpulseZero")
    .phase(phase)
    .run(() => {
      for (const eid of engine.impulseEntitiesThisStep) {
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

      engine.impulseEntitiesThisStep.clear();
    });
  system.entity.add(PhysicsSystemTag);
}
