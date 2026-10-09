import { describe, expect, it } from "vitest";
import { Decoder, Encoder } from "@vworlds/vecs-wire";
import {
  defaultMotionParams,
  Motion,
  MotionClock,
  MotionParams,
} from "../src/components/motion.js";
import { phaserMotionComponents } from "../src/index.js";

function encode(value: object): Uint8Array {
  const encoder = new Encoder(new Uint8Array(256));
  encoder.write(value);
  return encoder.getBuffer();
}

function roundTrip<T extends object>(C: new () => T, value: T): T {
  return new Decoder(encode(value)).read(C);
}

/** A moving baseline whose values are all f32, so a round trip must return them unchanged. */
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

/** A baseline at rest: the pose only. */
function restingBaseline(fields: Partial<Motion> = {}): Motion {
  return baseline({ vx: 0, vy: 0, w: 0, rest: true, ...fields });
}

/** The constants of a damped, off-center body with a gravity scale, all f32. */
const CONSTANTS = {
  linearDamping: Math.fround(0.15),
  angularDamping: Math.fround(0.1),
  localCenterX: 0.75,
  localCenterY: -0.5,
  gravityScale: -2,
  allowFastRotation: true,
} as const;

describe("Motion", () => {
  // Byte counts with a frame below 128, which takes one varint byte: 1 + the flags byte + 3 × 4 for
  // the pose, plus 3 × 4 for the velocities of a moving body.
  it("round-trips a moving baseline in 26 bytes, with its velocities", () => {
    const motion = baseline();
    const encoded = encode(motion);

    expect(encoded.length).toBe(26);
    expect(encoded[1]).toBe(0);
    const decoded = new Decoder(encoded).read(Motion);
    expect(decoded).toBeInstanceOf(Motion);
    expect({ ...decoded }).toEqual({ ...motion });
  });

  it("round-trips a baseline at rest in 14 bytes, with the pose only", () => {
    const motion = restingBaseline();
    const encoded = encode(motion);

    expect(encoded.length).toBe(14);
    expect(encoded[1]).toBe(1);
    const decoded = new Decoder(encoded).read(Motion);
    expect(decoded).toBeInstanceOf(Motion);
    expect({ ...decoded }).toEqual({ ...motion });
    expect(decoded).toMatchObject({ rest: true, vx: 0, vy: 0, w: 0 });
  });

  it("sends no velocity for a body at rest, and decodes it with zero velocities", () => {
    const decoded = roundTrip(Motion, baseline({ rest: true }));

    expect(decoded.rest).toBe(true);
    expect(decoded.vx).toBe(0);
    expect(decoded.vy).toBe(0);
    expect(decoded.w).toBe(0);
    expect(decoded.x).toBe(12.5);
    expect(decoded.y).toBe(-3.25);
    expect(decoded.angle).toBe(Math.fround(1.2345));
    expect(encode(baseline({ rest: true }))).toEqual(encode(restingBaseline()));
  });

  it("lays out the frame, the flags, the pose and the velocities in that order", () => {
    const encoded = encode(baseline({ frame: 5, x: 1, y: 2, angle: 3, vx: 4, vy: 5, w: 6 }));
    const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
    const f32At = (offset: number): number => view.getFloat32(offset, true);

    expect(encoded[0]).toBe(5);
    expect(encoded[1]).toBe(0);
    expect([2, 6, 10, 14, 18, 22].map(f32At)).toEqual([1, 2, 3, 4, 5, 6]);
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
    });
    const decoded = roundTrip(Motion, motion);

    const { frame, rest, ...values } = motion;
    expect(decoded.frame).toBe(frame);
    expect(decoded.rest).toBe(rest);
    for (const [key, value] of Object.entries(values)) {
      expect(decoded[key as keyof typeof values], key).toBe(Math.fround(value));
    }
    // Decoding the decoded values again changes nothing.
    expect({ ...roundTrip(Motion, decoded) }).toEqual({ ...decoded });
    // So does the pose of a baseline at rest.
    const resting = roundTrip(Motion, Object.assign(motion, { rest: true }));
    expect(resting.x).toBe(Math.fround(0.1));
    expect(resting.y).toBe(Math.fround(1234.5678));
    expect(resting.angle).toBe(Math.fround(Math.PI));
    expect({ ...roundTrip(Motion, resting) }).toEqual({ ...resting });
  });

  it("writes the frame as a varint", () => {
    expect(encode(baseline({ frame: 127 })).length).toBe(26);
    expect(encode(baseline({ frame: 128 })).length).toBe(27);
    expect(encode(baseline({ frame: 4_000_000_000 })).length).toBe(30);
    expect(encode(restingBaseline({ frame: 127 })).length).toBe(14);
    expect(encode(restingBaseline({ frame: 128 })).length).toBe(15);
    expect(encode(restingBaseline({ frame: 4_000_000_000 })).length).toBe(18);
  });

  it("rejects a frame that is not a u32", () => {
    expect(() => encode(baseline({ frame: -1 }))).toThrow(RangeError);
  });

  it("carries no body constant any more", () => {
    expect(Object.keys(new Motion()).sort()).toEqual(
      ["angle", "frame", "rest", "vx", "vy", "w", "x", "y"].sort()
    );
  });
});

describe("MotionParams", () => {
  /** The groups of `CONSTANTS` that a mask lists, with the wire bytes each costs. */
  const groups = [
    { bit: 1, bytes: 8, fields: ["linearDamping", "angularDamping"] },
    { bit: 2, bytes: 8, fields: ["localCenterX", "localCenterY"] },
    { bit: 4, bytes: 4, fields: ["gravityScale"] },
    { bit: 8, bytes: 0, fields: ["allowFastRotation"] },
  ] as const;

  /** Constants with exactly the groups `mask` lists set off their defaults. */
  function constantsFor(mask: number): MotionParams {
    const params = new MotionParams();
    for (const group of groups) {
      if ((mask & group.bit) !== 0) {
        for (const field of group.fields) {
          Object.assign(params, { [field]: CONSTANTS[field] });
        }
      }
    }
    return params;
  }

  // One byte for the mask, 8 for each pair, 4 for the gravity scale and nothing for the flag.
  it.each(Array.from({ length: 16 }, (_, mask) => mask))(
    "round-trips mask %i in exactly the bytes its groups cost",
    (mask) => {
      const params = constantsFor(mask);
      const encoded = encode(params);
      const bytes = 1 + groups.reduce((sum, g) => sum + ((mask & g.bit) !== 0 ? g.bytes : 0), 0);

      expect(encoded.length).toBe(bytes);
      expect(encoded[0]).toBe(mask);
      const decoded = new Decoder(encoded).read(MotionParams);
      expect(decoded).toBeInstanceOf(MotionParams);
      expect({ ...decoded }).toEqual({ ...params });
    }
  );

  it("costs one byte for the defaults and 21 with every group", () => {
    expect(encode(new MotionParams()).length).toBe(1);
    expect(encode(constantsFor(15)).length).toBe(21);
  });

  it("sends a group when only one of its fields is non-zero, and the other decodes to zero", () => {
    const encoded = encode(
      Object.assign(new MotionParams(), { angularDamping: 0.5, localCenterY: 2 })
    );
    const decoded = new Decoder(encoded).read(MotionParams);

    expect(encoded.length).toBe(17);
    expect(encoded[0]).toBe(3);
    expect(decoded.linearDamping).toBe(0);
    expect(decoded.angularDamping).toBe(0.5);
    expect(decoded.localCenterX).toBe(0);
    expect(decoded.localCenterY).toBe(2);
  });

  it("decodes absent groups to their defaults", () => {
    const decoded = roundTrip(MotionParams, new MotionParams());

    expect({ ...decoded }).toEqual({
      linearDamping: 0,
      angularDamping: 0,
      localCenterX: 0,
      localCenterY: 0,
      gravityScale: 1,
      allowFastRotation: false,
    });
  });

  it("decodes every value to the f32 nearest the encoded number", () => {
    const params = Object.assign(new MotionParams(), {
      linearDamping: 0.15,
      angularDamping: 0.1,
      localCenterX: 4 / 3,
      localCenterY: 7 / 9,
      gravityScale: 0.3,
      allowFastRotation: true,
    });
    const decoded = roundTrip(MotionParams, params);

    const { allowFastRotation, ...values } = params;
    expect(decoded.allowFastRotation).toBe(allowFastRotation);
    for (const [key, value] of Object.entries(values)) {
      expect(decoded[key as keyof typeof values], key).toBe(Math.fround(value));
    }
    // Decoding the decoded values again changes nothing.
    expect({ ...roundTrip(MotionParams, decoded) }).toEqual({ ...decoded });
  });
});

describe("defaultMotionParams", () => {
  it("holds the defaults of a MotionParams, which is what an entity without one has", () => {
    expect(defaultMotionParams).toBeInstanceOf(MotionParams);
    expect({ ...defaultMotionParams }).toEqual({ ...new MotionParams() });
    expect(encode(defaultMotionParams)).toEqual(encode(new MotionParams()));
  });

  it("is frozen, so no caller can change what every entity without constants shares", () => {
    expect(Object.isFrozen(defaultMotionParams)).toBe(true);
    expect(() => {
      (defaultMotionParams as MotionParams).linearDamping = 1;
    }).toThrow(TypeError);
    expect(defaultMotionParams.linearDamping).toBe(0);
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
  it("lists MotionClock, Motion then MotionParams, appended so no existing wire id shifts", () => {
    expect(phaserMotionComponents).toEqual([MotionClock, Motion, MotionParams]);
  });
});
