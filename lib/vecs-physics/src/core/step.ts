import { Module } from "@vworlds/vecs";

import { getPhysicsEngine, PhysicsSystemTag } from "../adapter/engine.js";
import { PhysicsCoreModule } from "./module.js";

export class PhysicsStepModule extends Module {
  public init(): void {
    const world = this.world;
    world.module(PhysicsCoreModule);

    const engine = getPhysicsEngine(world);
    world
      .system("PhysicsStep")
      .phase(engine.phases.step)
      .run((_now, delta) => {
        if (engine.debug && Math.abs(delta / 1000 - engine.fixedTimeStep) > 1e-4) {
          engine.warn.warnOnce(
            0,
            "delta-mismatch",
            `frame delta ${delta}ms does not match fixedTimeStep ${engine.fixedTimeStep * 1000}ms; ` +
              `physics expects a fixed delta.`
          );
        }
        engine.box2d.b2World_Step(engine.worldId, engine.fixedTimeStep, engine.subSteps);
      })
      .add(PhysicsSystemTag);
  }
}
