import { describe as suite, expect, it, vi } from "vitest";
import { World, type, range, description, unit, values } from "@vworlds/vecs";
import { componentSchema, describe, field, validateSet } from "../../src/schema/index.js";

suite("schema", () => {
  it("reads legacy core declarations even when the constructor is unusable", () => {
    class Resource {
      constructor() {
        throw new Error("resource requires external setup");
      }
    }
    type("string")(Resource.prototype, "label");
    description("resource name")(Resource.prototype, "label");
    expect(componentSchema(Resource).schema.properties).toEqual({
      label: { type: "string", description: "resource name" },
    });
    class UndeclaredResource {
      constructor() {
        throw new Error("no setup");
      }
    }
    expect(componentSchema(UndeclaredResource).fields).toEqual({});
  });

  it("inherits extras while allowing a derived policy to override each supplied key", () => {
    class Base {
      @type("f64") @field({ readOnly: true, optional: true }) x = 0;
    }
    class Derived extends Base {}
    field({ optional: false })(Derived.prototype, "x");
    expect(componentSchema(Derived).fields.x).toEqual({
      type: "number",
      optional: false,
      readOnly: true,
    });
    expect(componentSchema(Base).fields.x.optional).toBe(true);
  });

  it("maps inherited core members and overlays only MCP extras", () => {
    @describe("Base description")
    class Base {
      @type("f32") @range(-1, 10) @description("position") @unit("m") x = 0;
    }
    @describe("Derived description")
    class Derived extends Base {
      @type("u8") @range(0, 10) count = 1;
      @type("enum") @values([0, 2]) state = 0;
      @type("entity") target = 1;
      @type("f64") @field({ optional: true }) nullable: number | null = null;
      @type("bool") @field({ readOnly: true }) enabled = true;
      internal = "not declared";
    }
    expect(componentSchema(Derived).schema).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      description: "Derived description",
      additionalProperties: false,
      required: ["x", "count", "state", "target", "enabled"],
      properties: {
        x: {
          type: "number",
          minimum: -1,
          maximum: 10,
          description: "position",
          "x-vecs-unit": "m",
        },
        count: { type: "integer", minimum: 0, maximum: 10 },
        state: { enum: [0, 2] },
        target: { type: "integer", "x-vecs-entity": true },
        nullable: { anyOf: [{ type: "number" }, { type: "null" }] },
        enabled: { type: "boolean", readOnly: true },
      },
    });
  });

  it("maps nested and array core types without losing nested MCP policy", () => {
    class Nested {
      @type("string") label = "old";
      @type("bool") secret = false;
    }
    class C {
      @type(Nested) @field({ fields: { secret: { readOnly: true } } }) nested = new Nested();
      @type(["i32"]) @range(0, 10) list = [1];
      @type([Nested]) objects = [new Nested()];
      @type("any") data: unknown = null;
      @type("bytes") bytes = new Uint8Array();
    }
    expect(componentSchema(C).schema.properties).toEqual({
      nested: {
        type: "object",
        additionalProperties: false,
        required: ["label", "secret"],
        properties: { label: { type: "string" }, secret: { type: "boolean", readOnly: true } },
      },
      list: { type: "array", items: { type: "integer", minimum: 0, maximum: 10 } },
      objects: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["label", "secret"],
          properties: { label: { type: "string" }, secret: { type: "boolean" } },
        },
      },
      data: {},
      bytes: {},
    });
    const world = new World();
    world.component(C);
    expect(() => validateSet(world, C, { nested: {} }, { nested: {} })).toThrow("readOnly");
    world.dispose();
  });

  it("caches schemas and observes late fluent, inherited, nested and MCP declarations", () => {
    let constructions = 0;
    class Base {
      x = 0;
      constructor() {
        constructions++;
      }
    }
    class Derived extends Base {}
    const first = componentSchema(Derived);
    expect(componentSchema(Derived)).toBe(first);
    expect(constructions).toBe(1);
    const world = new World();
    world.component(Base).member("x", "f64").range(2, 10);
    const second = componentSchema(Derived);
    expect(second.fields.x.min).toBe(2);
    expect(second).not.toBe(first);
    field({ readOnly: true })(Base.prototype, "x");
    expect(componentSchema(Derived).fields.x.readOnly).toBe(true);
    describe("late description")(Base);
    expect(componentSchema(Derived).description).toBe("late description");
    class Container {
      @type(Base) nested = new Base();
    }
    const before = componentSchema(Container);
    world.component(Base).member("x", "f64").unit("m");
    expect(componentSchema(Container).fields.nested.fields?.x.unit).toBe("m");
    expect(componentSchema(Container)).not.toBe(before);
    world.dispose();
  });

  it("registers standard MCP extras once per concrete class and rejects unsupported targets", () => {
    const initializers: ((this: object) => void)[] = [];
    const decorator = field({ readOnly: true });
    const context = {
      kind: "field",
      name: "x",
      static: false,
      private: false,
      addInitializer: (fn: (this: object) => void) => initializers.push(fn),
    };
    (decorator as Function)(undefined, context);
    class C {
      x = 0;
      constructor() {
        initializers.forEach((fn) => fn.call(this));
      }
    }
    const schema = componentSchema(C);
    expect(schema.fields.x).toEqual({ type: "number", readOnly: true });
    new C();
    expect(componentSchema(C)).toBe(schema);
    for (const invalid of [
      { kind: "method" },
      { static: true },
      { private: true },
      { name: Symbol() },
    ]) {
      expect(() => (decorator as Function)(undefined, { ...context, ...invalid })).toThrow(
        "public, non-static string fields"
      );
    }
  });

  it("preserves metadata-free inference and accepts unrelated writes with invalid inferred state", () => {
    class C {
      mixed = [1, "game state"];
      nested = { flag: true, labels: ["one"] };
      empty = [];
      nullable = null;
      label = "old";
    }
    const world = new World();
    world.component(C);
    expect(componentSchema(C).fields).toEqual({
      mixed: { type: "array", items: { type: "number" } },
      nested: {
        type: "object",
        fields: { flag: { type: "boolean" }, labels: { type: "array", items: { type: "string" } } },
      },
      empty: { type: "array", items: {} },
      nullable: { optional: true },
      label: { type: "string" },
    });
    const draft = { ...new C(), label: "new" };
    expect(() => validateSet(world, C, draft, { label: "new" })).not.toThrow();
    expect(() => validateSet(world, C, draft, { mixed: draft.mixed })).toThrow("mixed[1]");
    expect(() => validateSet(world, C, draft, { extra: 1 })).toThrow("unknown field");
    world.dispose();
  });

  it.each([
    ["f64", "bad", "expected number"],
    ["f64", Infinity, "expected number"],
    ["i32", 1.2, "expected integer"],
    ["entity", "42", "expected entity"],
    ["string", 42, "expected string"],
    ["bool", 1, "expected boolean"],
    [["i32"], [1, "no"], "x[1]"],
    [["i32"], {}, "expected array"],
    ["f64", null, "required number"],
  ] as const)(
    "rejects structural errors before calling core (%s)",
    (memberType, value, message) => {
      class C {
        x: unknown = undefined;
      }
      type(memberType)(C.prototype, "x");
      field({ optional: false })(C.prototype, "x");
      const world = new World();
      const hook = vi.fn(() => true as const);
      world.component(C).on("validate", hook);
      expect(() => validateSet(world, C, { x: value }, { x: value })).toThrow(message);
      expect(hook).not.toHaveBeenCalled();
      world.dispose();
    }
  );

  it("passes merged class instances to core and preserves all violation strings", () => {
    const seen: C[] = [];
    class C {
      force = 10;
      boost = 1;
      static vecs_validate(draft: C) {
        seen.push(draft);
        return draft.boost > draft.force ? ["boost exceeds force", "second violation"] : true;
      }
    }
    const world = new World();
    world.component(C);
    expect(() => validateSet(world, C, { force: 2, boost: 3 }, { force: 2 })).toThrow(
      "boost exceeds force\nsecond violation"
    );
    expect(seen).toEqual([{ force: 2, boost: 3 }]);
    expect(seen[0]).toBeInstanceOf(C);
    world.dispose();
  });

  it("uses the core range/enum/type default on the whole draft and explicit hooks replace it", () => {
    class C {
      @type("u8") @range(0, 10) x = 1;
      @type("enum") @values([0, 2]) state = 0;
      @type("string") label = "old";
    }
    const world = new World();
    world.component(C);
    for (const draft of [
      { x: 11, state: 0 },
      { x: 1, state: 3 },
      { x: -1, state: 0 },
    ]) {
      const result = world.validate(Object.assign(new C(), draft));
      expect(result).not.toBe(true);
      expect(() => validateSet(world, C, { ...new C(), ...draft }, { label: "new" })).toThrow(
        Array.isArray(result) ? result.join("\n") : String(result)
      );
    }
    world.component(C).on("validate", () => true);
    expect(() => validateSet(world, C, { x: 99, state: 3, label: "new" }, { x: 99 })).not.toThrow();
    world.dispose();
  });

  it("does not remove readOnly descendants by replacing their parent container", () => {
    class C {
      @field({ optional: true, fields: { secret: { optional: true, readOnly: true } } }) obj:
        object | null = { secret: 1 };
      @field({ items: { readOnly: true } }) items = [1];
    }
    const world = new World();
    world.component(C);
    for (const patch of [{ obj: {} }, { obj: null }, { items: [] }]) {
      expect(() =>
        validateSet(world, C, { obj: { secret: 1 }, items: [1], ...patch }, patch)
      ).toThrow("readOnly");
    }
    world.dispose();
  });
});
