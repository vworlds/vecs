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
 * by field with exact equality. Every `set` counts as a modification: it fires `set` hooks, routes
 * `update` events and, for these networked components, is replicated to every client that sees the
 * entity. Writing equal values would make a body that does not turn re-send its constant `Rotation`
 * every frame. So a physics component that is modified without changing, or an entity that enters
 * with a render pose that already holds the physics pose, leaves the render pose untouched.
 */
export class PhaserServerModule extends Module<undefined> {
  public init(): void {
    const world = this.world;

    world.component(DrawIn).add(Exclusive);
    world.component(DrawBy).add(Exclusive).add(Traversable);
    world.setExclusiveComponents(...phaserRenderableComponents);

    // Both sync systems compare before they write. A `set` always marks the render component
    // modified, which fires its hooks, routes updates and replicates it, even when nothing changed.
    // They never create it: the query guarantees it exists, and a missing one is skipped, not set.
    world
      .system("phaser.sync.position")
      .with(PhysicsPosition, RenderPosition)
      .phase(POST_UPDATE)
      .update({ watch: PhysicsPosition, onEnter: true }, (e, p) => {
        const render = e.get(RenderPosition);
        if (render !== undefined && (render.x !== p.x || render.y !== p.y)) {
          e.set(RenderPosition, { x: p.x, y: p.y });
        }
      });

    world
      .system("phaser.sync.rotation")
      .with(PhysicsRotation, RenderRotation)
      .phase(POST_UPDATE)
      .update({ watch: PhysicsRotation, onEnter: true }, (e, r) => {
        const render = e.get(RenderRotation);
        if (render !== undefined && render.angle !== r.angle) {
          e.set(RenderRotation, { angle: r.angle });
        }
      });
  }
}
