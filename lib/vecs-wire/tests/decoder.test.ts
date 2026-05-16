import { describe, expect, it } from "vitest";
import { Decoder } from "../src/index.js";

function toUint8Array(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error("Invalid hex string. Length must be even.");
  }

  const uint8Array = new Uint8Array(hex.length / 2);

  for (let i = 0; i < hex.length; i += 2) {
    uint8Array[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }

  return uint8Array;
}

describe("Decoder", () => {
  it("decodes uint32", () => {
    const buffer = Uint8Array.from([0xc0, 0xc4, 0x07]);
    const decoder = new Decoder(buffer);

    expect(decoder.read_u32()).toBe(123456);
  });

  it("decodes int32", () => {
    const buffer = Uint8Array.from([0xe1, 0xef, 0x4f]);
    const decoder = new Decoder(buffer);

    expect(decoder.read_i32()).toBe(-654321);
  });

  it("decodes float", () => {
    const buffer = Uint8Array.from([0xc3, 0xf5, 0x48, 0x40]);
    const decoder = new Decoder(buffer);

    expect(decoder.read_f32()).toBeCloseTo(3.14, 2);
  });

  it("decodes double", () => {
    const buffer = Uint8Array.from([0x9b, 0x91, 0x04, 0x8b, 0x0a, 0xbf, 0x05, 0x40]);
    const decoder = new Decoder(buffer);

    expect(decoder.read_f64()).toBeCloseTo(2.718281828, 9);
  });

  it("decodes boolean", () => {
    const buffer = Uint8Array.from([0x01]);
    const decoder = new Decoder(buffer);

    expect(decoder.read_bool()).toBe(true);
  });

  it("decodes string", () => {
    const buffer = Uint8Array.from([
      0x11, 0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x2c, 0x20, 0x56, 0x65, 0x63, 0x73, 0x20, 0x57, 0x69,
      0x72, 0x65, 0x21,
    ]);
    const decoder = new Decoder(buffer);

    expect(decoder.read_string()).toBe("Hello, Vecs Wire!");
  });

  it("decodes bytes", () => {
    const buffer = Uint8Array.from([
      0x11, 0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x2c, 0x20, 0x56, 0x65, 0x63, 0x73, 0x20, 0x57, 0x69,
      0x72, 0x65, 0x21,
    ]);
    const decoder = new Decoder(buffer);

    expect(decoder.read_bytes()).toStrictEqual(
      Uint8Array.from([
        0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x2c, 0x20, 0x56, 0x65, 0x63, 0x73, 0x20, 0x57, 0x69, 0x72,
        0x65, 0x21,
      ])
    );
  });

  it("decodes multiple values", () => {
    const buffer = Uint8Array.from([
      0x2a, 0xa3, 0x13, 0x8d, 0x97, 0x6e, 0x12, 0x83, 0xc0, 0xf3, 0x3f, 0x05, 0x68, 0x65, 0x6c,
      0x6c, 0x6f, 0x00,
    ]);
    const decoder = new Decoder(buffer);

    expect(decoder.read_u32()).toBe(42);
    expect(decoder.read_i16()).toBe(-1234);
    expect(decoder.read_f64()).toBeCloseTo(1.2345, 4);
    expect(decoder.read_string()).toBe("hello");
    expect(decoder.read_bool()).toBe(false);
  });

  it("decodes any values", () => {
    const data = [
      "01",
      "21",
      "A802",
      "C40000C03F",
      "C8182D4454FB210940",
      "8568656C6C6F",
      "91",
      "12",
      "11",
      "320178A8020179A804",
      "5701A802C40000C03FC86957148B0ABF05401211320178A8020179A804",
      "D6010203040506",
      "61",
      "41",
      "5001A802A804A806A808A80AA80CA80EA810A812A814A816A818A81AA81CA81EA820A822",
      "F864",
      "78C701",
    ];

    const expected = [
      null,
      undefined,
      1,
      1.5,
      3.141592653589793,
      "hello",
      "",
      false,
      true,
      { x: 1, y: 2 },
      [null, 1, 1.5, 2.718281828459045, false, true, { x: 1, y: 2 }],
      Uint8Array.from([1, 2, 3, 4, 5, 6]),
      [],
      {},
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17],
      100n,
      -100n,
    ];

    data.forEach((hex, i) => {
      const decoder = new Decoder(toUint8Array(hex));

      expect(decoder.read_any()).toEqual(expected[i]);
    });
  });

  it("decodes custom types", () => {
    class CustomType {
      constructor(public value: number) {}

      static wireDecode(decoder: Decoder): CustomType {
        return new CustomType(decoder.read_u32());
      }
    }

    const buffer = Uint8Array.from([0x0f]);
    const decoder = new Decoder(buffer);
    const decoded = decoder.read(CustomType);

    expect(decoded).toBeInstanceOf(CustomType);
    expect(decoded.value).toBe(15);
  });
});
