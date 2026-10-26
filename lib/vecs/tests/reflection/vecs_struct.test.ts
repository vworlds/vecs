import { describe, expect, it, vi } from "vitest";
import {
  Component,
  ComponentDef,
  description,
  range,
  type,
  unit,
  values,
  VecsStruct,
  World,
  type MemberType,
} from "../../src/index.js";

// Definitions are per class for the whole process, so every test declares its
// own classes.

interface StandardFieldDefinition {
  name: string;
  decorators: ReturnType<typeof type>[];
}

type StandardDecorator = (
  value: undefined,
  context: {
    kind: string;
    name: string;
    static: boolean;
    private: boolean;
    metadata: Record<PropertyKey, unknown>;
    addInitializer(initializer: () => void): void;
  }
) => void;

/** Apply decorators the way a standard (TC39) compiler does, through `context.metadata`. */
function standardDecorated<T extends abstract new () => object>(
  Base: T,
  fields: readonly StandardFieldDefinition[]
): T {
  const metadata: Record<PropertyKey, unknown> = Object.create(null);
  for (const field of fields) {
    for (const decorator of [...field.decorators].reverse()) {
      (decorator as unknown as StandardDecorator)(undefined, {
        kind: "field",
        name: field.name,
        static: false,
        private: false,
        metadata,
        addInitializer: () => {
          throw new Error("metadata is available; no initializer expected");
        },
      });
    }
  }
  Object.defineProperty(Base, (Symbol as unknown as { metadata: symbol }).metadata, {
    value: metadata,
  });
  return Base;
}

const POSITION_STRUCT = {
  x: { type: "i32", range: [-100, 100], unit: "m", description: "The X coordinate" },
  y: { type: "i32", range: [-100, 100] },
};

describe("VecsStruct", () => {
  it("builds the same definition from fluent, decorator, standard and mixed declarations", () => {
    class Fluent {
      public x = 0;
      public y = 0;
    }
    class Decorated {
      @type("i32") @range(-100, 100) @unit("m") @description("The X coordinate") public x = 0;
      @type("i32") @range(-100, 100) public y = 0;
    }
    const Standard = standardDecorated(
      class Standard {
        public x = 0;
        public y = 0;
      },
      [
        {
          name: "x",
          decorators: [type("i32"), range(-100, 100), unit("m"), description("The X coordinate")],
        },
        { name: "y", decorators: [type("i32"), range(-100, 100)] },
      ]
    );
    class Mixed {
      @type("i32") @unit("m") public x = 0;
      public y = 0;
    }

    const world = new World();
    world
      .component(Fluent)
      .member("x", "i32")
      .range(-100, 100)
      .unit("m")
      .description("The X coordinate")
      .member("y", "i32")
      .range(-100, 100);
    world
      .component(Mixed)
      .member("x", "i32")
      .range(-100, 100)
      .description("The X coordinate")
      .member("y", "i32")
      .range(-100, 100);

    for (const Class of [Fluent, Decorated, Standard, Mixed]) {
      const struct = world.component(Class).get(VecsStruct);
      expect(struct).toBeInstanceOf(VecsStruct);
      expect(struct?.members).toEqual(POSITION_STRUCT);
      expect(Object.keys(struct!.members)).toEqual(["x", "y"]);
    }
  });

  it("returns the component from member() and applies modifiers to the last member", () => {
    class Three {
      public a = 0;
      public b = 0;
      public c = 0;
    }
    const world = new World();
    const onSet = vi.fn();
    const chained = world
      .component(Three)
      .member("a", "u8")
      .range(0, 9)
      .member("b", "f32")
      .unit("m")
      .description("Bee")
      .member("c", "enum")
      .values([1, 2])
      .on("set", onSet);

    expect(chained).toBeInstanceOf(Component);
    expect(chained).toBe(world.component(Three));
    expect(world.component(Three).member("a", "u8")).toBe(world.component(Three));
    expect(chained.get(VecsStruct)!.members).toEqual({
      a: { type: "u8", range: [0, 9] },
      b: { type: "f32", unit: "m", description: "Bee" },
      c: { type: "enum", values: [1, 2] },
    });
    const entity = world.entity().set(Three, { a: 1 });
    expect(onSet).toHaveBeenCalledWith(entity, entity.get(Three));
  });

  it("throws for a modifier before any member() on that component", () => {
    class Bare {
      public v = 0;
    }
    class Other {
      public v = 0;
    }
    const world = new World();
    world.component(Other).member("v", "u8");
    const bare = world.component(Bare);

    for (const modifier of [
      () => bare.range(0, 1),
      () => bare.description("d"),
      () => bare.unit("m"),
      () => bare.values([1]),
    ]) {
      expect(modifier).toThrow("on Bare: call .member(name, type) first");
    }
    expect(() => new World().component(Other).range(0, 1)).toThrow(
      "range() on Other: call .member(name, type) first"
    );
    expect(bare.has(VecsStruct)).toBe(false);
  });

  it("lists base class members first, then declaration order", () => {
    class Base {
      @type("f32") public b = 0;
      @type("f32") public a = 0;
    }
    class Derived extends Base {
      @type("string") public d = "";
      @type("bool") public c = false;
      public e = 0;
    }
    const world = new World();
    world.component(Derived).member("e", "u8");

    expect(Object.keys(world.component(Derived).get(VecsStruct)!.members)).toEqual([
      "b",
      "a",
      "d",
      "c",
      "e",
    ]);
  });

  it("inherits fluent declarations made on a base class before the subclass registers", () => {
    class Base {
      public x = 0;
    }
    class Derived extends Base {
      @type("u8") public d = 0;
    }
    const world = new World();
    world.component(Base).member("x", "i32").range(-5, 5);
    const derived = world.component(Derived);

    expect(derived.get(VecsStruct)!.members).toEqual({
      x: { type: "i32", range: [-5, 5] },
      d: { type: "u8" },
    });
    expect(Object.keys(derived.get(VecsStruct)!.members)).toEqual(["x", "d"]);
  });

  it("inherits fluent declarations made on a base class after the subclass registered", () => {
    class Base {
      public x = 0;
    }
    class Derived extends Base {
      public d = 0;
    }
    class Unrelated {
      public u = 0;
    }
    const world = new World();
    const derived = world.component(Derived);
    const unrelated = world.component(Unrelated);
    world.component(Base).member("x", "i32").range(-5, 5);
    derived.member("d", "u8");

    expect(derived.get(VecsStruct)!.members).toEqual({
      x: { type: "i32", range: [-5, 5] },
      d: { type: "u8" },
    });
    expect(unrelated.has(VecsStruct)).toBe(false);
    // Another world sees the same inherited definition.
    expect(new World().component(Derived).get(VecsStruct)).toBe(derived.get(VecsStruct));
  });

  it("builds the same subclass definition whether the base used decorators or fluent calls", () => {
    class DecoratedBase {
      @type("f32") @unit("m") public x = 0;
    }
    class FluentBase {
      public x = 0;
    }
    class FromDecorated extends DecoratedBase {
      @type("bool") public flag = false;
    }
    class FromFluent extends FluentBase {
      @type("bool") public flag = false;
    }
    const world = new World();
    world.component(FluentBase).member("x", "f32").unit("m");

    expect(world.component(FromFluent).get(VecsStruct)!.members).toEqual(
      world.component(FromDecorated).get(VecsStruct)!.members
    );
  });

  it("fills a subclass member with fields its base class declares later", () => {
    class Base {
      public x = 0;
    }
    class Derived extends Base {}
    const world = new World();
    world.component(Base).member("x", "i32");
    world.component(Derived).member("x", "i32").unit("m");
    world.component(Base).member("x", "i32").range(0, 9);

    expect(world.component(Derived).get(VecsStruct)!.members.x).toEqual({
      type: "i32",
      range: [0, 9],
      unit: "m",
    });
    expect(world.component(Base).get(VecsStruct)!.members.x).toEqual({
      type: "i32",
      range: [0, 9],
    });
  });

  it("throws when a base class declaration contradicts a subclass", () => {
    class Base {
      public x = 0;
    }
    class Derived extends Base {
      @type("i32") @range(0, 10) public override x = 0;
    }
    const world = new World();
    world.component(Derived);

    expect(() => world.component(Base).member("x", "u8")).toThrow(
      "VecsStruct Derived.x: type i32 contradicts the existing type u8"
    );
    expect(() => world.component(Base).member("x", "i32").range(0, 20)).toThrow(
      "VecsStruct Derived.x: range [0, 10] contradicts the existing range [0, 20]"
    );
    expect(world.component(Derived).get(VecsStruct)!.members.x).toEqual({
      type: "i32",
      range: [0, 10],
    });
  });

  it("records nested classes, arrays and enum values", () => {
    class Inner {
      @type("f64") public v = 0;
    }
    class Outer {
      @type(Inner) public inner = new Inner();
      @type(["u16"]) public ids: number[] = [];
      @type("enum") @values([1, 2, 4]) public mode = 1;
    }
    const members = new World().component(Outer).get(VecsStruct)!.members;
    expect(members.inner).toEqual({ type: Inner });
    expect(members.ids).toEqual({ type: ["u16"] });
    expect(members.mode).toEqual({ type: "enum", values: [1, 2, 4] });
  });

  it("attaches one frozen instance in every world", () => {
    class Shared {
      @type("u8") public level = 0;
    }
    const a = new World();
    const b = new World();
    const structA = a.component(Shared).get(VecsStruct);
    const structB = b.component(Shared).get(VecsStruct);

    expect(structA).toBe(structB);
    expect(Object.isFrozen(structA)).toBe(true);
    expect(Object.isFrozen(structA!.members)).toBe(true);
    expect(Object.isFrozen(structA!.members.level)).toBe(true);
    expect(() =>
      a.component(Shared).getMut(VecsStruct, (struct) => {
        (struct as { members: object }).members = {};
      })
    ).toThrow(TypeError);
  });

  it("repeats an identical fluent declaration in a second world without changes", () => {
    class Speed {
      public value = 0;
    }
    const register = (world: World) =>
      world.component(Speed).member("value", "f32").range(0, 10).unit("m/s");
    const a = new World();
    const b = new World();
    register(a);
    const before = a.component(Speed).get(VecsStruct)!.members;
    register(b);

    expect(b.component(Speed).get(VecsStruct)).toBe(a.component(Speed).get(VecsStruct));
    expect(a.component(Speed).get(VecsStruct)!.members).toBe(before);
  });

  it("shows a later declaration through the instance other worlds already carry", () => {
    class Growing {
      @type("u8") public a = 0;
      public b = 0;
    }
    const a = new World();
    const b = new World();
    const structA = a.component(Growing).get(VecsStruct)!;
    b.component(Growing).member("b", "u8");

    expect(Object.keys(structA.members)).toEqual(["a", "b"]);
  });

  it("throws on a contradiction, naming the class and the member", () => {
    class Contradicted {
      @type("i32") @range(0, 10) public x = 0;
    }
    const a = new World();
    a.component(Contradicted);
    const b = new World();

    expect(() => b.component(Contradicted).member("x", "u8")).toThrow(
      "VecsStruct Contradicted.x: type u8 contradicts the existing type i32"
    );
    expect(() => b.component(Contradicted).member("x", "i32").range(0, 20)).toThrow(
      "VecsStruct Contradicted.x: range [0, 20] contradicts the existing range [0, 10]"
    );
    expect(a.component(Contradicted).get(VecsStruct)!.members.x).toEqual({
      type: "i32",
      range: [0, 10],
    });
  });

  it("throws on an inherited contradiction", () => {
    class Base {
      @type("u8") public v = 0;
    }
    class Derived extends Base {
      @type("u16") public override v = 0;
    }
    const world = new World();
    expect(() => world.component(Derived)).toThrow(
      "VecsStruct Derived.v: type u16 contradicts the existing type u8"
    );
    expect(world.getEntity(Derived)).toBeUndefined();
  });

  it("rejects malformed declarations", () => {
    class Untyped {
      @range(0, 1) public v = 0;
    }
    class Texts {
      public s = "";
      public big = 0n;
      public e = 0;
    }
    expect(() => new World().component(Untyped)).toThrow(
      "VecsStruct Untyped.v: member metadata needs a type"
    );
    const component = new World().component(Texts);
    expect(() => component.member("s", "string").range(0, 1)).toThrow(
      "range needs a numeric type, not string"
    );
    expect(() => component.member("big", "u64").range(0.5, 1)).toThrow(
      "range bounds of a 64-bit member must be integers"
    );
    expect(() => component.member("e", "i32").values([1])).toThrow(
      "values needs an enum type, not i32"
    );
    expect(() => type("float" as MemberType)).toThrow("@type: unsupported member type float");
    expect(() => {
      class Twice {
        @type("u8") @type("u8") public v = 0;
      }
      return Twice;
    }).toThrow("VecsStruct Twice.v: type is declared twice");
  });

  it("stores 64-bit ranges as bigint", () => {
    class Wide {
      @type("u64") @range(0, 1000) public n = 0n;
    }
    expect(new World().component(Wide).get(VecsStruct)!.members.n.range).toEqual([0n, 1000n]);
  });

  it("leaves a class without metadata as before", () => {
    class Plain {
      public v = 0;
    }
    const world = new World();
    const component = world.component(Plain);

    expect(world.getEntity(VecsStruct)).toBeUndefined();
    expect(component.components.values().map((c) => c.constructor)).toEqual([ComponentDef]);
  });
});
