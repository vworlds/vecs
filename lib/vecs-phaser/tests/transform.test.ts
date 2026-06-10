import { describe, expect, it } from "vitest";
import { Decoder, Encoder } from "@vworlds/vecs-wire";
import { Alpha, Depth, Position, Rotation, Scale } from "../src/components/transform.js";

function roundTrip<T extends object>(C: new () => T, value: T): T {
  const enc = new Encoder(new Uint8Array(1024));
  enc.write(value);
  return new Decoder(enc.getBuffer()).read(C);
}

describe("Position", () => {
  it("round-trips defaults", () => {
    const decoded = roundTrip(Position, new Position());
    expect(decoded).toBeInstanceOf(Position);
    expect(decoded.x).toBe(0);
    expect(decoded.y).toBe(0);
  });

  it("round-trips non-default values", () => {
    const p = new Position();
    p.x = 1.5;
    p.y = -2.5;
    const decoded = roundTrip(Position, p);
    expect(decoded.x).toBeCloseTo(1.5);
    expect(decoded.y).toBeCloseTo(-2.5);
  });

  it("round-trips f32-exact values", () => {
    const p = new Position();
    p.x = 0.25;
    p.y = 0.5;
    const decoded = roundTrip(Position, p);
    expect(decoded.x).toBe(0.25);
    expect(decoded.y).toBe(0.5);
  });
});

describe("Rotation", () => {
  it("round-trips defaults", () => {
    const decoded = roundTrip(Rotation, new Rotation());
    expect(decoded).toBeInstanceOf(Rotation);
    expect(decoded.angle).toBe(0);
  });

  it("round-trips non-default angle", () => {
    const r = new Rotation();
    r.angle = 1.5;
    const decoded = roundTrip(Rotation, r);
    expect(decoded.angle).toBeCloseTo(1.5);
  });

  it("round-trips negative angle", () => {
    const r = new Rotation();
    r.angle = -0.25;
    const decoded = roundTrip(Rotation, r);
    expect(decoded.angle).toBe(-0.25);
  });
});

describe("Scale", () => {
  it("round-trips defaults", () => {
    const decoded = roundTrip(Scale, new Scale());
    expect(decoded).toBeInstanceOf(Scale);
    expect(decoded.x).toBe(1);
    expect(decoded.y).toBe(1);
  });

  it("round-trips non-default values", () => {
    const s = new Scale();
    s.x = 2;
    s.y = 0.5;
    const decoded = roundTrip(Scale, s);
    expect(decoded.x).toBe(2);
    expect(decoded.y).toBe(0.5);
  });

  it("round-trips fractional scale", () => {
    const s = new Scale();
    s.x = 0.25;
    s.y = 4;
    const decoded = roundTrip(Scale, s);
    expect(decoded.x).toBe(0.25);
    expect(decoded.y).toBe(4);
  });
});

describe("Alpha", () => {
  it("round-trips defaults", () => {
    const decoded = roundTrip(Alpha, new Alpha());
    expect(decoded).toBeInstanceOf(Alpha);
    expect(decoded.value).toBe(1);
  });

  it("round-trips non-default value", () => {
    const a = new Alpha();
    a.value = 0.5;
    const decoded = roundTrip(Alpha, a);
    expect(decoded.value).toBe(0.5);
  });

  it("round-trips zero", () => {
    const a = new Alpha();
    a.value = 0;
    const decoded = roundTrip(Alpha, a);
    expect(decoded.value).toBe(0);
  });
});

describe("Depth", () => {
  it("round-trips defaults", () => {
    const decoded = roundTrip(Depth, new Depth());
    expect(decoded).toBeInstanceOf(Depth);
    expect(decoded.value).toBe(0);
  });

  it("round-trips positive depth", () => {
    const d = new Depth();
    d.value = 10;
    const decoded = roundTrip(Depth, d);
    expect(decoded.value).toBe(10);
  });

  it("round-trips negative depth", () => {
    const d = new Depth();
    d.value = -5;
    const decoded = roundTrip(Depth, d);
    expect(decoded.value).toBe(-5);
  });
});
