import { Decoder, Encoder } from "@vworlds/vecs-wire";
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

/**
 * Multiplicative tint, one color per GameObject corner (top-left, top-right,
 * bottom-left, bottom-right). White (0xffffff) = no tint.
 *
 * Two wire modes keep the encoding efficient:
 * - **Monochromatic** (`monochromatic = true`): one u32 applies to all four
 *   corners. Set via the `value` setter (writes all four corners and flips the
 *   flag) or by constructing with identical corners.
 * - **Polychromatic** (`monochromatic = false`): four independent u32 corners.
 *   Set the corner fields directly.
 */
export class Tint {
  public topLeft = 0xffffff;
  public topRight = 0xffffff;
  public bottomLeft = 0xffffff;
  public bottomRight = 0xffffff;
  public monochromatic = true;

  /** Uniform tint color; writing it sets all four corners and `monochromatic = true`. */
  public get value(): number {
    return this.topLeft;
  }

  public set value(color: number) {
    this.topLeft = color;
    this.topRight = color;
    this.bottomLeft = color;
    this.bottomRight = color;
    this.monochromatic = true;
  }

  public wireEncode(encoder: Encoder): void {
    encoder.write_bool(this.monochromatic);
    if (this.monochromatic) {
      encoder.write_u32(this.topLeft);
      return;
    }
    encoder.write_u32(this.topLeft);
    encoder.write_u32(this.topRight);
    encoder.write_u32(this.bottomLeft);
    encoder.write_u32(this.bottomRight);
  }

  public static wireDecode(decoder: Decoder): Tint {
    const t = new Tint();
    t.monochromatic = decoder.read_bool();
    if (t.monochromatic) {
      const c = decoder.read_u32();
      t.topLeft = c;
      t.topRight = c;
      t.bottomLeft = c;
      t.bottomRight = c;
      return t;
    }
    t.topLeft = decoder.read_u32();
    t.topRight = decoder.read_u32();
    t.bottomLeft = decoder.read_u32();
    t.bottomRight = decoder.read_u32();
    return t;
  }
}
