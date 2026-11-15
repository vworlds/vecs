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

The world uses these numeric indexes internally. For component enumeration, use the
[entity component view](./entities.md#enumerating-components), not an `ArrayMap` cast.

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
over present entries. Random access reads the entry's dense position from a slot array indexed by
key, which holds only small integers so V8 keeps it on its fast path, then reads the value from a
dense value array. Iteration walks the dense key and value arrays directly. In vecs itself it
holds the world's entity table (`world.entities`); component instances live in the
[shared component stores](#shared-component-storage) instead.

Deletes keep the dense arrays dense by moving the last entry into the removed position, so
iteration is always a tight loop without sparse holes. Compared with `ArrayMap`, this costs extra
memory for the slot array and the dense key and value arrays. Because the dense arrays grow by
`push`, V8 cannot pretenure the entries, so a fresh process that creates tens of thousands of
long-lived entities in bulk and then destroys them can run slower than with per-entry
`[key, value]` tuples. The repository's `bench/README.md` has the measurements.

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

| Method              | Description                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| `set(key, val)`     | Insert or replace the value at `key`.                                                                 |
| `get(key)`          | Retrieve the value at `key`, or `undefined` if no entry exists.                                       |
| `has(key)`          | `true` when an entry exists at `key`.                                                                 |
| `delete(key)`       | Remove the entry at `key`. Swaps last item into vacated slot (O(1)).                                  |
| `forEach(cb)`       | Visit every entry in dense item order, invoking `cb(value, key, map)`.                                |
| `forEachSafe(cb)`   | Safe when the callback deletes only the current entry; other mutations during the scan are undefined. |
| `entries()`         | Iterator over `[key, value]` entries in dense item order.                                             |
| `values()`          | Every present value in dense item order as `T[]`.                                                     |
| `[Symbol.iterator]` | Same as `entries()`; supports `for..of`.                                                              |
| `clear()`           | Remove all entries and reset `size` to zero.                                                          |
| `size`              | The number of entries currently in the map.                                                           |

## Shared component storage

Each component's pinned term owns one internal `ComponentStore`
(`lib/vecs/src/util/component_store.ts`), combining carrier membership with instances.
Sparse stores use `Map<Entity, instance>` without id-indexed arrays. At sufficient
density, stores promote to parallel entity/instance arrays and flat id positions;
lookup checks entity identity because ids can be recycled. Direct removals move both
arrays together and adjust active iteration cursors, so nested carrier cleanup skips
deleted carriers and visits new ones without repeating unchanged survivors.

Promotion happens only on an idle insertion when `count * DENSITY` reaches
`highestId + 1`, or at least eight members qualify with a fixed 1024-slot allowance.
Both containers use density 8. The allowance does not promote near-singletons.
The highest sparse id is a monotone bound until membership empties; removing a high-id
carrier does not lower it. Slack makes small low-id populations direct without a
page table or per-mutation page counts. Client-local populations starting at 10000
remain subject to the density threshold. Direct positions grow by pushing zeros,
never by writing past the array's length; zero denotes an absent id.
An idle insertion demotes when the new id or retained position length exceeds
twice `(newCount * DENSITY + SLACK)`, converting members and instances in one pass.
This hysteresis bounds growth after low-id promotion without switching at every
boundary insertion. Removal never demotes nonempty membership. An active traversal
defers demotion to a later idle insertion, including one within the grown range.
Empty idle stores also demote; active traversals never change representation.
Ordinary entities retain only an ordered
list of component ids, not an instance map. Destruction temporarily retains instances
in a teardown stash so synchronous exits can still read ordinary components; detached
relationships disappear immediately. See [benchmark hot-path notes](../../../bench/README.md#component-store-hot-paths).
Teardown scratch frames retain cleared tuple slots and entry-array capacity between
entities; each borrower sets the exact active length before exposing the stash.
No component instances remain in the reusable frame after successful teardown.

Component leaf terms answer `has(entity)` from the entity's component bit using
a precomputed pointer, rejecting entities from another world first. The store
still owns instances, carrier iteration and counts. Staged additions set both
the bit and store before hooks; removals clear both before exit callbacks.
During destruction, not-yet-detached components remain members even though the
entity is already marked destroyed. If a throwing add hook interrupts teardown,
discarding its staged store entry also clears that component's bit and id-list
entry before notifying composite consumers. This does not make the rest of a
partial world usable after a throwing teardown hook.

Attachment checks use that same bit before writing the store. Sparse store and
term-container insertions detect a new member from the size change after native
`Map.set` or `Set.add`, rather than hashing the entity in a separate presence
probe. Their sparse removals use native `delete` directly; entity teardown still
reads the removed instance when needed for hooks and injection.

Composite query terms use `DenseEntitySet` (`lib/vecs/src/util/dense_entity_set.ts`)
for membership without instances. It follows the same slack-adjusted promotion and
idle-only representation rules. Dense traversal keeps live cursors across emptying/refill and
checks object identity after id reuse. Component-store membership tests stop at
the position and identity check rather than fetching an unused instance.
Direct injection captures store objects, never their arrays or sparse/direct mode.
Arity-specific one-, two- and three-component invokers still call `get` for every
visited entity, so an unrelated callback can promote, demote, empty or refill a
store without invalidating the invoker. Optional components keep synchronous
teardown and removed-instance reads; known required system components do not need them.

## `DenseSet`

`DenseSet` (`lib/vecs/src/util/dense_set.ts`) is an internal dense set implementation used by the
core library; its safe iteration method is documented here because it is part of the exported
utility surface.

### Reference

| Method            | Description                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| `forEachSafe(cb)` | Safe when the callback deletes only the current entry; other mutations during the scan are undefined. |

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

## Stable string hashing

Use `fnv1a32(input)` from `@vworlds/vecs` for unsigned 32-bit FNV-1a over UTF-16
code units, without normalization. Its values are stable across releases because
query cache keys and [RPC name ids](../../vecs-protocol/docs/rpc.md#names-and-numeric-request-ids)
depend on them. For RPC APIs, pass the name itself rather than a raw hash.

```ts
import { fnv1a32 } from "@vworlds/vecs";

const key = fnv1a32("auth"); // 0x953fa84f
```
