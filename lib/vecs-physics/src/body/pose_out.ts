import { Module } from "@vworlds/vecs";

import { getPhysicsEngine, PhysicsSystemTag } from "../adapter/engine.js";
import {
  AngularVelocity,
  Body,
  BodyType,
  LinearVelocity,
  Position,
  Rotation,
} from "./components.js";
import { PhysicsCoreModule } from "../core/module.js";

export class BodyPoseOutModule extends Module {
  public init(): void {
    const world = this.world;
    world.module(PhysicsCoreModule);

    const engine = getPhysicsEngine(world);
    world
      .system("PhysicsPoseSyncOut")
      .phase(engine.phases.postStep)
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
      })
      .add(PhysicsSystemTag);
  }
}
