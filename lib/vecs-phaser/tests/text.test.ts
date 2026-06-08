import { describe, expect, it } from "vitest";
import { Decoder, Encoder } from "@vworlds/vecs-wire";
import { Text, TextAlign } from "../src/components/text.js";

function roundTrip(instance: Text): Text {
  const enc = new Encoder(new Uint8Array(1024));
  enc.write(instance);
  return new Decoder(enc.getBuffer()).read(Text);
}

describe("Text component — wire round-trip", () => {
  it("round-trips default values", () => {
    const decoded = roundTrip(new Text());

    expect(decoded).toBeInstanceOf(Text);
    expect(decoded.value).toBe("");
    expect(decoded.fontFamily).toBe("sans-serif");
    expect(decoded.fontSize).toBe(16);
    expect(decoded.color).toBe(0xffffff);
    expect(decoded.backgroundColor).toBe(0);
    expect(decoded.backgroundAlpha).toBeCloseTo(0);
    expect(decoded.align).toBe(TextAlign.Left);
  });

  it("round-trips non-default values", () => {
    const t = new Text();
    t.value = "Hello";
    t.fontFamily = "monospace";
    t.fontSize = 32;
    t.color = 0xff0000;
    t.backgroundColor = 0x000000;
    t.backgroundAlpha = 0.5;
    t.align = TextAlign.Center;

    const decoded = roundTrip(t);

    expect(decoded.value).toBe("Hello");
    expect(decoded.fontFamily).toBe("monospace");
    expect(decoded.fontSize).toBe(32);
    expect(decoded.color).toBe(0xff0000);
    expect(decoded.backgroundColor).toBe(0x000000);
    expect(decoded.backgroundAlpha).toBeCloseTo(0.5);
    expect(decoded.align).toBe(TextAlign.Center);
  });

  it("round-trips a unicode string value", () => {
    const t = new Text();
    t.value = "こんにちは 🌍 العالم";

    const decoded = roundTrip(t);

    expect(decoded.value).toBe("こんにちは 🌍 العالم");
  });

  it("round-trips an empty string value", () => {
    const t = new Text();
    t.value = "";

    const decoded = roundTrip(t);

    expect(decoded.value).toBe("");
  });

  it("round-trips TextAlign.Left (0)", () => {
    const t = new Text();
    t.align = TextAlign.Left;

    const decoded = roundTrip(t);

    expect(decoded.align).toBe(0);
    expect(decoded.align).toBe(TextAlign.Left);
  });

  it("round-trips TextAlign.Center (1)", () => {
    const t = new Text();
    t.align = TextAlign.Center;

    const decoded = roundTrip(t);

    expect(decoded.align).toBe(1);
    expect(decoded.align).toBe(TextAlign.Center);
  });

  it("round-trips TextAlign.Right (2)", () => {
    const t = new Text();
    t.align = TextAlign.Right;

    const decoded = roundTrip(t);

    expect(decoded.align).toBe(2);
    expect(decoded.align).toBe(TextAlign.Right);
  });

  it("backgroundAlpha uses f32-exact value 0.5", () => {
    const t = new Text();
    t.backgroundAlpha = 0.5;

    const decoded = roundTrip(t);

    // 0.5 is exactly representable as f32
    expect(decoded.backgroundAlpha).toBe(0.5);
  });
});
