# vecs

A TypeScript Entity Component System (ECS) for real-time games and simulations.

`vecs` lets you model game state as **entities** (integer IDs) with **components** (typed data bags) attached to them. **Systems** declare which component combinations they care about and receive automatic callbacks when entities enter or leave their query, when component data changes, and on every tick. A **World** ties it all together and drives the update loop.

## Install

```
yarn add @vworlds/vecs
```

## Concepts

| Concept                  | What it is                                                                      |
| ------------------------ | ------------------------------------------------------------------------------- |
| **World**                | Central container. Owns all entities, runs all systems and queries.             |
| **Component**            | A plain data class. Extend `Component` and attach instances to entities.        |
| **Entity**               | An integer id with a set of components. Create via the world.                   |
| **Query**                | A reactive, always-updated set of entities that match a predicate.              |
| **System**               | A `Query` with per-tick runtime logic (phases, `update`, `each`, `run`).        |
| **Filter**               | A non-reactive, one-shot scan: walks all world entities on each `forEach` call. |
| **Exclusive components** | A group of components where at most one may be present on any entity at a time. |

### Lifecycle in brief

```
registerComponent() × N  →  system() / query() × N  →  start()  →  progress() every frame
```

After `start()`, component registration is disabled. Systems and queries can still be created — standalone queries backfill existing matched entities immediately.

---

## Example

The example below defines three components, two systems, a phase, and a hook, then runs a simple "move and despawn" loop.

```ts
import { World, Component, IPhase } from "@vworlds/vecs";

// ─── Components ────────────────────────────────────────────────────────────

class Position extends Component {
  x = 0;
  y = 0;
}

class Velocity extends Component {
  vx = 0;
  vy = 0;
}

class Health extends Component {
  hp = 100;
}

// ─── World setup ───────────────────────────────────────────────────────────

const world = new World();

world.registerComponent(Position);
world.registerComponent(Velocity);
world.registerComponent(Health);

// ─── Phases ────────────────────────────────────────────────────────────────

const update: IPhase = world.addPhase("update");
const cleanup: IPhase = world.addPhase("cleanup");

// ─── Systems ───────────────────────────────────────────────────────────────

// MoveSystem: runs every tick for entities that have both Position and Velocity.
world
  .system("Move")
  .phase(update)
  .requires(Position, Velocity)
  .enter([Position, Velocity], (e, [pos, vel]) => {
    console.log(`entity ${e.eid} entered Move with pos=(${pos.x},${pos.y})`);
  })
  .update(Velocity, [Position], (vel, [pos]) => {
    // Called whenever vel.modified() is queued.
    pos.x += vel.vx;
    pos.y += vel.vy;
    pos.modified(); // propagate position change to other systems
  })
  .exit((e) => {
    console.log(`entity ${e.eid} left Move`);
  });

// HealthSystem: despawns entities whose HP drops to zero.
world
  .system("Health")
  .phase(cleanup)
  .requires(Health)
  .update(Health, (health) => {
    if (health.hp <= 0) {
      health.entity.destroy();
    }
  });

// ─── Hooks ─────────────────────────────────────────────────────────────────

// Hooks are a lightweight alternative to systems for side effects on a single
// component type — no per-entity query, just callbacks on add/remove/set.
world
  .hook(Health)
  .onAdd((h) => console.log(`entity ${h.entity.eid} spawned with hp=${h.hp}`))
  .onRemove((h) => console.log(`entity ${h.entity.eid} died`));

// ─── Start ─────────────────────────────────────────────────────────────────

world.start(); // freeze registration, sort systems into phases

// ─── Create entities ───────────────────────────────────────────────────────

const bullet = world.createEntity();
bullet.set(Position, { x: 0, y: 0 });

const vel = bullet.set(Velocity, { vx: 5, vy: 0 }).get(Velocity)!;

const hp = bullet.set(Health, { hp: 3 }).get(Health)!;

// ─── Game loop ─────────────────────────────────────────────────────────────

let now = 0;
for (let tick = 0; tick < 5; tick++) {
  now += 16;
  world.progress(now, 16);
}
```

---

## API Reference

### World

The world owns everything. Create one per game session.

```ts
const world = new World();
```

#### Component registration

```ts
// Auto-assigned type id (starts at 256 for "local" components):
world.registerComponent(Position);

// Explicit numeric type id (required when the id comes from a server):
world.registerComponent(Position, 1);

// With a display name different from the class name:
world.registerComponent(Position, "pos");

// Pre-register a name → id mapping before the class is available:
world.registerComponentType("Position", 1);
```

After `world.start()` any further call to `registerComponent` throws.

#### Exclusive components

Declare a group of components that cannot coexist on the same entity. Adding a member of the group automatically removes any other member that was already present.

```ts
world.setExclusiveComponents(Walking, Running, Idle);

const e = world.createEntity();
e.add(Walking);
e.add(Running); // Walking is automatically removed first
// e.get(Walking) === undefined, e.get(Running) is defined
```

Each call to `setExclusiveComponents` defines one independent group. Components not in the group are unaffected. A component may belong to at most one exclusivity group (calling `setExclusiveComponents` a second time with the same class overwrites its group).

`setExclusiveComponents` may be called before or after `world.start()`.

#### Entity management

```ts
// Locally-owned entity with an auto-incrementing id:
const e = world.createEntity();

// Server-assigned id; creates the entity if it doesn't exist yet:
const e = world.getOrCreateEntity(serverId, (newEntity) => {
  tracked.add(newEntity);
});

// Look up by id (returns undefined if not found):
const e = world.entity(42);

// Destroy everything (e.g. on level reset):
world.clearAllEntities();

// Reserve a high id range for locally-created entities so they don't
// collide with server-assigned ids (call before world.start()):
world.setEntityIdRange(0x10000);
```

#### Systems

```ts
// Create, configure, and register a system in one chain:
world.system("MySystem")
  .phase("update")
  .requires(A, B)
  .enter(...)
  .update(...)
  .exit(...);

world.start(); // distributes systems to phases, freezes component registration
```

#### Queries

A standalone `Query` is a reactive entity set without a phase or per-tick callbacks. Use it when you need the matched set kept up-to-date automatically — for example to enumerate scene nodes or find the nearest enemy.

```ts
const enemies = world
  .query("Enemies")
  .requires(Enemy, Health)
  .enter((e) => console.log("enemy spawned", e.eid))
  .exit((e) => console.log("enemy died", e.eid));

world.start();
// enemies.entities is kept up-to-date automatically

// Can also be created after start(); existing matched entities are backfilled:
const lateQuery = world.query("Walls").requires(Wall);
// lateQuery.entities immediately contains all current Wall entities
```

#### Filters

A `Filter` is a non-reactive, one-shot scan. It holds no tracked entity set — each `forEach` call walks all world entities at that moment. Use it for ad-hoc lookups that don't need to stay live.

```ts
// Entity only:
world.filter([Position]).forEach((e) => console.log(e.eid));

// With component injection:
world.filter([Position, Velocity]).forEach([Position, Velocity], (e, [pos, vel]) => {
  pos.x += vel.vx;
});

// Full DSL, with auto-deduced required components:
world
  .filter({ AND: [{ HAS: Position }, { HAS: Velocity }] })
  .forEach([Position, Velocity], (e, [pos, vel]) => {
    pos.x += vel.vx; // pos and vel are non-null — deduced from AND of HAS
  });

// Manual type hint for queries the extractor can't see through:
world.filter({ OR: [Position, Velocity] }, [Position]).forEach([Position], (e, [pos]) => pos.x);
```

Unlike `Query`, a `Filter` requires no name, no `world.start()`, and no `destroy()` — create it anywhere and discard it freely.

#### Phases

```ts
// Declare phases in the order they should run each frame:
const preUpdate = world.addPhase("preupdate");
const update = world.addPhase("update");
const send = world.addPhase("send");

// Each frame, run all phases in registration order:
world.progress(Date.now(), deltaMs);

// Or drive individual phases manually:
world.runPhase(preUpdate, Date.now(), deltaMs);
world.runPhase(update, Date.now(), deltaMs);
world.runPhase(send, Date.now(), deltaMs);
```

Systems with no explicit phase go into a built-in `"update"` phase.

#### Hooks

A hook is a shorthand for reacting to a single component's lifecycle without writing a full system:

```ts
world
  .hook(Sprite)
  .onAdd((sprite) => sprite.initialize(scene))
  .onRemove((sprite) => sprite.destroy())
  .onSet((sprite) => sprite.syncToScene());
```

`onSet` fires whenever `component.modified()` is called.  
`onAdd` fires when the component is first attached to an entity.  
`onRemove` fires when it is removed or the entity is destroyed.

---

### Component

Extend `Component` to define your data:

```ts
class Position extends Component {
  x = 0;
  y = 0;
}

world.registerComponent(Position);

entity.add(Position);
const pos = entity.get(Position)!;
pos.x = 100;
pos.modified(); // tell the world this component changed

// Alternatively:
entity.set(Position, { x: 100 });
```

Every component instance exposes:

| Property / Method | Description                                                           |
| ----------------- | --------------------------------------------------------------------- |
| `entity`          | The `Entity` this component belongs to.                               |
| `meta`            | `ComponentMeta` — holds the type id, name, and bitset pointer.        |
| `type`            | Numeric type id (shorthand for `meta.type`).                          |
| `modified()`      | Queue an `onSet` / `update` notification. Call after mutating fields. |

---

### Entity

```ts
const e = world.createEntity();
```

| Property / Method      | Description                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| `eid`                  | Unique numeric entity id.                                                                                     |
| `world`                | The `World` that owns this entity.                                                                            |
| `add(Class)`           | Attach a component and return the entity for chaining. Idempotent.                                            |
| `set(Class, props)`    | Like `add`, but also assigns the given partial properties onto the instance. Returns the entity for chaining. |
| `modified(component)`  | Queue an `onSet` / `update` notification for the component. Returns the entity for chaining.                  |
| `get(Class)`           | Return the component instance, or `undefined` if not present.                                                 |
| `remove(Class)`        | Detach a component (triggers `onRemove` hooks and `exit` callbacks).                                          |
| `destroy()`            | Remove all components and unregister the entity. Recurses to children.                                        |
| `empty`                | `true` when no components are attached.                                                                       |
| `forEachComponent(cb)` | Iterate over all attached components.                                                                         |
| `parent`               | Parent entity in the scene hierarchy, or `undefined`.                                                         |
| `children`             | `Set<Entity>` of direct children (lazy, created on first access).                                             |
| `events`               | Typed event emitter. Currently emits `"destroy"` before teardown.                                             |
| `properties`           | `Map<string, any>` free-form bag for module-level bookkeeping.                                                |

`entity.modified(c)` is equivalent to `c.modified()` but returns the entity, making it usable in a method chain:

```ts
// Mutate fields then signal the change inline:
const vel = entity.get(Velocity)!;
vel.vx += accel;
entity.modified(vel); // same effect as vel.modified(), returns entity

// Or in a chain — add without initial notification, then notify later:
entity.add(Position, false).modified(entity.get(Position)!);
```

#### Parent–child hierarchy

```ts
child.parent = parent;
parent.children.add(child);

// Destroying a parent recursively destroys all children:
parent.destroy();
```

Archetype queries that use `{ PARENT: ... }` are automatically re-evaluated when a parent's component set changes.

---

### System

Systems are created via `world.system(name)` and configured through a fluent builder API. All methods return `this` for chaining.

#### `.requires(...components)` and `.query(q)`

Declare which entities the system should track:

```ts
// Entities that have both Position and Velocity:
.requires(Position, Velocity)

// Equivalent explicit query:
.query({ HAS: [Position, Velocity] })

// Entities that have a parent with Player AND Container:
.query({ PARENT: { AND: [Player, Container] } })

// Compound queries:
.query({ AND: [Position, { OR: [Sprite, Container] }] })
.query({ NOT: Invisible })
```

**Query operators:**

| Operator               | Meaning                                  |
| ---------------------- | ---------------------------------------- |
| `{ HAS: [A, B] }`      | Entity has all of A and B                |
| `{ HAS_ONLY: [A, B] }` | Entity has exactly A and B, nothing else |
| `{ AND: [q1, q2] }`    | Both sub-queries must match              |
| `{ OR: [q1, q2] }`     | Either sub-query matches                 |
| `{ NOT: q }`           | Sub-query must not match                 |
| `{ PARENT: q }`        | Entity's parent matches q                |
| An array `[A, B]`      | Shorthand for `HAS: [A, B]`              |

**Type inference:** `requires()` records the listed classes as a type parameter on the system. Callbacks in `.sort()`, `.each()`, and `.update()` inject then treat those components as non-nullable — no `!` needed. For complex `query()` expressions the type system cannot introspect, pass a second argument as an explicit hint:

```ts
.query({ AND: [{ HAS: Position }, { HAS: Velocity }] }, [Position, Velocity])
.each([Position, Velocity], (e, [pos, vel]) => {
  pos.x += vel.vx; // pos and vel are non-null
})
```

#### `.phase(p)`

Assign the system to a named phase or an `IPhase` reference. Systems without a phase run in `"update"`.

```ts
.phase("preupdate")   // by name
.phase(myPhase)       // by IPhase reference
```

#### `.enter(callback)` / `.enter(inject, callback)`

Called once when an entity first matches the system's query.

```ts
// No injection:
.enter((e) => { console.log("entity joined", e.eid); })

// With injection — component instances resolved from the entity:
.enter([Position, Sprite], (e, [pos, sprite]) => {
  sprite.setPosition(pos.x, pos.y);
})

// Resolve from parent:
.enter([{ parent: Container }], (e, [container]) => {
  container.add(e.get(Sprite)!.gameObject);
})
```

#### `.exit(callback)` / `.exit(inject, callback)`

Called when an entity leaves the system (component removed or entity destroyed). Components removed in the same frame are still accessible in exit callbacks.

```ts
.exit([Sprite], (e, [sprite]) => {
  sprite.destroy();
})
```

#### `.update(ComponentClass, callback)` / `.update(ComponentClass, inject, callback)`

Called when `component.modified()` is queued on a watched component of a tracked entity.

```ts
// Simple — receives the modified component:
.update(Position, (pos) => {
  renderer.setPosition(pos.x, pos.y);
})

// With injection — receives the modified component and extra components:
.update(Position, [Sprite], (pos, [sprite]) => {
  sprite.sprite.setPosition(pos.x, pos.y);
})
```

Injected components listed in `requires()` are non-nullable in the callback; any others are `Type | undefined`.

Calling `update` also adds that component type to the system's implicit `HAS` query (unless you called `query()` first).

#### `.each(components, callback)`

Called every tick for **every tracked entity**, unconditionally. Unlike `update` (which only fires when `component.modified()` is called), `each` fires regardless of whether the component was modified — use it for per-entity logic that must run on every frame.

The callback receives the entity and a tuple of resolved component instances. Components declared via `requires()` are guaranteed non-null; any others are `undefined` if the entity lacks them.

```ts
.requires(Position, Velocity)
.each([Position, Velocity], (e, [pos, vel]) => {
  pos.x += vel.vx; // non-null — both are in requires()
  pos.y += vel.vy;
})
```

`each` does not modify the system's query — define membership with `requires(...)` or `query(...)` as usual. Only one `each` may be registered per system; a second call throws.

#### `.sort(components, compare)`

Enable sorted entity tracking. Matched entities are stored in an ordered set whose insertion position is determined by `compare`, which receives a tuple of resolved component instances for each pair being ordered. Implies `.track()`.

Components declared via `requires()` are non-null in the compare callback.

```ts
world
  .system("Render")
  .requires(Position, Sprite)
  .sort([Position], ([posA], [posB]) => posA.z - posB.z)
  .each([Position, Sprite], (e, [pos, sprite]) => {
    sprite.draw(pos.x, pos.y);
  });
```

Iterating `system.entities` after a phase run yields entities in the sorted order.

#### `.track()`

Enable entity tracking without an `each` callback — matched entities are exposed via `system.entities` (or `query.entities`) as they enter and leave. `each` and `sort` imply `track` automatically; call this directly only when you need the tracked set without a per-tick callback.

When called after `world.start()`, `track()` immediately backfills existing entities that satisfy the query predicate.

#### `.run(callback)`

Called every tick when the system's phase runs, regardless of entity state. Use this for polling, network I/O, timers, etc.

```ts
.run((now, delta) => {
  sendNetworkPacket(now);
})
```

---

### Query

A standalone query is created via `world.query(name)` and configured through the same fluent builder API as `System` (`requires`, `query`, `enter`, `exit`, `sort`, `track`, `forEach`, `entities`). It has no phase and no per-tick callbacks.

```ts
const projectiles = world
  .query("Projectiles")
  .requires(Position, Velocity)
  .sort([Position], ([a], [b]) => a.z - b.z)
  .enter([Position], (e, [pos]) => {
    pos.x = spawnX;
  });

world.start();

// Anywhere in game code:
projectiles.forEach((e) => {
  /* ... */
});
console.log(projectiles.entities.size, "active projectiles");
```

| Method                                          | Description                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------- |
| `.requires(...components)`                      | Set the membership predicate and start tracking.                          |
| `.query(expr)`                                  | Set the membership predicate using the {@link SystemQuery} DSL.           |
| `.enter(callback)` / `.enter(inject, callback)` | Fires when an entity joins the query.                                     |
| `.exit(callback)` / `.exit(inject, callback)`   | Fires when an entity leaves the query.                                    |
| `.sort(components, compare)`                    | Store matched entities in sorted order.                                   |
| `.track()`                                      | Enable tracking (implied by `sort`; backfills when called after `start`). |
| `.belongs(e)`                                   | Returns `true` if the entity satisfies the predicate.                     |
| `.forEach(callback)`                            | Iterate all currently tracked entities (entity only).                     |
| `.forEach(components, callback)`                | Iterate with component injection — same signature as `Filter.forEach`.    |
| `.entities`                                     | `ReadonlySet<Entity>` of all currently tracked entities.                  |
| `.destroy()`                                    | Remove the query from the world and all entities. See below.              |

#### `.destroy()`

Permanently removes a standalone query from the world. All entity references are silently purged (no exit callbacks fire), the tracked entity set is cleared, and the query's `world` reference is set to `undefined`. After this call, any use of the query object is **undefined behavior**.

```ts
const q = world.query("Temporary").requires(Position);
// ... use q.entities ...
q.destroy(); // unregisters from world and all entities
```

`System` does **not** support `destroy()` — calling it throws. Systems are owned by the world for the lifetime of the session. Use a standalone `Query` when you need a temporary reactive set.

Both `System` and `Query` share the same query DSL, enter/exit callbacks, sort, and `entities` set — `System` extends `Query` and layers phase execution on top.

---

### Filter

A `Filter` is created via `world.filter(dsl)` and provides a non-reactive `forEach`. It accepts the same [`QueryDSL`](#-requirescomponents-and-queryq) expressions as systems and queries.

```ts
const f = world.filter([Position, Velocity]);
```

| Method                           | Description                                                                |
| -------------------------------- | -------------------------------------------------------------------------- |
| `.forEach(callback)`             | Walk all world entities; invoke callback for each matching one.            |
| `.forEach(components, callback)` | Same, with component injection and non-null types for required components. |

**Type inference** works the same way as for `requires()` on systems/queries: component classes extractable from the DSL (`HAS`, `HAS_ONLY`, plain arrays, and `AND` of those) are non-nullable in the callback tuple. Pass a `_guaranteed` second argument to `world.filter()` as a manual override when inference can't reach:

```ts
// Auto-deduced — both non-null:
world.filter([Position, Velocity])
  .forEach([Position, Velocity], (e, [pos, vel]) => { ... });

// Manual hint for OR / NOT / PARENT / custom function:
world.filter({ OR: [Position, Velocity] }, [Position])
  .forEach([Position], (e, [pos]) => pos.x);
```

A `Filter` holds no tracked set, makes no registration calls, and needs no `destroy()`.

---

## Build & Test

```
yarn build
yarn test
```

---

## License

UNLICENSED
