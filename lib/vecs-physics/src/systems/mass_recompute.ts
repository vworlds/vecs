import { type Entity, type System, type World } from "@vworlds/vecs";

import { Body, BodyType } from "../components/body.js";
import { type PhysicsState } from "../adapter/state.js";

const CODE_DYNAMIC_BODY_WITHOUT_DENSITY = "dynamic-body-without-density";

export function installMassRecompute(world: World, state: PhysicsState, phase: Entity): System {
  return world
    .system("PhysicsMassRecompute")
    .phase(phase)
    .run(() => {
      for (const eid of state.dirtyMassBodies) {
        const bodyId = world.getEntity(eid)?.get(Body)?._bodyId;
        if (bodyId !== undefined) {
          state.box2d.b2Body_ApplyMassFromShapes(bodyId);
        }
      }
      state.dirtyMassBodies.clear();

      if (state.debug) {
        warnOnMasslessDynamicBodies(world, state);
      }
    });
}

function warnOnMasslessDynamicBodies(world: World, state: PhysicsState): void {
  world.filter(Body).forEach([Body], (entity, [body]) => {
    const eid = entity.eid;
    const bodyId = body._bodyId;
    if (body.type !== BodyType.Dynamic || bodyId === undefined) {
      state.warn.rearm(eid, CODE_DYNAMIC_BODY_WITHOUT_DENSITY);
      return;
    }

    if (state.box2d.b2Body_GetMass(bodyId) === 0) {
      state.warn.warnOnce(
        eid,
        CODE_DYNAMIC_BODY_WITHOUT_DENSITY,
        `Entity${eid} is a dynamic body with zero mass after recompute; it will not fall.`
      );
    } else {
      state.warn.rearm(eid, CODE_DYNAMIC_BODY_WITHOUT_DENSITY);
    }
  });
}
