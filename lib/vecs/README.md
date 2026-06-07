# vecs

A TypeScript Entity Component System (ECS) for real-time games and simulations.

`vecs` lets you model game state as **entities** (numeric ids) with **components** (typed data bags) attached to them. **Systems** declare which component combinations they care about and receive automatic callbacks when entities enter or leave their query, when component data changes, and on every tick. A **World** ties it all together and drives the update loop.

## Install

```
yarn add @vworlds/vecs
```

## Concepts

| Concept                  | What it is                                                                      |
| ------------------------ | ------------------------------------------------------------------------------- |
| **World**                | Central container. Owns every entity, query, system, and flat system pipeline.  |
| **Component**            | A registered plain data class with a no-argument constructor.                   |
| **Entity**               | A numeric id with a set of components. Created via the world.                   |
| **Query**                | A reactive, always-up-to-date set of entities matching a predicate.             |
| **System**               | A `Query` with per-tick logic (`update`, `each`, `run`).                        |
| **Filter**               | A non-reactive, one-shot scan: walks all world entities on each `forEach` call. |
| **Hook**                 | Lightweight `onAdd` / `onRemove` / `onSet` callbacks per component class.       |
| **Phase**                | Marker component for entities used as pipeline ordering anchors.                |
| **Exclusive components** | A group of components where at most one may exist on any entity at a time.      |

### Lifecycle in brief

```
world.component() × N  →  system() / query() × N  →  start()  →  progress() every frame
```

Components must be registered before they are used as component classes. After `start()`, component registration is disabled. Systems and queries can still be created — standalone queries backfill existing matched entities immediately.

---

## Example

```ts
import { DependsOn, ON_UPDATE, Phase, World } from "@vworlds/vecs";

// ─── Components ────────────────────────────────────────────────────────────

class Position {
  x = 0;
  y = 0;
}

class Velocity {
  vx = 0;
  vy = 0;
}

class Health {
  hp = 100;
}

// ─── World setup ───────────────────────────────────────────────────────────

const world = new World();

world.component(Position);
world.component(Velocity);
world.component(Health);

// ─── Pipeline anchors ──────────────────────────────────────────────────────

const update = world.entity(ON_UPDATE);
const cleanup = world.entity("cleanup").add(Phase).set(DependsOn, { target: update });

// ─── Systems ───────────────────────────────────────────────────────────────

// MoveSystem: integrates Velocity into Position every tick.
world
  .system("Move")
  .with(Position, Velocity)
  .each([Position, Velocity], (e, [pos, vel]) => {
    pos.x += vel.vx;
    pos.y += vel.vy;
    e.modified(Position); // signal that Position changed so other systems react
  });

// HealthSystem: despawns entities whose HP drops to zero.
world
  .system("Health")
  .phase(cleanup)
  .with(Health)
  .update(Health, (entity, health) => {
    if (health.hp <= 0) {
      entity.destroy();
    }
  });

// ─── Hooks ─────────────────────────────────────────────────────────────────

world
  .component(Health)
  .onAdd((entity, h) => console.log(`entity ${entity.eid} spawned with hp=${h.hp}`))
  .onRemove((entity) => console.log(`entity ${entity.eid} died`));

// ─── Start ─────────────────────────────────────────────────────────────────

world.start(); // freeze registration and prepare the pipeline

// ─── Spawn entities ────────────────────────────────────────────────────────

world.entity().set(Position, { x: 0, y: 0 }).set(Velocity, { vx: 5, vy: 0 }).set(Health, { hp: 3 });

// ─── Game loop ─────────────────────────────────────────────────────────────

let now = 0;
for (let tick = 0; tick < 5; tick++) {
  now += 16;
  world.progress(now, 16);
}
```

---

## Deferred mode

Inside a system body, a `Query.forEach`, or any `world.defer(...)` block, the world is in **deferred mode**: entity mutations (`add` / `attach` / `set` / `remove` / `destroy` / `modified`) are queued instead of applied inline. The queue drains on the boundary that opened the deferred scope.

Concretely, while deferred:

- `entity.get(C)` / `entity.getMut(C)` returns `undefined` after `entity.add(C)` (no instance has been created yet).
- `entity.get(C)` / `entity.getMut(C)` returns `undefined` after `entity.attach(instance)` if C was absent.
- `entity.get(C)` / `entity.getMut(C)` returns the **previous** value after `entity.set(C, props)`.
- `entity.get(C)` / `entity.getMut(C)` still returns the component after `entity.remove(C)`.

Outside any deferred scope (top-level user code) the same calls execute inline and effects are visible immediately. `world.flush()` drains any pending top-level commands; `world.defer(fn)` is sugar for `beginDefer / fn / endDefer`.

---

## API Reference

### `World`

Create one per game session.

```ts
const world = new World();
```

#### Component registration

Components are ordinary classes. They do not inherit from a vecs base class, and vecs constructs them with `new ComponentClass()`, so constructors should take no parameters. Register every component class before using it in `add`, `set`, `get`, `with`, `filter`, hook registration, or `setExclusiveComponents`.

```ts
class Position {
  x = 0;
  y = 0;
}

// Auto-assigned component id (drawn from the "component" id pool, 1–899 by default):
const positionComponent = world.component(Position);

// Explicit numeric id (e.g. a server-assigned stable id):
world.component(Position, 42);

// Access component metadata (numeric id, cleanup policy, etc.):
const componentMeta = world.component(Position).meta; // ComponentMeta

// Give the component a name so it can be looked up by string later:
world.component(Position).name = "Position";
world.component("Position"); // resolves the same Component entity
```

`world.component(Class)` returns the `Component` entity for that class, creating and registering it on the first call. Subsequent calls with the same class return the same entity. The same class can be registered independently in multiple worlds.

Id ranges are configured by passing `idPools` to the `World` constructor. The built-in defaults are:

| Pool        | Range     |
| ----------- | --------- |
| `component` | 1 – 899   |
| `module`    | 900 – 999 |
| `entity`    | 1000 – ∞  |

After `world.start()` (or `world.disableComponentRegistration()`) any further call to `world.component(Class)` that would register a new class throws. There is no automatic component registration; using an unregistered component class as a component is an error.

#### Exclusive component groups

```ts
world.setExclusiveComponents(Walking, Running, Idle);

const e = world.entity();
e.add(Walking);
e.add(Running); // Walking is automatically removed first
```

Each call defines one independent group. A component may belong to at most one group; calling `setExclusiveComponents` again with the same class overwrites its group. Safe to call before or after `world.start()`.

#### Entity management

```ts
// New entity with an auto-incrementing id:
const e = world.entity();

// Look up by id (throws if not found):
const found = world.entity(42);

// Optional lookup by id or component ref:
const maybeFound = world.getEntity(42);

// Server-assigned id; creates the entity if it doesn't exist yet:
const net = world.getOrCreateEntity(serverId, (newEntity) => {
  tracked.add(newEntity);
});

// Destroy everything (e.g. on level reset):
world.clearAllEntities();

// Named entity lookup via Identity.name — creates entity with that name if absent:
world.entity("player").name === "player"; // true
world.getEntity("player") === entity; // true (returns undefined when absent)

// Named component lookup — set the name first, then resolve by name:
world.component(Position).name = "Position";
world.component("Position"); // resolves the same component entity
```

#### Component entity deletion cleanup

Every component key is backed by a component entity. Destroying that component entity is controlled by `world.component(C).meta.onDelete`:

| Policy                 | Meaning                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| `CleanupPolicy.Throw`  | Default. Destroying the component entity while other entities carry it throws and changes nothing. |
| `CleanupPolicy.Remove` | Remove the component from every carrier, then destroy the component entity.                        |
| `CleanupPolicy.Delete` | Destroy every carrier, then destroy the component entity.                                          |

```ts
import { CleanupPolicy } from "@vworlds/vecs";

world.component(Temporary).meta.onDelete = CleanupPolicy.Remove;
world.component(Temporary).destroy(); // strips Temporary from all carriers
```

The `Throw` default also applies to plain entities used as component keys (`entity.add(key)`). It preserves consistency: a failed destroy leaves the component entity, its carriers, and the usage count untouched.

#### Hooks

```ts
world
  .component(Sprite)
  .onAdd((entity, sprite) => sprite.initialize(scene, entity))
  .onRemove((entity, sprite) => sprite.destroy(scene, entity))
  .onSet((entity, sprite) => sprite.syncToScene(entity));
```

`onAdd` fires when the component is first attached. `onRemove` fires when it is removed (or the entity is destroyed). `onSet` fires whenever `entity.modified(C)` is called, when `entity.set(C, props)` applies data, and when `entity.attach(instance)` stores an existing instance. Hook callbacks receive the owning entity because component instances do not carry entity references.

#### Pipeline

```ts
const update = world.entity("vecs::OnUpdate");
const send = world.entity("send").add(Phase).set(DependsOn, { target: update });

world.system("Send").phase(send).run(sendPackets);

// Drive every system returned by the pipeline query:
world.progress(now, delta);
```

Systems default to `vecs::OnUpdate`; call `.phase(...)` only when a system needs another pipeline anchor. The default pipeline query matches systems whose backing entity `DependsOn` a `Phase`, ordered by the `DependsOn` cascade. Built-in phase entity names are namespaced: `vecs::OnLoad`, `vecs::PostLoad`, `vecs::PreUpdate`, `vecs::OnUpdate`, `vecs::OnValidate`, `vecs::PostUpdate`, `vecs::PreStore`, and `vecs::OnStore`.

Use `world.setPipeline(spec)` to replace the default. `World` appends `System` to the query, so the query result is always flattened to systems.

#### Systems

```ts
world
  .system("MySystem")
  .with(A, B)
  .enter(...)
  .update(...)
  .each(...)
  .exit(...);
```

#### Timers and rate filters

Systems can opt into a slower cadence instead of running on every phase tick. `interval()` takes seconds; throttled `run()` callbacks receive the accumulated milliseconds since the previous fire as `delta`.

```ts
import { IntervalTickSource, RateTickSource } from "@vworlds/vecs";

world
  .system("Move")
  .interval(1.0)
  .each([Position], (e, [pos]) => {
    // 1 Hz
  });

world
  .system("Move")
  .rate(2)
  .each([Position], (e, [pos]) => {
    // every 2nd frame
  });

const second = new IntervalTickSource(1.0);

world
  .system("Move")
  .tickSource(second)
  .each([Position], (e, [pos]) => {
    // driven by a shared timer
  });

second.stop();
second.start();

const minute = new RateTickSource(60, second);
const hour = world
  .system("Hour")
  .tickSource(minute)
  .rate(60)
  .run((now, delta) => {
    console.log("hour tick", now, delta);
  });

// Systems can also be tick sources for each other.
const eachSecond = world
  .system("EachSecond")
  .interval(1)
  .run(() => {
    // ...
  });

const eachMinute = world
  .system("EachMinute")
  .tickSource(eachSecond)
  .rate(60)
  .run(() => {
    // ...
  });
```

Tick source objects and systems can both be used as sources. Disabling a source system suppresses its callbacks, but its clock still drives downstream consumers.

#### Queries

```ts
const enemies = world
  .query("Enemies")
  .with(Enemy, Health)
  .enter((e) => console.log("enemy spawned", e.eid));

world.start();
// enemies.count and query iteration are kept up-to-date automatically.

// Standalone queries can also be created after start(); existing matched
// entities are backfilled immediately.
```

#### Filters

```ts
// Entity only:
world.filter([Position]).forEach((e) => console.log(e.eid));

// With component injection:
world.filter([Position, Velocity]).forEach([Position, Velocity], (e, [pos, vel]) => {
  pos.x += vel.vx;
});

// Full DSL, with auto-deduced required components:
world.filter({ all: [Position, Velocity] }).forEach([Position, Velocity], (e, [pos, vel]) => {
  pos.x += vel.vx;
});

// Manual hint for queries the type extractor can't see through:
world
  .filter({ with: { any: [Position, Velocity] }, hint: [Position] })
  .forEach([Position], (e, [pos]) => pos.x);
```

A `Filter` requires no name, no `world.start()`, and no `destroy()` — create it anywhere and discard freely.

#### Pipeline control

```ts
world.start();                         // freeze registration, distribute systems
world.disableComponentRegistration();  // freeze registration without sorting

world.flush();                         // drain queued top-level mutations
world.defer(() => { ... });            // run a block in deferred mode
world.beginDefer();                    // pair with endDefer() for finer scoping
world.endDefer();
```

---

### `ComponentInstance`

Components are plain classes. vecs does not provide a runtime base class and does not attach `entity`, `meta`, `type`, `bitPtr`, or `modified()` to component instances.

```ts
class Position {
  x = 0;
  y = 0;
}

world.component(Position);

entity.add(Position);
const pos = entity.getMut(Position)!;
pos.x = 100;
// getMut marks Position changed before returning the mutable instance.

// Equivalent — set assigns props and fires onSet automatically:
entity.set(Position, { x: 100 });

// Store an existing instance directly:
const shared = new Position();
entity.attach(shared);
entity.get(Position) === shared; // true
```

| Rule                      | Description                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Plain class               | Components should be ordinary classes with field initializers and methods as needed.                           |
| No-arg construction       | vecs calls `new ComponentClass()`, so constructors should be omitted or take no parameters.                    |
| Explicit registration     | Call `world.component(C)` before using the class as a component.                                               |
| Shared instances possible | `entity.attach(instance)` stores the exact passed object; code should use the entity passed by vecs callbacks. |
| Manual dirty marking      | After mutating fields directly, call `entity.modified(C)` to notify hooks, queries, and systems.               |

Use `world.component(C).meta` when you need metadata such as the numeric type id or component name. Metadata is world-specific.

---

### `Entity`

Created via `world.entity()` (auto-assigned id) or `world.getOrCreateEntity(id, ...)` (caller-supplied id).

| Property / Method   | Description                                                                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `eid`               | Unique numeric entity id.                                                                                                                     |
| `world`             | The `World` that owns this entity.                                                                                                            |
| `componentBitmask`  | `Bitset` of component type ids attached to this entity. Used by archetype matching.                                                           |
| `properties`        | `Map<string, any>` free-form bag for module-level bookkeeping.                                                                                |
| `add(Class)`        | Attach a component (idempotent). Returns the entity for chaining.                                                                             |
| `attach(instance)`  | Attach an existing registered component instance directly; replaces any previous instance for that component class and fires `onSet`.         |
| `set(Class, props)` | Attach a component and assign `props`; fires `onSet`. Returns the entity for chaining.                                                        |
| `modified(Class)`   | Queue an `onSet` / `update` notification for a component class or numeric type id. Returns the entity for chaining.                           |
| `get(Class)`        | Return the component as a readonly-typed value, or `undefined`.                                                                               |
| `getMut(Class)`     | Mark the component modified and return the mutable instance, or `undefined`.                                                                  |
| `remove(Class)`     | Detach a component (fires `onRemove` and `exit`).                                                                                             |
| `destroy()`         | Remove all components, unregister from the world, then applies incoming relationship cleanup policies.                                        |
| `components`        | `ReadonlyArrayMap<ComponentInstance>` — read-only view of attached components keyed by type id. Supports `forEach`, `get`, `has`, and `size`. |
| `empty`             | `true` when no components are attached.                                                                                                       |
| `parent(ref)`       | Target entity for relationship component `ref`, or `undefined`.                                                                               |
| `children(ref)`     | `ReadonlySet<Entity>` of entities targeting this one through relationship component `ref`.                                                    |
| `events`            | Typed event emitter. Currently emits `"destroy"` just before teardown.                                                                        |
| `toString()`        | Returns `"EntityN"`.                                                                                                                          |

Use `entity.getMut(C)` when you need to mutate a component directly. It calls `entity.modified(C)` before returning the mutable instance. Repeated modified notifications for the same component type are coalesced while the world is deferred:

```ts
const vel = entity.getMut(Velocity)!;
vel.vx += accel;
```

Use `entity.attach(instance)` when component ownership is intentionally shared with caller code or another object graph. The instance constructor must be registered in the entity's world; unregistered instances throw. If the component belongs to an exclusive component group, conflicting components are removed before the instance is stored.

#### Relationships and parent / child hierarchy

```ts
import { ChildOf, CleanupPolicy, Relationship } from "@vworlds/vecs";

child.set(ChildOf, { target: parent });
child.parent(ChildOf) === parent; // true
parent.children(ChildOf).has(child); // true

// ChildOf is configured with CleanupPolicy.Delete, so destroying a parent
// recursively destroys children that target it through ChildOf:
parent.destroy();
```

Any component that extends `Relationship` can point at another entity through its `target` field. The source entity stores the relationship component; the target entity can enumerate sources with `children(ref)`.

```ts
class EquippedBy extends Relationship {}

item.set(EquippedBy, { target: player });
item.parent(EquippedBy); // player
player.children(EquippedBy).has(item); // true
```

Relationship target cleanup is controlled by `meta.onDeleteTarget`:

| Policy                 | Meaning                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| `CleanupPolicy.Remove` | Default. When a target is destroyed, remove the relationship component from each source.     |
| `CleanupPolicy.Delete` | When a target is destroyed, destroy each source entity that targets it through the relation. |

`ChildOf` is registered by every `World` and uses `CleanupPolicy.Delete`. Custom relationships default to `Remove`; set `world.component(MyRelationship).meta.onDeleteTarget = CleanupPolicy.Delete` if target deletion should cascade.

`onDeleteTarget` is independent from `onDelete`: `onDeleteTarget` runs when a relationship target is destroyed, while `onDelete` runs when the relationship component entity itself is destroyed.

Retarget relationships with `entity.set(RelationshipClass, { target })`. `entity.getMut(RelationshipClass)` throws for relationship components because in-place target mutation would bypass the reverse index used by `children(ref)` and cleanup cascades.

Relationship queries use `target` to follow a relationship from the candidate entity to its target and test that target with another DSL expression. Use `parent` for the built-in `ChildOf` hierarchy:

```ts
world.query("body-friends").with({ all: [Body, { target: [FriendOf, [Position, Velocity]] }] });
world.query("positioned-children").with({ all: [Position, { parent: Body }] });
```

Tracked queries stay live when either side changes. Adding or removing `FriendOf` on the candidate re-routes the candidate normally; adding or removing `Position` / `Velocity` on the target also refreshes every candidate that points at that target. Nested `target` works the same way across multiple hops.

Use `source` with `world.filter(...)` when you need the opposite direction: test whether at least one child points at the candidate through a relationship and matches an inner DSL expression. Use `children` for the built-in `ChildOf` hierarchy. `source` and `children` are exact for each filter scan, but they are non-reactive and rejected by tracked `Query` / `System` membership.

```ts
world.filter({ all: [Body, { children: Position }] }).forEach((parent) => {
  // parent has at least one ChildOf child with Position right now.
});
```

Component injection supports lowercase `down` in `forEach` and system `each` injection lists. It fans out: the callback fires once for each child pointing at the visited entity through the relationship, and child component slots are nullable.

```ts
world
  .query("parents")
  .with(Body)
  .forEach([Body, { down: [ChildOf, [Position]] }], (parent, [body, childPos]) => {
    // One call per ChildOf child of parent. childPos is undefined when that child lacks Position.
  });
```

Two details matter:

- A `down` injection does not call the callback for a matched entity with zero children through that relationship.
- `down` injection iterates all children through the relationship, independent of any `children` / `source` filter used for membership. For example, `world.filter({ children: Position }).forEach([{ down: [ChildOf, [Position]] }], ...)` also visits children without `Position`, with `childPos === undefined`.

---

### `System`

Systems are created via `world.system(name)` and configured through a fluent builder. Every method returns `this` for chaining. `System` extends `Query`, so the membership / enter / exit / update / sort APIs are shared.

#### `.with(...specs)`

Declare which entities the system tracks.

```ts
.with(Position, Velocity)                                         // explicit component list
.with([Position, Velocity])                                       // array shorthand
.with({ all: [Position, { any: [Sprite, Container] }] })          // compound
.with({ not: Invisible })
.without(Invisible)                                               // shorthand for .with({ not: Invisible })
.with({ target: [FriendOf, Position] })                           // relationship target has Position
.with({ parent: Body })                                           // ChildOf target has Body
```

**Query operators:**

| Operator             | Meaning                                                |
| -------------------- | ------------------------------------------------------ |
| A single class / id  | Entity has that component                              |
| An array `[A, B]`    | Entity has all of A and B                              |
| `{ only: [A, B] }`   | Entity has exactly A and B, nothing else               |
| `{ all: [q1, q2] }`  | Both sub-queries must match                            |
| `{ any: [q1, q2] }`  | Either sub-query matches                               |
| `{ not: q }`         | Sub-query must not match                               |
| `{ target: [R, q] }` | Relationship `R` target matches `q`                    |
| `{ source: [R, q] }` | Filter-only: some `R` source/child matches `q`         |
| `{ parent: q }`      | Built-in `ChildOf` target matches `q`                  |
| `{ children: q }`    | Filter-only: some built-in `ChildOf` child matches `q` |
| `{ test: fn }`       | Custom membership logic                                |

`target` and `source` use tuple form only: `{ target: [RelationshipClass, innerDSL] }` / `{ source: [RelationshipClass, innerDSL] }`. The first element must be a component that extends `Relationship`; passing a normal component throws. `target` evaluates the inner DSL against the relationship target; `source` evaluates it against each child/source and matches when at least one child/source matches. Because `source` and `children` are non-reactive, use them with `world.filter(...)`, not tracked queries or systems.

Component injection also supports lowercase relationship markers. `target` works in `forEach`, `each`, `enter`, and `exit` injection lists. It follows the relationship target and flattens the requested target components into the callback tuple:

```ts
world
  .query("friends")
  .with({ target: [FriendOf, Position] })
  .forEach([Body, { target: [FriendOf, [Position, Velocity]] }], (e, [body, pos, vel]) => {
    // body is from e; pos and vel are from e.parent(FriendOf)
    // target-side injected components are undefined if the target is absent or lacks them.
  });
```

On `exit`, direct component injection is snapshot-stable when the exiting component was just removed. `target` injection resolves the target live at callback time, so target-side slots can be `undefined` if the exit was caused by the target losing that component.

Lowercase `down` is allowed only in `forEach` and system `each`, where fan-out has a clear meaning. Only one `down` marker is allowed per injection tuple.

#### Iter cursor

Pass `Iter` as the first argument to `each`, `forEach`, `enter`, `exit`, `update`, or `orderBy` to receive a reusable cursor object instead of the bare entity. The cursor exposes:

- `it.entity` — the visited entity.
- `it.src` — a same-length array of source entities: the visited entity for a directly-injected component, the relationship target for a `target`-injected one, or the specific child for a `down`-injected one.

```ts
system.each(Iter, [Body, { target: [ChildOf, [Position]] }], (it, [body, pos]) => {
  it.entity; // the visited entity
  it.src[0]; // entity `body` was read from (the visited entity)
  it.src[1]; // entity `pos` was read from (the ChildOf target)
});
```

When `Iter` is **not** requested, the original code path runs with zero per-entity overhead. Dispatch to the cursor or non-cursor path happens once at setup time — not per entity. A single `Iter` instance is mutated before each callback; read what you need inside the callback but do not retain the cursor or its `src` array across callbacks.

`enter` and `exit` allocate a fresh `Iter` per event (they fire reentrantly during command routing). `each` / `forEach` / `update` reuse a single `Iter` instance for the whole pass; `orderBy` reuses two (one per side of the comparison). Because a plain `Query.update` callback fires synchronously during command routing, a nested mutation triggered from inside it can re-enter `update` and overwrite that reused cursor and tuple mid-callback — snapshot any `it`, `it.src`, or tuple values you need before triggering further mutations.

Class-valued query terms are components. Register component classes before using them in a `QueryDSL`; an unregistered class throws. Use `{ test: fn }` for arbitrary predicate functions.

**Type inference.** `with()` records inferrable component classes as a type parameter `R` on the system. Callbacks in `.orderBy()`, `.each()`, and `.update()` injection treat those components as non-nullable — no `!` needed. For complex `with()` expressions the type system can't introspect, supply a `hint` field:

```ts
.with({ with: { all: [Position, Velocity] }, hint: [Position, Velocity] })
.each([Position, Velocity], (e, [pos, vel]) => {
  pos.x += vel.vx; // pos and vel are non-null
});
```

#### `.enter(callback)` / `.enter(inject, callback)`

Fires once when an entity first matches the system.

```ts
.enter((e) => { ... })
.enter([Position, Sprite], (e, [pos, sprite]) => {
  sprite.setPosition(pos.x, pos.y);
})
```

#### `.exit(callback)` / `.exit(inject, callback)`

Fires when an entity leaves the system (component removed or entity destroyed). Direct components removed in the same frame are still resolvable in `inject`; `target` injection resolves relationship targets live.

```ts
.exit([Sprite], (e, [sprite]) => sprite.destroy());
```

#### `.update(ComponentClass, callback)` / `.update(ComponentClass, inject, callback)`

Fires when `entity.modified(ComponentClass)` is called for the watched component on a tracked entity. It also fires for `entity.set(C, props)` on an already-attached component and for initial watched components when an entity enters the query. The callback receives the entity first because component instances do not carry owner references.

```ts
.update(Position, (entity, pos) => renderer.setPosition(entity.eid, pos.x, pos.y));

.update(Position, [Sprite], (entity, pos, [sprite]) => {
  sprite.sprite.setPosition(pos.x, pos.y);
});
```

If `with()` has not been called, `update` automatically expands the implicit component predicate to require the watched component.

#### `.each(components, callback)`

Fires every tick for **every tracked entity**, regardless of whether anything changed. Use it for per-entity logic that must run every frame. Implies `.track()`. Only one `each` per system.

```ts
.with(Position, Velocity)
.each([Position, Velocity], (e, [pos, vel]) => {
  pos.x += vel.vx;
});
```

#### `.orderBy(components, compare)`

Store matched entities in a custom order determined by `compare`. Implies `.track()`. Iterating the system, `forEach`, and `each` walks entities in sorted order.

```ts
world
  .system("Render")
  .with(Position, Sprite)
  .orderBy([Position], (_entityA, [posA], _entityB, [posB]) => posA.z - posB.z)
  .each([Position, Sprite], (e, [pos, sprite]) => sprite.draw(pos.x, pos.y));
```

#### `.track()`

Enable entity tracking without an `each` callback — exposes matched entities via `system.count`, `system.has(e)`, and direct iteration. `each` and `orderBy` imply `track` automatically. When called after `world.start()`, immediately backfills existing matched entities.

#### `.run(callback)`

Fires every tick when the system runs in the pipeline, regardless of entity state. Use for polling, network I/O, timers, etc.

```ts
.run((now, delta) => {
  sendNetworkPacket(now);
});
```

#### `.disable()` / `.enable()`

Pause and resume a system at runtime. While disabled the system is effectively invisible: the inbox is cleared immediately, any new `enter`, `exit`, or `update` events are silently dropped, `run` and `each` callbacks do not fire, and the system skips its `_run` entirely. Entity membership in the underlying query is still maintained, so the tracked set remains correct and the system resumes cleanly when re-enabled. Events that occurred while the system was disabled are **not** replayed.

```ts
const ai = world.system("AI").with(Enemy).run(tickAI);

// Pause AI processing during a cutscene:
ai.disable();

// Resume normal processing:
ai.enable();
```

Both methods return `this` for chaining and are idempotent (calling `disable()` on an already-disabled system, or `enable()` on an already-enabled system, is a no-op).

#### `.destroy()`

Permanently remove this system from the world. Calls `disable()` first (clearing the inbox), then unregisters its backing entity. No `exit` callbacks fire. Use a standalone `Query` if you need a temporary reactive set that can be destroyed mid-session.

---

### `Query`

`world.query(name)` returns a standalone reactive entity set, configured through the same builder API as `System`. It has no per-tick callbacks.

```ts
const projectiles = world
  .query("Projectiles")
  .with(Position, Velocity)
  .orderBy([Position], (_entityA, [a], _entityB, [b]) => a.z - b.z)
  .enter([Position], (e, [pos]) => {
    pos.x = spawnX;
  });

world.start();

projectiles.forEach((e) => { ... });
for (const e of projectiles) { ... }
console.log(projectiles.count, "active projectiles");
```

| Method                                                  | Description                                                                                         |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `.with(...specs)`                                       | Add membership predicates using `QuerySpec` expressions.                                            |
| `.without(dsl)`                                         | Add a negated membership predicate; shorthand for `.with({ not: dsl })`.                            |
| `.enter(callback)` / `.enter(inject, callback)`         | Fires when an entity joins the query.                                                               |
| `.exit(callback)` / `.exit(inject, callback)`           | Fires when an entity leaves the query.                                                              |
| `.update(C, callback)` / `.update(C, inject, callback)` | Fires when `C` is modified on a tracked entity. Callback receives `(entity, component, injected?)`. |
| `.orderBy(components, compare)`                         | Store matched entities in sorted order. Comparator receives `(entityA, tupleA, entityB, tupleB)`.   |
| `.track()`                                              | Enable tracking. Backfills when called after `start()`.                                             |
| `.belongs(e)`                                           | Returns `true` if the entity satisfies the predicate.                                               |
| `.count`                                                | Number of currently tracked entities.                                                               |
| `.has(e)`                                               | Returns `true` if the entity is currently tracked.                                                  |
| `[Symbol.iterator]()`                                   | Iterate currently tracked entities with `for (const e of query)`.                                   |
| `.forEach(callback)`                                    | Iterate currently tracked entities.                                                                 |
| `.forEach(components, callback)`                        | Iterate with component injection.                                                                   |
| `.destroy()`                                            | Remove the query from the world and from every entity (no exit fires).                              |

#### `.destroy()` semantics

`destroy()` permanently removes a standalone query from the world. Entity references are silently purged (no `exit` callbacks fire), the tracked set is cleared, and the `world` reference is set to `undefined`. Any further use of the object is **undefined behavior**.

```ts
const q = world.query("Temporary").with(Position);
// ... use q.count, q.has(e), or iterate q ...
q.destroy();
```

`System` shares the same DSL, callback, sorting, and tracking machinery — `System` extends `Query` and adds `run`, `each`, and an inbox replayed on every tick.

---

### `Filter`

`world.filter(dsl)` returns a `Filter` that performs a non-reactive scan. It accepts the same `QueryDSL` expressions as systems and queries.

```ts
const f = world.filter([Position, Velocity]);
```

| Method                           | Description                                                                |
| -------------------------------- | -------------------------------------------------------------------------- |
| `.forEach(callback)`             | Walk all world entities; invoke callback on each match.                    |
| `.forEach(components, callback)` | Same, with component injection and non-null types for required components. |

`forEach` runs inside a deferred scope, so mutations made by the callback are batched and become visible after iteration finishes.

**Type inference.** Component classes the type system can extract from the DSL (plain component classes, plain arrays, `only`, and `all` of those) are non-nullable in the callback tuple. For the rest, supply a `hint` field:

```ts
// Auto-deduced — both non-null:
world.filter([Position, Velocity]).forEach([Position, Velocity], (e, [pos, vel]) => { ... });

// Manual hint for any / not / test:
world.filter({ with: { any: [Position, Velocity] }, hint: [Position] }).forEach([Position], (e, [pos]) => pos.x);
```

A `Filter` holds no tracked set, makes no registration calls, and needs no `destroy()`.

---

### `Bitset`

A compact, growable set of non-negative integers backed by 32-bit words. Used internally for entity archetypes and watchlists, and exposed in the public API so component data can use it for bit-flag fields.

| Method             | Description                                                                           |
| ------------------ | ------------------------------------------------------------------------------------- |
| `add(n)`           | Set bit `n`.                                                                          |
| `addBit(bptr)`     | Set the bit at a pre-computed `BitPtr` (fast path).                                   |
| `delete(n)`        | Clear bit `n`. Storage is not compacted automatically; call `compact()` when needed.  |
| `deleteBit(bptr)`  | Clear the bit at a pre-computed `BitPtr` (fast path). Does not compact automatically. |
| `compact()`        | Trim trailing zero words from backing storage.                                        |
| `clear()`          | Remove every set bit.                                                                 |
| `has(n)`           | Returns `true` if bit `n` is set.                                                     |
| `hasBit(bptr)`     | Fast check via a pre-computed `BitPtr`.                                               |
| `equal(other)`     | Returns `true` when both bitsets have the same bits set.                              |
| `hasBitset(other)` | Returns `true` when every bit set in `other` is also set in this bitset.              |
| `forEach(cb)`      | Visit each set bit index in ascending order.                                          |
| `indices()`        | Return all set bit indices as a `number[]`.                                           |

```ts
class Tags {
  tags = new Bitset();
}

tags.tags.add(TAG_VISIBLE);
if (tags.tags.has(TAG_VISIBLE)) { ... }
```

---

## Build & Test

```
yarn build
yarn test
yarn lint
```

---

## License

UNLICENSED
