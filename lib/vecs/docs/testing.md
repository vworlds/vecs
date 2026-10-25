# Testing entity and world identity

Compare ECS objects without traversing their worlds, and print safe diagnostic summaries.

## Register reference equality

Register the optional tester once in your Vitest setup file:

```ts
import { expect } from "vitest";
import { vecsEqualityTester } from "@vworlds/vecs/testing";

expect.addEqualityTesters([vecsEqualityTester]);
```

The tester compares by reference whenever either operand is an `Entity` or `World`, including
subclasses. It prevents `toEqual` and `toBe`'s deep-equality hint from walking the world, even
inside ordinary objects and arrays. Unrelated values keep Vitest's normal equality behavior.
The helper itself does not depend on Vitest at runtime.

Use `===` or `toBe` for identity, not `eid`: see [entity identity](./entities.md#identity-and-diagnostic-summaries).

## Read diagnostic output

`Entity.toJSON()` and `World.toJSON()` give JSON, assertion output and snapshots small summaries
instead of traversing component data and engine handles. See the [summary shapes](./entities.md#identity-and-diagnostic-summaries).
These summaries are diagnostics, not persistence snapshots; use [subtree snapshots](./snapshots.md)
to capture ECS state.
