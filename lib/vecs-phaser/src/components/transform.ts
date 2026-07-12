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
 * Normalized display origin (anchor) for textured renderables and text.
 *
 * `(0.5, 0.5)` (the default) centers the object on its `Position`, matching
 * the behavior of every renderable when `Origin` is absent. Coordinates are
 * normalized 0..1 in **math convention**: `y = 0` anchors the bottom edge,
 * `y = 1` the top edge (the client converts to Phaser's y-down origin at the
 * frontier). `{ x: 0.5, y: 0 }` plants a character sprite's feet on its
 * `Position`; `{ x: 0, y: 1 }` top-left-aligns a HUD label.
 *
 * Applies to GameObjects with a configurable origin (`Image`, `Text`, and
 * future textured renderables). Centered primitives keep their fixed center
 * origin, and vertex shapes (`Polygon`, `Line`, `Triangle`) keep vertex-space
 * `(0, 0)` pinned to `Position`; `Origin` on those entities is a silent
 * no-op by design.
 */
export class Origin {
  /** Normalized horizontal anchor: 0 = left edge, 1 = right edge. */
  @wireType("f32")
  public x = 0.5;

  /** Normalized vertical anchor in math convention: 0 = bottom, 1 = top. */
  @wireType("f32")
  public y = 0.5;
}

/**
 * Screen-space placement for HUD/UI entities, replacing world `Position`.
 *
 * `x`/`y` are normalized screen fractions in **math convention** (`0, 0` is
 * the bottom-left corner, `1, 1` the top-right); `offsetX`/`offsetY` nudge
 * the object from that anchor point in meters (+y up). The client positions
 * the GameObject in screen pixels, pins it to the camera (scroll factor 0),
 * and re-lays it out when the canvas resizes.
 *
 * `ScreenAnchor` and `Position` are mutually exclusive (enforced by
 * `PhaserServerModule`): an entity renders either in the world or on the
 * screen, never both. Score HUDs, timers, and banners are ordinary networked
 * entities with a `ScreenAnchor` instead of a `Position`.
 */
export class ScreenAnchor {
  /** Normalized horizontal anchor: 0 = left edge, 1 = right edge. */
  @wireType("f32")
  public x = 0.5;

  /** Normalized vertical anchor in math convention: 0 = bottom, 1 = top. */
  @wireType("f32")
  public y = 0.5;

  /** Horizontal nudge from the anchor point, in meters. */
  @wireType("f32")
  public offsetX = 0;

  /** Vertical nudge from the anchor point, in meters (+y up). */
  @wireType("f32")
  public offsetY = 0;
}

/**
 * Local position offset relative to the parent entity, expressed in the
 * parent's local (rotated) frame in meters.
 *
 * Parent-relative rendering has two modes, selected by the relationship:
 *
 * - **Native parenting** (`DrawIn`) — parent has `Container`. The child's
 *   Phaser GameObject is added to the parent's Container. Phaser composes
 *   transforms natively: moving/rotating the Container moves/rotates all
 *   children. `Offset` sets the child's local position inside the container.
 *   Zero per-frame JS.
 *
 * - **Computed parenting** (`DrawBy`) — parent is a renderable (no
 *   `Container`). A client-side system derives the child's world `Position`
 *   from the parent's interpolated `Position` plus `Offset` rotated by the
 *   parent's `Rotation`. The `Position` is client-local (never networked).
 *   `Offset` is optional; if absent, the offset defaults to (0, 0).
 */
export class Offset {
  @wireType("f32")
  public x = 0;

  @wireType("f32")
  public y = 0;
}
