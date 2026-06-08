import { type as wireType } from "@vworlds/vecs-wire";

/** Horizontal text alignment, maps to Phaser text align settings. */
export enum TextAlign {
  Left = 0,
  Center = 1,
  Right = 2,
}

/** Render a text string at the entity's Position (centered origin). */
export class Text {
  /** The string to display. */
  @wireType("string")
  public value = "";

  /** CSS font-family string. */
  @wireType("string")
  public fontFamily = "sans-serif";

  /** Font size in screen pixels (not meters). */
  @wireType("u16")
  public fontSize = 16;

  /** Text fill color as an RGB integer. */
  @wireType("u32")
  public color = 0xffffff;

  /** Background rectangle color as an RGB integer. */
  @wireType("u32")
  public backgroundColor = 0;

  /** Background rectangle opacity (0 = transparent). */
  @wireType("f32")
  public backgroundAlpha = 0;

  /** Horizontal alignment; one of the TextAlign enum values. */
  @wireType("u8")
  public align = TextAlign.Left;
}
