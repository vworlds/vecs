import { type as wireType } from "@vworlds/vecs-wire";

/** Fill color (RGB integer, e.g. 0xff0000) and opacity 0..1. */
export class FillStyle {
  @wireType("u32")
  public color = 0xffffff;

  @wireType("f32")
  public alpha = 1;
}

/** Stroke color (RGB integer), opacity 0..1, and line width in screen pixels. */
export class StrokeStyle {
  @wireType("u32")
  public color = 0xffffff;

  @wireType("f32")
  public alpha = 1;

  /** Line width in screen pixels. */
  @wireType("f32")
  public width = 1;
}
