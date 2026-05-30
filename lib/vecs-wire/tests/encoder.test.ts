import { describe, expect, it } from "vitest";
import { Decoder, Encoder, type IEncodable } from "../src/index.js";

function createEncoder(): Encoder {
  return new Encoder(new Uint8Array(1024));
}

function roundTripAny(value: unknown): unknown {
  const encoder = createEncoder();
  encoder.write_any(value);

  return new Decoder(encoder.getBuffer()).read_any();
}

describe("Encoder", () => {
  it("encodes and decodes uint32", () => {
    const encoder = createEncoder();
    encoder.write_u32(123456);

    const decoder = new Decoder(encoder.getBuffer());

    expect(decoder.read_u32()).toBe(123456);
  });

  it("encodes and decodes int32", () => {
    const encoder = createEncoder();
    encoder.write_i32(-654321);

    const decoder = new Decoder(encoder.getBuffer());

    expect(decoder.read_i32()).toBe(-654321);
  });

  it("encodes and decodes float", () => {
    const encoder = createEncoder();
    encoder.write_f32(3.14);

    const decoder = new Decoder(encoder.getBuffer());

    expect(decoder.read_f32()).toBeCloseTo(3.14, 2);
  });

  it("encodes and decodes double", () => {
    const encoder = createEncoder();
    encoder.write_f64(2.718281828);

    const decoder = new Decoder(encoder.getBuffer());
    expect(decoder.read_f64()).toBeCloseTo(2.718281828, 9);
  });

  it("encodes and decodes boolean", () => {
    const encoder = createEncoder();
    encoder.write_bool(true);

    let decoder = new Decoder(encoder.getBuffer());
    expect(decoder.read_bool()).toBe(true);

    encoder.reset();
    encoder.write_bool(false);

    decoder = new Decoder(encoder.getBuffer());
    expect(decoder.read_bool()).toBe(false);
  });

  it("encodes and decodes string", () => {
    const encoder = createEncoder();
    encoder.write_string("Hello, Vecs Wire!");

    const decoder = new Decoder(encoder.getBuffer());

    expect(decoder.read_string()).toBe("Hello, Vecs Wire!");
  });

  it("encodes and decodes bytes", () => {
    const bytes = Uint8Array.from([0x48, 0x65, 0x6c, 0x6c, 0x6f]);
    const encoder = createEncoder();
    encoder.write_buffer(bytes);

    const decoder = new Decoder(encoder.getBuffer());

    expect(decoder.read_bytes()).toStrictEqual(bytes);
  });

  it("encodes and decodes uint64", () => {
    const encoder = createEncoder();
    encoder.write_u64(BigInt(9876543210));

    const decoder = new Decoder(encoder.getBuffer());

    expect(decoder.read_u64()).toBe(BigInt(9876543210));
  });

  it("encodes and decodes int64", () => {
    const encoder = createEncoder();
    encoder.write_i64(BigInt(-9876543210));

    const decoder = new Decoder(encoder.getBuffer());

    expect(decoder.read_i64()).toBe(BigInt(-9876543210));
  });

  it("encodes and decodes primitive any arrays", () => {
    const values = [42, -1234, 3.14, true];
    const encoder = createEncoder();
    encoder.write_any(values);

    const decoder = new Decoder(encoder.getBuffer());
    const decodedValue = decoder.read_any();

    expect(Array.isArray(decodedValue)).toBe(true);
    expect(decodedValue).toHaveLength(values.length);
    (decodedValue as unknown[]).forEach((value, index) => {
      if (typeof value === "number" && !Number.isInteger(value)) {
        expect(value).toBeCloseTo(values[index] as number, 2);
      } else {
        expect(value).toEqual(values[index]);
      }
    });
  });

  it("encodes and decodes nested any arrays", () => {
    const values = [[-42, 2.7179999351501465], "Nested array test", false];
    const encoder = createEncoder();
    encoder.write_any(values);

    const decoder = new Decoder(encoder.getBuffer());

    expect(decoder.read_any()).toEqual(values);
  });

  it("encodes and decodes bigint any values", () => {
    const values = [100n, -100n, 9007199254740993n, -9007199254740993n];
    const encoder = createEncoder();
    encoder.write_any(values);

    const decoder = new Decoder(encoder.getBuffer());

    expect(decoder.read_any()).toEqual(values);
  });

  it("preserves undefined any values", () => {
    expect(roundTripAny(undefined)).toBeUndefined();
    expect(roundTripAny([1, undefined, null])).toEqual([1, undefined, null]);
    expect(roundTripAny({ present: undefined, fallback: null })).toEqual({
      present: undefined,
      fallback: null,
    });
  });
});

describe("Encoder with custom types", () => {
  class CustomType implements IEncodable {
    constructor(public value: number) {}

    wireEncode(encoder: Encoder): void {
      encoder.write_u32(this.value);
    }

    static wireDecode(decoder: Decoder): CustomType {
      return new CustomType(decoder.read_u32());
    }
  }

  it("encodes and decodes custom types", () => {
    const encoder = createEncoder();
    const customValue = new CustomType(123456);
    encoder.write(customValue);

    const decoder = new Decoder(encoder.getBuffer());
    const decodedValue = decoder.read(CustomType);

    expect(decodedValue).toBeInstanceOf(CustomType);
    expect(decodedValue.value).toBe(123456);
  });
});
