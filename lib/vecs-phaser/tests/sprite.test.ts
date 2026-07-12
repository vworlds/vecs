import { describe, expect, it } from "vitest";
import { Decoder, Encoder } from "@vworlds/vecs-wire";
import { Animation, Sprite } from "../src/components/sprite.js";

function roundTrip<T extends object>(C: new () => T, value: T): T {
  const enc = new Encoder(new Uint8Array(1024));
  enc.write(value);
  return new Decoder(enc.getBuffer()).read(C);
}

describe("Sprite", () => {
  it("round-trips defaults", () => {
    const decoded = roundTrip(Sprite, new Sprite());
    expect(decoded).toBeInstanceOf(Sprite);
    expect(decoded.texture).toBe(0);
    expect(decoded.frame).toBe(0);
  });

  it("round-trips texture id and frame", () => {
    const sprite = new Sprite();
    sprite.texture = 3;
    sprite.frame = 42;
    const decoded = roundTrip(Sprite, sprite);
    expect(decoded.texture).toBe(3);
    expect(decoded.frame).toBe(42);
  });
});

describe("Animation", () => {
  it("round-trips defaults (tile 0, authored speed)", () => {
    const decoded = roundTrip(Animation, new Animation());
    expect(decoded).toBeInstanceOf(Animation);
    expect(decoded.tile).toBe(0);
    expect(decoded.speed).toBe(1);
  });

  it("round-trips tile and speed", () => {
    const animation = new Animation();
    animation.tile = 5;
    animation.speed = 2.5;
    const decoded = roundTrip(Animation, animation);
    expect(decoded.tile).toBe(5);
    expect(decoded.speed).toBe(2.5);
  });
});
