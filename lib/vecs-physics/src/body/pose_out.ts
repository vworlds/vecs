import { Module, type Entity } from "@vworlds/vecs";

import {
  getPhysicsEngine,
  PhysicsSystemTag,
  type b2BodyId,
  type PhysicsEngine,
} from "../adapter/engine.js";
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
          const moveCount = bodyEvents.moveCount;
          for (let i = 0; i < moveCount; i++) {
            const move = bodyEvents.GetMoveEvent(i);
            try {
              const bodyId = move.bodyId;
              const entityId = engine.entityByBodyIndex.get(bodyId.index1);
              if (entityId === undefined) {
                continue;
              }

              // A postStep system may destroy an entity after Box2D produced this event.
              // Keep the reverse slot until the reaper frees the body; lookup is O(1).
              const entity = world.getEntity(entityId);
              if (entity === undefined || entity.destroyed) {
                continue;
              }
              const body = entity.get(Body);
              if (body?.type !== BodyType.Dynamic) {
                continue;
              }

              writePose(engine, entity, bodyId);
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

/**
 * Copy one moved body's Box2D pose into its pose components, writing only the components whose
 * values changed.
 *
 * Box2D reports every awake body on every step and returns bit-identical values for a body that
 * did not move or turn, while every `entity.set` counts as a modification: it fires `set` hooks,
 * routes `update` events to every system watching the component and, for a networked component,
 * is replicated to every client that sees the entity. Writing unchanged values would make a body
 * flying straight re-send its constant `Rotation` every step and an awake body at rest re-send its
 * whole pose. So each component the body carries is compared with the new values field by field
 * using exact equality (no epsilon) and `set` runs only when at least one field differs.
 *
 * `Position` is always maintained and is created by the first write. `Rotation`, `LinearVelocity`
 * and `AngularVelocity` are maintained only on bodies that already carry them, so a body never
 * gains a component it did not ask for.
 *
 * Inside a system `entity.get` returns the committed state, because writes are deferred until the
 * system finishes. That state includes every write earlier systems made this frame, a user
 * teleport for one, and is exactly what the new values must be compared with. The check allocates
 * nothing per body: the new values are read into locals and compared directly, and the `{ x, y }`
 * literals exist only on the write path.
 *
 * Read position and optional rotation directly from the body: two owned values instead of the
 * event's three borrowed `transform`/`p`/`q` handles. Every by-value result is released in `finally`.
 * Rotation still uses Box2D's `GetAngle`, whose result is not bit-identical to `Math.atan2`.
 * Velocity reads remain conditional on the corresponding component being present; dead reckoning
 * reads body motion separately and does not require adding velocity components for pose-out.
 */
function writePose(engine: PhysicsEngine, entity: Entity, bodyId: b2BodyId): void {
  const p = engine.box2d.b2Body_GetPosition(bodyId);
  try {
    const x = p.x;
    const y = p.y;
    const position = entity.get(Position);
    if (position === undefined || position.x !== x || position.y !== y) {
      entity.set(Position, { x, y });
    }
  } finally {
    p.delete();
  }

  const rotation = entity.get(Rotation);
  if (rotation !== undefined) {
    const q = engine.box2d.b2Body_GetRotation(bodyId);
    try {
      const angle = q.GetAngle();
      if (rotation.angle !== angle) {
        entity.set(Rotation, { angle });
      }
    } finally {
      q.delete();
    }
  }

  const linearVelocity = entity.get(LinearVelocity);
  if (linearVelocity !== undefined) {
    const linear = engine.box2d.b2Body_GetLinearVelocity(bodyId);
    try {
      const vx = linear.x;
      const vy = linear.y;
      if (linearVelocity.x !== vx || linearVelocity.y !== vy) {
        entity.set(LinearVelocity, { x: vx, y: vy });
      }
    } finally {
      linear.delete();
    }
  }

  const angularVelocity = entity.get(AngularVelocity);
  if (angularVelocity !== undefined) {
    const value = engine.box2d.b2Body_GetAngularVelocity(bodyId);
    if (angularVelocity.value !== value) {
      entity.set(AngularVelocity, { value });
    }
  }
}
