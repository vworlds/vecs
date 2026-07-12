import { describe, expect, it } from "vitest";
import { Decoder, Encoder } from "@vworlds/vecs-wire";
import { ParticleBurst } from "../src/components/effects.js";

function roundTrip<T extends object>(C: new () => T, value: T): T {
  const enc = new Encoder(new Uint8Array(1024));
  enc.write(value);
  return new Decoder(enc.getBuffer()).read(C);
}

describe("ParticleBurst", () => {
  it("round-trips defaults", () => {
    const decoded = roundTrip(ParticleBurst, new ParticleBurst());
    expect(decoded).toBeInstanceOf(ParticleBurst);
    expect(decoded).toMatchObject({
      texture: 0,
      frame: 0,
      count: 16,
      speed: 2,
      lifespanMs: 500,
      scale: 1,
      gravityY: 0,
      tint: 0xffffff,
    });
  });

  it("round-trips a customized explosion", () => {
    const burst = new ParticleBurst();
    burst.texture = 7;
    burst.frame = 3;
    burst.count = 64;
    burst.speed = 5.5;
    burst.lifespanMs = 1200;
    burst.scale = 0.25;
    burst.gravityY = -9.8;
    burst.tint = 0x00ffcc;
    const decoded = roundTrip(ParticleBurst, burst);
    expect(decoded).toMatchObject({
      texture: 7,
      frame: 3,
      count: 64,
      lifespanMs: 1200,
      scale: 0.25,
      tint: 0x00ffcc,
    });
    expect(decoded.speed).toBe(5.5);
    expect(decoded.gravityY).toBeCloseTo(-9.8);
  });
});
