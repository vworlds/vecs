import { describe, expect, it } from "vitest";
import { Decoder, Encoder } from "@vworlds/vecs-wire";
import { Motion, MotionClock } from "../src/components/motion.js";
import { phaserMotionComponents } from "../src/index.js";

function encode(value: object): Uint8Array {
  const encoder = new Encoder(new Uint8Array(256));
  encoder.write(value);
  return encoder.getBuffer();
}

function roundTrip<T extends object>(C: new () => T, value: T): T {
  return new Decoder(encode(value)).read(C);
}

/** A baseline whose values are all f32, so a round trip must return them unchanged. */
function baseline(fields: Partial<Motion> = {}): Motion {
  return Object.assign(new Motion(), {
    frame: 77,
    x: 12.5,
    y: -3.25,
    angle: Math.fround(1.2345),
    vx: Math.fround(6.1),
    vy: -8,
    w: Math.fround(-2.75),
    ...fields,
  });
}

describe("Motion", () => {
  // Byte counts with a frame below 128, which takes one varint byte: 1 + 6 × 4 + the mask byte,
  // plus 8 per pair, 4 for the gravity scale and nothing for the fast-rotation flag.
  it.each([
    { name: "no group", fields: {}, mask: 0, bytes: 26 },
    {
      name: "damping",
      fields: { linearDamping: Math.fround(0.15), angularDamping: Math.fround(0.1) },
      mask: 1,
      bytes: 34,
    },
    {
      name: "local center",
      fields: { localCenterX: 0.75, localCenterY: -0.5 },
      mask: 2,
      bytes: 34,
    },
    {
      name: "damping and local center",
      fields: {
        linearDamping: Math.fround(0.15),
        angularDamping: Math.fround(0.1),
        localCenterX: 0.75,
        localCenterY: -0.5,
      },
      mask: 3,
      bytes: 42,
    },
    { name: "gravity scale", fields: { gravityScale: 0.5 }, mask: 4, bytes: 30 },
    { name: "fast rotation", fields: { allowFastRotation: true }, mask: 8, bytes: 26 },
    {
      name: "gravity scale and fast rotation",
      fields: { gravityScale: 0, allowFastRotation: true },
      mask: 12,
      bytes: 30,
    },
    {
      name: "every group",
      fields: {
        linearDamping: Math.fround(0.15),
        angularDamping: Math.fround(0.1),
        localCenterX: 0.75,
        localCenterY: -0.5,
        gravityScale: -2,
        allowFastRotation: true,
      },
      mask: 15,
      bytes: 46,
    },
  ])("round-trips with $name in $bytes bytes", ({ fields, mask, bytes }) => {
    const motion = baseline(fields);
    const encoded = encode(motion);

    expect(encoded.length).toBe(bytes);
    expect(encoded[25]).toBe(mask);
    const decoded = new Decoder(encoded).read(Motion);
    expect(decoded).toBeInstanceOf(Motion);
    expect({ ...decoded }).toEqual({ ...motion });
  });

  it("sends a group when only one of its fields is non-zero, and the other decodes to zero", () => {
    const decoded = roundTrip(Motion, baseline({ angularDamping: 0.5, localCenterY: 2 }));

    expect(decoded.linearDamping).toBe(0);
    expect(decoded.angularDamping).toBe(0.5);
    expect(decoded.localCenterX).toBe(0);
    expect(decoded.localCenterY).toBe(2);
  });

  it("decodes absent groups to their defaults", () => {
    const decoded = roundTrip(Motion, baseline());

    expect(decoded.linearDamping).toBe(0);
    expect(decoded.angularDamping).toBe(0);
    expect(decoded.localCenterX).toBe(0);
    expect(decoded.localCenterY).toBe(0);
    expect(decoded.gravityScale).toBe(1);
    expect(decoded.allowFastRotation).toBe(false);
  });

  it("decodes every value to the f32 nearest the encoded number", () => {
    const motion = Object.assign(new Motion(), {
      frame: 4_000_000_000,
      x: 0.1,
      y: 1234.5678,
      angle: Math.PI,
      vx: 1 / 3,
      vy: -1e-7,
      w: 2 ** -20,
      linearDamping: 0.15,
      angularDamping: 0.1,
      localCenterX: 4 / 3,
      localCenterY: 7 / 9,
      gravityScale: 0.3,
    });
    const decoded = roundTrip(Motion, motion);

    const { frame, allowFastRotation, ...values } = motion;
    expect(decoded.frame).toBe(frame);
    expect(decoded.allowFastRotation).toBe(allowFastRotation);
    for (const [key, value] of Object.entries(values)) {
      expect(decoded[key as keyof typeof values], key).toBe(Math.fround(value));
    }
    // Decoding the decoded values again changes nothing.
    expect({ ...roundTrip(Motion, decoded) }).toEqual({ ...decoded });
  });

  it("writes the frame as a varint", () => {
    expect(encode(baseline({ frame: 127 })).length).toBe(26);
    expect(encode(baseline({ frame: 128 })).length).toBe(27);
    expect(encode(baseline({ frame: 4_000_000_000 })).length).toBe(30);
  });

  it("rejects a frame that is not a u32", () => {
    expect(() => encode(baseline({ frame: -1 }))).toThrow(RangeError);
  });
});

describe("MotionClock", () => {
  it("defaults to PhysicsModule's step, substeps and speed cap, with no gravity", () => {
    const clock = new MotionClock();

    expect(clock.stepSeconds).toBe(1 / 60);
    expect(clock.subSteps).toBe(4);
    expect(clock.gravityX).toBe(0);
    expect(clock.gravityY).toBe(0);
    expect(clock.maxLinearSpeed).toBe(400);
  });

  it("round-trips in 17 bytes", () => {
    const clock = Object.assign(new MotionClock(), {
      stepSeconds: 1 / 30,
      subSteps: 8,
      gravityX: 1,
      gravityY: -9.8,
      maxLinearSpeed: 250,
    });
    const encoded = encode(clock);
    const decoded = new Decoder(encoded).read(MotionClock);

    expect(encoded.length).toBe(17);
    expect(decoded).toBeInstanceOf(MotionClock);
    expect({ ...decoded }).toEqual({
      stepSeconds: Math.fround(1 / 30),
      subSteps: 8,
      gravityX: 1,
      gravityY: Math.fround(-9.8),
      maxLinearSpeed: 250,
    });
  });
});

describe("phaserMotionComponents", () => {
  it("lists MotionClock then Motion", () => {
    expect(phaserMotionComponents).toEqual([MotionClock, Motion]);
  });
});
