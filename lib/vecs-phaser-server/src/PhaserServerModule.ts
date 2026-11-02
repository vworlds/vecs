import {
  Exclusive,
  insertPhaseAfter,
  Module,
  ON_STORE,
  Phase,
  POST_UPDATE,
  Traversable,
  type ComponentClass,
  type Entity,
  type World,
} from "@vworlds/vecs";
import {
  DrawBy,
  DrawIn,
  phaserRenderableComponents,
  Position as RenderPosition,
  Rotation as RenderRotation,
} from "@vworlds/vecs-phaser";
import { Position as PhysicsPosition, Rotation as PhysicsRotation } from "@vworlds/vecs-physics";

/**
 * Name of the phase in which the pose guards run: right after `ON_STORE`, so after every user
 * phase, and before `ServerWorld`'s own store phase, which records and sends the frame.
 */
export const POSE_GUARD_PHASE = "phaser.PoseGuard";

/**
 * Server-side setup for vecs-backed Phaser worlds, installed with `world.module(PhaserServerModule)`
 * on a `ServerWorld`.
 *
 * It configures the display relationships and renderable exclusivity the way the client does:
 * `DrawIn` and `DrawBy` are single-target (`Exclusive`), only `DrawBy` is `Traversable`, and the
 * renderable components are mutually exclusive, so an entity has one shape.
 *
 * It also installs two reactive `POST_UPDATE` systems that copy the vecs-physics pose into the
 * networked render pose, after the physics phases have written it:
 *
 * - `phaser.sync.position` copies physics `Position` into render `Position`.
 * - `phaser.sync.rotation` copies physics `Rotation` into render `Rotation`.
 *
 * Each runs when the physics component is modified and once when an entity enters it, and only for
 * entities that already carry both the physics and the render component. It never creates the
 * render component; the entity's owner decides whether it exists.
 *
 * A system writes the render component only when its value differs from the physics value, field
 * by field with exact equality. Every modification counts: it fires `set` hooks, routes `update`
 * events and, for these networked components, is replicated to every client that sees the entity.
 * Writing equal values would make a body that does not turn re-send its constant `Rotation` every
 * frame. So a physics component that is modified without changing, or an entity that enters with a
 * render pose that already holds the physics pose, leaves the render pose untouched.
 *
 * The render component is injected instead of read with `entity.get`. The system's `.with(...)`
 * guarantees it is there, so injection hands over the live instance as non-nullable, with no
 * `undefined` to guard, and resolves the component once when the callback is registered instead of
 * on every call.
 *
 * A changed pose is assigned into that instance and announced with `entity.modified(...)`, not
 * written with `entity.set(...)`. The two have the same downstream effects: `set` assigns its props
 * when the queued command is applied and then runs the same notification `modified` queues, so the
 * `set` hooks, the `update` routing and the replication, which `ServerWorld` drives from those
 * `update` events, are identical. In place skips the `{ x, y }` literal and the copy at flush, and a
 * second event for the same entity in one inbox drain finds the first write already applied and
 * writes nothing, where `set` would write and notify again. The deferral `set` adds hides nothing
 * here: the write happens inside this system, no other system runs until the flush that follows
 * it, and the instance that replication and the `update` inboxes hold is the one `set` would have
 * assigned into anyway. An in-place write must always be followed by `modified`, because
 * assignment alone notifies nobody and the hooks, watchers and replication would never see the
 * change.
 *
 * ## The unsynced-pose guard
 *
 * The two sync systems run in `POST_UPDATE`, so an entity that gets its pose after them, in
 * `PRE_STORE`, `ON_STORE`, an RPC handler between ticks or any later phase, enters them only on the
 * next tick, and the frame in flight would carry its render pose at the default (0, 0). A third
 * system, `phaser.guard.pose`, closes that gap: **no render pose reaches the wire before it
 * reflects the physics pose, whatever phase created the entity.**
 *
 * It runs in {@link POSE_GUARD_PHASE}, a phase inserted right after `ON_STORE` (so after every user
 * phase) and before `ServerWorld`'s store phase, which records and sends the frame. It drains a
 * worklist that the `add` hooks of the physics and the render pose fill when an entity holds both
 * halves of a pair, and copies the physics value into a render pose that differs, change-only and
 * announced with `modified`, exactly as the sync systems do. An entity that `POST_UPDATE` already
 * synced costs one comparison. A frame with nothing to drain costs an empty check; modifying a
 * pose adds no work, and the sync systems are untouched.
 *
 * The guard covers an entity created or completed late, not a pose that game code writes late: a
 * physics pose changed in `ON_STORE` on an entity that was already synced reaches the render pose
 * on the next tick, as before.
 */
export class PhaserServerModule extends Module<undefined> {
  public init(): void {
    const world = this.world;

    world.component(DrawIn).add(Exclusive);
    world.component(DrawBy).add(Exclusive).add(Traversable);
    world.setExclusiveComponents(...phaserRenderableComponents);

    // Both sync systems inject the render component, which `.with(...)` guarantees, and compare it
    // with the physics value before they write: a modification fires its hooks, routes updates and
    // replicates the component even when nothing changed. A changed pose is assigned in place and
    // announced with `modified`, which has the same effects as `set` (see the class docs). They
    // never create the render component; its owner decides whether it exists.
    world
      .system("phaser.sync.position")
      .with(PhysicsPosition, RenderPosition)
      .phase(POST_UPDATE)
      .update(
        { watch: PhysicsPosition, onEnter: true, inject: [RenderPosition] },
        (e, p, [render]) => {
          if (render.x !== p.x || render.y !== p.y) {
            render.x = p.x;
            render.y = p.y;
            e.modified(RenderPosition);
          }
        }
      );

    world
      .system("phaser.sync.rotation")
      .with(PhysicsRotation, RenderRotation)
      .phase(POST_UPDATE)
      .update(
        { watch: PhysicsRotation, onEnter: true, inject: [RenderRotation] },
        (e, r, [render]) => {
          if (render.angle !== r.angle) {
            render.angle = r.angle;
            e.modified(RenderRotation);
          }
        }
      );

    installPoseGuard(world);
  }
}

// Syncs, before the frame is recorded, every render pose that was created or completed after
// `phaser.sync.*` ran. The hooks queue an entity only when it holds both halves of a pair, which
// the second half to arrive always sees, so an entity without a render pose is never queued.
function installPoseGuard(world: World): void {
  const guardPhase = world.entity(POSE_GUARD_PHASE).add(Phase);
  insertPhaseAfter(guardPhase, world.entity(ON_STORE));

  const unsynced = new Set<Entity>();
  const queueWith = (counterpart: ComponentClass) => (entity: Entity) => {
    if (entity.has(counterpart)) {
      unsynced.add(entity);
    }
  };
  world.component(PhysicsPosition).on("add", queueWith(RenderPosition));
  world.component(RenderPosition).on("add", queueWith(PhysicsPosition));
  world.component(PhysicsRotation).on("add", queueWith(RenderRotation));
  world.component(RenderRotation).on("add", queueWith(PhysicsRotation));

  world
    .system("phaser.guard.pose")
    .phase(guardPhase)
    .run(() => {
      if (unsynced.size === 0) {
        return;
      }
      for (const entity of unsynced) {
        syncRenderPose(entity);
      }
      unsynced.clear();
    });
}

// The sync systems' write, for one entity: copy each physics value into its render pose only when
// it differs, and announce the change. `get` hands out a readonly view, so the in-place write casts
// it; `modified` follows every write, as in the systems.
function syncRenderPose(entity: Entity): void {
  if (entity.destroyed) {
    return;
  }
  const physicsPosition = entity.get(PhysicsPosition);
  const renderPosition = entity.get(RenderPosition) as RenderPosition | undefined;
  if (
    physicsPosition !== undefined &&
    renderPosition !== undefined &&
    (renderPosition.x !== physicsPosition.x || renderPosition.y !== physicsPosition.y)
  ) {
    renderPosition.x = physicsPosition.x;
    renderPosition.y = physicsPosition.y;
    entity.modified(RenderPosition);
  }
  const physicsRotation = entity.get(PhysicsRotation);
  const renderRotation = entity.get(RenderRotation) as RenderRotation | undefined;
  if (
    physicsRotation !== undefined &&
    renderRotation !== undefined &&
    renderRotation.angle !== physicsRotation.angle
  ) {
    renderRotation.angle = physicsRotation.angle;
    entity.modified(RenderRotation);
  }
}
