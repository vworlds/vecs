import { ChildOf, Module } from "@vworlds/vecs";

import { getPhysicsEngine, PhysicsSystemTag } from "../adapter/engine.js";
import { Body } from "../body/components.js";
import { Force, Torque } from "./components.js";
import { rev } from "../adapter/runtime.js";
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
        // A zero force changes nothing, but Box2D would still wake a sleeping body for it when
        // `wake` is set, so a body holding an idle `Force { x: 0, y: 0 }` could never stay asleep.
        // Skip it: no wasm call and no wake.
        if (force.x === 0 && force.y === 0) {
          return;
        }

        const bodyId = body?._bodyId ?? parentBody?._bodyId;
        if (bodyId === undefined) {
          return;
        }

        engine.fast.module._b2x_Body_ApplyForceToCenter(
          bodyId.index1,
          rev(bodyId),
          force.x,
          force.y,
          force.wake ? 1 : 0
        );
      })
      .entity.add(PhysicsSystemTag);

    world
      .system("PhysicsForceGather:Torque")
      .with(Torque, forceTargetPredicate)
      .phase(phase)
      .each(
        [Torque, Body, { target: [ChildOf, [Body]] }],
        (_entity, [torque, body, parentBody]) => {
          // Same as a zero force: skip it so an idle `Torque { value: 0 }` cannot keep waking
          // its body.
          if (torque.value === 0) {
            return;
          }

          const bodyId = body?._bodyId ?? parentBody?._bodyId;
          if (bodyId === undefined) {
            return;
          }

          engine.fast.module._b2x_Body_ApplyTorque(
            bodyId.index1,
            rev(bodyId),
            torque.value,
            torque.wake ? 1 : 0
          );
        }
      )
      .entity.add(PhysicsSystemTag);
  }
}
