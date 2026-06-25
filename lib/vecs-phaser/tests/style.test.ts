import { describe, expect, it } from "vitest";
import { Decoder, Encoder } from "@vworlds/vecs-wire";
import { FillStyle, StrokeStyle, Tint } from "../src/components/style.js";

function roundTrip<T extends object>(C: new () => T, value: T): T {
  const enc = new Encoder(new Uint8Array(1024));
  enc.write(value);
  return new Decoder(enc.getBuffer()).read(C);
}

describe("FillStyle", () => {
  it("round-trips defaults", () => {
    const decoded = roundTrip(FillStyle, new FillStyle());
    expect(decoded).toBeInstanceOf(FillStyle);
    expect(decoded.color).toBe(0xffffff);
    expect(decoded.alpha).toBe(1);
  });

  it("round-trips non-default color and alpha", () => {
    const f = new FillStyle();
    f.color = 0xff0000;
    f.alpha = 0.5;
    const decoded = roundTrip(FillStyle, f);
    expect(decoded.color).toBe(0xff0000);
    expect(decoded.alpha).toBe(0.5);
  });

  it("round-trips zero alpha (transparent)", () => {
    const f = new FillStyle();
    f.color = 0x000000;
    f.alpha = 0;
    const decoded = roundTrip(FillStyle, f);
    expect(decoded.color).toBe(0x000000);
    expect(decoded.alpha).toBe(0);
  });

  it("round-trips a large color value", () => {
    const f = new FillStyle();
    f.color = 0xffcc00;
    f.alpha = 0.75;
    const decoded = roundTrip(FillStyle, f);
    expect(decoded.color).toBe(0xffcc00);
    expect(decoded.alpha).toBeCloseTo(0.75);
  });
});

describe("StrokeStyle", () => {
  it("round-trips defaults", () => {
    const decoded = roundTrip(StrokeStyle, new StrokeStyle());
    expect(decoded).toBeInstanceOf(StrokeStyle);
    expect(decoded.color).toBe(0xffffff);
    expect(decoded.alpha).toBe(1);
    expect(decoded.width).toBe(1);
  });

  it("round-trips non-default values", () => {
    const s = new StrokeStyle();
    s.color = 0x0000ff;
    s.alpha = 0.5;
    s.width = 2;
    const decoded = roundTrip(StrokeStyle, s);
    expect(decoded.color).toBe(0x0000ff);
    expect(decoded.alpha).toBe(0.5);
    expect(decoded.width).toBe(2);
  });

  it("round-trips zero width (hairline)", () => {
    const s = new StrokeStyle();
    s.width = 0;
    const decoded = roundTrip(StrokeStyle, s);
    expect(decoded.width).toBe(0);
  });

  it("round-trips fractional width", () => {
    const s = new StrokeStyle();
    s.width = 1.5;
    const decoded = roundTrip(StrokeStyle, s);
    expect(decoded.width).toBeCloseTo(1.5);
  });

  it("round-trips black stroke with full opacity", () => {
    const s = new StrokeStyle();
    s.color = 0x000000;
    s.alpha = 1;
    s.width = 4;
    const decoded = roundTrip(StrokeStyle, s);
    expect(decoded.color).toBe(0x000000);
    expect(decoded.alpha).toBe(1);
    expect(decoded.width).toBe(4);
  });
});

describe("Tint", () => {
  it("round-trips monochromatic defaults (white = no tint)", () => {
    const decoded = roundTrip(Tint, new Tint());
    expect(decoded).toBeInstanceOf(Tint);
    expect(decoded.monochromatic).toBe(true);
    expect(decoded.topLeft).toBe(0xffffff);
    expect(decoded.topRight).toBe(0xffffff);
    expect(decoded.bottomLeft).toBe(0xffffff);
    expect(decoded.bottomRight).toBe(0xffffff);
  });

  it("round-trips a monochromatic tint set via the value setter", () => {
    const t = new Tint();
    t.value = 0xff8800;
    const decoded = roundTrip(Tint, t);
    expect(decoded.monochromatic).toBe(true);
    expect(decoded.topLeft).toBe(0xff8800);
    expect(decoded.topRight).toBe(0xff8800);
    expect(decoded.bottomLeft).toBe(0xff8800);
    expect(decoded.bottomRight).toBe(0xff8800);
  });

  it("round-trips a polychromatic tint with distinct corners", () => {
    const t = new Tint();
    t.monochromatic = false;
    t.topLeft = 0xff0000;
    t.topRight = 0x00ff00;
    t.bottomLeft = 0x0000ff;
    t.bottomRight = 0xffff00;
    const decoded = roundTrip(Tint, t);
    expect(decoded.monochromatic).toBe(false);
    expect(decoded.topLeft).toBe(0xff0000);
    expect(decoded.topRight).toBe(0x00ff00);
    expect(decoded.bottomLeft).toBe(0x0000ff);
    expect(decoded.bottomRight).toBe(0xffff00);
  });
});
