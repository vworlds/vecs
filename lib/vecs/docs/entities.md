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
for end-of-session teardown, not selective resets. To destroy only what the application created
and keep the world's own entities, see [Disposing a world](#disposing-a-world).

## The component API

```ts
e.add(Position); // attach with default field values (idempotent)
e.set(Position, { x: 100 }); // attach if needed, assign props, fire onSet/update
e.add(FriendOf, friend); // relationship edges require an explicit target
e.remove(FriendOf, friend); // remove one relationship edge
e.get(Position); // Readonly<Position> | undefined
e.ensure(Position, (pos) => (pos.x += 1)); // create if needed, then mutate and notify
e.has(Position); // boolean
e.remove(Position); // detach; fires exit callbacks, then onRemove
e.modified(Position); // mark changed after in-place mutation
e.destroy(); // remove everything and unregister the entity
```

All mutators return the entity for chaining (`remove` and `destroy` return `void`). Component
references can be a registered class, a numeric component id, or an entity used as a component
key. Relationship `target` arguments accept the same `ComponentRef` shapes (class, numeric id, or
entity) and are resolved eagerly via `world.entity(target)`, so the target entity must already
exist when the call is made.

### `set` vs `add` vs `modified`

- `add(C)` attaches with defaults and fires `onAdd` only. It is idempotent and does **not** fire
  `onSet`.
- For ordinary components, `set(C, props)` attaches if needed (firing `onAdd`), copies `props` onto
  the instance, and fires `onSet` plus `update` callbacks.
- `ensure(C, callback)` creates the component if missing, then lets you mutate it and fires
  `onAdd` followed by one `onSet`. When the component already exists, it behaves like `getMut`.
- `modified(C)` fires `onSet`/`update` for data you already mutated in place. Repeated calls are
  coalesced until the world routes the notification.

Relationships use a stricter API: `add(R, target)` creates a unique edge, `remove(R, target)`
removes one edge, and `remove(R)` removes every edge. `set(R, props)` updates only ordinary fields
on an existing relationship and never creates or changes edges. See
[Relationships](./relationships.md#adding-removing-and-setting).

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

`getMut` marks the component modified whenever it is present, with or without a callback and whether
or not you assign anything: the callback form marks it after the callback returns, and the
callback-free form marks it before it returns the instance, so even a read-only use notifies. The
mark fires `onSet`, routes an `update` event to every system watching the component and replicates a
networked component (repeated marks before the queue drains coalesce into one). A `getMut` that runs
every tick therefore does all of that every tick. Read with `get`, and call `getMut` only when a
change is intended. When the component is absent, `getMut` returns `undefined` and marks nothing.

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

Calling `getMut(C)` or `ensure(C)` without a callback outside deferred mode throws. Both methods
also throw for relationship components (change edges with `add` / `remove` and ordinary data with
`set`) and for `Implements` interface aliases. `attach` rejects relationships for the same reason:
their private edge storage must remain under vecs's control.

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

Relationship edge commands share the same FIFO queue. Until it drains, `has(R)`, `target(R)`,
`targets(R)`, `hasTarget(R, target)`, and `children(R)` expose only committed edges.

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

A `destroy()` thrown synchronously (a `Throw`-policy component entity still in use) leaves the world
usable because nothing has been mutated. A throw during deferred drain or a relationship cleanup
cascade — an impossible policy combination, a `Throw`-policy component reached via a cascade, or a
hook that throws — propagates out of `progress()` / `flush()` and leaves the world in a partial
state. Treat this as a programming error: recreate the world or stop.

## Entities as component keys

Any entity can serve as a component key: `other.add(keyEntity)` attaches a marker component whose
type id is the key entity's eid. The key entity's `meta` (created lazily) carries the same hook
and policy surface as a registered class, and `keyEntity.on("add" / "set" / "remove" / "targetAdd" /
"targetRemove", handler)` registers its lifecycle handlers directly. This is how tag-like,
runtime-created component types work without declaring a class.

## Disposing a world

When you are finished with a world — a scene or route change, a hot reload — call
`world.dispose()` and drop the reference. It destroys application entities, then the world's
infrastructure, so the `remove` hook of each component they carry runs and releases what the component
owns: a render object, a handle, a timer.

```ts
class Handle {
  public released = false;
}

world.component(Handle).on("remove", (_entity, handle) => {
  handle.released = true; // release the resource here
});

const handle = new Handle();
world.entity().attach(handle);

world.dispose();
handle.released; // true
```

Disposal uses two passes through the existing entity destroy path. Every `remove` hook fires once;
entities already destroyed by a hook or cascade are skipped. In **pass 1**, every application entity
uses ordinary [cleanup policies and cascades](./relationships.md#cleanup-when-a-target-dies).
This includes plain entities created inside module scopes, even though their parent is infrastructure.
Application hook-generated commands settle before pass 2 starts.

**Pass 2** destroys remaining infrastructure (`lib/vecs/src/world/world.disposal.ts`):

| Infrastructure                | Recognized by                                                 |
| ----------------------------- | ------------------------------------------------------------- |
| Component and module entities | They are `Component` instances; `Module` extends `Component`. |
| Query and system entities     | They carry the `Query` component.                             |
| Phase entities                | They carry the `Phase` component.                             |

Data stored on component entities (including singletons set with `world.set`) is removed once,
after queued application cleanup. Bind module-owned resources to that data with `remove` hooks;
you do not need a separate disposal callback.

During pass 2 only, cleanup policies are suspended. `ChildOf`/`OwnedTarget` do not cascade;
children are destroyed explicitly in the pass. A component still carried by another entity is removed
from each carrier through the ordinary remove path, firing its public `remove` hooks, instead of
throwing or deleting the carriers. Irrevocable relationship-trait guards are bypassed, extending the
existing destroy-time exemption. This suspension also covers the pass's hook-generated commands and
is reset in `finally`. Successful disposal leaves nothing, including component-carrier cycles.

- **Order.** Among unrelated entities the order is unspecified, so do not make a hook depend on it.
  Pass 2 processes systems and queries first, then modules in reverse registration order, then the
  rest. Beyond those priorities the order is unspecified; it is not a resource dependency contract.
  There is no infrastructure carriers-first sort or dependency-survivor error. If an internal bug
  prevents a full teardown pass from destroying anything, an invariant error names the remaining
  registered entities instead of looping forever. `clearAllEntities()` retains its
  ordinary cleanup policies and throwing behavior; it orders both carriers before component keys
  and children before parents, and throws if those dependencies cannot be ordered. The suspension
  belongs only to `dispose()`.
- **Call site.** Call at top level: not inside `progress()`, `defer`, a command drain or an
  entity's destroy. A forbidden call throws before disposal changes anything, leaving the world
  usable; finish the enclosing operation and dispose afterwards. Ordinary synchronous top-level
  `add`, `set` and `remove` hooks may call it. Teardown is synchronous: application hook-generated
  commands settle before infrastructure teardown, and `dispose()` returns with the entities gone.
  The final pass drains its own hook-generated commands and repeats while it can destroy more entities.
- **After disposal.** A disposed world must not be used again. Nothing enforces it — no other method
  mutation checks are added. Calling `dispose()` again at top level does nothing; the call-site
  rule still applies during teardown. Do not keep spawning from teardown hooks: that prevents
  the repeated final pass from settling. A system's queued `exit` callback will not run after
  teardown; release resources in `remove` hooks, as
  [Resources as components](./design-guide.md#resources-as-components-hold-non-ecs-objects)
  recommends.

## Relationships, in brief

`e.target(Rel)` returns one current target, `e.targets(Rel)` a readonly snapshot of every target,
`e.hasTarget(Rel, target)` tests one edge, and `e.children(Rel)` returns the sources targeting `e`.
`e.childOf(parent)` is shorthand for `e.add(ChildOf, parent)`. The full model is in
[Relationships](./relationships.md).

## Reference

`lib/vecs/src/entity/` (split across `entity.base.ts`, `entity.components.ts`,
`entity.lifecycle.ts`, `entity.relationships.ts`):

| Property / Method                              | Description                                                                                                                                                           |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eid`                                          | Unique numeric entity id.                                                                                                                                             |
| `world`                                        | The `World` that owns this entity.                                                                                                                                    |
| `name`                                         | Identity name (getter/setter backed by the `Identity` component); `undefined` when unnamed.                                                                           |
| `componentBitmask`                             | `Bitset` of component type ids attached. Used for archetype matching.                                                                                                 |
| `components`                                   | Read-only `ArrayMap` view of attached instances keyed by type id (`forEach`, `get`, `has`, `size`).                                                                   |
| `empty`                                        | `true` when no components are attached.                                                                                                                               |
| `properties`                                   | Free-form `Map<string, any>` for module-level bookkeeping.                                                                                                            |
| `meta`                                         | `ComponentMeta` for using this entity as a component key (created lazily).                                                                                            |
| `instanceCount()`                              | Number of entities currently carrying this entity's eid as a component.                                                                                               |
| `add(ref)` / `add(Relationship, target)`       | Attach an ordinary component, or add one explicit relationship edge. `target` accepts any `ComponentRef` resolved eagerly via `world.entity(target)`. Returns `this`. |
| `attach(instance)` / `attach(Class, instance)` | Store an existing instance, replacing any previous one; fires set-side events. Returns `this`.                                                                        |
| `set(ref, props)`                              | Attach/set ordinary data; relationships must exist and only ordinary fields are assigned.                                                                             |
| `get(ref)`                                     | Read-only component lookup, or `undefined`.                                                                                                                           |
| `getMut(ref)` / `getMut(ref, callback)`        | Mutable lookup that marks the component modified. Callback form required outside deferred mode.                                                                       |
| `ensure(ref)` / `ensure(ref, callback)`        | Mutable lookup that creates when missing. Callback form required outside deferred mode.                                                                               |
| `has(ref)`                                     | `true` when the component is attached.                                                                                                                                |
| `modified(ref)`                                | Queue an `onSet`/`update` notification; coalesced while pending. Returns `this`.                                                                                      |
| `remove(ref)` / `remove(Relationship, target)` | Detach a component/all edges, or remove one relationship edge. `target` accepts any `ComponentRef` resolved eagerly via `world.entity(target)`.                       |
| `destroy()`                                    | Remove all components, unregister, and apply incoming relationship cleanup.                                                                                           |
| `target(rel)`                                  | One current target entity of relationship `rel`, or `undefined`; not a stable selection policy.                                                                       |
| `targets(rel)`                                 | Readonly snapshot of all targets; ordering is unspecified.                                                                                                            |
| `hasTarget(rel, target)`                       | `true` when the specific relationship edge exists.                                                                                                                    |
| `children(rel)`                                | `ReadonlySet<Entity>` of entities targeting this one through `rel`.                                                                                                   |
| `childOf(parent)`                              | Shorthand for `add(ChildOf, parent)`. Returns `this`.                                                                                                                 |
| `parent` / `parent = p`                        | Getter/setter for the built-in `ChildOf` target; assigning `undefined` removes `ChildOf`.                                                                             |
| `destroyed` / `alive`                          | `true` when the entity has been / has not been destroyed (marked for deletion).                                                                                       |
| `on(event, handler, insert?)`                  | Register a handler for a hook event on this component's meta. `insert` defaults to `false` (append); `true` prepends. Returns `this`.                                 |
| `off(event, handler)`                          | Remove a previously-registered handler by reference. Idempotent. Returns `this`.                                                                                      |
| `toString()`                                   | Returns `"EntityN"`.                                                                                                                                                  |
