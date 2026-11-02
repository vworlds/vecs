# Component reflection

Declare the types and metadata of a component's members, read them back through `VecsStruct`, and
check or fix component data with `validate` and `normalize` hooks.

## Concept

A component class is plain data, so the ECS cannot tell an `i32` from an `f64` or a meter from a
degree by looking at it. Reflection lets you declare it once and then use it anywhere: an editor or
inspector, a generated UI, a schema, or a check on data that arrives from outside.

- **Member types** name what each field holds: a scalar, a nested component class, or an array.
- **`VecsStruct`** is a core component holding the declared members. It sits on the class's
  **component entity**, so you query it like any other component.
- **`validate` and `normalize` hooks** check a component instance or fix it in place. They run only
  when you call `world.validate`, `world.isValid` or `world.normalize`. Nothing runs them on `set`,
  so declaring metadata adds no cost per mutation.

A class without declarations registers and behaves exactly as before. Its component entity does not
carry a `VecsStruct`.

## Declaring members

You can declare members in three equivalent forms. They all produce the same definition.

```ts
import { description, range, type, unit, World } from "@vworlds/vecs";

// Decorators, read by world.component(Position).
class Position {
  @type("i32") @range(-100, 100) @unit("m") @description("The X coordinate") x = 0;
  @type("i32") @range(-100, 100) y = 0;
}

// Fluent, on the component entity.
class Velocity {
  dx = 0;
  dy = 0;
}

const world = new World();
world.component(Position);
world
  .component(Velocity)
  .member("dx", "f32")
  .range(-10, 10)
  .unit("m/s")
  .member("dy", "f32")
  .range(-10, 10)
  .unit("m/s");
```

The fluent form follows Flecs: `.member(name, type)` returns the `Component` itself, and each
modifier (`.range`, `.description`, `.unit`, `.values`) applies to the member most recently
declared with `.member` on that component entity, in that world. Because the chain stays on the
`Component`, it can carry on with `.on(…)` or any other component method:

```ts
class Score {
  value = 0;
}

const score = world
  .component(Score)
  .member("value", "u32")
  .description("Points scored")
  .on("set", (entity, s) => console.log(entity.eid, s.value));
score === world.component(Score); // true
```

A modifier called before any `.member` on that component throws, telling you to call
`.member(name, type)` first.

You can also mix the forms. A fluent call that repeats a decorated member with the same type adds
the fields it is missing:

```ts
class Heading {
  @type("f32") @unit("deg") angle = 0;
}

world.component(Heading).member("angle", "f32").range(0, 360);
```

Decorators work in both legacy (`experimentalDecorators`) and standard (TC39) mode. In standard mode
they store their declarations in the class's decorator metadata. Importing `@vworlds/vecs` defines
`Symbol.metadata` when the runtime lacks it, so `world.component(C)` reads the declarations without
constructing an instance.

Every member that carries metadata needs a type. A `@range` without a `@type` throws when you
register the class.

## Reading the definition

```ts
import { VecsStruct } from "@vworlds/vecs";

const struct = world.component(Position).get(VecsStruct);
struct?.members.x; // { type: "i32", range: [-100, 100], unit: "m", description: "The X coordinate" }

// Read the same frozen instance without creating a world or constructing Position.
VecsStruct.of(Position) === struct; // true
```

Members are inherited along the class chain, however the base class declared them: a subclass of a
class with fluent declarations gets the same members as a subclass of a decorated one. They are
listed base class first, then in declaration order. A subclass may repeat an inherited member to add
fields, such as a `unit`, but not to change one.

Use `VecsStruct.of(C)` for world-free access. It reads decorators and existing fluent declarations,
returning `undefined` if neither the class nor its bases declares members. Its `members` view stays
live, just like the instance attached to each world.

The definition is **per class, for the whole process**:

- The first registration builds it. Later declarations, in any world, merge into it.
- A declaration that repeats the definition is a no-op. That makes it safe to run the same
  registration code for every world.
- A declaration that contradicts it (a different type, range, unit, description or set of values)
  throws, naming the class and the member. That includes a base class declaration contradicting a
  subclass that repeated the member.
- Every world attaches the **same frozen instance**. `getMut(VecsStruct, …)` throws on any write.
  A later declaration, on the class or a base class, is visible through that instance in every
  world. The world that makes the declaration attaches or marks modified the `VecsStruct` of the
  class and of its registered subclasses.

`VecsStruct` is registered in a world only when the world first attaches one, so worlds without
declarations keep their component ids. Look it up with `world.getEntity(VecsStruct)`, because
`entity.get(VecsStruct)` throws in a world that has never registered it. Like `ComponentDef`, it has
the `DontSnapshot` policy.

## Wire encoding

`@vworlds/vecs-wire` uses reflection as a **per-class-chain fallback**: if any class in the chain
declares `@wireType` fields, only those fields are encoded and reflection is ignored. Otherwise,
unless the chain is explicitly registered with `tag`, the codec uses the members from
`VecsStruct.of(C)`, base class first, with each member's `type` as its wire spec. Ranges, units,
descriptions and enum `values` do not affect encoding. A class with neither definition is not
wire-encodable; explicit tags remain presence-only.

Declare reflection members **before the class's first network use**. The encoder/decoder compiles
the layout at the first encode or decode; members declared later remain visible to reflection but
are not encoded. See the [wire guide](../../vecs-wire/README.md#reflection-fallback) for examples
and the entity-reference encoding rule. Keep existing `@wireType` declarations unchanged when
adding reflection; there is no rename or migration.

## Validating and normalizing

```ts
const position = Object.assign(new Position(), { x: 150.5, y: 3 });

world.validate(position); // ["x: 150.5 is not an integer"]
world.isValid(position); // false
world.normalize(position); // x becomes 100: truncated, then clamped
world.isValid(position); // true
```

All three methods resolve the class from `component.constructor`. They throw when that class is not
registered in the world.

### Default hooks

When a class declares ranges or integer types and has no explicit hook, the first call to
`world.validate` or `world.normalize` creates a default hook from the definition:

- `validate` checks each such member against its range and its type's bounds, and checks that
  integer values are whole. For example, `u8` is 0–255. An `enum` member with `values` must hold
  one of them. It returns every violation.
- `normalize` truncates integers, then clamps each such member to its range and its type's bounds.
  `NaN` becomes `0` first. It leaves a value of the wrong JavaScript type, or an `enum` value outside
  its `values`, unchanged, since neither has a sensible fix; `validate` reports both.
- `u64` and `i64` hold `bigint` values. `normalize` converts a finite `number` to a `bigint`.
- For an array member, the checks apply to each element.
- Floats are checked against their range only. A `string`, `bool` or nested member without a range
  is not checked.

The default derives its checks from the current definition on every call, so it covers members
declared later, in any world or on a base class. It stays until you register a hook explicitly, and
the first explicit hook replaces it.

### Explicit hooks

Register explicit hooks with `on`, like the lifecycle hooks:

```ts
class Wallet {
  coins = 0;
}

world
  .component(Wallet)
  .on("validate", (wallet) => (wallet.coins >= 0 ? true : "coins must not be negative"))
  .on("normalize", (wallet) => {
    wallet.coins = Math.max(0, Math.floor(wallet.coins));
  });
```

You can also declare them as static methods on the class (see [`vecs_` statics](#vecs_-statics)).

Several hooks for the same event run in registration order. `validate` returns the first failure.
`normalize` hooks chain, each one working on the result of the previous one.

## `vecs_` statics

`world.component(C)` registers any static `vecs_<event>` method on `C` as a hook for `<event>`. These
hooks run ahead of the hooks you add with `.on(…)`, and they cover every public hook event:

| Static              | Event          | Signature                                   |
| ------------------- | -------------- | ------------------------------------------- |
| `vecs_add`          | `add`          | `(entity, component) => void`               |
| `vecs_set`          | `set`          | `(entity, component) => void`               |
| `vecs_remove`       | `remove`       | `(entity, component) => void`               |
| `vecs_targetAdd`    | `targetAdd`    | `(source, relationship, target) => void`    |
| `vecs_targetRemove` | `targetRemove` | `(source, relationship, target) => void`    |
| `vecs_validate`     | `validate`     | `(component) => true \| string \| string[]` |
| `vecs_normalize`    | `normalize`    | `(component) => void`                       |

```ts
class Health {
  @type("u16") hp = 100;

  static vecs_normalize(health: Health): void {
    health.hp = Math.min(Math.max(Math.round(health.hp), 0), 1000);
  }
}
```

Statics are called with the class as `this`, and component instances never store closures.
`vecs_targetAdd` and `vecs_targetRemove` require a [relationship](./relationships.md) class.
Registering one on any other class throws. Like any explicit hook, `vecs_validate` and
`vecs_normalize` replace the default.

## Reference

### Member types (`lib/vecs/src/reflection/member_types.ts`)

| Type                                   | Values                                               |
| -------------------------------------- | ---------------------------------------------------- |
| `bool`                                 | `boolean`                                            |
| `u8`, `i8`, `u16`, `i16`, `u32`, `i32` | Integer `number` within the type's bounds            |
| `u64`, `i64`                           | `bigint` within the type's bounds                    |
| `enum`                                 | `i32`, optionally restricted with `values([...])`    |
| `f32`, `f64`                           | `number`                                             |
| `string`, `bytes`, `any`, `entity`     | String, `Uint8Array`, any value, an entity reference |
| A component class                      | A nested instance of that class                      |
| `[type]`                               | An array of the element type                         |

These names are declared once, as `MemberScalarType`; `@vworlds/vecs-wire` reuses that type as its
`@wireType` vocabulary (`WireScalarType`).

### Declarations

| Decorator            | Fluent                               | Member field  |
| -------------------- | ------------------------------------ | ------------- |
| `@type(memberType)`  | `component.member(name, memberType)` | `type`        |
| `@range(min, max)`   | `.range(min, max)`                   | `range`       |
| `@description(text)` | `.description(text)`                 | `description` |
| `@unit(text)`        | `.unit(text)`                        | `unit`        |
| `@values([...])`     | `.values([...])`                     | `values`      |

Each fluent call returns the `Component`, and each modifier applies to the member last declared
with `.member` on it. A `range` needs a numeric type and is inclusive. For `u64` and `i64` it is stored as `bigint`.
`values` needs an `enum` type.

### `World` reflection methods (`lib/vecs/src/world/world.components.ts`)

| Method                 | Returns                                                  |
| ---------------------- | -------------------------------------------------------- |
| `validate(component)`  | `true`, or the violations: a message or a list of them.  |
| `isValid(component)`   | `validate(component) === true`.                          |
| `normalize(component)` | `component`, modified in place by the `normalize` hooks. |

See [Components — hooks](./components.md#hooks-component-and-relationship-edges) for the lifecycle
events and [ECS design diagrams](./diagrams.md#member-types) for drawing member types.
