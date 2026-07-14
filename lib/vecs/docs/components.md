# Components

Define plain-data components, register them with the world, and configure their lifecycle: hooks,
exclusivity, cleanup policies, interface aliases, and singletons.

## Components are plain data classes

A component is an ordinary class with field initializers and a no-argument constructor. It does
not inherit from a vecs base class — vecs instantiates it with `new ComponentClass()`:

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
released this frame is not immediately recycled. `world.peekNextEid(poolName)` returns the next id
a pool would allocate without reserving it. Id 0 is reserved.

## Hooks: `onAdd`, `onSet`, `onRemove`, `onRetarget`

The `Component` entity exposes lifecycle hooks fired for every entity carrying the component:

```ts
world
  .component(Sprite)
  .onAdd((entity, sprite) => sprite.initialize(scene, entity))
  .onSet((entity, sprite) => sprite.syncToScene(entity))
  .onRemove((entity, sprite) => sprite.destroy(scene, entity));
```

| Hook       | Fires when…                                                                                                                                               |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onAdd`    | The component is first attached (`add`, or `set` on an entity that lacked it).                                                                            |
| `onSet`    | `entity.set(C, props)` applies data, `entity.attach(instance)` stores an instance, `entity.modified(C)` is called, or `getMut` / `ensure` marks it dirty. |
| `onRemove` | The component is detached (`entity.remove(C)`), or the owning entity is destroyed.                                                                        |

Relationship component entities additionally expose `onRetarget`. It fires after an existing
relationship changes to a different target, once `target` and `children` already reflect the new
reverse-index state. Initial assignment, same-target `set`, and removal do not fire it.

Handlers receive `(entity, componentInstance)` — component instances do not carry entity
references, so the entity is passed explicitly. Hooks fire synchronously when the corresponding
command is applied (see [Execution model](./execution-model.md#reactive-routing)). Use hooks for
resource management and cross-cutting reactions that aren't worth a system; use systems when the
reaction belongs to a phase.

Each lifecycle event has one handler slot per component. Calling `onAdd(handler)`,
`onSet(handler)`, `onRemove(handler)`, or `onRetarget(handler)` replaces the current handler and
returns the component entity for chaining. Call the method without an argument to read the current
handler, or pass `undefined` to remove it.

## Component traits: policy on component entities

Registered components are themselves entities. Attach a configuration component to a component
entity to change policy for every use of that component type. vecs calls these configuration
components **component traits**:

```ts
world.component(Gravity).add(Singleton);
world.component(Inventory).add(OwnedTarget);
world.component(ChildOf).add(Traversable);
world.component(Orange).set(Implements, { interfaces: [Fruit] });
```

| Trait/declaration | Applies to                         | Effect                                                               |
| ----------------- | ---------------------------------- | -------------------------------------------------------------------- |
| `Singleton`       | Concrete components                | Allows at most one carrier entity                                    |
| `Implements`      | Non-relationship components        | Exposes concrete data through abstract aliases                       |
| `Traversable`     | Relationships                      | Maintains hierarchy depth for cascade ordering                       |
| `OwnedTarget`     | Relationships other than `ChildOf` | Owns the active target through `ChildOf` and destructive replacement |

Traits declare policy; their built-in modules install the hooks and maintain the metadata that
enforce it. Configure traits in feature-module setup rather than opportunistically inside systems.
Do not assume all traits have the same lifecycle:

- Add `Singleton` before component instances exist.
- Configure owner hooks, then add `OwnedTarget`, before relationship instances exist; it wraps the
  current hooks and does not backfill.
- `Traversable` backfills existing relationship instances.
- Setting or removing `Implements` recomputes interface aliases.

Treat traits as setup policy unless their documentation explicitly supports runtime changes. Before
writing custom component-type bookkeeping, check whether an existing trait already expresses the
invariant.

Custom traits use the same mechanism. Keep the trait class as data and put its behavior in a module:

```ts
class Audited {}

class AuditModule extends Module {
  public init(): void {
    this.world.component(Audited).onAdd((component) => {
      component.onSet((entity) => console.log("changed", component.meta.Class.name, entity.eid));
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

## Cleanup policies: destroying a component entity

Every component key is backed by a component entity. What happens when you destroy that entity
while other entities still carry the component is controlled by `meta.onDelete`
(`CleanupPolicy` in `lib/vecs/src/component_meta.ts`):

| Policy                 | Meaning                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| `CleanupPolicy.Throw`  | Default. Destroying the component entity while other entities carry it throws and changes nothing. |
| `CleanupPolicy.Remove` | Remove the component from every carrier, then destroy the component entity.                        |
| `CleanupPolicy.Delete` | Destroy every carrier entity, then destroy the component entity.                                   |

```ts
import { CleanupPolicy } from "@vworlds/vecs";

world.component(Temporary).meta.onDelete = CleanupPolicy.Remove;
world.component(Temporary).destroy(); // strips Temporary from all carriers
```

The `Throw` default also applies to plain entities used as component keys (`entity.add(keyEntity)`).
A failed destroy leaves the component entity, its carriers, and the usage count untouched.

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
  `modified`, `getMut`, `ensure`, and `attach` on an interface throw at runtime (and `add`/`set` are
  rejected by TypeScript for abstract classes).
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

world.component(Phaser.GameObjects.Arc).onRemove((_entity, obj) => obj.destroy());
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

### `Component` entity (`lib/vecs/src/component.ts`)

A `Component<T>` is an `Entity` subclass, so the full [entity API](./entities.md#reference)
applies. On top of it:

| Member                 | Description                                                                |
| ---------------------- | -------------------------------------------------------------------------- |
| `onAdd(handler?)`      | Get, set, or remove the single add hook. Setter returns the component.     |
| `onRemove(handler?)`   | Get, set, or remove the single remove hook.                                |
| `onRetarget(handler?)` | Get, set, or remove the relationship retarget hook. Rejects non-relations. |
| `onSet(handler?)`      | Get, set, or remove the single set/modified hook.                          |
| `meta`                 | The `ComponentMeta` bookkeeping record.                                    |

### `ComponentMeta` (`lib/vecs/src/component_meta.ts`)

| Field            | Description                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `Class`          | The component class constructor.                                                              |
| `eid`            | Component entity id assigned at registration.                                                 |
| `bitPtr`         | Pre-computed bit pointer into entity archetype bitsets.                                       |
| `isRelationship` | `true` when the class extends `Relationship`.                                                 |
| `onDelete`       | `CleanupPolicy` applied to carriers when the component entity is destroyed. Default `Throw`.  |
| `onDeleteTarget` | `CleanupPolicy` applied to sources when a relationship target is destroyed. Default `Remove`. |
| `usageCount`     | Number of entities currently carrying this component.                                         |
