import { description, range, type, unit, values, VecsStruct, World } from "@vworlds/vecs";
import { describe, expect, it } from "vitest";
import { Decoder, Encoder, tag, wireFields, wireType } from "../src/index.js";

function encode(value: object): Uint8Array {
  const encoder = new Encoder(new Uint8Array(1024));
  encoder.write(value);
  return encoder.getBuffer();
}

describe("reflection wire fallback", () => {
  it("round-trips decorator-only members, base first, without a world", () => {
    class Point {
      @type("i32") public x = 0;
    }
    class Base {
      @type("u8") @range(0, 1) @unit("m") @description("Metadata only") public id = 0;
    }
    class Reflected extends Base {
      @type("entity") public target: { eid: number } | number = { eid: 0 };
      @type(Point) public point = new Point();
      @type([Point]) public points: Point[] = [];
      @type(["entity"]) public targets: ({ eid: number } | number)[] = [];
      @type(["u16"]) public ids: number[] = [];
      @type("enum") @values([1, 2]) public mode = 1;
    }
    const value = Object.assign(new Reflected(), {
      id: 7,
      target: { eid: 42 },
      point: Object.assign(new Point(), { x: -3 }),
      points: [Object.assign(new Point(), { x: 5 })],
      targets: [{ eid: 99 }],
      ids: [300],
      mode: 4,
    });
    const bytes = encode(value);
    expect(Array.from(bytes)).toEqual([7, 42, 5, 1, 10, 1, 99, 1, 172, 2, 8]);
    const decoded = new Decoder(bytes).read(Reflected);
    expect(decoded).toBeInstanceOf(Reflected);
    expect(decoded).toEqual({
      id: 7,
      target: 42,
      point: { x: -3 },
      points: [{ x: 5 }],
      targets: [99],
      ids: [300],
      mode: 4,
    });
    expect(decoded.point).toBeInstanceOf(Point);
    expect(decoded.points[0]).toBeInstanceOf(Point);
    expect(wireFields(Reflected)).toEqual([]);
  });

  it("round-trips fluent-only members including entities, nested classes and arrays", () => {
    class Point {
      public x = 0;
    }
    class Reflected {
      public target: { eid: number } | number = { eid: 0 };
      public point = new Point();
      public ids: number[] = [];
    }
    const world = new World();
    world.component(Point).member("x", "i32");
    world
      .component(Reflected)
      .member("target", "entity")
      .member("point", Point)
      .member("ids", ["u16"]);
    const value = Object.assign(new Reflected(), {
      target: { eid: 55 },
      point: Object.assign(new Point(), { x: -7 }),
      ids: [1, 300],
    });
    const decoded = new Decoder(encode(value)).read(Reflected);
    expect(decoded).toEqual({ target: 55, point: { x: -7 }, ids: [1, 300] });
    expect(decoded.point).toBeInstanceOf(Point);
    expect(new Decoder(encode(new Reflected())).read(Reflected).ids).toEqual([]);
  });

  it("compiles on decode first and ignores declarations after compilation", () => {
    class Reflected {
      @type("u8") public first = 0;
      public later = 0;
    }
    expect(new Decoder(Uint8Array.of(7)).read(Reflected).first).toBe(7);
    new World().component(Reflected).member("later", "u8");
    const value = Object.assign(new Reflected(), { first: 8, later: 9 });
    expect(Array.from(encode(value))).toEqual([8]);
    expect(new Decoder(encode(value)).read(Reflected).later).toBe(0);
  });

  it("ignores members added after the first encode while reflection stays live", () => {
    class Reflected {
      @type("u8") public first = 0;
      public later = 0;
    }
    const value = Object.assign(new Reflected(), { first: 3, later: 4 });
    expect(Array.from(encode(value))).toEqual([3]);
    new World().component(Reflected).member("later", "u8");
    expect(Object.keys(VecsStruct.of(Reflected)!.members)).toEqual(["first", "later"]);
    expect(Array.from(encode(value))).toEqual([3]);
    expect(new Decoder(encode(value)).read(Reflected).later).toBe(0);
  });

  it("uses only wire fields when the same class also has reflection", () => {
    class Mixed {
      @wireType("u8") @type("u16") public sent = 0;
      @type("u8") public local = 0;
    }
    const value = Object.assign(new Mixed(), { sent: 7, local: 8 });
    expect(Array.from(encode(value))).toEqual([7]);
    expect(new Decoder(encode(value)).read(Mixed)).toEqual({ sent: 7, local: 0 });
  });

  it("ignores reflection throughout the chain if any base or subclass declares wire fields", () => {
    class WireBase {
      @wireType("u8") public sent = 0;
    }
    class ReflectedChild extends WireBase {
      @type("u8") public local = 0;
    }
    class ReflectedBase {
      @type("u8") public local = 0;
    }
    class WireChild extends ReflectedBase {
      @wireType("u8") public sent = 0;
    }
    for (const C of [ReflectedChild, WireChild]) {
      const value = Object.assign(new C(), { sent: 5, local: 6 });
      expect(Array.from(encode(value))).toEqual([5]);
      expect(new Decoder(encode(value)).read(C)).toEqual({ sent: 5, local: 0 });
    }
  });

  it("keeps explicit tags presence-only even when reflection is available", () => {
    @tag
    class Marker {
      @type("u8") public local = 0;
    }
    expect(Array.from(encode(Object.assign(new Marker(), { local: 9 })))).toEqual([]);
    expect(new Decoder(new Uint8Array()).read(Marker)).toEqual({ local: 0 });
  });

  it("compiles subclasses independently after a reflected base has been used", () => {
    class Base {
      @type("u8") public first = 1;
    }
    class Child extends Base {
      @type("u8") public second = 2;
    }
    class DecodeChild extends Base {
      @type("u8") public third = 3;
    }
    expect(Array.from(encode(new Base()))).toEqual([1]);
    expect(Array.from(encode(new Child()))).toEqual([1, 2]);
    expect(new Decoder(Uint8Array.of(4, 5)).read(DecodeChild)).toEqual({ first: 4, third: 5 });
    expect(new Decoder(Uint8Array.of(6, 7)).read(Child)).toEqual({ first: 6, second: 7 });
    expect(Array.from(encode(new Base()))).toEqual([1]);
  });

  it("preserves custom codecs instead of compiling reflection", () => {
    class Custom {
      @type("u8") public local = 7;
      public wireEncode(encoder: Encoder): void {
        encoder.write_u8(42);
      }
      public static wireDecode(decoder: Decoder): Custom {
        return Object.assign(new Custom(), { local: decoder.read_u8() + 1 });
      }
    }
    expect(Array.from(encode(new Custom()))).toEqual([42]);
    expect(new Decoder(Uint8Array.of(42)).read(Custom).local).toBe(43);
  });

  it("retains array validation and rejects truncated reflected payloads", () => {
    class Reflected {
      @type(["u8"]) public items: unknown = [];
    }
    expect(() => encode(Object.assign(new Reflected(), { items: 42 }))).toThrow(
      "items must be an array"
    );
    expect(() => new Decoder(Uint8Array.of(2, 7)).read(Reflected)).toThrow(RangeError);
  });

  it("rejects a class with neither reflection nor a wire definition", () => {
    class Plain {
      public value = 1;
    }
    expect(() => encode(new Plain())).toThrow("requires a wireEncode method");
    expect(() => new Decoder(Uint8Array.of(1)).read(Plain)).toThrow("requires a wireDecode method");
  });
});
