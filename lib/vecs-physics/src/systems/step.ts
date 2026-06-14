import { type Entity, type World } from "@vworlds/vecs";

import { PhysicsSystemTag, type PhysicsEngine } from "../adapter/engine.js";

export function installStep(world: World, engine: PhysicsEngine, phase: Entity): void {
  const system = world
    .system("PhysicsStep")
    .phase(phase)
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
    });
  system.entity.add(PhysicsSystemTag);
}
