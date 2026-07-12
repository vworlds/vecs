import { describe, expect, it } from "vitest";
import { Decoder, Encoder } from "@vworlds/vecs-wire";
import { Music, Sound } from "../src/components/audio.js";

function roundTrip<T extends object>(C: new () => T, value: T): T {
  const enc = new Encoder(new Uint8Array(1024));
  enc.write(value);
  return new Decoder(enc.getBuffer()).read(C);
}

describe("Sound", () => {
  it("round-trips defaults", () => {
    const decoded = roundTrip(Sound, new Sound());
    expect(decoded).toBeInstanceOf(Sound);
    expect(decoded.asset).toBe(0);
    expect(decoded.volume).toBe(1);
    expect(decoded.rate).toBe(1);
  });

  it("round-trips a quiet, pitched-down one-shot", () => {
    const sound = new Sound();
    sound.asset = 12;
    sound.volume = 0.25;
    sound.rate = 0.5;
    const decoded = roundTrip(Sound, sound);
    expect(decoded.asset).toBe(12);
    expect(decoded.volume).toBe(0.25);
    expect(decoded.rate).toBe(0.5);
  });
});

describe("Music", () => {
  it("round-trips defaults (looping)", () => {
    const decoded = roundTrip(Music, new Music());
    expect(decoded).toBeInstanceOf(Music);
    expect(decoded.asset).toBe(0);
    expect(decoded.volume).toBe(1);
    expect(decoded.loop).toBe(true);
  });

  it("round-trips a non-looping track", () => {
    const music = new Music();
    music.asset = 7;
    music.volume = 0.6;
    music.loop = false;
    const decoded = roundTrip(Music, music);
    expect(decoded.asset).toBe(7);
    expect(decoded.volume).toBeCloseTo(0.6);
    expect(decoded.loop).toBe(false);
  });
});
