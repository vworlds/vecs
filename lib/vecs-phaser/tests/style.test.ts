import { describe, expect, it } from "vitest";
import { Decoder, Encoder } from "@vworlds/vecs-wire";
import { FillStyle, StrokeStyle } from "../src/components/style.js";

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
