import { ChildOf, type Entity, type World } from "@vworlds/vecs";

import { Body } from "../components/body.js";
import { Force, Torque } from "../components/force.js";
import { PhysicsSystemTag, type PhysicsState } from "../adapter/state.js";

const forceTargetPredicate = { any: [Body, { parent: Body }] } as const;

export function installForceGather(world: World, state: PhysicsState, phase: Entity): void {
  const forceSystem = world
    .system("PhysicsForceGather:Force")
    .with(Force, forceTargetPredicate)
    .phase(phase);
  forceSystem.entity.add(PhysicsSystemTag);

  forceSystem.each([Force, Body, { target: [ChildOf, [Body]] }], (_entity, tuple) => {
    const [force, body, parentBody] = tuple;
    const bodyId = body?._bodyId ?? parentBody?._bodyId;
    if (bodyId === undefined) {
      return;
    }

    state.scratchVec2.Set(force.x, force.y);
    state.box2d.b2Body_ApplyForceToCenter(bodyId, state.scratchVec2, force.wake);
  });

  const torqueSystem = world
    .system("PhysicsForceGather:Torque")
    .with(Torque, forceTargetPredicate)
    .phase(phase)
    .each([Torque, Body, { target: [ChildOf, [Body]] }], (_entity, tuple) => {
      const [torque, body, parentBody] = tuple;
      const bodyId = body?._bodyId ?? parentBody?._bodyId;
      if (bodyId === undefined) {
        return;
      }

      state.box2d.b2Body_ApplyTorque(bodyId, torque.value, torque.wake);
    });
  torqueSystem.entity.add(PhysicsSystemTag);
}
