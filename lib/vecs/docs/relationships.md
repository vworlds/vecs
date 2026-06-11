# Relationships

Link entities to entities with relationship components: hierarchy, reverse lookup, retargeting,
cleanup cascades, and depth-ordered traversal.

## What a relationship is

A relationship is a component whose `target` field points at another entity. Define one by
extending the abstract `Relationship` base (`lib/vecs/src/component_meta.ts`) and registering it
like any component:

```ts
import { Relationship } from "@vworlds/vecs";

class EquippedBy extends Relationship {}

world.component(EquippedBy);

item.set(EquippedBy, { target: player });
item.parent(EquippedBy); // player
player.children(EquippedBy).has(item); // true
```

The **source** entity stores the relationship component; the **target** can enumerate its sources
with `children(ref)` through a reverse index the world maintains automatically. An entity holds at
most one instance of a given relationship class (like any component), so multi-target links are
modeled with one relationship class per meaning, or child entities.

Because `target` is an `Entity` reference, **relationships are not wire-serializable — don't try
to network them**. Replicate a plain id or tag instead, or keep the relationship server-local.

## Built-in relationships

| Class           | Purpose                                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `ChildOf`       | General parent/child hierarchy. `onDeleteTarget = Delete`: destroying a parent destroys its `ChildOf` children.            |
| `DependsOn`     | Pipeline ordering: phases chain to each other and systems attach to phases through it.                                     |
| `SilenceSource` | Marks a query's silence domain; configured via [`ignoreSource`](./queries-and-filters.md#silencing-feedback-ignoresource). |

`entity.childOf(parent)` is shorthand for `entity.set(ChildOf, { target: parent })`.

## Retargeting

Point a relationship somewhere else with a plain `set`:

```ts
unit.set(InCell, { target: newCell }); // reverse index updates automatically
```

Retargeting is a **data change, not an archetype change** — no component is added or removed, so
no `enter`/`exit` churn. Prefer retargeting a relationship over swapping marker components to
express "which bucket this entity is in", and pair it with
[`groupBy(Relationship)`](./queries-and-filters.md#grouped-queries-groupby) for O(1) bucket
lookups.

`getMut` throws for relationship components: in-place target mutation would bypass the reverse
index used by `children()` and the cleanup cascades. Always retarget with `set`.

## Cleanup when a target dies

What happens to sources when their target entity is destroyed is governed by the relationship's
`meta.onDeleteTarget`:

| Policy                 | Meaning                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `CleanupPolicy.Remove` | Default. The relationship component is removed from each source.                          |
| `CleanupPolicy.Delete` | Each source entity targeting the destroyed entity through this relationship is destroyed. |

```ts
import { CleanupPolicy } from "@vworlds/vecs";

world.component(MyRel).meta.onDeleteTarget = CleanupPolicy.Delete; // cascade like ChildOf
```

`ChildOf` ships with `Delete`, so destroying a parent recursively destroys its subtree:

```ts
child.set(ChildOf, { target: parent });
parent.destroy(); // child (and its own ChildOf children) are destroyed too
```

`onDeleteTarget` is independent from `onDelete`: `onDeleteTarget` runs when a relationship
**target** is destroyed; `onDelete` runs when the relationship **component entity itself** is
destroyed (see
[Components — cleanup policies](./components.md#cleanup-policies-destroying-a-component-entity)).

## Querying through relationships

The DSL follows relationships in both directions
([operator table](./queries-and-filters.md#the-query-dsl)):

```ts
// Reactive: candidates whose FriendOf target has Position and Velocity.
world.query("body-friends").with({ all: [Body, { target: [FriendOf, [Position, Velocity]] }] });

// Reactive: candidates whose ChildOf parent has Body.
world.query("positioned-children").with({ all: [Position, { parent: Body }] });

// Filter-only: parents with at least one ChildOf child that has Position.
world.filter({ all: [Body, { children: Position }] }).forEach((parent) => { ... });
```

`target` / `parent` queries are **live on both sides**: adding or removing the relationship on the
candidate re-routes it normally, and changing the _target's_ components refreshes every candidate
pointing at it — across multiple nested `target` hops. `source` / `children` look down the reverse
index and are **non-reactive**: exact for each `Filter` scan but rejected by tracked queries and
systems.

To pull a target's or children's components into callbacks, use `target` / `down` injection — see
[Systems — relationship injection](./systems.md#relationship-injection-target-and-down).

## Traversal order: `Traversable` and `cascade`

Tag a relationship component entity with `Traversable` to enable automatic depth tracking: every
entity carrying the relationship gets a depth (hops to its root), maintained reactively by
`RelationshipsModule` (`lib/vecs/src/modules/relationships.ts`):

```ts
import { Traversable } from "@vworlds/vecs";

world.component(InCell).add(Traversable);
```

A query can then order its members depth-first along the relationship with `cascade`:

```ts
world.query("tree").with({ with: Node, cascade: ChildOf });
```

Parents sort before children. Retargeting updates relationship depths, and cascade-ordered queries
refresh their order before the next iteration. `ChildOf` and `DependsOn` are `Traversable` out of
the box — the world's default pipeline is itself a `cascade: DependsOn` query (see
[Execution model](./execution-model.md#the-pipeline-is-a-query)).

## Reference

| API                                                 | Description                                                                            |
| --------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `class R extends Relationship {}`                   | Declare a relationship component with a `target: Entity` field.                        |
| `e.set(R, { target })`                              | Create or retarget the relationship.                                                   |
| `e.parent(R)`                                       | The target entity, or `undefined`.                                                     |
| `e.children(R)`                                     | `ReadonlySet<Entity>` of sources targeting `e` through `R`.                            |
| `e.childOf(parent)`                                 | Shorthand for `e.set(ChildOf, { target: parent })`.                                    |
| `meta.onDeleteTarget`                               | `Remove` (default) or `Delete` cascade when a target is destroyed.                     |
| `world.component(R).add(Traversable)`               | Enable depth tracking for `cascade` ordering.                                          |
| `{ target: [R, q] }` / `{ parent: q }`              | Reactive DSL operators through the relationship.                                       |
| `{ source: [R, q] }` / `{ children: q }`            | Filter-only DSL operators down the reverse index.                                      |
| `{ target: [R, [C...]] }` / `{ down: [R, [C...]] }` | Injection markers; see [Systems](./systems.md#relationship-injection-target-and-down). |
