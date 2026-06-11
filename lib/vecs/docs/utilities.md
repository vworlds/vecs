# Utilities

Public helper classes exported by `@vworlds/vecs` for code that lives around the ECS core.

## `Events`

Use `Events` when a vecs package or integration needs typed package-level events without adding an
external runtime dependency. It is not an entity lifecycle API; entity teardown is modeled through
component removal, hooks, query exits, and relationship cleanup.

```ts
import { Events } from "@vworlds/vecs";

type ClientEvents = {
  reset(event: { initial: boolean }): void;
};

const events = new Events<ClientEvents>();
events.on("reset", (event) => console.log(event.initial));
events.emit("reset", { initial: true });
```

### Reference

| Method                             | Description                                                                |
| ---------------------------------- | -------------------------------------------------------------------------- |
| `on(event, fn, context?)`          | Register a listener.                                                       |
| `addListener(event, fn, ctx?)`     | Alias of `on`.                                                             |
| `once(event, fn, context?)`        | Register a listener that removes itself before its first call.             |
| `emit(event, ...args)`             | Invoke listeners and return `true` when at least one listener ran.         |
| `off(event, fn?, context?)`        | Remove one listener, or every listener for the event when `fn` is omitted. |
| `removeListener(event, fn?, ctx?)` | Alias of `off`.                                                            |
| `removeAllListeners(event?)`       | Remove listeners for one event, or all listeners when no event is given.   |
| `eventNames()`                     | Return event names with at least one listener.                             |
| `listeners(event)`                 | Return registered listener functions for an event.                         |
| `listenerCount(event)`             | Return the number of listeners registered for an event.                    |

## `ArrayMap`

`ArrayMap` (`lib/vecs/src/util/array_map.ts`) is a cheap `Map<number, T>` substitute backed by a
sparse JavaScript array. Lookups are a single array read and memory usage is one sparse backing
array. Use it when you only need random access (`get`, `set`, `has`, `delete`) by non-negative
integer keys and don't need iteration.

The world and entity APIs return read-only `ArrayMap` views (e.g. `entity.components`).

```ts
import { ArrayMap } from "@vworlds/vecs";

const map = new ArrayMap<string>();
map.set(42, "hello");
map.get(42); // "hello"
map.has(42); // true
map.delete(42);
map.size; // 0
```

### Reference

| Method          | Description                                                       |
| --------------- | ----------------------------------------------------------------- |
| `set(key, val)` | Insert or replace the value at `key`. Increments `size` when new. |
| `get(key)`      | Retrieve the value at `key`, or `undefined` if no entry exists.   |
| `has(key)`      | `true` when an entry exists at `key`.                             |
| `delete(key)`   | Remove the entry at `key`. Does nothing if no entry exists there. |
| `clear()`       | Remove all entries and reset `size` to zero.                      |
| `size`          | The number of entries currently in the map.                       |

## `IterableArrayMap`

`IterableArrayMap` (`lib/vecs/src/util/array_map.ts`) is an iterable `Map<number, T>` substitute
backed by dense entries plus sparse indexes. Use it when callers need fast `forEach` or `values`
over present entries. Random access resolves `key → dense index` through an internal `ArrayMap`,
then indexes into a dense items array; iteration walks the dense items array directly.

Deletes keep the items array dense by moving the last value into the removed slot, so iteration
is always a tight loop without sparse holes. Compared with `ArrayMap`, this costs extra memory
for tuple storage and an index map.

```ts
import { IterableArrayMap } from "@vworlds/vecs";

const map = new IterableArrayMap<{ x: number }>();
map.set(1, { x: 10 });
map.set(3, { x: 30 });

for (const [key, value] of map) {
  console.log(key, value.x); // 1 10, 3 30 (or swapped after a delete)
}
```

### Reference

| Method              | Description                                                            |
| ------------------- | ---------------------------------------------------------------------- |
| `set(key, val)`     | Insert or replace the value at `key`.                                  |
| `get(key)`          | Retrieve the value at `key`, or `undefined` if no entry exists.        |
| `has(key)`          | `true` when an entry exists at `key`.                                  |
| `delete(key)`       | Remove the entry at `key`. Swaps last item into vacated slot (O(1)).   |
| `forEach(cb)`       | Visit every entry in dense item order, invoking `cb(value, key, map)`. |
| `entries()`         | Iterator over `[key, value]` entries in dense item order.              |
| `values()`          | Every present value in dense item order as `T[]`.                      |
| `[Symbol.iterator]` | Same as `entries()`; supports `for..of`.                               |
| `clear()`           | Remove all entries and reset `size` to zero.                           |
| `size`              | The number of entries currently in the map.                            |

## `Bitset`

`Bitset` (`lib/vecs/src/util/bitset.ts`) is the compact integer-set type the ECS uses for entity
archetypes and watchlists. It is exported so component data can use it for bit-flag fields:

```ts
import { Bitset } from "@vworlds/vecs";

class Tags {
  tags = new Bitset();
}

tags.tags.add(TAG_VISIBLE);
if (tags.tags.has(TAG_VISIBLE)) { ... }
```

### Reference

| Method                                              | Description                                                                          |
| --------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `add(n)`                                            | Set bit `n`.                                                                         |
| `delete(n)`                                         | Clear bit `n`. Storage is not compacted automatically; call `compact()` when needed. |
| `addBit(bptr)` / `deleteBit(bptr)` / `hasBit(bptr)` | Fast paths using a pre-computed `BitPtr`.                                            |
| `has(n)`                                            | `true` when bit `n` is set.                                                          |
| `equal(other)`                                      | `true` when both bitsets have exactly the same bits set.                             |
| `hasBitset(other)`                                  | `true` when every bit in `other` is also set here (subset check).                    |
| `forEach(cb)`                                       | Visit each set bit index in ascending order.                                         |
| `indices()`                                         | All set bit indices as `number[]`.                                                   |
| `clear()`                                           | Remove every set bit.                                                                |
| `compact()`                                         | Trim trailing zero words from backing storage.                                       |

Related: `getDSLKey(dsl, world)` returns a deterministic 32-bit hash of a DSL expression
(equivalent expressions hash identically), useful for caching keyed on predicates.
