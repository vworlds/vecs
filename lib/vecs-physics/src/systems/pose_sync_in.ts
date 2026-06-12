import { type Entity, type System, type World } from "@vworlds/vecs";

import { AngularVelocity, Body, LinearVelocity, Position, Rotation } from "../components/body.js";
import { PhysicsSystemTag, type PhysicsState } from "../adapter/state.js";

export function installPoseSyncIn(world: World, state: PhysicsState, phase: Entity): System {
  const system = world.system("PhysicsPoseSyncIn").with(Body).phase(phase);

  system.ignoreSource([PhysicsSystemTag]);

  world
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
        state.scratchVec2.Set(position.x, position.y);
        state.box2d.b2Body_SetTransform(bodyId, state.scratchVec2, rotation);
      } finally {
        rotation.delete();
      }
    });

  world
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

  world
    .system("PhysicsPoseSyncIn:LinearVelocity")
    .with(Body, LinearVelocity)
    .phase(phase)
    .ignoreSource([PhysicsSystemTag])
    .update(LinearVelocity, [Body], (entity, velocity, [body]) => {
      const bodyId = body?._bodyId;
      if (bodyId === undefined) {
        return;
      }

      state.scratchVec2.Set(velocity.x, velocity.y);
      state.box2d.b2Body_SetLinearVelocity(bodyId, state.scratchVec2);
    });

  world
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

  return system;
}
