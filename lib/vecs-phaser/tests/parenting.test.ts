import { describe, expect, it } from "vitest";
import { Decoder, Encoder } from "@vworlds/vecs-wire";
import { InheritRotation } from "../src/components/parenting.js";
import * as phaser from "../src/index.js";

function roundTrip<T extends object>(C: new () => T, value: T): T {
  const enc = new Encoder(new Uint8Array(1024));
  enc.write(value);
  return new Decoder(enc.getBuffer()).read(C);
}

describe("InheritRotation", () => {
  it("round-trips defaults", () => {
    const decoded = roundTrip(InheritRotation, new InheritRotation());
    expect(decoded).toBeInstanceOf(InheritRotation);
    expect(decoded.angle).toBe(0);
  });

  it("round-trips a non-default angle", () => {
    const tag = new InheritRotation();
    tag.angle = 1.5;
    const decoded = roundTrip(InheritRotation, tag);
    expect(decoded.angle).toBeCloseTo(1.5);
  });

  it("round-trips a negative f32-exact angle", () => {
    const tag = new InheritRotation();
    tag.angle = -0.25;
    const decoded = roundTrip(InheritRotation, tag);
    expect(decoded.angle).toBe(-0.25);
  });

  it("is exported from the package entry point", () => {
    expect(phaser.InheritRotation).toBe(InheritRotation);
  });

  it("is not part of phaserNetworkComponents, so no wire id shifts", () => {
    expect(phaser.phaserNetworkComponents).not.toContain(InheritRotation);
    expect(phaser.phaserNetworkComponents).toHaveLength(23);
  });
});
