import { type IPhase, type System, type World } from "@vworlds/vecs";

import { Body, BodyType } from "../components/body.js";
import { type PhysicsState } from "../adapter/state.js";
import { WarnDedupe } from "../util/warn.js";

const CODE_DYNAMIC_BODY_WITHOUT_DENSITY = "dynamic-body-without-density";

export function installMassRecompute(world: World, state: PhysicsState, phase: IPhase): System {
  const warn = new WarnDedupe();

  return world
    .system("PhysicsMassRecompute")
    .phase(phase)
    .run(() => {
      for (const eid of state.dirtyMassBodies) {
        const bodyId = state.bodyByEntityWasm.get(eid);
        if (bodyId !== undefined) {
          state.box2d.b2Body_ApplyMassFromShapes(bodyId);
        }
      }
      state.dirtyMassBodies.clear();
      syncLegacyMassState(state);

      if (state.debug) {
        warnOnMasslessDynamicBodies(world, state, warn);
      }
    });
}

function syncLegacyMassState(state: PhysicsState): void {
  for (const body of state.bodies.records) {
    if (body === undefined || !body.massDirty) {
      continue;
    }

    body.massDirty = false;
    const bodyId = state.bodyByEntityWasm.get(body.entity.eid);
    const set = state.solverSets[body.setIndex];
    const sim = set?.bodySims[body.localIndex];
    if (bodyId === undefined || sim === undefined) {
      continue;
    }

    const massData = state.box2d.b2Body_GetMassData(bodyId);
    try {
      sim.invMass = massData.mass > 0 ? 1 / massData.mass : 0;
      sim.invInertia = massData.rotationalInertia > 0 ? 1 / massData.rotationalInertia : 0;
      sim.localCenterX = massData.center.x;
      sim.localCenterY = massData.center.y;
      sim.centerX = sim.cos * sim.localCenterX - sim.sin * sim.localCenterY + sim.transformX;
      sim.centerY = sim.sin * sim.localCenterX + sim.cos * sim.localCenterY + sim.transformY;
    } finally {
      massData.delete();
    }
  }
}

function warnOnMasslessDynamicBodies(world: World, state: PhysicsState, warn: WarnDedupe): void {
  for (const [eid, bodyId] of state.bodyByEntityWasm) {
    const entity = world.getEntity(eid);
    const body = entity?.get(Body);
    if (body?.type !== BodyType.Dynamic) {
      warn.rearm(eid, CODE_DYNAMIC_BODY_WITHOUT_DENSITY);
      continue;
    }

    if (state.box2d.b2Body_GetMass(bodyId) === 0) {
      warn.warnOnce(
        eid,
        CODE_DYNAMIC_BODY_WITHOUT_DENSITY,
        `Entity${eid} is a dynamic body with zero mass after recompute; it will not fall.`
      );
    } else {
      warn.rearm(eid, CODE_DYNAMIC_BODY_WITHOUT_DENSITY);
    }
  }
}
