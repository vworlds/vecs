import { type Entity, type World } from "@vworlds/vecs";

import {
  AngularVelocity,
  Body,
  BodyType,
  LinearVelocity,
  Position,
  Rotation,
} from "../components/body.js";
import { PhysicsSystemTag, type PhysicsEngine } from "../adapter/engine.js";

export function installPoseSyncOut(world: World, engine: PhysicsEngine, phase: Entity): void {
  const system = world
    .system("PhysicsPoseSyncOut")
    .phase(phase)
    .run(() => {
      const bodyEvents = engine.box2d.b2World_GetBodyEvents(engine.worldId);
      try {
        for (let i = 0; i < bodyEvents.moveCount; i++) {
          const move = bodyEvents.GetMoveEvent(i);
          try {
            const entityId = engine.entityByBodyIndex.get(move.bodyId.index1);
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
              const linear = engine.box2d.b2Body_GetLinearVelocity(move.bodyId);
              try {
                entity.set(LinearVelocity, { x: linear.x, y: linear.y });
              } finally {
                linear.delete();
              }
            }
            if (entity.get(AngularVelocity) !== undefined) {
              entity.set(AngularVelocity, {
                value: engine.box2d.b2Body_GetAngularVelocity(move.bodyId),
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
  system.entity.add(PhysicsSystemTag);
}
