import { wireType } from "@vworlds/vecs-wire";

export { ChildOf } from "@vworlds/vecs";

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
 * Marker component: the entity renders as a Phaser {@link Phaser.GameObjects.Container},
 * not a renderable shape. Exclusive with all renderable components (`Arc`, `Image`, …).
 *
 * Add this to entities that have children via {@link ChildOf} so those children can be
 * reparented into the Container for native scene-graph transform composition. The
 * entity's own visual (if any) moves to a separate `ChildOf` sub-entity.
 *
 * Carries a single placeholder wire field so the wire codec can serialise its
 * presence/absence. The value is always 0 and carries no semantic meaning.
 */
export class Container {
  @wireType("u8")
  public placeholder = 0;
}

/**
 * Local position offset relative to the parent entity (the {@link ChildOf} target),
 * expressed in the parent's local (rotated) frame in meters.
 *
 * On a child of a `Container` parent, the offset is applied as a Phaser local position
 * inside the container — Phaser composes the transform natively (case B). On a child
 * of a renderable parent, a client-side system computes the world position from the
 * parent's interpolated `Position` + this offset (case C).
 */
export class Offset {
  @wireType("f32")
  public x = 0;

  @wireType("f32")
  public y = 0;
}
