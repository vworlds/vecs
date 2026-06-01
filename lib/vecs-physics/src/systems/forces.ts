import { ChildOf, type Entity, type IPhase, type System, type World } from "@vworlds/vecs";

import { Body } from "../components/body.js";
import { Force, Torque } from "../components/force.js";
import { type b2BodyId, type PhysicsState } from "../adapter/state.js";

export function installForceGather(world: World, state: PhysicsState, phase: IPhase): System {
  const forceFilter = world.filter({ any: [Force, Torque] });

  return world
    .system("PhysicsForceGather")
    .phase(phase)
    .run(() => {
      forceFilter.forEach((entity) => {
        const bodyId = resolveBodyId(entity, state);
        if (bodyId === undefined) {
          return;
        }

        const force = entity.get(Force) as Force | undefined;
        if (force !== undefined) {
          state.scratchVec2.Set(force.x, force.y);
          state.box2d.b2Body_ApplyForceToCenter(bodyId, state.scratchVec2, force.wake);
        }

        const torque = entity.get(Torque) as Torque | undefined;
        if (torque !== undefined) {
          state.box2d.b2Body_ApplyTorque(bodyId, torque.value, torque.wake);
        }
      });
    });
}

function resolveBodyId(entity: Entity, state: PhysicsState): b2BodyId | undefined {
  if (entity.get(Body) !== undefined) {
    return state.bodyByEntityWasm.get(entity.eid);
  }

  const parent = entity.parent(ChildOf);
  if (parent === undefined || parent.get(Body) === undefined) {
    return undefined;
  }
  return state.bodyByEntityWasm.get(parent.eid);
}
