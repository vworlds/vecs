# Queries and Filters

Express entity predicates with the query DSL, track them live with `Query`, scan once with
`Filter`, index with `groupBy`, and reach for the `Bitset` utility that powers matching.

## The query DSL

A `QueryDSL` (`lib/vecs/src/dsl.ts`) is a composable expression describing which entities match.
It is accepted by `query().with`, `system().with`, and `world.filter`:

| Operator               | Meaning                                                             |
| ---------------------- | ------------------------------------------------------------------- |
| a component class/id   | Entity has that component                                           |
| an array `[A, B]`      | Entity has all of `A` and `B` (empty array matches all)             |
| `true` / `false`       | Match all / match no entities                                       |
| `{ all: [q1, q2] }`    | Every sub-expression matches                                        |
| `{ any: [q1, q2] }`    | At least one sub-expression matches                                 |
| `{ not: q }`           | Sub-expression must not match                                       |
| `{ only: [A, B] }`     | Entity has exactly `A` and `B`, nothing else                        |
| `{ target: [R, q] }`   | At least one of relationship `R`'s targets matches `q`              |
| `{ source: [R, q] }`   | Filter-only: some entity targeting this one through `R` matches `q` |
| `{ parent: q }`        | Built-in `ChildOf` target matches `q`                               |
| `{ children: q }`      | Filter-only: some `ChildOf` child matches `q`                       |
| `{ test: fn, watch? }` | Custom predicate; rechecked when a `watch`-listed component changes |

Operators nest arbitrarily:

```ts
world.system("render").with({
  all: [Position, { any: [Sprite, Container] }],
});
```

Class-valued terms are components — register them first; an unregistered class throws. Use
`{ test: fn }` for arbitrary logic the operators can't express, with `watch` naming the components
whose changes should re-evaluate it.

`target` and `source` take tuple form only: `{ target: [RelationshipClass, innerDSL] }`. The first
element must extend `Relationship` (a plain component throws). `target` is existential: it evaluates
the inner DSL against every relationship target and matches when at least one does. `source`
evaluates it against each entity pointing at the candidate and also matches when at least one does.
`parent` / `children` are the same operators specialized to the exclusive `ChildOf` relationship.
**`source` and `children` are non-reactive**: exact for each filter scan, but rejected by tracked
queries and systems. `target` / `parent` are fully reactive to edge changes and target-side changes
— see [Relationships](./relationships.md#querying-through-relationships).

### `QuerySpec`: adding `cascade` and `hint`

Anywhere a DSL is accepted, you can pass the object form
`{ with: dsl, cascade?: Rel, hint?: [C...] }`:

- `cascade` orders the tracked set depth-first along a
  [`Traversable` relationship](./relationships.md#traversal-order-traversable-and-cascade).
- `hint` declares components as guaranteed-present for **type inference only** (not validated at
  runtime). Use it when the DSL shape (`any`, `not`, `test`, numeric ids) hides a guarantee the
  type extractor can't see:

```ts
world
  .filter({ with: { any: [Position, Velocity] }, hint: [Position] })
  .forEach([Position], (e, [pos]) => pos.x);
```

Without a hint, only plain classes, arrays, `only`, and `all`-chains of those count as guaranteed,
and everything else injects as `T | undefined`.

## Live queries: `Query`

`world.query(name)` returns a standalone reactive entity set (`lib/vecs/src/query/query.ts`),
configured through the same fluent builder as systems but without pipeline integration:

```ts
const projectiles = world
  .query("Projectiles")
  .with(Position, Velocity)
  .enter((e) => console.log("spawned", e.eid))
  .exit((e) => console.log("gone", e.eid));

projectiles.count; // kept up to date automatically
projectiles.has(e);
for (const e of projectiles) { ... }
projectiles.forEach([Position], (e, [pos]) => { ... });
projectiles.forEach({ inject: [Position] }, (e, [pos]) => { ... });
```

The crucial difference from systems: **standalone query callbacks fire synchronously** while the
world routes a command, not in a phase slot. Mutations made inside one callback are themselves
observed immediately by other queries. Systems instead queue events into an inbox replayed on
their tick (see [Execution model](./execution-model.md#reactive-routing)).

### Lifecycle: build, backfill, destroy

A query is **built** — its predicate materialized and registered — at the next `world.flush()` /
`progress()`, or immediately via `query.build()` outside deferred mode. Tracked queries (and any
query with callbacks) **backfill**: entities that already match are routed through `enter` at
build time. Builder methods throw once the query is built; `built` reports the state.

`query.destroy()` permanently removes the query: entity references are purged silently (no `exit`
fires), the tracked set is cleared, and further use of the object is undefined behavior. Use a
standalone query when you need a reactive set you can destroy mid-session.

### Reading a query

| Member                      | Description                                                                                              |
| --------------------------- | -------------------------------------------------------------------------------------------------------- |
| `count`                     | Number of currently tracked entities (0 unless tracking).                                                |
| `has(e)`                    | `true` when `e` is currently tracked.                                                                    |
| `belongs(e)`                | Evaluate the predicate against `e` right now (works regardless of tracking).                             |
| `[Symbol.iterator]`         | Iterate tracked entities.                                                                                |
| `forEach(...)`              | Iterate with optional [component injection](./systems.md#component-injection); runs in a deferred scope. |
| `changed`                   | `true` when membership or watched data changed since the last `forEach` reset it.                        |
| `name` / `entity` / `world` | Display name; the backing entity; the owning world.                                                      |

`orderBy`, `track`, `enter`, `exit`, `update`, `with`, and `without` behave exactly as on systems
— see [Systems](./systems.md) — except that `update` callbacks fire synchronously here. A plain
`Query.update` callback can therefore re-enter during command routing; snapshot reused `Iter` /
tuple values before triggering further mutations from inside it.

### Silencing feedback: `ignoreSource`

`query.ignoreSource(dsl | query)` makes the query drop `update` notifications whose originating
system matches the given query — the standard cure for write feedback loops (A updates B, B's
system writes back, A reacts again). The relationship is stored as the built-in `SilenceSource`
component on the query's backing entity. Update callbacks that opt into `{ onEnter: true }` still run
when newly entered entities initialize; for systems, that entry-time dispatch bypasses the silence
filter.

## Grouped queries: `groupBy`

`groupBy` partitions a query's members into live buckets you can look up by key — spatial grids,
interest management, any "find members in bucket K" — without re-scanning:

```ts
const ballsByCell = world
  .query("ByCell")
  .with(Ball, Position)
  .groupBy({ inject: [Position] }, (_e, [p]) => cellIndex(p)); // re-buckets reactively as Position changes

ballsByCell.group(key)?.forEach({ inject: [Position] }, (e, [p]) => { ... });
ballsByCell.group(key)?.count;
for (const group of ballsByCell.groups()) { ... }
```

Two forms (`lib/vecs/src/query/grouped_query.ts`):

- `groupBy([components], keyFn)` / `groupBy({ inject: [components] }, keyFn)` — bucket by a
  computed key; injected components are watched, so changing them re-keys the entity.
- `groupBy(RelationshipClass)` / `groupBy({ relationship: RelationshipClass })` — place each member
  in one bucket per relationship target. Adding or removing edges reconciles only the affected
  buckets; an exclusive replacement moves the member from the old target bucket to the new one.

The result is a `GroupedQuery<K, R>` adding `group(key)`, `groups()`, `groupKeys()`, `groupCount`,
and `onGroupEnter` / `onGroupExit` callbacks for bucket creation and disposal. Each `Group` exposes
`key`, `count`, `has`, iteration, and injected `forEach`. Grouping implies tracking. Systems do
not support `groupBy` — keep the grouped query standalone and read it from a system.

A many-target member can therefore appear in several groups at once. Re-adding an existing edge
does not duplicate it within a bucket, removing one edge leaves its other buckets intact, and
destroying a target removes that target's bucket according to normal relationship cleanup.

## Filters: one-shot scans

`world.filter(spec)` returns a `Filter` (`lib/vecs/src/filter.ts`): a non-reactive predicate that
walks entities on each `forEach` call. It accepts the same DSL (including the filter-only
`source` / `children` operators):

```ts
// Entity only:
world.filter([Position]).forEach((e) => console.log(e.eid));

// With component injection (auto-deduced non-null types):
world.filter([Position, Velocity]).forEach([Position, Velocity], (e, [pos, vel]) => {
  pos.x += vel.vx;
});

// Manual hint where the extractor can't see through the DSL:
world
  .filter({ with: { any: [Position, Velocity] }, hint: [Position] })
  .forEach([Position], (e, [pos]) => pos.x);
```

A `Filter` holds no tracked set, registers nothing, and needs no `destroy()` — create it anywhere
and discard freely. `forEach` runs inside a deferred scope, so mutations made by the callback are
batched and visible after iteration; nested inside an already-deferred block it inherits the outer
scope. When the world already maintains a live term for the same predicate, the filter iterates
that term instead of scanning every entity.

Use a `Filter` for occasional or one-off scans; use a `Query`/`System` when you need continuous
reactivity.

## `Bitset`

`Bitset` is the compact integer-set type that powers entity archetypes and query watchlists.
It is documented in full in [Utilities](./utilities.md#bitset).
