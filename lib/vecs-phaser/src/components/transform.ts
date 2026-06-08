import { type as wireType } from "@vworlds/vecs-wire";

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
