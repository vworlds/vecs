# Components

Define plain-data components, register them with the world, and configure their lifecycle: hooks,
exclusivity, cleanup policies, interface aliases, and singletons.

## Components are plain data classes

An ordinary component is a class with field initializers and a no-argument constructor. Relationship
components are the exception: they extend `Relationship` so vecs can recognize their private edge
storage. Vecs instantiates either form with `new ComponentClass()`:

```ts
class Position {
  x = 0;
  y = 0;
}
```

| Rule                      | Description                                                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Plain class               | Ordinary classes with field initializers; methods are allowed but behavior belongs in systems.                                |
| No-arg construction       | vecs calls `new ComponentClass()`; omit the constructor or take no parameters.                                                |
| Explicit registration     | Call `world.component(C)` before using the class as a component anywhere.                                                     |
| Shared instances possible | `entity.attach(instance)` stores the exact passed object (see [Entities](./entities.md#attach-storing-an-existing-instance)). |
| Manual dirty marking      | After mutating fields directly, call `entity.modified(C)` so hooks, queries, and systems react.                               |

Keep components small and single-purpose — `Position {x,y}` and `Rotation {angle}`, not a
`Transform` god-component. Absence of a component encodes "not applicable", and small components
compose into precise queries. The reasoning is developed in the
[Design guide](./design-guide.md#3-components).

## Registration: `world.component`

Register every component class before using it in `add`, `set`, `get`, `with`, `filter`, hook
registration, or `setExclusiveComponents`. Registration can happen at any time:

```ts
// Auto-assigned component id (drawn from the "component" id pool, 1–899 by default):
const positionComponent = world.component(Position);

// Explicit numeric id (e.g. a server-assigned stable id):
world.component(Position, 42);

// Access component metadata (numeric id, cleanup policy, usage count, …):
const meta = world.component(Position).meta;

// Name the component entity, then resolve it by string later:
world.component(Position).name = "Position";
world.component("Position"); // returns the same Component entity
```

`world.component(Class)` (`lib/vecs/src/world/world.components.ts`) returns the **`Component`
entity** for that class, creating and registering it on the first call. Subsequent calls with the
same class return the same entity. The same class can be registered independently in multiple
worlds — metadata is world-specific. Passing an explicit id for an already-registered class (with
a different id) throws, as does passing a name with no matching component entity.

### Reflecting on component definitions

Use the built-in `ComponentDef` tag to query registered definitions rather than scanning every
entity with an `instanceof Component` predicate:

```ts
import { ComponentDef, World } from "@vworlds/vecs";

const world = new World();
const definitions = world.query("Definitions").with(ComponentDef).build();
for (const definition of definitions) {
  console.log(definition.meta.Class.name);
}
```

Every registered component and module entity carries the tag, including built-ins and
`ComponentDef` itself. The query tracks later registrations and destroyed definitions incrementally;
iterating it visits definitions only, not ordinary game, query, system, or phase entities.
Registration adds one tag per class; worlds that never query it need no reflection query.

Treat `ComponentDef` as world-managed schema metadata: do not add or remove it yourself.
Its `DontSnapshot` policy excludes it from subtree snapshots, and `NetworkWorld` rejects it in
`networkComponents`. Each destination world tags its own locally registered definitions instead.
Component entities themselves remain invalid subtree snapshot roots. The tag does not change
[world disposal priorities](./entities.md#disposing-a-world).

To reflect only policy definitions, combine `ComponentDef` with the declarative `Trait` marker:

```ts
import { ComponentDef, Trait } from "@vworlds/vecs";

const traits = world.query("Traits").with(ComponentDef, Trait).build();
```

This query tracks later `add(Trait)` declarations incrementally, without a world scan. Like
`ComponentDef`, `Trait` has `DontSnapshot` policy and is rejected in `networkComponents`;
each destination world marks its own locally registered traits. Neither marker marks itself as
a trait. See [Component traits](#component-traits-policy-on-component-entities) for declarations.

### Registration provenance

Components created during a module's `init` become its `ChildOf` children, through
[`world.scope`](./modules.md#scopes-and-module-provenance). Read `world.component(C).parent`,
or walk parents to the nearest `Module` when an explicit hierarchy intervenes (for example
`OneOf` values). Existing registrations are never reparented by a second module. There is no
registrar list or per-trait audit; trait additions do not create separate entities. Vecs' own
constructor-installed built-in modules remain unscoped.

### Id pools

Entity ids are drawn from configurable pools. The defaults
(`DEFAULT_POOLS` in `lib/vecs/src/world/world.pools.ts`):

| Pool        | Range     | Used by           |
| ----------- | --------- | ----------------- |
| `component` | 1 – 899   | `world.component` |
| `module`    | 900 – 999 | `world.module`    |
| `entity`    | 1000 – ∞  | `world.entity()`  |

Pass `idPools` to the `World` constructor to change ranges (each entry is an `IdPoolConfig` with
`name`, `min`, optional `max`, and optional `reuseWaitFrames`). Freed ids wait
`reuseWaitFrames` frames (default `DEFAULT_ID_REUSE_WAIT_FRAMES = 16`) before reuse, so an id
released this frame is not immediately recycled. A frame is one `beginFrame()`, so one
`progress()`; a wait of `0` frees the id at once. Once the wait is over, allocation hands out free
ids before never-used ones, lowest first, so a released id is recycled by one of the next entities
created. A `ClientWorld` sets the wait to `0` for the ids of replicated entities and keeps the
default for its local ones. A `ServerWorld` allocates its replicated entities from the `entity` pool,
and holds a freed id for at least `historyFrames + 1` frames (65 by default) whatever the wait
asks for, so the frame that removed an entity has left every session's history before its id comes
back (see [Reusing entity ids](../../vecs-server/docs/sessions.md#reusing-entity-ids)). The
`networkEntityReuseWaitFrames` option of the networked worlds sets the wait of the pool that holds
the replicated entities: `entity` for a server, `network_entity` for a client. A diff that removes
an entity and snapshots a new one under the same id is read in a fixed order, which is how a client
tells the two apart (see [State diffs](../../vecs-protocol/docs/state-diffs.md)). A recycled id is
why a stored id is not a safe link between entities
(see [Link with edges, not stored ids](./relationships.md#link-with-edges-not-stored-ids)).
`NetworkWorld` uses the same component → module → entity layout, with `moduleIdCount` controlling
the size of its module range (100 by default); see [Network world id layout](../../vecs-protocol/docs/network-world.md).
`world.peekNextEid(poolName)` returns the next id a pool would allocate without reserving it. Id 0
is reserved.

## Hooks: component and relationship edges

The `Component` entity exposes lifecycle hooks fired for every entity carrying the component:

```ts
world
  .component(Sprite)
  .on("add", (entity, sprite) => sprite.initialize(scene, entity))
  .on("set", (entity, sprite) => sprite.syncToScene(entity))
  .on("remove", (entity, sprite) => sprite.destroy(scene, entity));
```

| Hook     | Fires when…                                                                                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `add`    | The component is first attached (`add`, or `set` on an entity that lacked an ordinary component).                                                                  |
| `set`    | `entity.set(C, props)` applies ordinary data, `entity.attach(instance)` stores an instance, `entity.modified(C)` is called, or `getMut` / `ensure` marks it dirty. |
| `remove` | The component is detached (`entity.remove(C)`), or the owning entity is destroyed.                                                                                 |

Two more events, `validate` and `normalize`, check or fix a component instance. They run only
through `world.validate` and `world.normalize`, never on a mutation; see
[Component reflection](./reflection.md#validating-and-normalizing). A class can also declare any hook
as a static `vecs_<event>` method, which runs ahead of hooks added with `on`; see
[`vecs_` statics](./reflection.md#vecs_-statics).

Relationship component entities additionally expose the `targetAdd` and `targetRemove` events. Both
receive `(source, relationshipInstance, target)` after the edge and reverse index reach their new
state. An exclusive replacement fires `targetRemove` for the old edge before `targetAdd` for
the new edge. Adding or removing edges never fires `set`; it is reserved for ordinary fields on
an existing relationship. See [Relationships — edge hooks](./relationships.md#edge-hooks) for the
full ordering.

Handlers receive `(entity, componentInstance)` — component instances do not carry entity
references, so the entity is passed explicitly. Hooks fire synchronously when the corresponding
command is applied (see [Execution model](./execution-model.md#reactive-routing)). Use hooks for
resource management and cross-cutting reactions that aren't worth a system; use systems when the
reaction belongs to a phase.

`remove` also fires when the owning entity is destroyed, and `entity.destroyed` is already `true`
inside the hook. A dying entity silently drops every write, including `ensure`, so write to it
without checking `destroyed` in a `remove` hook or a system's `exit`. Releasing the entity's resource
also needs no check. Check `entity.destroyed` only to skip other work that is pointless or unsafe
for a dying entity, such as re-projecting a view, refreshing other entities, or releasing shared
state (relationship hooks follow the same rule, see
[Relationships — edge hooks](./relationships.md#edge-hooks)):

```ts
class Shield {}
class Stats {
  armor = 0;
}

world.component(Shield).on("remove", (entity) => {
  entity.ensure(Stats, (stats) => (stats.armor -= 10)); // silently dropped on a dying entity
});
```

Multiple handlers may be registered for the same event: they fire in registration
order. Call `on(event, handler)` to append and `off(event, handler)` to remove a handler by
reference; both return the component entity for chaining. The built-in relationship traits
(`Exclusive`, `Traversable`, `OwnedTarget`, `With`, `OneOf`) register their handlers in the same
lists, ahead of yours, so your handlers see the state they establish: a `ChildOf` `targetAdd`
handler already finds the source's `Traversable` depth updated.

`entity.attach(instance)` that replaces a different stored instance fires only `set` for your
handlers. The built-in traits' own `remove` and `add` handlers run for the old and new instance
first, so a trait such as `Traversable` refuses being swapped out.

## Component traits: policy on component entities

Registered components are themselves entities. Attach a configuration component to a component
entity to change policy for every use of that component type. vecs calls these configuration
components **component traits**:

```ts
world.component(Gravity).add(Singleton);
world.component(Inventory).add(Exclusive).add(OwnedTarget);
world.component(ChildOf).add(Traversable); // ChildOf is already Exclusive
world.component(Orange).set(Implements, { interfaces: [Fruit] });
```

Declare a policy component by adding `Trait` to **its definition**, not to its carriers.
The built-in modules mark the traits below in their `init()` methods. `Trait` is only metadata:
it installs no hooks and is not an enforcement gate. Unmarked components may still be attached
to definitions, including world-global data stored with `world.set(C, ...)`. Being used on a
definition does not make a component a trait: `ComponentDef`, `Identity`, `ChildOf`, and a
component's own singleton data are not policy declarations.

| Trait/declaration | Applies to                                   | Effect                                                                       |
| ----------------- | -------------------------------------------- | ---------------------------------------------------------------------------- |
| `Singleton`       | Concrete components                          | Allows at most one carrier entity                                            |
| `Implements`      | Non-relationship components                  | Exposes concrete data through abstract aliases                               |
| `Exclusive`       | Relationships                                | Restricts the relationship to one target with atomic replacement             |
| `Traversable`     | Exclusive relationships                      | Maintains hierarchy depth for cascade ordering                               |
| `OwnedTarget`     | Exclusive relationships other than `ChildOf` | Owns each explicit target through `ChildOf` and destructive edge replacement |
| `OneOf`           | Relationships                                | Constrains each target to be a direct `ChildOf` child of a declared parent   |
| `With`            | A component and a target of the same kind    | Adding the component also adds the target (the same targets, for edges)      |
| `OnSnapshot`      | Components                                   | Selects a [subtree snapshot policy](./snapshots.md)                          |

`ClonePublic`, `DontSnapshot`, and `CustomSnapshot` are policy targets of `OnSnapshot`, not
traits, and remain unmarked. Phase, query, system, and module definitions are also not traits.

Traits declare policy; their built-in modules install the hooks and maintain the metadata that
enforce it. Configure traits in feature-module setup rather than opportunistically inside systems.
Do not assume all traits have the same lifecycle:

- Add `Singleton` before component instances exist.
- Add `Exclusive` before relationship instances exist. `OwnedTarget` and `Traversable` require it.
- Add `OwnedTarget` before relationship instances exist; it never creates a target implicitly and
  does not replace public edge hooks.
- Add `OneOf` before relationship instances exist; it rejects every target that is not a direct
  `ChildOf` child of the declared parent.
- `Traversable` backfills existing relationship instances.
- Setting or removing `Implements` recomputes interface aliases.
- Add `With` before the component is in use, as `world.component(X).add(With, world.component(Y))`.
  It is irrevocable, both must be plain components or both relationships, and it only brings `Y`
  along: an existing `Y` is left as it is, and removing `X` does not remove `Y`. On a `ClientWorld`,
  a network removal of `Y` is skipped while `X` is on the entity (see
  [Applying a frame](../../vecs-client/docs/client-world.md#applying-a-frame)).

Treat traits as setup policy unless their documentation explicitly supports runtime changes. Before
writing custom component-type bookkeeping, check whether an existing trait already expresses the
invariant.

Custom traits use the same mechanism. Keep the trait class as data and put its behavior in a module:

```ts
import { Module, Trait } from "@vworlds/vecs";

class Audited {}

class AuditModule extends Module {
  public init(): void {
    this.world
      .component(Audited)
      .add(Trait)
      .on("add", (component) => {
        component.on("set", (entity) =>
          console.log("changed", component.meta.Class.name, entity.eid)
        );
      });
  }
}

world.module(AuditModule);
world.component(Position).add(Audited);
```

Create a custom trait only when several component types need the same reusable, declarative policy.
For one component type, register hooks directly in its owning module.

## Exclusive component groups

`world.setExclusiveComponents(A, B, C)` declares a mutually exclusive group: setting one
automatically removes the others first.

```ts
world.setExclusiveComponents(Walking, Running, Idle);

const e = world.entity();
e.add(Walking);
e.add(Running); // Walking is removed first
```

Each call defines one independent group. A component belongs to at most one group; calling
`setExclusiveComponents` again with the same class overwrites its group membership. Safe to call
at any time. Exclusivity is how you model "exactly one of N" (one renderable per entity, one
physics shape per body) — and it makes type swaps clean, because replacing the component fires the
old one's `exit`/`onRemove` automatically.

This is distinct from the `Exclusive` relationship trait. `setExclusiveComponents(A, B)` chooses
which **component class** may exist; `world.component(R).add(Exclusive)` allows one instance of
relationship `R` as usual but limits it to one **target edge**, replacing that edge atomically. See
[Relationships — exclusive one-target relationships](./relationships.md#exclusive-one-target-relationships).

## Cleanup policies: destroying a component entity

Every component key is backed by a component entity. What happens when you destroy that entity
while other entities still carry the component is controlled by `meta.onDelete`
(`CleanupPolicy` in `lib/vecs/src/component_meta.ts`):

| Policy                 | Meaning                                                                                                                                                                                                                                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CleanupPolicy.Throw`  | Default. Destroying the component entity while other entities carry it throws. The synchronous `destroy()` call throws before mutating anything, so the world stays usable; a `Throw` policy reached during a deferred drain or a relationship cascade throws and leaves the world partial — discard it. |
| `CleanupPolicy.Remove` | Remove the component from every carrier, then destroy the component entity.                                                                                                                                                                                                                              |
| `CleanupPolicy.Delete` | Destroy every carrier entity, then destroy the component entity.                                                                                                                                                                                                                                         |

```ts
import { CleanupPolicy } from "@vworlds/vecs";

world.component(Temporary).meta.onDelete = CleanupPolicy.Remove;
world.component(Temporary).destroy(); // strips Temporary from all carriers
```

The `Throw` default also applies to plain entities used as component keys (`entity.add(keyEntity)`).

## Snapshot policies: what a component may cross worlds with

A component type also declares how
[subtree snapshots](./snapshots.md) capture it, through `world.component(Type).snapshotPolicy(...)`.
The default — no declaration — deep-copies the instance's own enumerable fields, and **fails
loudly at capture** on a nested value that is not plain data, so a component carrying a class
instance must declare a policy saying how that instance is detached. `DontSnapshot` marks a
type as world-bound (an engine handle, a socket, a live `Query`), and `CustomSnapshot` with
`capture` / `materialize` callbacks is how a type that mixes declarative and runtime state hands over
only the declarative half:

```ts
world.component(PhysicsEngine).snapshotPolicy(DontSnapshot);
```

A policy is declared by the owning module and may change at any time: a capture binds the
materializer its policy resolved to, so an existing snapshot always restores the way it was
captured.
A synchronous `destroy()` throw (component still in use) leaves the world usable. A throw during
deferred drain or a cascade is irrecoverable — the component entity, its carriers, and the usage
count are in a partial state and the world must be discarded. Configure cleanup policies so cascades
are consistent; treat a mid-destroy throw as a programming error.

Relationship components have a second, independent policy — `meta.onDeleteTarget` — that governs
what happens to _sources_ when a relationship **target** is destroyed. See
[Relationships](./relationships.md#cleanup-when-a-target-dies).

## Interface aliases with `Implements`

Use the built-in `Implements` component when one concrete component should be queryable through
abstract parent or interface component types. The concrete component stays the single source of
truth; vecs stores the same instance under each alias, so `get(Parent) === get(Concrete)`:

```ts
import { Implements, World } from "@vworlds/vecs";

abstract class Food {
  calories = 0;
}

abstract class Fruit extends Food {
  color = "";
}

class Orange extends Fruit {
  acidity = 8;
}

const world = new World();
world.component(Food);
world.component(Fruit).set(Implements, { interfaces: [Food] });
world.component(Orange).set(Implements, { interfaces: [Fruit] });

const orange = world.entity().set(Orange, { calories: 7 });

orange.get(Food) === orange.get(Orange); // true
orange.has(Fruit); // true

world
  .query("foods")
  .with(Food)
  .forEach([Food], (_entity, [food]) => {
    food.calories; // Orange data, read through the Food alias
  });
```

Rules (enforced by `ImplementsModule`, `lib/vecs/src/modules/implements.ts`):

- **Aliases are read/query only.** `get`, `has`, `with`, `filter`, and injection accept an
  interface type; mutation must go through the concrete component. `add`, `set`, `remove`,
  `modified`, `getMut`, `ensure`, and `attach` on an interface throw at runtime (`ensure` drops first
  on a destroyed entity; `add`/`set` are rejected by TypeScript for abstract classes).
- **Declarations are transitive.** `Orange` implements `Fruit`, `Fruit` implements `Food`, so an
  entity with `Orange` matches `with(Food)`. Cyclic declarations throw.
- **One implementer per interface per entity.** Setting a second concrete component that
  implements the same interface evicts the first concrete component and all of its aliases.
- Relationship components cannot be implementers or interfaces.

## Singletons and world-global data

Tag a component class with `Singleton` to enforce that at most one entity holds it:

```ts
import { Singleton } from "@vworlds/vecs";

world.component(Gravity).add(Singleton); // adding Gravity to a second entity now throws
```

For world-global state, store the component **on its own component entity** with the `world.get` /
`world.set` shorthand:

```ts
world.set(Gravity, { y: -9.8 }); // world.component(Gravity).set(Gravity, {...})
world.get(Gravity)?.y; // world.component(Gravity).get(Gravity)
```

`SingletonModule` enforces the constraint (`lib/vecs/src/modules/singleton.ts`); see
[Modules](./modules.md#built-in-modules).

## Resources as components (non-ECS objects)

To bind a non-ECS resource (a renderer object, a WASM handle, a DOM node) to an entity, **store
the live object itself as a component** with `entity.attach(obj)` instead of keeping a side
`Map<eid, resource>`:

```ts
const obj = scene.add.arc(0, 0); // a Phaser GameObject
entity.attach(obj); // the GameObject is now a component, keyed by its class

world.component(Phaser.GameObjects.Arc).on("remove", (_entity, obj) => obj.destroy());
```

The entity's component set then _is_ the resource lifecycle: queries drive create/destroy, and
`onRemove` releases the resource whether the component is removed explicitly or the entity is
destroyed. A plain wrapper component (`class Handle { obj }`) still works when you need extra fields
beside the resource. The full pattern — create/update, the remove-hook teardown, and `Implements`
interface markers for polymorphic dispatch — is in the
[Design guide](./design-guide.md#7-patterns-reach-for-these).

## Reference

### `World` component methods (`lib/vecs/src/world/world.components.ts`)

| Method                               | Description                                                                                        |
| ------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `component(Class, ceid?)`            | Register or look up the `Component` entity for `Class`; optional explicit numeric id.              |
| `component(name)`                    | Resolve an already-registered component entity by its `name`. Throws if absent or not a component. |
| `get(Class)`                         | Singleton read: `component(Class).get(Class)`.                                                     |
| `set(Class, props)`                  | Singleton write: `component(Class).set(Class, props)`.                                             |
| `setExclusiveComponents(...classes)` | Declare one mutually exclusive group.                                                              |
| `validate(c)` / `isValid(c)`         | Run the class's `validate` hooks; see [Component reflection](./reflection.md).                     |
| `normalize(c)`                       | Run the class's `normalize` hooks, modifying `c` in place.                                         |

### `Component` entity (`lib/vecs/src/component.ts`)

A `Component<T>` is an `Entity` subclass, so the full [entity API](./entities.md#reference)
applies. On top of it:

| Member                | Description                                                                                                                                                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `member(name, type)`  | Declare a member for [reflection](./reflection.md) and return the component; `.range` / `.description` / `.unit` / `.values` then apply to it.                                                                                   |
| `on(event, handler)`  | Register a handler for `add` / `remove` / `set` / `targetAdd` / `targetRemove` / `validate` / `normalize`, appended after the handlers already registered. Rejects `target*` events on non-relationships. Returns the component. |
| `off(event, handler)` | Remove a previously-registered handler by reference. Idempotent. Returns the component.                                                                                                                                          |
| `meta`                | The `ComponentMeta` bookkeeping record.                                                                                                                                                                                          |

### `ComponentMeta` (`lib/vecs/src/component_meta.ts`)

| Field                   | Description                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| `Class`                 | The component class constructor.                                                              |
| `eid`                   | Component entity id assigned at registration.                                                 |
| `bitPtr`                | Pre-computed bit pointer into entity archetype bitsets.                                       |
| `isRelationship`        | `true` when the class extends `Relationship`.                                                 |
| `relationshipExclusive` | `true` when the relationship carries the `Exclusive` trait.                                   |
| `onDelete`              | `CleanupPolicy` applied to carriers when the component entity is destroyed. Default `Throw`.  |
| `onDeleteTarget`        | `CleanupPolicy` applied to sources when a relationship target is destroyed. Default `Remove`. |
| `usageCount`            | Number of entities currently carrying this component.                                         |
