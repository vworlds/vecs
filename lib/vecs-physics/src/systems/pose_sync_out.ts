import { type IPhase, type System, type World } from "@vworlds/vecs";

import {
  AngularVelocity,
  Body,
  BodyType,
  LinearVelocity,
  Position,
  Rotation,
} from "../components/body.js";
import { type b2BodyId, type PhysicsState } from "../adapter/state.js";

export function installPoseSyncOut(world: World, state: PhysicsState, phase: IPhase): System {
  return world
    .system("PhysicsPoseSyncOut")
    .phase(phase)
    .run(() => {
      const bodyEvents = state.box2d.b2World_GetBodyEvents(state.worldId);
      try {
        for (let i = 0; i < bodyEvents.moveCount; i++) {
          const move = bodyEvents.GetMoveEvent(i);
          try {
            const entityId = resolveBodyEntityId(state, move.bodyId);
            if (entityId === undefined) {
              continue;
            }

            const entity = world.entity(entityId);
            const body = entity.get(Body);
            if (body?.type !== BodyType.Dynamic) {
              continue;
            }

            entity.set(Position, { x: move.transform.p.x, y: move.transform.p.y });
            if (entity.get(Rotation) !== undefined) {
              entity.set(Rotation, { angle: move.transform.q.GetAngle() });
            }
            if (entity.get(LinearVelocity) !== undefined) {
              const linear = state.box2d.b2Body_GetLinearVelocity(move.bodyId);
              try {
                entity.set(LinearVelocity, { x: linear.x, y: linear.y });
              } finally {
                linear.delete();
              }
            }
            if (entity.get(AngularVelocity) !== undefined) {
              entity.set(AngularVelocity, {
                value: state.box2d.b2Body_GetAngularVelocity(move.bodyId),
              });
            }
          } finally {
            move.delete();
          }
        }
      } finally {
        bodyEvents.delete();
      }
    });
}

function resolveBodyEntityId(state: PhysicsState, bodyId: b2BodyId): number | undefined {
  const direct = state.entityByBody.get(bodyId);
  if (direct !== undefined) {
    return direct;
  }

  for (const [knownBodyId, entityId] of state.entityByBody) {
    if (
      knownBodyId.index1 === bodyId.index1 &&
      knownBodyId.world0 === bodyId.world0 &&
      knownBodyId.generation === bodyId.generation
    ) {
      return entityId;
    }
  }
  return undefined;
}
