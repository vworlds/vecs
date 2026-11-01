import { Module, type Entity } from "@vworlds/vecs";

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

/** Export moved bodies once per post-step tick and write only changed Dynamic-body components.
 * The pinned fast path refreshes heap views; optional components and modification routing remain
 * unchanged, and no per-body Box2D handle, marshalling object or typed-array view is created.
 * Publishes the reused `PhysicsQueries.poseChanges()` view, including admitted application poses
 * and final sleep events even when their pose did not change. */
export class BodyPoseOutModule extends Module {
  public init(): void {
    const world = this.world;
    world.module(PhysicsCoreModule);

    const engine = getPhysicsEngine(world);
    const fast = engine.fast;
    const move = fast.layout.move;
    const offsets: MoveOffsets = {
      bodyIndex: move.bodyIndex >> 2,
      x: move.x >> 2,
      y: move.y >> 2,
      angle: move.angle >> 2,
      vx: move.vx >> 2,
      vy: move.vy >> 2,
      w: move.w >> 2,
    };
    const flags = fast.layout.constants.exportVelocity;
    // Numeric ids avoid resolving component classes on every moved body.
    const ids: ComponentIds = {
      body: world.entity(Body).eid,
      position: world.entity(Position).eid,
      rotation: world.entity(Rotation).eid,
      linearVelocity: world.entity(LinearVelocity).eid,
      angularVelocity: world.entity(AngularVelocity).eid,
    };
    world
      .system("PhysicsPoseSyncOut")
      .phase(engine.phases.postStep)
      .run(() => {
        // Export after preceding postStep systems; exportMoves also refreshes memory views.
        const exporter = engine.moveExporter;
        const bodyEntities = engine.bodyEntities;
        const changes = engine.poseChanges;
        const pending = engine.pendingPoseChanges;
        const count = exporter.exportMoves(engine.world, flags);
        const required = pending.length + count;
        let eids = changes.eids;
        if (required > eids.length) {
          let capacity = eids.length;
          while (capacity < required) {
            capacity *= 2;
          }
          eids = changes.eids = new Int32Array(capacity);
        }
        let changedCount = 0;
        // Application writes are rare. Revalidate here: an intervening system may have removed
        // Body or destroyed the entity since pose-in admitted it. No filter is added per move.
        for (const entity of pending) {
          if (!entity.destroyed && entity.has(ids.body)) {
            eids[changedCount++] = entity.eid;
          }
        }
        pending.length = 0;
        const i32 = fast.i32;
        const f32 = fast.f32;
        const stride = exporter.stride;
        let base = exporter.base;
        for (let i = 0; i < count; i++, base += stride) {
          // A postStep system may destroy an entity after Box2D produced this event.
          // Keep the reverse slot until the reaper frees the body; lookup is O(1).
          const entity = bodyEntities[i32[base + offsets.bodyIndex]!];
          if (entity === undefined || entity.destroyed) {
            continue;
          }
          const body = entity.get(ids.body) as Body | undefined;
          if (body === undefined || body.type !== BodyType.Dynamic) {
            continue;
          }
          eids[changedCount++] = entity.eid;
          writePose(entity, f32, base, offsets, ids);
        }
        changes.count = changedCount;
      })
      .add(PhysicsSystemTag);
  }
}

/** Component entity ids resolved once when pose-out is installed. */
interface ComponentIds {
  body: number;
  position: number;
  rotation: number;
  linearVelocity: number;
  angularVelocity: number;
}

/** Word offsets of the b2xMove fields pose-out reads, from the generated layout. */
interface MoveOffsets {
  bodyIndex: number;
  x: number;
  y: number;
  angle: number;
  vx: number;
  vy: number;
  w: number;
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
 * Values come from the move record exported after preceding postStep systems. The angle uses
 * Box2D's b2Rot_GetAngle, preserving its exact bits, and velocities use the same Box2D getters
 * in wasm. Reading these f32 records creates no embind handle or allocation.
 */
function writePose(
  entity: Entity,
  f32: Float32Array,
  base: number,
  offsets: MoveOffsets,
  ids: ComponentIds
): void {
  const x = f32[base + offsets.x]!;
  const y = f32[base + offsets.y]!;
  const position = entity.get(ids.position) as Position | undefined;
  if (position === undefined || position.x !== x || position.y !== y) {
    entity.set(Position, { x, y });
  }

  const rotation = entity.get(ids.rotation) as Rotation | undefined;
  if (rotation !== undefined) {
    const angle = f32[base + offsets.angle]!;
    if (rotation.angle !== angle) {
      entity.set(Rotation, { angle });
    }
  }

  const linearVelocity = entity.get(ids.linearVelocity) as LinearVelocity | undefined;
  if (linearVelocity !== undefined) {
    const vx = f32[base + offsets.vx]!;
    const vy = f32[base + offsets.vy]!;
    if (linearVelocity.x !== vx || linearVelocity.y !== vy) {
      entity.set(LinearVelocity, { x: vx, y: vy });
    }
  }

  const angularVelocity = entity.get(ids.angularVelocity) as AngularVelocity | undefined;
  if (angularVelocity !== undefined) {
    const value = f32[base + offsets.w]!;
    if (angularVelocity.value !== value) {
      entity.set(AngularVelocity, { value });
    }
  }
}
