import { Module, type Entity } from "@vworlds/vecs";

import {
  getPhysicsEngine,
  PhysicsSystemTag,
  type b2BodyId,
  type PhysicsEngine,
} from "../adapter/engine.js";
import { type Box2DModule } from "../adapter/runtime.js";
import {
  AngularVelocity,
  Body,
  BodyType,
  LinearVelocity,
  Position,
  Rotation,
} from "./components.js";
import { PhysicsCoreModule } from "../core/module.js";

type b2Transform = ReturnType<Box2DModule["b2World_GetBodyEvents"]>["GetMoveEvent"] extends (
  ...args: never[]
) => infer Move
  ? Move extends { transform: infer T }
    ? T
    : never
  : never;

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
              const bodyId = move.bodyId;
              const entityId = engine.entityByBodyIndex.get(bodyId.index1);
              if (entityId === undefined) {
                continue;
              }

              const entity = world.entity(entityId);
              const body = entity.get(Body);
              if (body?.type !== BodyType.Dynamic) {
                continue;
              }

              writePose(engine, entity, move.transform, bodyId);
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

// `move.transform`, `.p` and `.q` are Embind views into the move event's own memory (same address
// on every read, `transform.p` even shares the transform's), not copies. Read each once and leave
// them alone: calling `delete()` on a view runs the C++ destructor on an interior pointer of the
// event, which corrupts the wasm heap. The event's single `move.delete()` releases the memory.
function writePose(
  engine: PhysicsEngine,
  entity: Entity,
  transform: b2Transform,
  bodyId: b2BodyId
): void {
  const p = transform.p;
  entity.set(Position, { x: p.x, y: p.y });

  if (entity.get(Rotation) !== undefined) {
    entity.set(Rotation, { angle: transform.q.GetAngle() });
  }

  if (entity.get(LinearVelocity) !== undefined) {
    // By-value return: a heap copy that this code owns.
    const linear = engine.box2d.b2Body_GetLinearVelocity(bodyId);
    try {
      entity.set(LinearVelocity, { x: linear.x, y: linear.y });
    } finally {
      linear.delete();
    }
  }
  if (entity.get(AngularVelocity) !== undefined) {
    entity.set(AngularVelocity, { value: engine.box2d.b2Body_GetAngularVelocity(bodyId) });
  }
}
