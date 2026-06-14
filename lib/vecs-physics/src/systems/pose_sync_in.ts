import { type Entity, type World } from "@vworlds/vecs";

import { AngularVelocity, Body, LinearVelocity, Position, Rotation } from "../components/body.js";
import { scr_b2Vec2 } from "../adapter/runtime.js";
import { PhysicsSystemTag, type PhysicsState } from "../adapter/state.js";

export function installPoseSyncIn(world: World, state: PhysicsState, phase: Entity): void {
  const system = world.system("PhysicsPoseSyncIn").with(Body).phase(phase);
  system.entity.add(PhysicsSystemTag);

  system.ignoreSource([PhysicsSystemTag]);

  const positionSystem = world
    .system("PhysicsPoseSyncIn:Position")
    .with(Body, Position)
    .phase(phase)
    .ignoreSource([PhysicsSystemTag])
    .update(Position, [Body], (entity, position, [body]) => {
      const bodyId = body?._bodyId;
      if (bodyId === undefined) {
        return;
      }

      const rotation = state.box2d.b2Body_GetRotation(bodyId);
      try {
        const vec = scr_b2Vec2[0];
        vec.Set(position.x, position.y);
        state.box2d.b2Body_SetTransform(bodyId, vec, rotation);
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
    .update(Rotation, [Body], (entity, rotation, [body]) => {
      const bodyId = body?._bodyId;
      if (bodyId === undefined) {
        return;
      }

      const position = state.box2d.b2Body_GetPosition(bodyId);
      const wasmRotation = state.box2d.b2MakeRot(rotation.angle);
      try {
        state.box2d.b2Body_SetTransform(bodyId, position, wasmRotation);
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
    .update(LinearVelocity, [Body], (entity, velocity, [body]) => {
      const bodyId = body?._bodyId;
      if (bodyId === undefined) {
        return;
      }

      const vec = scr_b2Vec2[0];
      vec.Set(velocity.x, velocity.y);
      state.box2d.b2Body_SetLinearVelocity(bodyId, vec);
    });
  linearVelocitySystem.entity.add(PhysicsSystemTag);

  const angularVelocitySystem = world
    .system("PhysicsPoseSyncIn:AngularVelocity")
    .with(Body, AngularVelocity)
    .phase(phase)
    .ignoreSource([PhysicsSystemTag])
    .update(AngularVelocity, [Body], (entity, velocity, [body]) => {
      const bodyId = body?._bodyId;
      if (bodyId === undefined) {
        return;
      }

      state.box2d.b2Body_SetAngularVelocity(bodyId, velocity.value);
    });
  angularVelocitySystem.entity.add(PhysicsSystemTag);
}
