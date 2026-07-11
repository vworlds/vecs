import { Module, ON_STORE } from "@vworlds/vecs";
import { DrawBy, Offset, Position } from "@vworlds/vecs-phaser";

/**
 * Computed parenting: derives a child's world `Position` from the parent's
 * interpolated `Position` + `Offset`, when the parent is a renderable
 * (no `Container`). The child has `DrawBy` (and auto-added `Position`) — the
 * `Position` is client-local (never networked) and overwritten each frame.
 *
 * The offset is added directly to the parent's position (no parent rotation
 * applied). Parent rotation will be conditioned by a tag component in a
 * future change.
 *
 * `Offset` is optional on the child; if absent, the offset defaults to (0, 0)
 * and the child sits at the parent's position.
 *
 * Runs in `ON_STORE` before `phaser.sync.position` so the computed `Position`
 * is applied to the GameObject in the same frame.
 */
export class OffsetResolveModule extends Module {
  public init(): void {
    const world = this.world;

    world
      .system("phaser.resolve.offset")
      .with(DrawBy, Position)
      .cascade(DrawBy)
      .phase(ON_STORE)
      .each(
        [Offset, Position, { target: [DrawBy, [Position]] }],
        (entity, [injectedOffset, pos, parentPos]) => {
          if (!parentPos) {
            return;
          }
          const offset = (injectedOffset as Offset | undefined) ?? { x: 0, y: 0 };
          const x = parentPos.x + offset.x;
          const y = parentPos.y + offset.y;
          if (pos.x !== x || pos.y !== y) {
            pos.x = x;
            pos.y = y;
            entity.modified(Position);
          }
        }
      );
  }
}
