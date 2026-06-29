import { Module } from "@vworlds/vecs";

import { getPhysicsEngine, PhysicsSystemTag } from "../adapter/engine.js";
import { PhysicsCoreModule } from "../core/module.js";
import { AngularImpulse, Impulse } from "./components.js";

export class ImpulseZeroModule extends Module {
  public init(): void {
    const world = this.world;
    world.module(PhysicsCoreModule);

    const engine = getPhysicsEngine(world);
    world
      .system("PhysicsImpulseZero")
      .phase(engine.phases.postStep)
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
      })
      .add(PhysicsSystemTag);
  }
}
