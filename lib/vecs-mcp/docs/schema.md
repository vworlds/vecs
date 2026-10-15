# Schema decorators

Describe component data for agents without changing game-time behavior.

Import from `@vworlds/vecs-mcp/schema` in shared code. Both legacy TypeScript and
standard field decorators are supported. Metadata is recorded in a WeakMap;
validators are not called by game systems. Standard decorator initializers
register metadata when an instance is constructed, just like vecs-wire.

```ts
import { describe, field } from "@vworlds/vecs-mcp/schema";

@describe("Engine controls")
class Thruster {
  @field({ type: "number", min: 0, max: 50, unit: "N" })
  force = 10;

  @field({
    type: "number",
    validate: (value, draft) =>
      (value as number) > (draft.force as number) ? "boost exceeds force" : undefined,
  })
  boost = 0;
}
```

`componentSchema(C)` returns `{ schema, fields, description? }`. It constructs
`new C()` for initializer inference (failed constructors yield no inferred
fields), overlays `wireFields(C)` metadata, then overlays inherited `@field`
metadata base-first. Each supplied spec key overrides the lower-priority value.
Descriptions inherit unless overridden. Inference recurses through plain objects
and the first array element; empty arrays have unconstrained items. `null` and
`undefined` infer unknown, optional fields, not a concrete type. Non-plain class
values are not traversed. Explicitly set `optional: false` to override inferred
optionality.

| Key                      | Meaning                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------ |
| `type`                   | `number`, `integer`, `string`, `boolean`, `entity`, `enum`, `object`, `array`, `any` |
| `description`, `unit`    | Agent documentation; unit becomes `x-vecs-unit`                                      |
| `min`, `max`             | Inclusive numeric bounds                                                             |
| `values`                 | Allowed JSON enum values                                                             |
| `items`, `fields`        | Array item spec and nested object field specs                                        |
| `optional`               | Accept `null` or `undefined`; omit from JSON Schema required list                    |
| `readOnly`               | Reject writes even when the value is unchanged                                       |
| `validate(value, draft)` | Return an error string or nothing; draft is the merged whole component               |

`validateSet(C, draft, patch)` checks the whole merged draft, rejects unknown
patch fields and written read-only fields (nested too), then runs validators.
The bridge calls it only for `set`, during static validation and again at the
write boundary to account for hook-induced changes. Validators should therefore
be pure. Type failures prevent validators from running. No runtime function
appears in JSON Schema: validators become `x-vecs-validated: true`; entity fields
become `{ "type": "integer", "x-vecs-entity": true }`. Optional fields use a
nullable `anyOf`; the schema uses draft 2020-12 vocabulary.

`wireFields(C)` in vecs-wire returns a frozen, detached array of `{ key, spec }`
including inherited fields, or `[]` for an unregistered class. As with standard
`@wireType`, construct an instance before asking for standard-decorated metadata.
