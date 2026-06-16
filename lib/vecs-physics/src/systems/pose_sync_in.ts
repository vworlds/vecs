import { type Entity, type World } from "@vworlds/vecs";

import { AngularVelocity, Body, LinearVelocity, Position, Rotation } from "../components/body.js";
import { scr_b2Vec2 } from "../adapter/runtime.js";
import { PhysicsSystemTag, type PhysicsEngine } from "../adapter/engine.js";

export function installPoseSyncIn(world: World, engine: PhysicsEngine, phase: Entity): void {
  const system = world.system("PhysicsPoseSyncIn").with(Body).phase(phase);
  system.entity.add(PhysicsSystemTag);

  system.ignoreSource([PhysicsSystemTag]);

  const positionSystem = world
    .system("PhysicsPoseSyncIn:Position")
    .with(Body, Position)
    .phase(phase)
    .ignoreSource([PhysicsSystemTag])
    .update({ component: Position, inject: [Body] }, (entity, position, [body]) => {
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
    });
  positionSystem.entity.add(PhysicsSystemTag);

  const rotationSystem = world
    .system("PhysicsPoseSyncIn:Rotation")
    .with(Body, Rotation)
    .phase(phase)
    .ignoreSource([PhysicsSystemTag])
    .update({ component: Rotation, inject: [Body] }, (entity, rotation, [body]) => {
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
    });
  rotationSystem.entity.add(PhysicsSystemTag);

  const linearVelocitySystem = world
    .system("PhysicsPoseSyncIn:LinearVelocity")
    .with(Body, LinearVelocity)
    .phase(phase)
    .ignoreSource([PhysicsSystemTag])
    .update({ component: LinearVelocity, inject: [Body] }, (entity, velocity, [body]) => {
      const bodyId = body?._bodyId;
      if (bodyId === undefined) {
        return;
      }

      const vec = scr_b2Vec2[0];
      vec.Set(velocity.x, velocity.y);
      engine.box2d.b2Body_SetLinearVelocity(bodyId, vec);
    });
  linearVelocitySystem.entity.add(PhysicsSystemTag);

  const angularVelocitySystem = world
    .system("PhysicsPoseSyncIn:AngularVelocity")
    .with(Body, AngularVelocity)
    .phase(phase)
    .ignoreSource([PhysicsSystemTag])
    .update({ component: AngularVelocity, inject: [Body] }, (entity, velocity, [body]) => {
      const bodyId = body?._bodyId;
      if (bodyId === undefined) {
        return;
      }

      engine.box2d.b2Body_SetAngularVelocity(bodyId, velocity.value);
    });
  angularVelocitySystem.entity.add(PhysicsSystemTag);
}
