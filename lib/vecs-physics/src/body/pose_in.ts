import { Module } from "@vworlds/vecs";

import { getPhysicsEngine, PhysicsSystemTag } from "../adapter/engine.js";
import { AngularVelocity, Body, LinearVelocity, Position, Rotation } from "./components.js";
import { scr_b2Vec2 } from "../adapter/runtime.js";
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

        const rotation = engine.box2d.b2Body_GetRotation(bodyId);
        try {
          const vec = scr_b2Vec2[0];
          vec.Set(position.x, position.y);
          engine.box2d.b2Body_SetTransform(bodyId, vec, rotation);
        } finally {
          rotation.delete();
        }
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

        const position = engine.box2d.b2Body_GetPosition(bodyId);
        const wasmRotation = engine.box2d.b2MakeRot(rotation.angle);
        try {
          engine.box2d.b2Body_SetTransform(bodyId, position, wasmRotation);
        } finally {
          wasmRotation.delete();
          position.delete();
        }
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

          const vec = scr_b2Vec2[0];
          vec.Set(velocity.x, velocity.y);
          engine.box2d.b2Body_SetLinearVelocity(bodyId, vec);
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

          engine.box2d.b2Body_SetAngularVelocity(bodyId, velocity.value);
        }
      )
      .add(PhysicsSystemTag);
  }
}
