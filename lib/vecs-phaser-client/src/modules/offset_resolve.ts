import { Module, ON_STORE } from "@vworlds/vecs";
import { DrawBy, Offset, Position, Rotation } from "@vworlds/vecs-phaser";

/**
 * Computed parenting: derives a child's world `Position` from the parent's
 * interpolated `Position` + rotated `Offset`, when the parent is a renderable
 * (no `Container`). The child has `DrawBy` (and auto-added `Position`) — the
 * `Position` is client-local (never networked) and overwritten each frame.
 *
 * The offset vector is rotated by the parent's `Rotation` before being added
 * to the parent's position, so children swing around a rotating parent.
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
        [Offset, { target: [DrawBy, [Position, Rotation]] }],
        (entity, [injectedOffset, parentPos, parentRot]) => {
          if (!parentPos) {
            return;
          }
          const offset = (injectedOffset as Offset | undefined) ?? { x: 0, y: 0 };
          const pos = parentPos as Position;
          const rot = parentRot as Rotation | undefined;
          const angle = rot?.angle ?? 0;
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);
          entity.set(Position, {
            x: pos.x + offset.x * cos - offset.y * sin,
            y: pos.y + offset.x * sin + offset.y * cos,
          });
        }
      );
  }
}
