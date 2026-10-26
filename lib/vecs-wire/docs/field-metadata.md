# Field metadata

Inspect wire field descriptions without compiling an encoder or mutating the registry.

`wireFields(C)` returns a frozen, detached array of `{ key, spec }` entries,
including inherited fields in base-first registration order. Entries and array
specs are frozen too. An unregistered class or presence-only tag returns `[]`.
Conflicting inherited declarations retain the same error behavior as wire
compilation.

This accessor reports only explicit wire declarations, not the
[reflection fallback](../README.md#reflection-fallback). Use
[`VecsStruct.of(C)`](../../vecs/docs/reflection.md#reading-the-definition) for reflection members.

```ts
import { wireFields, wireType } from "@vworlds/vecs-wire";

class Position {
  @wireType("f32") x = 0;
}
new Position();
const fields = wireFields(Position); // [{ key: "x", spec: "f32" }]
```

Standard field decorators register metadata when an instance is constructed;
construct one before reading their fields. Legacy decorators record metadata
at class definition. The accessor does not construct instances on your behalf.
