import { describe as suite, expect, it } from "vitest";
import { wireType } from "@vworlds/vecs-wire";
import {
  componentSchema,
  describe,
  field,
  validateSet,
  type FieldSpec,
} from "../../src/schema/index.js";

suite("schema", () => {
  it("merges inference, wire and explicit metadata with inheritance", () => {
    @describe("Base description")
    class Base {
      @field({ description: "position", unit: "m", min: -1 }) @wireType("f32") x = 0;
    }
    @describe("Derived description")
    class Derived extends Base {
      @field({ type: "number", max: 10 }) @wireType("u8") count = 1;
      nested = { flag: true, labels: ["one"] };
      empty = [];
      unknown = undefined;
      nullable = null;
    }
    const { schema, fields, description } = componentSchema(Derived);
    expect(description).toBe("Derived description");
    expect(fields.x).toEqual({ type: "number", description: "position", unit: "m", min: -1 });
    expect(fields.count).toEqual({ type: "number", max: 10 });
    expect(fields.nested).toEqual({
      type: "object",
      fields: { flag: { type: "boolean" }, labels: { type: "array", items: { type: "string" } } },
    });
    expect(fields.empty).toEqual({ type: "array", items: {} });
    expect(fields.unknown).toEqual({ optional: true });
    expect(fields.nullable).toEqual({ optional: true });
    expect(schema).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      description: "Derived description",
      additionalProperties: false,
      properties: {
        x: { type: "number", minimum: -1, description: "position", "x-vecs-unit": "m" },
        count: { type: "number", maximum: 10 },
      },
    });
  });

  it("records legacy and standard field decorators and rejects unsupported standard targets", () => {
    class Legacy {
      n = 0;
    }
    field({ min: 1 })(Legacy.prototype, "n");
    expect(componentSchema(Legacy).fields.n.min).toBe(1);
    const initializers: ((this: object) => void)[] = [];
    const decorator = field({ type: "integer", description: "standard" }) as Function;
    decorator(undefined, {
      kind: "field",
      name: "n",
      static: false,
      private: false,
      addInitializer: (fn: (this: object) => void) => initializers.push(fn),
    });
    class Standard {
      n = 2;
      constructor() {
        for (const fn of initializers) {
          fn.call(this);
        }
      }
    }
    expect(componentSchema(Standard).fields.n).toEqual({
      type: "integer",
      description: "standard",
    });
    for (const context of [
      { kind: "method" },
      { static: true },
      { private: true },
      { name: Symbol() },
    ]) {
      expect(() =>
        decorator(undefined, {
          kind: "field",
          name: "n",
          static: false,
          private: false,
          ...context,
        })
      ).toThrow("public, non-static string fields");
    }
  });

  it("emits entity, enum, optional, readOnly and validator vocabulary", () => {
    class C {
      @field({ type: "entity" }) target = 1;
      @field({ type: "enum", values: ["idle", "burn"] }) state = "idle";
      @field({ type: "number", optional: true }) nullable: number | null = null;
      @field({ readOnly: true }) heat = 0;
      @field({ validate: () => undefined }) boost = 0;
    }
    expect(componentSchema(C).schema.properties).toEqual({
      target: { type: "integer", "x-vecs-entity": true },
      state: { enum: ["idle", "burn"] },
      nullable: { anyOf: [{ type: "number" }, { type: "null" }] },
      heat: { type: "number", readOnly: true },
      boost: { type: "number", "x-vecs-validated": true },
    });
    validateSet(
      C,
      { target: 42, state: "burn", nullable: null, heat: 0, boost: 0 },
      { target: 42 }
    );
  });

  it.each([
    [{ type: "number" }, "bad", "expected number"],
    [{ type: "number" }, Infinity, "expected number"],
    [{ type: "integer" }, 1.2, "expected integer"],
    [{ type: "entity" }, "42", "expected entity"],
    [{ type: "string" }, 42, "expected string"],
    [{ type: "boolean" }, 1, "expected boolean"],
    [{ type: "enum", values: ["a", "b"] }, "c", "enum member"],
    [{ type: "number", min: 1 }, 0, "minimum 1"],
    [{ type: "number", max: 1 }, 2, "maximum 1"],
    [{ type: "array", items: { type: "integer" } }, [1, "no"], "x[1]"],
    [{ type: "array" }, {}, "expected array"],
    [{ type: "object", fields: { a: { type: "boolean" } } }, { a: 1 }, "x.a"],
    [{ type: "object" }, [], "expected plain object"],
    [{ type: "number", optional: false }, null, "required number"],
    [{ readOnly: true }, 0, "readOnly"],
    [{ type: "object", fields: { a: { readOnly: true } } }, { a: 1 }, "readOnly"],
    [{ type: "array", items: { readOnly: true } }, [1], "readOnly"],
  ] as [FieldSpec, unknown, string][])("rejects invalid field %#", (spec, value, message) => {
    class C {
      x: unknown = undefined;
    }
    field(spec)(C.prototype, "x");
    expect(() => validateSet(C, { x: value }, { x: value })).toThrow(message);
  });

  it("checks unknown keys and validators against the merged draft, after types", () => {
    const seen: unknown[] = [];
    class C {
      force = 10;
      @field({
        type: "number",
        validate: (value, draft) => {
          seen.push(draft);
          return (value as number) > (draft.force as number) ? "boost exceeds force" : undefined;
        },
      })
      boost = 1;
    }
    expect(() => validateSet(C, { force: 2, boost: 3 }, { force: 2 })).toThrow(
      "boost exceeds force"
    );
    expect(seen).toEqual([{ force: 2, boost: 3 }]);
    expect(() => validateSet(C, { force: 2, boost: "no" }, { boost: "no" })).toThrow(
      "expected number"
    );
    expect(seen).toHaveLength(1);
    expect(() => validateSet(C, { force: 2, boost: 1 }, { extra: 1 })).toThrow("unknown field");
  });

  it("accepts any and optional values and validates nested rules", () => {
    class C {
      @field({ type: "any" }) data: unknown = null;
      @field({
        type: "object",
        fields: { n: { type: "number", validate: (v) => (v === 3 ? "no three" : undefined) } },
      })
      obj = { n: 1 };
    }
    validateSet(C, { data: [1, "x"], obj: { n: 2 } }, { data: [1, "x"] });
    expect(() => validateSet(C, { data: null, obj: { n: 3 } }, { obj: { n: 3 } })).toThrow(
      "obj.n: no three"
    );
  });

  it("does not remove readOnly descendants by replacing their parent container", () => {
    class C {
      @field({
        type: "object",
        optional: true,
        fields: { secret: { optional: true, readOnly: true } },
      })
      obj: object | null = { secret: 1 };
      @field({ type: "array", items: { readOnly: true } })
      items = [1];
    }
    for (const patch of [{ obj: {} }, { obj: null }, { items: [] }]) {
      expect(() => validateSet(C, { obj: { secret: 1 }, items: [1], ...patch }, patch)).toThrow(
        "readOnly"
      );
    }
  });
});
