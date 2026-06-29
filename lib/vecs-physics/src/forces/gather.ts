import { ChildOf, Module } from "@vworlds/vecs";

import { getPhysicsEngine, PhysicsSystemTag, type PhysicsEngine } from "../adapter/engine.js";
import { Body } from "../body/components.js";
import { Force, Torque } from "./components.js";
import { scr_b2Vec2 } from "../adapter/runtime.js";
import { PhysicsCoreModule } from "../core/module.js";

const forceTargetPredicate = { any: [Body, { parent: Body }] } as const;

export class ForceGatherModule extends Module {
  public init(): void {
    const world = this.world;
    world.module(PhysicsCoreModule);

    const engine = getPhysicsEngine(world);
    const phase = engine.phases.preStep;
    world
      .system("PhysicsForceGather:Force")
      .with(Force, forceTargetPredicate)
      .phase(phase)
      .each([Force, Body, { target: [ChildOf, [Body]] }], (_entity, [force, body, parentBody]) => {
        const bodyId = body?._bodyId ?? parentBody?._bodyId;
        if (bodyId === undefined) {
          return;
        }

        const vec = scr_b2Vec2[0];
        vec.Set(force.x, force.y);
        engine.box2d.b2Body_ApplyForceToCenter(bodyId, vec, force.wake);
      })
      .add(PhysicsSystemTag);

    world
      .system("PhysicsForceGather:Torque")
      .with(Torque, forceTargetPredicate)
      .phase(phase)
      .each(
        [Torque, Body, { target: [ChildOf, [Body]] }],
        (_entity, [torque, body, parentBody]) => {
          const bodyId = body?._bodyId ?? parentBody?._bodyId;
          if (bodyId === undefined) {
            return;
          }

          engine.box2d.b2Body_ApplyTorque(bodyId, torque.value, torque.wake);
        }
      )
      .add(PhysicsSystemTag);
  }
}
