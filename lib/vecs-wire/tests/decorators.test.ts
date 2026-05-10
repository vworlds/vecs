import { describe, expect, it } from "vitest";
import { Decoder, Encoder, type } from "../src/index.js";

function roundTrip<T>(C: new () => T, value: object): T {
  const encoder = new Encoder(new Uint8Array(4096));
  encoder.write(value);

  return new Decoder(encoder.getBuffer()).read(C);
}

describe("type decorator", () => {
  it("generates wireEncode and wireDecode for primitive fields", () => {
    class Scalars {
      @type("bool")
      public enabled = false;

      @type("u8")
      public u8 = 0;

      @type("i8")
      public i8 = 0;

      @type("u16")
      public u16 = 0;

      @type("i16")
      public i16 = 0;

      @type("u32")
      public u32 = 0;

      @type("i32")
      public i32 = 0;

      @type("u64")
      public u64 = 0n;

      @type("i64")
      public i64 = 0n;

      @type("enum")
      public state = 0;

      @type("f32")
      public f32 = 0;

      @type("f64")
      public f64 = 0;

      @type("string")
      public name = "";

      @type("bytes")
      public payload = new Uint8Array();

      @type("any")
      public extra: unknown = null;
    }

    const value = new Scalars();
    value.enabled = true;
    value.u8 = 255;
    value.i8 = -12;
    value.u16 = 12345;
    value.i16 = -1234;
    value.u32 = 123456;
    value.i32 = -654321;
    value.u64 = 9876543210n;
    value.i64 = -9876543210n;
    value.state = 3;
    value.f32 = 3.5;
    value.f64 = Math.PI;
    value.name = "position";
    value.payload = Uint8Array.from([1, 2, 3]);
    value.extra = { ok: true, values: [1, 2, 3] };

    const decoded = roundTrip(Scalars, value);

    expect(decoded).toBeInstanceOf(Scalars);
    expect(decoded.enabled).toBe(true);
    expect(decoded.u8).toBe(255);
    expect(decoded.i8).toBe(-12);
    expect(decoded.u16).toBe(12345);
    expect(decoded.i16).toBe(-1234);
    expect(decoded.u32).toBe(123456);
    expect(decoded.i32).toBe(-654321);
    expect(decoded.u64).toBe(9876543210n);
    expect(decoded.i64).toBe(-9876543210n);
    expect(decoded.state).toBe(3);
    expect(decoded.f32).toBe(3.5);
    expect(decoded.f64).toBe(Math.PI);
    expect(decoded.name).toBe("position");
    expect(decoded.payload).toStrictEqual(Uint8Array.from([1, 2, 3]));
    expect(decoded.extra).toEqual({ ok: true, values: [1, 2, 3] });
  });

  it("encodes arrays as a u32 length followed by elements", () => {
    class NumberList {
      @type(["u32"])
      public values: number[] = [];
    }

    const value = new NumberList();
    value.values = [1, 2, 300];

    const encoder = new Encoder(new Uint8Array(128));
    encoder.write(value);

    expect(Array.from(encoder.getBuffer())).toEqual([3, 1, 2, 0xac, 0x02]);
    expect(new Decoder(encoder.getBuffer()).read(NumberList).values).toEqual([1, 2, 300]);
  });

  it("round-trips empty arrays", () => {
    class EmptyList {
      @type(["string"])
      public values: string[] = [];
    }

    expect(roundTrip(EmptyList, new EmptyList()).values).toEqual([]);
  });

  it("round-trips nested decorated classes", () => {
    class Position {
      @type("u32")
      public x = 0;

      @type("u32")
      public y = 0;
    }

    class Player {
      @type(Position)
      public position = new Position();
    }

    const value = new Player();
    value.position.x = 10;
    value.position.y = 20;

    const decoded = roundTrip(Player, value);

    expect(decoded).toBeInstanceOf(Player);
    expect(decoded.position).toBeInstanceOf(Position);
    expect(decoded.position.x).toBe(10);
    expect(decoded.position.y).toBe(20);
  });

  it("round-trips arrays of nested decorated classes", () => {
    class Position {
      @type("i32")
      public x = 0;

      @type("i32")
      public y = 0;
    }

    class Trail {
      @type([Position])
      public points: Position[] = [];
    }

    const first = new Position();
    first.x = -1;
    first.y = -2;

    const second = new Position();
    second.x = 3;
    second.y = 4;

    const value = new Trail();
    value.points = [first, second];

    const decoded = roundTrip(Trail, value);

    expect(decoded.points).toHaveLength(2);
    expect(decoded.points[0]).toBeInstanceOf(Position);
    expect(decoded.points[0].x).toBe(-1);
    expect(decoded.points[0].y).toBe(-2);
    expect(decoded.points[1]).toBeInstanceOf(Position);
    expect(decoded.points[1].x).toBe(3);
    expect(decoded.points[1].y).toBe(4);
  });

  it("does not share metadata between classes", () => {
    class A {
      @type("u32")
      public value = 1;
    }

    class B {
      @type("string")
      public value = "b";
    }

    const a = new A();
    a.value = 7;
    const b = new B();
    b.value = "separate";

    expect(roundTrip(A, a).value).toBe(7);
    expect(roundTrip(B, b).value).toBe("separate");
  });

  it("throws when an array field is not an array", () => {
    class NumberList {
      @type(["u32"])
      public values: unknown = [];
    }

    const value = new NumberList();
    value.values = 123;

    expect(() => {
      const encoder = new Encoder(new Uint8Array(128));
      encoder.write(value);
    }).toThrow("values must be an array");
  });
});
