# Inheritance

Build immutable template hierarchies with `IsA`, choose per-component snapshot or shared behavior,
and understand copy-on-write and notification boundaries.

## Templates and instances

Use an entity as a template, then add an `IsA` edge from an instance to that template:

```ts
import { Inherit, IsA, OnInstantiate, World } from "@vworlds/vecs";

class Position {
  x = 0;
  y = 0;
}

class Appearance {
  color = "white";
}

const world = new World();
world.component(Position); // no policy means Override
world.component(Appearance).add(OnInstantiate, Inherit);

const enemy = world.entity().set(Position, { x: 10, y: 20 }).set(Appearance, { color: "red" });

const grunt = world.entity().add(IsA, enemy);
```

`grunt` receives a shallow `Position` copy and the exact `Appearance` object held by `enemy`.
`IsA` is an exclusive relationship, so each entity has at most one direct template. Re-adding the
same edge is an idempotent no-op. You cannot remove or retarget a live edge while both source and
target are alive. Cycles throw as programming errors. Destroying a template destroys every direct
and transitive inheritor because `IsA.meta.onDeleteTarget` is `CleanupPolicy.Delete`.

Every `World` auto-registers `InheritanceModule` immediately after `RelationshipsModule`. You do
not need to install it yourself.

## Component policy

Configure policy on the component entity during world or feature-module setup, before any entity
carries that component:

```ts
import { DontInherit, Inherit, OnInstantiate, Override } from "@vworlds/vecs";

world.component(Position).add(OnInstantiate, Override);
world.component(Appearance).add(OnInstantiate, Inherit);
world.component(RuntimeHandle).add(OnInstantiate, DontInherit);
```

`OnInstantiate` is an exclusive `OneOf` relationship. `Override`, `Inherit`, and `DontInherit` are
component entities parented directly beneath the `OnInstantiate` component entity, so no other
policy target is valid. Validation checks those three exact entity identities; another direct child
is not a policy. Once configured, a policy cannot be changed or removed. Configuration rejects
components that already have carriers.

Selecting a policy also attaches that policy marker component to the configured component entity.
The configured component is therefore a carrier of `Override`, `Inherit`, or `DontInherit` for as
long as the policy exists. The marker's default `CleanupPolicy.Throw` prevents its component entity
from being destroyed while any policy references it. `InheritanceModule` makes each built-in policy
marker meta's `onDelete` property runtime-read-only at `CleanupPolicy.Throw`; assigning `Remove` or
`Delete` throws without changing the value. Normal component-entity teardown removes the carrier, so
`clearAllEntities()` can still release configured components and then the markers.

While the configured component has the matching `OnInstantiate` edge, you cannot explicitly remove
its policy marker component or replace that marker instance with a different object through
`attach`. Both operations reject before changing marker or relationship state. Reattaching the exact
existing marker object follows normal attach semantics because it is not a replacement. Entity
destruction bypasses ordinary mutation validators, so normal configured-component destruction and
`clearAllEntities()` still tear down the marker carrier cleanly.

For `Inherit`, all compatibility and zero-carrier validation completes first, then vecs installs the
shared ownership, mutation, COW, and remove-hook policy before storing the `OnInstantiate` edge or
structurally adding its marker. A synchronous query entering on that `Inherit` marker can therefore
create a component carrier safely: the new instance is already branded as a local owner and normal
owner mutation APIs work.

| Policy        | On `IsA` creation                                                                                      | Later local add on a template                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| No policy     | Same as `Override`.                                                                                    | Does not propagate.                                                            |
| `Override`    | Constructs `new ComponentClass()`, then shallow-copies enumerable own properties with `Object.assign`. | Does not propagate.                                                            |
| `Inherit`     | Stores the exact effective template object reference.                                                  | Propagates that exact reference through existing unshadowed `IsA` descendants. |
| `DontInherit` | Does not attach the component.                                                                         | Does not propagate.                                                            |

An existing value on the child always wins. In a hierarchy, that value also shadows the same
component for the branch below it. This is true whether the hierarchy is built root-first or
leaf-first. When you add an `IsA` edge to an entity that already has inheritors, vecs walks that
existing subtree iteratively from parent to child and instantiates every level. Each `Override`
level receives an independent copy. An unshadowed `Inherit` branch keeps one shared pointer.

The scan covers effective ordinary components on the immediate template. It skips relationships,
`Implements` alias slots, the `Singleton` marker and singleton-marked components, and inheritance
policy infrastructure. It also skips every component carrying `With`; model that component and its
required companion independently instead of relying on template materialization. It never
duplicates an interface alias entry.

## Shared values and copy-on-write

A locally added `Inherit` component owns its object. Vecs records that owner in private,
non-enumerable, immutable metadata and silently gives the same object to existing descendants that
do not shadow the component.

Use `set` to write through an inherited value:

```ts
const elite = world.entity().add(IsA, enemy);
const scout = world.entity().add(IsA, enemy);
const eliteChild = world.entity().add(IsA, elite);

elite.set(Appearance, { color: "gold" });

elite.get(Appearance) === eliteChild.get(Appearance); // true
elite.get(Appearance) === enemy.get(Appearance); // false
scout.get(Appearance) === enemy.get(Appearance); // true
```

Before applying `Object.assign`, `set` checks ownership. If the value is inherited, vecs creates a
shallow no-argument-constructor copy, makes the explicitly set entity its owner, and repoints that
entity plus each descendant whose current pointer is exactly the old object. A different pointer or
a missing component prunes that branch. Setting the owner again mutates the existing object and does
not clone it. Deferred `set` follows the same rule when its queued command is applied.

Copying is shallow for both `Override` and `Inherit` copy-on-write. Nested arrays, objects, and other
references remain shared. Component classes used by either path must be safe to construct with no
arguments. Use `DontInherit` for attached resources, handles, DOM/render objects, and other values
whose identity or teardown cannot be copied safely.

Every `Inherit` instance must also be extensible. Vecs brands a local owner instance with private,
non-enumerable, immutable ownership metadata before it can be shared. A frozen, sealed, or otherwise
non-extensible instance is rejected before component storage, bitmasks, carriers, component terms,
or query membership change. This applies to normal adds/sets and ensure-missing attachment paths.

## Mutation restrictions

Shared identity makes mutation methods other than `set` ambiguous. For a component configured with
`Inherit`, vecs enforces these rules:

| Operation                    | Result                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `entity.set(C, props)`       | Supported. Performs copy-on-write when the current object is inherited.                                                   |
| `entity.add(C)`              | Supported when absent; creates a local owner value and propagates it through unshadowed descendants. Existing is a no-op. |
| `entity.attach(C, instance)` | Rejected for every `Inherit` component, including attaching the exact current instance.                                   |
| `entity.remove(C)`           | Rejected for every `Inherit` component. Use entity/template lifecycle for teardown.                                       |
| `entity.modified(C)`         | Rejected on an inherited object; allowed on its owner.                                                                    |
| `entity.getMut(C, callback)` | Rejected on an inherited object; allowed on its owner.                                                                    |
| `entity.ensure(C, callback)` | Rejected when the existing object is inherited; normal for an owner or a missing component.                               |

Calling `modified`, `getMut`, or `ensure` on an owner does not copy. Direct owner mutation changes
the shared object visible to descendants, but only the owner emits the normal update notification.
Prefer `set` when you want explicit branch ownership and predictable notification semantics.

Ensure-missing uses an internal attachment path rather than public `attach`. In deferred mode vecs
retains that origin on the pending ensure object, so it remains allowed when the command applies. If
a `set` for the same missing component was queued first, FIFO application creates the set value and
then attaches the ensured object, matching the existing deferred command semantics. A real deferred
public attach is revalidated when it applies and remains rejected for `Inherit`.

## Queries, hooks, and notifications

Silent inheritance is structurally complete. An inherited insertion updates the entity's component
storage and bitmask, component carrier tracking and `usageCount`, component terms, and structural
query membership. A prebuilt `.with(C)` query therefore admits a descendant as soon as inheritance
adds `C`.

Concrete and interface-alias slots, carrier records, and bits are staged together before the first
structural notification, so a synchronous query callback always observes complete alias structure.
If that callback destroys the entity or removes/replaces the staged value, insertion stops without
writing further slots or continuing template traversal through the dead entity. During late shared
propagation, vecs rereads each child's pointer after query entry; if the callback performed COW, that
new branch pointer, rather than the stale source pointer, propagates to the child's descendants.

Silent insertion intentionally skips component `policyAdd`, `onAdd`, and `onSet` hooks. Pointer
repointing during copy-on-write changes only component storage because membership and carrier counts
do not change. Only the entity on which you explicitly call `set` receives normal `onSet` and query
`update(C)` delivery.

There is deliberately no descendant value-refresh machinery. Descendants immediately read the new
shared value through the pointer, but value-sensitive descendant predicates, grouped-query keys,
orderings, update callbacks, and network deltas are not refreshed. Descendant component value hooks
also do not fire. Structural `.with(C)` enter and exit behavior remains correct.

During destruction, `onRemove` fires once for the owner of a shared `Inherit` object, not for
inherited carriers of that same object. Every carrier still performs normal structural query and
carrier cleanup. `Override` copies are ordinary local components and fire normal remove hooks.

## Unsupported composition

`Inherit` version 1 deliberately excludes combinations that need policy coordination beyond shared
plain data. Configuration rejects the combinations exposed by simple component metadata or traits:

| Combination                                 | Status                                                                                              |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Relationship component                      | Unsupported for `OnInstantiate`; relationships are skipped during template scanning.                |
| `Implements` declaration or interface alias | Unsupported with `Inherit`; alias scan entries are skipped for all policies.                        |
| Exclusive component group                   | Unsupported with `Inherit`.                                                                         |
| `Singleton`                                 | Unsupported with `Inherit`; singleton values are skipped during template scanning.                  |
| `With`                                      | Rejected with explicit `Inherit`; components carrying `With` are skipped for every template policy. |
| Non-default component `onDelete` policy     | Unsupported with `Inherit`; keep `CleanupPolicy.Throw`.                                             |
| Attached/resource component                 | Use `DontInherit`; copying or sharing resource lifecycle is unsafe.                                 |
| Networking                                  | Unsupported. `IsA`, policy, shared pointers, and COW are local-only in version 1.                   |

Configure all participating traits before `OnInstantiate`, and treat policy as setup-time state.
The module guards obvious invalid combinations in either setup order where the current architecture
provides a narrow check. It does not maintain a cross-module compatibility state machine. Networking
support, including hierarchy replication and descendant deltas, is deferred. Networking remains a
documented unsupported composition rather than a mechanically rejected one: this minimal local
feature deliberately does not import or maintain network metadata from other packages.

Changing an `Inherit` component's low-level `meta.onDelete` after configuration is unsupported. If
it is changed from `CleanupPolicy.Throw` to `Remove` or `Delete`, destroying that component entity
rejects before marking it destroyed, including when destruction is reached through an internal
cascade. Reverse setup guards such as adding an `Inherit` component as an `Implements` interface may
throw from existing lifecycle hooks after their initiating operation has partially applied; this is
the existing programming-error contract, so discard that world.

## Reference

| API                                                  | Description                                                                                                 |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `class IsA extends Relationship`                     | Exclusive, acyclic, immutable template edge with target deletion cascade.                                   |
| `class OnInstantiate extends Relationship`           | Exclusive `OneOf` policy selector attached to a component entity.                                           |
| `Override`                                           | Shallow per-level snapshot policy; also the default when no policy is configured.                           |
| `Inherit`                                            | Shared-reference policy with late-add propagation and branch copy-on-write through `set`.                   |
| `DontInherit`                                        | Omit the component from template instances.                                                                 |
| `InheritanceModule`                                  | Auto-installed built-in module implementing the hierarchy and policies.                                     |
| `world.component(C).add(OnInstantiate, Override)`    | Explicitly select shallow snapshots for `C`.                                                                |
| `world.component(C).add(OnInstantiate, Inherit)`     | Select shared references and copy-on-write for `C`.                                                         |
| `world.component(C).add(OnInstantiate, DontInherit)` | Prevent `C` from being instantiated through `IsA`.                                                          |
| `child.add(IsA, template)`                           | Instantiate effective ordinary template components and create the immutable hierarchy edge.                 |
| `child.set(C, props)`                                | Split and repoint the unshadowed child branch before applying a shallow update to inherited `Inherit` data. |
