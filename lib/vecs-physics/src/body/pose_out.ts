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
 * Embind handle rules, which the compare must keep: `move.transform`, `.p` and `.q` are views into
 * the move event's own memory (same address on every read, `transform.p` even shares the
 * transform's), not copies. Read each once and leave them alone: calling `delete()` on a view runs
 * the C++ destructor on an interior pointer of the event, which corrupts the wasm heap. The event's
 * single `move.delete()` releases the memory. The linear velocity is a by-value return, a heap copy
 * this function owns and deletes.
 */
function writePose(
  engine: PhysicsEngine,
  entity: Entity,
  transform: b2Transform,
  bodyId: b2BodyId
): void {
  const p = transform.p;
  const x = p.x;
  const y = p.y;
  const position = entity.get(Position);
  if (position === undefined || position.x !== x || position.y !== y) {
    entity.set(Position, { x, y });
  }

  const rotation = entity.get(Rotation);
  if (rotation !== undefined) {
    const angle = transform.q.GetAngle();
    if (rotation.angle !== angle) {
      entity.set(Rotation, { angle });
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
