import { describe, expect, it } from "vitest";
import { Decoder, Encoder } from "@vworlds/vecs-wire";
import { Flip, Hidden } from "../src/components/display.js";

function roundTrip<T extends object>(C: new () => T, value: T): T {
  const enc = new Encoder(new Uint8Array(1024));
  enc.write(value);
  return new Decoder(enc.getBuffer()).read(C);
}

describe("Hidden", () => {
  it("is a presence-only tag that encodes to zero bytes", () => {
    const enc = new Encoder(new Uint8Array(64));
    enc.write(new Hidden());
    expect(enc.getBuffer().length).toBe(0);
  });

  it("round-trips as an instance", () => {
    const decoded = roundTrip(Hidden, new Hidden());
    expect(decoded).toBeInstanceOf(Hidden);
  });
});

describe("Flip", () => {
  it("round-trips defaults (no mirroring)", () => {
    const decoded = roundTrip(Flip, new Flip());
    expect(decoded).toBeInstanceOf(Flip);
    expect(decoded.x).toBe(false);
    expect(decoded.y).toBe(false);
  });

  it("round-trips horizontal-only flip", () => {
    const f = new Flip();
    f.x = true;
    const decoded = roundTrip(Flip, f);
    expect(decoded.x).toBe(true);
    expect(decoded.y).toBe(false);
  });

  it("round-trips both axes flipped", () => {
    const f = new Flip();
    f.x = true;
    f.y = true;
    const decoded = roundTrip(Flip, f);
    expect(decoded.x).toBe(true);
    expect(decoded.y).toBe(true);
  });
});
