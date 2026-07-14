# Entities

Create, look up, mutate, and destroy entities, and understand how the entity API behaves under
deferred mutation.

## What an entity is

An `Entity` (`lib/vecs/src/entity/entity.ts`) is a unique numeric id (`eid`) owned by a `World`,
with an arbitrary set of component instances attached. Never instantiate `Entity` directly —
create entities through the world.

## Creating and looking up entities

```ts
// New entity with an auto-assigned id (from the "entity" pool, 1000+ by default):
const e = world.entity();

// Look up by id (throws if not found):
const found = world.entity(42);

// Optional lookup — returns undefined instead of throwing:
const maybe = world.getEntity(42);

// Externally assigned id (e.g. from a server); creates the entity if absent:
const net = world.getOrCreateEntity(serverId, (newEntity) => {
  tracked.add(newEntity);
});

// Named entities, via the built-in Identity component:
world.entity("player"); // looks up by name, creating the entity if absent
world.entity("player").name === "player"; // true
world.getEntity("player"); // lookup only — undefined when absent
```

`world.entity(ref)` also accepts a registered component class (returning its component entity) or
an `Entity` (validating it belongs to this world). Names are maintained by `IdentityModule`:
setting `entity.name` writes the `Identity` component, and duplicate names are last-writer-wins.

`world.entities` is a read-only view of every live entity keyed by id, and `world.clearAllEntities()`
destroys **every** entity in the world — ordinary entities first, then component entities once
their carriers are gone. It is a full wipe (systems and phases are backed by entities too); use it
for end-of-session teardown, not selective resets.

## The component API

```ts
e.add(Position); // attach with default field values (idempotent)
e.set(Position, { x: 100 }); // attach if needed, assign props, fire onSet/update
e.get(Position); // Readonly<Position> | undefined
e.ensure(Position, (pos) => (pos.x += 1)); // create if needed, then mutate and notify
e.ensureTarget(FriendOf); // get or create an independent relationship target
e.has(Position); // boolean
e.remove(Position); // detach; fires exit callbacks, then onRemove
e.modified(Position); // mark changed after in-place mutation
e.destroy(); // remove everything and unregister the entity
```

All mutators return the entity for chaining (`remove` and `destroy` return `void`). Component
references can be a registered class, a numeric component id, or an entity used as a component
key.

### `set` vs `add` vs `modified`

- `add(C)` attaches with defaults and fires `onAdd` only. It is idempotent and does **not** fire
  `onSet`.
- `set(C, props)` attaches if needed (firing `onAdd`), copies `props` onto the instance, and fires
  `onSet` plus `update` callbacks.
- `ensure(C, callback)` creates the component if missing, then lets you mutate it and fires
  `onAdd` followed by one `onSet`. When the component already exists, it behaves like `getMut`.
- `modified(C)` fires `onSet`/`update` for data you already mutated in place. Repeated calls are
  coalesced until the world routes the notification.

### `getMut` and `ensure`: mutating in place

`get` returns a `Readonly` view. To mutate, use `getMut`, which marks the component modified for
you:

```ts
// Inside a system / forEach / defer block (deferred mode) — returns the mutable instance:
const vel = e.getMut(Velocity)!;
vel.vx += 1;

// Outside deferred mode you must use the callback form, so the modified
// notification fires after your mutation:
e.getMut(Velocity, (vel) => {
  vel.vx += 1;
});
```

Use `ensure` when absence should mean "create with defaults, then mutate":

```ts
e.ensure(Velocity, (vel) => {
  vel.vx = 2;
});
```

`ensure` always returns a component for a live entity. Calling it on a destroyed entity throws.
When several calls ensure the same missing component during one deferred scope, they return the
same pending instance. The instance remains hidden from `get` and queries until the queue drains,
but every ensure callback mutates that shared pending value.

Use `ensureTarget` for the corresponding get-or-create operation on a registered relationship:

```ts
world.component(FriendOf);

const friend = entity.ensureTarget(FriendOf);
entity.ensureTarget(FriendOf) === friend; // true
entity.target(FriendOf) === friend; // true after deferred changes flush
```

When the relationship is absent, `ensureTarget` creates an independent entity and points the
relationship at it. It does not add `ChildOf`; destroying the source does not destroy the generated
target. Repeated calls during one deferred scope return the same pending target, while `target`
continues to expose only committed state until the queue drains.

Mark the relationship with `OwnedTarget` during world setup when its targets should instead be
owned by their sources:

```ts
world.component(Inventory).add(OwnedTarget);

const inventory = player.ensureTarget(Inventory);
inventory.parent === player; // true after deferred changes flush

player.add(Inventory); // also creates an owned target
```

The relationship module creates a target when an owned relationship is added, adds `ChildOf`
whenever `Inventory` is assigned, destroys displaced targets on retarget, and destroys the current
target when the relationship is removed. Destroying `player` therefore also destroys `inventory`.
See [Relationships](./relationships.md#owned-targets).

Calling `getMut(C)` or `ensure(C)` without a callback outside deferred mode throws. Both methods
also throw for relationship components (retarget with `set` instead — see
[Relationships](./relationships.md#retargeting)) and for `Implements` interface aliases.

### `attach`: storing an existing instance

`attach` stores the exact object you pass, replacing any previous instance of that component
class, and fires events as a `set` would:

```ts
const shared = new Position();
e.attach(shared);
e.get(Position) === shared; // true

// Store under a base class key instead of the instance's own constructor:
e.attach(BaseShape, concreteShape);
```

The resolved class must already be registered in the entity's world. Use `attach` when component
ownership is intentionally shared with caller code or another object graph; code receiving the
component through vecs callbacks should use the entity vecs passes, not assume a 1:1 mapping.

### Deferred semantics

Inside a system body, a `forEach`, or a `world.defer` block, all of the mutators above enqueue
commands instead of applying immediately, and reads return the pre-mutation state until the queue
drains. The exact read-after-write rules are tabulated in
[Execution model — deferred mutation](./execution-model.md#deferred-mutation-and-flush-boundaries).
`ensure(C)` is the exception for mutable access: it returns a mutable component immediately, but a
newly created component does not appear in `get(C)` until the queue drains.

Deferred entity creation is idempotent within one deferred scope: if `world.entity()` or
`getOrCreateEntity(eid)` creates a new entity, `getEntity(eid)`, `entity(eid)`, and later
`getOrCreateEntity(eid)` calls before the drain return that same pending entity. Collection-style
reads such as `world.entities` and queries still do not see the entity until the queued creation
drains.

## Destroying entities

`e.destroy()` removes every component (firing each `onRemove` hook and query `exit`), emits the
entity's `"destroy"` event just before teardown, unregisters the entity from the world, and
applies incoming relationship cleanup policies (see
[Relationships](./relationships.md#cleanup-when-a-target-dies)). After destruction the entity must
not be used.

If the entity is itself in use as a component key, `destroy` honors `meta.onDelete` — by default
it throws while carriers remain ([Components — cleanup policies](./components.md#cleanup-policies-destroying-a-component-entity)).

## Entities as component keys

Any entity can serve as a component key: `other.add(keyEntity)` attaches a marker component whose
type id is the key entity's eid. The key entity's `meta` (created lazily) carries the same hook
and policy surface as a registered class, and `keyEntity.onAdd/onSet/onRemove(...)` get, set, or
remove its single lifecycle handlers directly. This is how tag-like, runtime-created component
types work without declaring a class. Registered relationship component entities additionally
expose `onRetarget(...)`.

## Relationships, in brief

`e.target(Rel)` returns the target of a relationship component, `e.children(Rel)` the set of
entities targeting `e` through it, and `e.childOf(parent)` is shorthand for
`e.set(ChildOf, { target: parent })`. The full model — retargeting, cleanup cascades, traversal —
is in [Relationships](./relationships.md).

## Reference

`lib/vecs/src/entity/` (split across `entity.base.ts`, `entity.components.ts`,
`entity.lifecycle.ts`, `entity.relationships.ts`):

| Property / Method                              | Description                                                                                         |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `eid`                                          | Unique numeric entity id.                                                                           |
| `world`                                        | The `World` that owns this entity.                                                                  |
| `name`                                         | Identity name (getter/setter backed by the `Identity` component); `undefined` when unnamed.         |
| `componentBitmask`                             | `Bitset` of component type ids attached. Used for archetype matching.                               |
| `components`                                   | Read-only `ArrayMap` view of attached instances keyed by type id (`forEach`, `get`, `has`, `size`). |
| `empty`                                        | `true` when no components are attached.                                                             |
| `properties`                                   | Free-form `Map<string, any>` for module-level bookkeeping.                                          |
| `meta`                                         | `ComponentMeta` for using this entity as a component key (created lazily).                          |
| `instanceCount()`                              | Number of entities currently carrying this entity's eid as a component.                             |
| `add(ref)`                                     | Attach a component with default values (idempotent). Returns `this`.                                |
| `attach(instance)` / `attach(Class, instance)` | Store an existing instance, replacing any previous one; fires set-side events. Returns `this`.      |
| `set(ref, props)`                              | Attach if needed and assign `props`; fires `onSet` and `update` callbacks. Returns `this`.          |
| `get(ref)`                                     | Read-only component lookup, or `undefined`.                                                         |
| `getMut(ref)` / `getMut(ref, callback)`        | Mutable lookup that marks the component modified. Callback form required outside deferred mode.     |
| `ensure(ref)` / `ensure(ref, callback)`        | Mutable lookup that creates when missing. Callback form required outside deferred mode.             |
| `ensureTarget(Relationship)`                   | Return a relationship target, creating an independent target when absent.                           |
| `has(ref)`                                     | `true` when the component is attached.                                                              |
| `modified(ref)`                                | Queue an `onSet`/`update` notification; coalesced while pending. Returns `this`.                    |
| `remove(ref)`                                  | Detach a component; routes `exit`, then fires `onRemove`.                                           |
| `destroy()`                                    | Remove all components, unregister, and apply incoming relationship cleanup.                         |
| `target(rel)`                                  | Target entity of relationship `rel`, or `undefined`.                                                |
| `children(rel)`                                | `ReadonlySet<Entity>` of entities targeting this one through `rel`.                                 |
| `childOf(parent)`                              | Shorthand for `set(ChildOf, { target: parent })`. Returns `this`.                                   |
| `parent` / `parent = p`                        | Getter/setter for the built-in `ChildOf` target; assigning `undefined` removes `ChildOf`.           |
| `destroyed` / `alive`                          | `true` when the entity has been / has not been destroyed (marked for deletion).                     |
| `onAdd/onSet/onRemove(handler?)`               | Get, set, or remove this component key's single hook. Setters return `this`.                        |
| `onRetarget(handler?)`                         | Get, set, or remove a relationship component entity's single retarget hook.                         |
| `toString()`                                   | Returns `"EntityN"`.                                                                                |
