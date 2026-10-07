import { Module, ON_STORE } from "@vworlds/vecs";
import { DrawBy, InheritRotation, Offset, Position, Rotation } from "@vworlds/vecs-phaser";

/**
 * Computed parenting: derives a `DrawBy` child's pose from its parent's
 * interpolated pose, when the parent is a renderable (no `Container`). The
 * child has `DrawBy` (and auto-added `Position`) — the `Position` is
 * client-local (never networked) and overwritten each frame.
 *
 * One cascade-ordered system, `phaser.resolve.offset`, resolves every child,
 * so a chain of children resolves parent-first in a single pass, with no frame
 * of lag, whatever mix of tagged and untagged children it holds. `Offset` is
 * optional; if absent, the offset defaults to (0, 0).
 *
 * - **Untagged child:** `Position` is the parent's `Position` plus `Offset`,
 *   added as is. The parent's rotation does not turn the offset, and the
 *   child's own `Rotation`, if any, is never touched.
 * - **Child tagged with `InheritRotation`:** it lives in the parent's local
 *   frame. With `a` the parent's `Rotation.angle` (`0` when the parent has no
 *   `Rotation`; for a parent that is itself tagged, that is its derived world
 *   angle), the child's `Position` is the parent's `Position` plus `Offset`
 *   rotated by `a`, and its client-local `Rotation` is `a` plus the tag's
 *   `angle`. Angles are in component space (radians, counter-clockwise
 *   positive, +y up); `CoordSpace` flips them for Phaser at render time.
 *
 * Values are written in place and the component is marked modified only when
 * a value actually changed, so the pass allocates nothing per entity and a
 * child that did not move costs the sync systems nothing. Trig runs only for
 * tagged children.
 *
 * The callback injects only what every child uses: the `Offset`, the child's
 * `Position`, the parent's `Position` and the `InheritRotation` tag it branches
 * on. The two `Rotation`s, and the parent entity they hang off, are read with
 * `get` and `target` in the tagged branch alone, so an untagged child, the
 * common case, pays no lookup for them.
 *
 * Runs in `ON_STORE` before `phaser.sync.position` and `phaser.sync.rotation`
 * so the computed pose is applied to the GameObject in the same frame.
 */
export class OffsetResolveModule extends Module {
  public init(): void {
    const world = this.world;
    // The tagged branch reads by component id, which skips the class lookup `get(Rotation)` does.
    const drawById = world.component(DrawBy).eid;
    const rotationId = world.component(Rotation).eid;

    world
      .system("phaser.resolve.offset")
      .with(DrawBy, Position)
      .cascade(DrawBy)
      .phase(ON_STORE)
      .each(
        [Offset, InheritRotation, Position, { target: [DrawBy, [Position]] }],
        (entity, [offset, tag, pos, parentPos]) => {
          if (!parentPos) {
            return;
          }
          const ox = offset?.x ?? 0;
          const oy = offset?.y ?? 0;
          let x: number;
          let y: number;
          if (tag === undefined) {
            x = parentPos.x + ox;
            y = parentPos.y + oy;
          } else {
            const parentRot = entity.target(drawById)?.get(rotationId) as Rotation | undefined;
            const angle = parentRot?.angle ?? 0;
            const cos = Math.cos(angle);
            const sin = Math.sin(angle);
            x = parentPos.x + ox * cos - oy * sin;
            y = parentPos.y + ox * sin + oy * cos;
            // A tagged child normally has a Rotation (the tag adds one); without it there is
            // nothing to carry the derived angle, but the offset is still rotated.
            const rot = entity.get(rotationId) as Rotation | undefined;
            if (rot !== undefined) {
              const derived = angle + tag.angle;
              if (rot.angle !== derived) {
                rot.angle = derived;
                entity.modified(Rotation);
              }
            }
          }
          if (pos.x !== x || pos.y !== y) {
            pos.x = x;
            pos.y = y;
            entity.modified(Position);
          }
        }
      );
  }
}
