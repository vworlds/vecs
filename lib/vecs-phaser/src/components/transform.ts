import { wireType } from "@vworlds/vecs-wire";

/** Entity position in meters, +y up (math convention). */
export class Position {
  @wireType("f32")
  public x = 0;

  @wireType("f32")
  public y = 0;
}

/** Entity orientation in radians, counter-clockwise positive. */
export class Rotation {
  @wireType("f32")
  public angle = 0;
}

/** Uniform scale multiplier (unitless). */
export class Scale {
  @wireType("f32")
  public x = 1;

  @wireType("f32")
  public y = 1;
}

/** Opacity in the range 0..1. */
export class Alpha {
  @wireType("f32")
  public value = 1;
}

/** Render order (unitless integer; higher values draw on top). */
export class Depth {
  @wireType("i32")
  public value = 0;
}

/**
 * Local position offset relative to the parent entity (the `ChildOf` target),
 * expressed in the parent's local (rotated) frame in meters.
 *
 * Parent-relative rendering has two modes, depending on whether the parent
 * renders as a `Container` or a direct renderable (shape/image/text):
 *
 * - **Native parenting** — child has `Offset` but no `Position`, parent has
 *   `Container`. The child's Phaser GameObject is added to the parent's
 *   Container. Phaser composes transforms natively: moving/rotating the
 *   Container moves/rotates all children. `Offset` sets the child's local
 *   position inside the container. Zero per-frame JS.
 *
 * - **Computed parenting** — child has both `Offset` and `Position`, parent
 *   is a renderable (no `Container`). A client-side system derives the
 *   child's world `Position` from the parent's interpolated `Position` plus
 *   `Offset` rotated by the parent's `Rotation`. The `Position` is
 *   client-local (never networked).
 *
 * Distinguish the two by the presence of `Position` on the child: no
 * `Position` = native (inside a Container), `Position` = computed.
 */
export class Offset {
  @wireType("f32")
  public x = 0;

  @wireType("f32")
  public y = 0;
}
