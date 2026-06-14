import { type Entity, type World } from "@vworlds/vecs";

import { Body, BodyType } from "../components/body.js";
import { PhysicsSystemTag, type PhysicsEngine } from "../adapter/engine.js";

const CODE_DYNAMIC_BODY_WITHOUT_DENSITY = "dynamic-body-without-density";

export function installMassRecompute(world: World, engine: PhysicsEngine, phase: Entity): void {
  const system = world
    .system("PhysicsMassRecompute")
    .phase(phase)
    .run(() => {
      for (const eid of engine.dirtyMassBodies) {
        const bodyId = world.getEntity(eid)?.get(Body)?._bodyId;
        if (bodyId !== undefined) {
          engine.box2d.b2Body_ApplyMassFromShapes(bodyId);
        }
      }
      engine.dirtyMassBodies.clear();

      if (engine.debug) {
        warnOnMasslessDynamicBodies(world, engine);
      }
    });
  system.entity.add(PhysicsSystemTag);
}

function warnOnMasslessDynamicBodies(world: World, engine: PhysicsEngine): void {
  world.filter(Body).forEach([Body], (entity, [body]) => {
    const eid = entity.eid;
    const bodyId = body._bodyId;
    if (body.type !== BodyType.Dynamic || bodyId === undefined) {
      engine.warn.rearm(eid, CODE_DYNAMIC_BODY_WITHOUT_DENSITY);
      return;
    }

    if (engine.box2d.b2Body_GetMass(bodyId) === 0) {
      engine.warn.warnOnce(
        eid,
        CODE_DYNAMIC_BODY_WITHOUT_DENSITY,
        `Entity${eid} is a dynamic body with zero mass after recompute; it will not fall.`
      );
    } else {
      engine.warn.rearm(eid, CODE_DYNAMIC_BODY_WITHOUT_DENSITY);
    }
  });
}
