# Relationships

Link entities to entities with relationship components: many-target edges, reverse lookup,
one-target constraints, ownership, cleanup cascades, and depth-ordered traversal.

## What a relationship is

A relationship is a component with private target storage managed by vecs. Define one by extending
the abstract `Relationship` base (`lib/vecs/src/component_meta.ts`) and register it like any
component:

```ts
import { Relationship } from "@vworlds/vecs";

class EquippedBy extends Relationship {}

world.component(EquippedBy);

item.add(EquippedBy, player);
item.target(EquippedBy); // player
item.targets(EquippedBy); // readonly snapshot: [player]
item.hasTarget(EquippedBy, player); // true
player.children(EquippedBy).has(item); // true
```

The **source** entity stores the relationship component; each **target** can enumerate its sources
with `children(ref)` through a reverse index the world maintains automatically. Relationships allow
many targets by default. Each source/relationship/target edge is unique, so adding the same target
again is idempotent. Target ordering is not a public contract.

`target(ref)` is a singular convenience that returns one current target, or `undefined`. Use
`targets(ref)` for all targets; it returns a safe readonly array snapshot, not vecs's internal
storage. For a non-exclusive relationship, do not use `target(ref)` as a stable selection policy.
Use `hasTarget(ref, target)` to test one edge without allocating a snapshot.

## Built-in relationships

| Class           | Purpose                                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `ChildOf`       | Exclusive parent/child hierarchy. `onDeleteTarget = Delete`: destroying a parent destroys its `ChildOf` children.          |
| `DependsOn`     | Exclusive pipeline ordering: phases chain to each other and systems attach to phases through it.                           |
| `SilenceSource` | Exclusive query silence domain; configured via [`ignoreSource`](./queries-and-filters.md#silencing-feedback-ignoresource). |

`ChildOf` and `DependsOn` are also `Traversable`; all three built-ins above are `Exclusive`.

## Adding, removing, and setting

Create edges explicitly with `add(Relationship, target)`:

```ts
unit.add(VisibleTo, playerA).add(VisibleTo, playerB);

unit.remove(VisibleTo, playerA); // remove one edge
unit.remove(VisibleTo); // remove the component and every remaining edge
```

`add(Relationship)` without a target is invalid. Targets must be live entities in the same world as
the source. Removing a missing edge is a no-op; removing the final edge also removes the
relationship component.

A relationship subclass can still declare ordinary data fields:

```ts
class WeightedLink extends Relationship {
  weight = 0;
}

source.add(WeightedLink, target);
source.set(WeightedLink, { weight: 10 });
```

For relationships, `set` is **existing-only and data-only**. It updates ordinary fields on an
attached relationship, but does nothing when the relationship is absent and ignores target-storage
spellings. Edge changes must use `add` and `remove`; they never fire `onSet`.

`attach`, `ensure`, and `getMut` reject relationship components because replacing or mutating an
instance could bypass edge uniqueness, reverse indexes, and cleanup policies. Target storage is
private: there is no public `target` or `targets` field to assign. The former `ensureTarget` and
`onRetarget` APIs have been removed.

`entity.childOf(parent)` is shorthand for `entity.add(ChildOf, parent)`. The `parent` property reads
the first `ChildOf` target; assigning a parent adds or replaces that target because `ChildOf` is
exclusive, while assigning `undefined` removes `ChildOf`.

## Exclusive one-target relationships

Add the `Exclusive` trait to restrict a relationship to one target:

```ts
import { Exclusive, Relationship } from "@vworlds/vecs";

class InCell extends Relationship {}

world.component(InCell).add(Exclusive);

unit.add(InCell, oldCell);
unit.add(InCell, newCell); // atomically replaces oldCell with newCell
```

Adding a different target atomically replaces the existing edge. Observers never see two targets:
the reverse indexes already reflect the replacement when the old edge's remove hook runs, followed
by the new edge's add hook. Re-adding the current target is a no-op.

`ChildOf`, `DependsOn`, and `SilenceSource` are `Exclusive` out of the box. Configure `Exclusive`
before relationship instances exist; vecs rejects first-time configuration or removal while the
relationship is in use (re-adding an already attached trait is an idempotent no-op), and rejects
removing it while `OwnedTarget` or `Traversable` depends on it.

Do not confuse this trait with `world.setExclusiveComponents(A, B)`. `Exclusive` limits **one
relationship class** to one target. `setExclusiveComponents` declares that **different component
classes** cannot coexist on one entity (see
[Components](./components.md#exclusive-component-groups)).

## Edge hooks

Relationship component entities expose one public hook slot for edge addition and one for edge
removal:

```ts
world
  .component(InCell)
  .onTargetAdd((source, relationship, target) => {
    // The edge and reverse index already exist.
  })
  .onTargetRemove((source, relationship, target) => {
    // The edge and reverse index are already gone.
  });
```

Both handlers receive `(source, relationshipInstance, target)`. For a new relationship,
`onTargetAdd` runs before `onAdd`; query entry follows `onAdd`. Removing the whole relationship
routes query exit and detaches all edges, calls `onTargetRemove` once per edge, then
calls `onRemove`. An exclusive replacement calls `onTargetRemove` for the old target before
`onTargetAdd` for the new target without removing and re-adding the component. Edge changes route
relationship-dependent query updates, but do not call `onSet`; `onSet` is reserved for ordinary
relationship data changed through `set`.

The first edge and relationship instance share the component initialization boundary. The edge and
reverse index exist while `onTargetAdd` and `onAdd` run, but relationship queries enter only after
both handlers succeed. Those handlers may add more non-exclusive edges, but cannot remove the
initializing relationship, remove its final edge, replace its exclusive target, destroy a target
whose cleanup would eliminate it, or build a query or uncached term. A throw rolls back the new
relationship, every edge added by that initialization, reverse indexes, and built-in policy effects
without firing remove hooks.

Call `onTargetAdd()` or `onTargetRemove()` without an argument to read the current handler, pass a
handler to replace it, or pass `undefined` to clear it. Framework traits install separate internal
policies, so adding or removing a trait does not replace these public hooks.

## Owned targets

Use `OwnedTarget` when an exclusive relationship explicitly owns its target:

```ts
import { Exclusive, OwnedTarget, Relationship } from "@vworlds/vecs";

class Inventory extends Relationship {}

world.component(Inventory).add(Exclusive).add(OwnedTarget);

const inventory = world.entity();
player.add(Inventory, inventory);
inventory.parent === player; // true

player.remove(Inventory); // destroys inventory
```

`OwnedTarget` requires `Exclusive`, rejects ordinary components and `ChildOf`, and never creates a
target implicitly. You must create the target and pass it to `add`. When an edge is added, the target
becomes a `ChildOf` child of its source before the public `onTargetAdd` hook runs. When that edge is
removed, its target is destroyed before the public `onTargetRemove` hook runs. Exclusive replacement
therefore destroys the displaced target and adopts the replacement atomically; removing the
relationship or destroying its source destroys the current target.

Configure the traits before creating relationship instances. Removing `OwnedTarget` removes only
its ownership policy; public edge hooks remain installed. Do not share an owned target between
sources because either owner can destroy it when its edge is removed.

## Cleanup when a target dies

What happens to each incoming edge when its target entity is destroyed is governed by the
relationship's `meta.onDeleteTarget`:

| Policy                 | Meaning                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `CleanupPolicy.Remove` | Default. Remove only the edge to the destroyed target; other targets remain attached.      |
| `CleanupPolicy.Delete` | Destroy each source entity that has an edge to the destroyed target through this relation. |

```ts
import { CleanupPolicy } from "@vworlds/vecs";

world.component(MyRel).meta.onDeleteTarget = CleanupPolicy.Delete;
```

`ChildOf` ships with `Delete`, so destroying a parent recursively destroys its subtree:

```ts
child.add(ChildOf, parent);
parent.destroy(); // child and its own ChildOf children are destroyed too
```

With the default `Remove`, cleanup follows normal per-edge semantics: `onTargetRemove` receives the
destroyed target, and the relationship component remains if another edge survives. Removing the
last edge also removes the component.

Target destruction is preflighted with the rest of its transitive deletion graph. Every source
selected by `Delete` must itself be destroyable, and a final-edge `Remove` validator must succeed,
before the target is frozen. A blocker leaves the complete graph unchanged. Commit then destroys
sources or removes only the collected target edges without rescanning unrelated entities.

`onDeleteTarget` is independent from `onDelete`: `onDeleteTarget` applies when a relationship
**target** is destroyed; `onDelete` applies when the relationship **component entity itself** is
destroyed (see
[Components — cleanup policies](./components.md#cleanup-policies-destroying-a-component-entity)).

## Querying through relationships

The DSL follows relationships in both directions
([operator table](./queries-and-filters.md#the-query-dsl)):

```ts
// Reactive: candidates with any FriendOf target that has Position and Velocity.
world.query("body-friends").with({ all: [Body, { target: [FriendOf, [Position, Velocity]] }] });

// Reactive: candidates whose ChildOf parent has Body.
world.query("positioned-children").with({ all: [Position, { parent: Body }] });

// Filter-only: parents with at least one ChildOf child that has Position.
world.filter({ all: [Body, { children: Position }] }).forEach((parent) => { ... });
```

`target` is existential: a source matches when **any** target through the relationship matches the
inner DSL. `target` / `parent` queries are live on both sides: edge changes re-evaluate the source,
and changes to any target's components refresh every source pointing at it, across nested `target`
hops. `source` / `children` look down the reverse index and are non-reactive: exact for each
`Filter` scan but rejected by tracked queries and systems.

To pull one current target or all targets into callbacks, use singular `target` or plural `targets`
injection; see [Systems — relationship injection](./systems.md#relationship-injection).

## Traversal order: `Traversable` and `cascade`

Tag an exclusive relationship component entity with `Traversable` to enable automatic depth
tracking: every entity carrying the relationship gets a depth (hops to its root), maintained
reactively by `RelationshipsModule` (`lib/vecs/src/modules/relationships.ts`):

```ts
import { Exclusive, Traversable } from "@vworlds/vecs";

world.component(InCell).add(Exclusive).add(Traversable);
```

`Traversable` requires `Exclusive` because a node needs one unambiguous parent. It backfills existing
exclusive edges when attached. A query can then order members depth-first with `cascade`:

```ts
world.query("tree").with({ with: Node, cascade: ChildOf });
```

Parents sort before children. Replacing an exclusive edge updates relationship depths, and
cascade-ordered queries refresh before the next iteration. `ChildOf` and `DependsOn` are
`Exclusive` and `Traversable` out of the box; the world's default pipeline is itself a
`cascade: DependsOn` query (see [Execution model](./execution-model.md#the-pipeline-is-a-query)).

## Network snapshots

Relationship subclasses listed in a server/client world's `networkComponents` are networkable.
Their payload writes a u32 target count, every target eid, then the relationship's ordinary wire
fields. Target ids are sorted by the server for deterministic snapshots; duplicate, zero, or empty
target lists are rejected, and an `Exclusive` relationship rejects a payload with more than one
target.

The client reconciles every received edge and applies ordinary fields. If a target entity has not
arrived, it creates a networked ghost for that eid immediately; each missing target in a many-target
payload gets its own ghost. List `ChildOf` or a custom relationship explicitly in
`networkComponents` when those edges must replicate.

## Reference

| API                                           | Description                                                                                         |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `class R extends Relationship {}`             | Declare a many-target relationship with private target storage.                                     |
| `e.add(R, target)`                            | Add one unique edge; atomically replace the edge when `R` is `Exclusive`.                           |
| `e.remove(R, target)` / `e.remove(R)`         | Remove one edge, or remove the relationship and all edges.                                          |
| `e.set(R, ordinaryProps)`                     | Update ordinary data on an existing relationship; never creates or changes edges.                   |
| `e.target(R)`                                 | First target through `R`, or `undefined`.                                                           |
| `e.targets(R)`                                | Readonly snapshot of every target through `R`; ordering is unspecified.                             |
| `e.hasTarget(R, target)`                      | Test whether one edge exists.                                                                       |
| `e.children(R)`                               | `ReadonlySet<Entity>` of sources targeting `e` through `R`.                                         |
| `e.childOf(parent)`                           | Shorthand for `e.add(ChildOf, parent)`.                                                             |
| `e.parent` / `e.parent = p`                   | First built-in `ChildOf` target; assignment replaces it or removes `ChildOf` for `undefined`.       |
| `world.component(R).add(Exclusive)`           | Restrict `R` to one target.                                                                         |
| `world.component(R).onTargetAdd(handler?)`    | Get, set, or clear the `(source, relationship, target)` edge-add handler.                           |
| `world.component(R).onTargetRemove(handler?)` | Get, set, or clear the `(source, relationship, target)` edge-remove handler.                        |
| `world.component(R).add(OwnedTarget)`         | Adopt and destroy explicit targets; requires `Exclusive`.                                           |
| `meta.onDeleteTarget`                         | `Remove` (default) per edge or `Delete` the source when a target dies.                              |
| `world.component(R).add(Traversable)`         | Enable depth tracking for cascade ordering; requires `Exclusive`.                                   |
| `{ target: [R, q] }` / `{ parent: q }`        | Reactive existential DSL operators through relationship targets.                                    |
| `{ source: [R, q] }` / `{ children: q }`      | Filter-only DSL operators down the reverse index.                                                   |
| `{ target: [R, projection] }`                 | Inject projections from one current target; selection is unspecified for non-exclusive relations.   |
| `{ targets: [R, projection] }`                | Inject one row-array slot covering all targets; see [Systems](./systems.md#relationship-injection). |
| `{ down: [R, [C...]] }`                       | Fan out over sources; see [Systems](./systems.md#relationship-injection).                           |
