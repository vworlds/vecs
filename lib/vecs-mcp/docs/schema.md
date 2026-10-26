# Component schemas and validation

Describe agent-visible data with core reflection and keep MCP write policy separate.

## Declare shared metadata

Use core decorators from `@vworlds/vecs` for member types, ranges, descriptions,
units and enum values. Both legacy TypeScript and standard field decorators work.
Use `@field` from `@vworlds/vecs-mcp/schema` only for MCP-specific `optional` and
`readOnly` policy. Class-level `@describe` stays in MCP because core has no class
description.

```ts
import { type, range, unit } from "@vworlds/vecs";
import { describe, field } from "@vworlds/vecs-mcp/schema";

@describe("Engine controls")
class Thruster {
  @type("f64")
  @range(0, 50)
  @unit("N")
  force = 10;

  @type("f64")
  boost = 0;

  @type("f64")
  @field({ readOnly: true })
  heat = 0;

  static vecs_validate(draft: Thruster) {
    return draft.boost > draft.force ? "boost exceeds force" : true;
  }
}
```

An explicit hook replaces core's default range/integer/enum validator; enforce
any required ranges inside that hook too. See [core reflection](../../vecs/docs/reflection.md)
for fluent declarations and validation semantics. Nothing validates automatically
on game-time `set`; MCP explicitly calls `world.validate` at its write boundary.

## Read schemas

`componentSchema(C)` returns `{ schema, fields, description? }`. Treat the result
as read-only. It reads the composed members from `VecsStruct.of(C)`, base class
first. For a class without reflection members, it keeps the previous fallback:
construct `new C()` for inference, then overlay `wireFields(C)`. Failed
constructors yield no inferred fields. Reflected classes expose only declared
members, not additional instance fields.

Inference traverses plain objects and the first array element; empty arrays have
unconstrained items. `null` and `undefined` infer optional unknown fields.
Non-plain class values are not traversed. Overlay inherited MCP extras base-first;
`items` and `fields` can carry nested optional/read-only policy without replacing
core types. Use `optional: false` to override inherited or inferred optionality.
Descriptions inherit unless overridden. Cached schemas refresh when core members
(including nested definitions), MCP extras or class descriptions change.

| Core metadata           | JSON Schema                              |
| ----------------------- | ---------------------------------------- |
| `f32`, `f64`            | `type: "number"`                         |
| Integer types           | `type: "integer"`                        |
| `bool`, `string`        | `type: "boolean"`, `type: "string"`      |
| `entity`                | `type: "integer"`, `x-vecs-entity: true` |
| `enum` with `values`    | `enum`                                   |
| Nested class / `[type]` | Object properties / array items          |
| `range`                 | `minimum`, `maximum`                     |
| `description`, `unit`   | `description`, `x-vecs-unit`             |

`any` and `bytes` add no JSON type constraint. Bigint members remain opaque to
MCP writes; range bounds are represented as JSON numbers in schemas.
Optional fields use nullable `anyOf` and are omitted from `required`; read-only
fields emit `readOnly: true`. Schemas use draft 2020-12 vocabulary.

## Validate external writes

`validateSet(world, C, draft, patch)` first checks written fields structurally:
types, unknown keys and read-only policy (including nested fields). Then it calls
`world.validate` on a copy of the whole merged draft with `C.prototype`, so core
can resolve the registered class and hooks can inspect untouched fields.
The caller must register `C` in that world and merge the current value with the
patch before calling. Core violation strings are unchanged; lists are joined
with newlines in the error. The bridge adds its existing `ops[index]` context.

Structural checks still ignore invalid untouched inferred fields, but core's
default range/integer/enum checks now cover the **whole draft**, including
untouched members. MCP checks structural errors before calling hooks. It runs
validation during batch preflight and again at the write boundary to account for
hook-induced changes, so validation hooks must be pure.

## Migrate MCP declarations

Replace `@field` type/documentation options with core decorators:
`number` → `@type("f64")`, `integer` → `@type("i32")`, `boolean` →
`@type("bool")`, `min`/`max` → `@range`, and `description`, `unit`, `values` →
the corresponding core decorators. Core enum values are numeric. Declare nested
objects with a class and arrays with `[type]`. Replace field `validate` callbacks
with `vecs_validate` or `.on("validate", hook)` on the component; return `true`
on success. MCP no longer emits the field-specific `x-vecs-validated` extension.
The old options are removed; `@field` accepts only MCP extras.
