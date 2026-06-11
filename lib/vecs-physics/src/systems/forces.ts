import { type Entity, type System, type World } from "@vworlds/vecs";

import { Force, Torque } from "../components/force.js";
import { type PhysicsState } from "../adapter/state.js";
import { resolveBodyId } from "../util/resolve_body.js";

export function installForceGather(world: World, state: PhysicsState, phase: Entity): System {
  const forceFilter = world.filter({ any: [Force, Torque] });

  return world
    .system("PhysicsForceGather")
    .phase(phase)
    .run(() => {
      forceFilter.forEach((entity) => {
        const bodyId = resolveBodyId(entity);
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
