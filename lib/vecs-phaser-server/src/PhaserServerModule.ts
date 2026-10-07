import { Exclusive, Module, POST_UPDATE, Traversable } from "@vworlds/vecs";
import {
  DrawBy,
  DrawIn,
  phaserRenderableComponents,
  Position as RenderPosition,
  Rotation as RenderRotation,
} from "@vworlds/vecs-phaser";
import { Position as PhysicsPosition, Rotation as PhysicsRotation } from "@vworlds/vecs-physics";

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
  }
}
