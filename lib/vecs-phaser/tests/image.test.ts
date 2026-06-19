import { describe, expect, it } from "vitest";
import { Decoder, Encoder } from "@vworlds/vecs-wire";
import { Image } from "../src/components/image.js";

function roundTrip(instance: Image): Image {
  const enc = new Encoder(new Uint8Array(1024));
  enc.write(instance);
  return new Decoder(enc.getBuffer()).read(Image);
}

describe("Image component — wire round-trip", () => {
  it("round-trips default values", () => {
    const decoded = roundTrip(new Image());

    expect(decoded).toBeInstanceOf(Image);
    expect(decoded.texture).toBe(0);
    expect(decoded.frame).toBe(0);
  });

  it("round-trips non-default values", () => {
    const image = new Image();
    image.texture = 123;
    image.frame = 45;

    const decoded = roundTrip(image);

    expect(decoded.texture).toBe(123);
    expect(decoded.frame).toBe(45);
  });

  it("round-trips u32 and u16 range values", () => {
    const image = new Image();
    image.texture = 4_000_000_000;
    image.frame = 60_000;

    const decoded = roundTrip(image);

    expect(decoded.texture).toBe(4_000_000_000);
    expect(decoded.frame).toBe(60_000);
  });
});
