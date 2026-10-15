import { Module } from "@vworlds/vecs";

import { getPhysicsEngine, PhysicsSystemTag } from "../adapter/engine.js";
import { AngularVelocity, Body, LinearVelocity, Position, Rotation } from "./components.js";
import { rev } from "../adapter/runtime.js";
import { PhysicsCoreModule } from "../core/module.js";

export class BodyPoseInModule extends Module {
  public init(): void {
    const world = this.world;
    world.module(PhysicsCoreModule);

    const engine = getPhysicsEngine(world);
    const phase = engine.phases.preStep;
    world
      .system("PhysicsPoseSyncIn")
      .with(Body)
      .phase(phase)
      .ignoreSource([PhysicsSystemTag])
      .add(PhysicsSystemTag);

    world
      .system("PhysicsPoseSyncIn:Position")
      .with(Body, Position)
      .phase(phase)
      .ignoreSource([PhysicsSystemTag])
      .update({ watch: Position, onEnter: true, inject: [Body] }, (entity, position, [body]) => {
        const bodyId = body?._bodyId;
        if (bodyId === undefined) {
          return;
        }

        // SetTransform with the body's existing rotation, in one crossing.
        engine.fast.module._b2x_Body_SetPosition(
          bodyId.index1,
          rev(bodyId),
          position.x,
          position.y
        );
      })
      .add(PhysicsSystemTag);

    world
      .system("PhysicsPoseSyncIn:Rotation")
      .with(Body, Rotation)
      .phase(phase)
      .ignoreSource([PhysicsSystemTag])
      .update({ watch: Rotation, onEnter: true, inject: [Body] }, (entity, rotation, [body]) => {
        const bodyId = body?._bodyId;
        if (bodyId === undefined) {
          return;
        }

        // SetTransform with the body's existing position and b2MakeRot(angle).
        engine.fast.module._b2x_Body_SetAngle(bodyId.index1, rev(bodyId), rotation.angle);
      })
      .add(PhysicsSystemTag);

    world
      .system("PhysicsPoseSyncIn:LinearVelocity")
      .with(Body, LinearVelocity)
      .phase(phase)
      .ignoreSource([PhysicsSystemTag])
      .update(
        { watch: LinearVelocity, onEnter: true, inject: [Body] },
        (entity, velocity, [body]) => {
          const bodyId = body?._bodyId;
          if (bodyId === undefined) {
            return;
          }

          engine.fast.module._b2x_Body_SetLinearVelocity(
            bodyId.index1,
            rev(bodyId),
            velocity.x,
            velocity.y
          );
        }
      )
      .add(PhysicsSystemTag);

    world
      .system("PhysicsPoseSyncIn:AngularVelocity")
      .with(Body, AngularVelocity)
      .phase(phase)
      .ignoreSource([PhysicsSystemTag])
      .update(
        { watch: AngularVelocity, onEnter: true, inject: [Body] },
        (entity, velocity, [body]) => {
          const bodyId = body?._bodyId;
          if (bodyId === undefined) {
            return;
          }

          engine.fast.module._b2x_Body_SetAngularVelocity(
            bodyId.index1,
            rev(bodyId),
            velocity.value
          );
        }
      )
      .add(PhysicsSystemTag);
  }
}
