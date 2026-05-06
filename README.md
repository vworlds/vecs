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
| **World**                | Central container. Owns every entity, query, system, and pipeline phase.        |
| **Component**            | A plain data class. Extend `Component` and attach instances to entities.        |
| **Entity**               | A numeric id with a set of components. Created via the world.                   |
| **Query**                | A reactive, always-up-to-date set of entities matching a predicate.             |
| **System**               | A `Query` with phase placement and per-tick logic (`update`, `each`, `run`).    |
| **Filter**               | A non-reactive, one-shot scan: walks all world entities on each `forEach` call. |
| **Hook**                 | Lightweight `onAdd` / `onRemove` / `onSet` callbacks per component class.       |
| **Phase**                | Named ordered bucket of systems within the update pipeline.                     |
| **Exclusive components** | A group of components where at most one may exist on any entity at a time.      |

### Lifecycle in brief

```
registerComponent() × N  →  addPhase() / system() / query() × N  →  start()  →  progress() every frame
```

After `start()`, component registration is disabled. Systems and queries can still be created — standalone queries backfill existing matched entities immediately.

---

## Example

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

// MoveSystem: integrates Velocity into Position every tick.
world
  .system("Move")
  .phase(update)
  .requires(Position, Velocity)
  .each([Position, Velocity], (e, [pos, vel]) => {
    pos.x += vel.vx;
    pos.y += vel.vy;
    pos.modified(); // signal that Position changed so other systems react
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

world
  .hook(Health)
  .onAdd((h) => console.log(`entity ${h.entity.eid} spawned with hp=${h.hp}`))
  .onRemove((h) => console.log(`entity ${h.entity.eid} died`));

// ─── Start ─────────────────────────────────────────────────────────────────

world.start(); // freeze registration, distribute systems into phases

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

Inside a system body, a `Query.forEach`, or any `world.defer(...)` block, the world is in **deferred mode**: entity mutations (`add` / `set` / `remove` / `destroy` / `setParent` / `modified`) are queued instead of applied inline. The queue drains on the boundary that opened the deferred scope.

Concretely, while deferred:

- `entity.get(C)` returns `undefined` after `entity.add(C)` (no instance has been created yet).
- `entity.get(C)` returns the **previous** value after `entity.set(C, props)`.
- `entity.get(C)` still returns the component after `entity.remove(C)`.

Outside any deferred scope (top-level user code) the same calls execute inline and effects are visible immediately. `world.flush()` drains any pending top-level commands; `world.defer(fn)` is sugar for `beginDefer / fn / endDefer`.

---

## API Reference

### `World`

Create one per game session.

```ts
const world = new World();
```

#### Component registration

```ts
// Auto-assigned type id (≥ 256 for "local" components):
world.registerComponent(Position);

// Explicit numeric type id (e.g. server-assigned):
world.registerComponent(Position, 1);

// Explicit display name (e.g. when the class name differs from the network name):
world.registerComponent(Position, "pos");

// Pre-register a name → id mapping before the class is available:
world.registerComponentType("Position", 1);
```

After `world.start()` (or `world.disableComponentRegistration()`) any further call to `registerComponent` throws.

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

// Look up by id (returns undefined if not found):
const found = world.entity(42);

// Server-assigned id; creates the entity if it doesn't exist yet:
const net = world.getOrCreateEntity(serverId, (newEntity) => {
  tracked.add(newEntity);
});

// Reserve a high id range for locally created entities so they don't collide
// with server-assigned ids (call before world.start()):
world.setEntityIdRange(0x10000);

// Destroy everything (e.g. on level reset):
world.clearAllEntities();
```

#### Hooks

```ts
world
  .hook(Sprite)
  .onAdd((sprite) => sprite.initialize(scene))
  .onRemove((sprite) => sprite.destroy())
  .onSet((sprite) => sprite.syncToScene());
```

`onAdd` fires when the component is first attached. `onRemove` fires when it is removed (or the entity is destroyed). `onSet` fires whenever `component.modified()` (or `entity.modified(c)`) is called, and when `entity.set(C, props)` is applied to an entity that already has the component.

#### Phases

```ts
const preUpdate = world.addPhase("preupdate");
const update = world.addPhase("update");
const send = world.addPhase("send");

// Drive every phase in registration order:
world.progress(now, delta);

// ...or run individual phases manually:
world.runPhase(preUpdate, now, delta);
world.runPhase(update, now, delta);
world.runPhase(send, now, delta);
```

Systems with no explicit phase are placed in the built-in `"update"` phase.

#### Systems

```ts
world
  .system("MySystem")
  .phase("update")
  .requires(A, B)
  .enter(...)
  .update(...)
  .each(...)
  .exit(...);
```

#### Timers and rate filters

Systems can opt into a slower cadence instead of running on every phase tick. `interval()` takes seconds; throttled `run()` callbacks receive the accumulated milliseconds since the previous fire as `delta`.

```ts
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

const second = world.timer().interval(1.0);

world
  .system("Move")
  .tickSource(second)
  .each([Position], (e, [pos]) => {
    // driven by a shared timer
  });

second.stop();
second.start();

const minute = world.timer().rate(60, second);
const hour = world
  .system("Hour")
  .tickSource(minute)
  .rate(60)
  .run((now, delta) => {
    console.log("hour tick", now, delta);
  });
```

Timers and systems can both be used as tick sources. Disabling a source system suppresses its callbacks, but its clock still drives downstream consumers.

#### Queries

```ts
const enemies = world
  .query("Enemies")
  .requires(Enemy, Health)
  .enter((e) => console.log("enemy spawned", e.eid));

world.start();
// enemies.entities is kept up-to-date automatically.

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
world
  .filter({ AND: [{ HAS: Position }, { HAS: Velocity }] })
  .forEach([Position, Velocity], (e, [pos, vel]) => {
    pos.x += vel.vx;
  });

// Manual hint for queries the type extractor can't see through:
world.filter({ OR: [Position, Velocity] }, [Position]).forEach([Position], (e, [pos]) => pos.x);
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

### `Component`

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

// Equivalent — set assigns props and fires onSet automatically:
entity.set(Position, { x: 100 });
```

| Property / Method | Description                                                           |
| ----------------- | --------------------------------------------------------------------- |
| `entity`          | The `Entity` this component belongs to.                               |
| `meta`            | `ComponentMeta` — type id, display name, and bit-pointer.             |
| `type`            | Numeric type id (shorthand for `meta.type`).                          |
| `bitPtr`          | `BitPtr` (shorthand for `meta.bitPtr`).                               |
| `modified()`      | Queue an `onSet` / `update` notification. Call after mutating fields. |
| `toString()`      | Returns the registered component name.                                |

---

### `Entity`

Created via `world.entity()` (auto-assigned id) or `world.getOrCreateEntity(id, ...)` (caller-supplied id).

| Property / Method     | Description                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `eid`                 | Unique numeric entity id.                                                                                                             |
| `world`               | The `World` that owns this entity.                                                                                                    |
| `componentBitmask`    | `Bitset` of component type ids attached to this entity. Used by archetype matching.                                                   |
| `properties`          | `Map<string, any>` free-form bag for module-level bookkeeping.                                                                        |
| `add(Class)`          | Attach a component (idempotent). Returns the entity for chaining.                                                                     |
| `set(Class, props)`   | Attach a component and assign `props`; fires `onSet`. Returns the entity for chaining.                                                |
| `modified(component)` | Queue an `onSet` / `update` notification. Returns the entity for chaining.                                                            |
| `get(Class)`          | Return the component instance, or `undefined`.                                                                                        |
| `remove(Class)`       | Detach a component (fires `onRemove` and `exit`).                                                                                     |
| `destroy()`           | Remove all components, unregister from the world, recurse into children.                                                              |
| `components`          | `ReadonlyArrayMap<Component>` — read-only view of attached components keyed by type id. Supports `forEach`, `get`, `has`, and `size`. |
| `empty`               | `true` when no components are attached.                                                                                               |
| `parent`              | Parent entity, or `undefined` for a root entity.                                                                                      |
| `children`            | `ReadonlySet<Entity>` of direct children (lazy).                                                                                      |
| `setParent(p)`        | Reparent the entity. `undefined` makes it a root entity. Throws on cycles.                                                            |
| `events`              | Typed event emitter. Currently emits `"destroy"` just before teardown.                                                                |
| `toString()`          | Returns `"EntityN"`.                                                                                                                  |

`entity.modified(c)` is equivalent to `c.modified()` but returns the entity so it can chain:

```ts
const vel = entity.get(Velocity)!;
vel.vx += accel;
entity.modified(vel); // chainable
```

#### Parent / child hierarchy

```ts
child.setParent(parent);
parent.children.has(child); // true

// Destroying a parent recursively destroys all children:
parent.destroy();
```

`setParent` throws if the new parent is a descendant of the entity. Archetype queries that use `{ PARENT: ... }` are re-evaluated automatically when a parent's component set changes.

---

### `System`

Systems are created via `world.system(name)` and configured through a fluent builder. Every method returns `this` for chaining. `System` extends `Query`, so the membership / enter / exit / update / sort APIs are shared.

#### `.requires(...components)` and `.query(q)`

Declare which entities the system tracks.

```ts
.requires(Position, Velocity)                                    // shorthand for HAS
.query({ HAS: [Position, Velocity] })                            // explicit
.query({ PARENT: { AND: [Player, Container] } })                 // parent-aware
.query({ AND: [Position, { OR: [Sprite, Container] }] })         // compound
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
| An array `[A, B]`      | Shorthand for `{ HAS: [A, B] }`          |
| A single class / id    | Shorthand for `{ HAS: [C] }`             |
| A predicate function   | Custom membership logic                  |

**Type inference.** `requires()` records the listed classes as a type parameter `R` on the system. Callbacks in `.sort()`, `.each()`, and `.update()` injection treat those components as non-nullable — no `!` needed. For complex `query()` expressions the type system can't introspect, supply a `_guaranteed` second argument:

```ts
.query({ AND: [{ HAS: Position }, { HAS: Velocity }] }, [Position, Velocity])
.each([Position, Velocity], (e, [pos, vel]) => {
  pos.x += vel.vx; // pos and vel are non-null
});
```

#### `.phase(p)`

Assign the system to a phase by name or `IPhase` reference. Default phase is `"update"`.

```ts
.phase("preupdate")
.phase(myPhase)
```

#### `.enter(callback)` / `.enter(inject, callback)`

Fires once when an entity first matches the system.

```ts
.enter((e) => { ... })
.enter([Position, Sprite], (e, [pos, sprite]) => {
  sprite.setPosition(pos.x, pos.y);
})

// Resolve from the entity's parent:
.enter([{ parent: Container }], (e, [container]) => {
  container.add(e.get(Sprite)!.gameObject);
});
```

#### `.exit(callback)` / `.exit(inject, callback)`

Fires when an entity leaves the system (component removed or entity destroyed). Components removed in the same frame are still resolvable in `inject`.

```ts
.exit([Sprite], (e, [sprite]) => sprite.destroy());
```

#### `.update(ComponentClass, callback)` / `.update(ComponentClass, inject, callback)`

Fires when `component.modified()` is called for the watched component on a tracked entity.

```ts
.update(Position, (pos) => renderer.setPosition(pos.x, pos.y));

.update(Position, [Sprite], (pos, [sprite]) => {
  sprite.sprite.setPosition(pos.x, pos.y);
});
```

If `query()` has not been called, `update` automatically expands the implicit `HAS` predicate to require the watched component.

#### `.each(components, callback)`

Fires every tick for **every tracked entity**, regardless of whether anything changed. Use it for per-entity logic that must run every frame. Implies `.track()`. Only one `each` per system.

```ts
.requires(Position, Velocity)
.each([Position, Velocity], (e, [pos, vel]) => {
  pos.x += vel.vx;
});
```

#### `.sort(components, compare)`

Store matched entities in a custom order determined by `compare`. Implies `.track()`. Iterating `system.entities`, `forEach`, and `each` walks entities in sorted order.

```ts
world
  .system("Render")
  .requires(Position, Sprite)
  .sort([Position], ([posA], [posB]) => posA.z - posB.z)
  .each([Position, Sprite], (e, [pos, sprite]) => sprite.draw(pos.x, pos.y));
```

#### `.track()`

Enable entity tracking without an `each` callback — exposes matched entities via `system.entities`. `each` and `sort` imply `track` automatically. When called after `world.start()`, immediately backfills existing matched entities.

#### `.run(callback)`

Fires every tick when the system's phase runs, regardless of entity state. Use for polling, network I/O, timers, etc.

```ts
.run((now, delta) => {
  sendNetworkPacket(now);
});
```

#### `.disable()` / `.enable()`

Pause and resume a system at runtime. While disabled the system is effectively invisible: the inbox is cleared immediately, any new `enter`, `exit`, or `update` events are silently dropped, `run` and `each` callbacks do not fire, and the system skips its `_run` entirely. Entity membership in the underlying query is still maintained, so the tracked set remains correct and the system resumes cleanly when re-enabled. Events that occurred while the system was disabled are **not** replayed.

```ts
const ai = world.system("AI").requires(Enemy).run(tickAI);

// Pause AI processing during a cutscene:
ai.disable();

// Resume normal processing:
ai.enable();
```

Both methods return `this` for chaining and are idempotent (calling `disable()` on an already-disabled system, or `enable()` on an already-enabled system, is a no-op).

#### `.destroy()`

**Not supported on `System`** — calling it throws. Systems live for the duration of the world. Use a standalone `Query` for temporary reactive sets.

---

### `Query`

`world.query(name)` returns a standalone reactive entity set, configured through the same builder API as `System`. It has no phase and no per-tick callbacks.

```ts
const projectiles = world
  .query("Projectiles")
  .requires(Position, Velocity)
  .sort([Position], ([a], [b]) => a.z - b.z)
  .enter([Position], (e, [pos]) => {
    pos.x = spawnX;
  });

world.start();

projectiles.forEach((e) => { ... });
console.log(projectiles.entities.size, "active projectiles");
```

| Method                                                  | Description                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------------ |
| `.requires(...components)`                              | Set the membership predicate to `HAS(...components)` and start tracking. |
| `.query(expr, _guaranteed?)`                            | Set the membership predicate using a `QueryDSL` expression.              |
| `.enter(callback)` / `.enter(inject, callback)`         | Fires when an entity joins the query.                                    |
| `.exit(callback)` / `.exit(inject, callback)`           | Fires when an entity leaves the query.                                   |
| `.update(C, callback)` / `.update(C, inject, callback)` | Fires when `C` is modified on a tracked entity.                          |
| `.sort(components, compare)`                            | Store matched entities in sorted order.                                  |
| `.track()`                                              | Enable tracking. Backfills when called after `start()`.                  |
| `.belongs(e)`                                           | Returns `true` if the entity satisfies the predicate.                    |
| `.forEach(callback)`                                    | Iterate currently tracked entities.                                      |
| `.forEach(components, callback)`                        | Iterate with component injection.                                        |
| `.entities`                                             | `ReadonlySet<Entity>` of currently tracked entities.                     |
| `.destroy()`                                            | Remove the query from the world and from every entity (no exit fires).   |

#### `.destroy()` semantics

`destroy()` permanently removes a standalone query from the world. Entity references are silently purged (no `exit` callbacks fire), the tracked set is cleared, and the `world` reference is set to `undefined`. Any further use of the object is **undefined behavior**.

```ts
const q = world.query("Temporary").requires(Position);
// ... use q.entities ...
q.destroy();
```

`System` shares the same DSL, callback, sorting, and tracking machinery — `System` extends `Query` and adds phase placement, `run`, `each`, and an inbox replayed on every tick.

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

**Type inference.** Component classes the type system can extract from the DSL (`HAS`, `HAS_ONLY`, plain arrays, `AND` of those) are non-nullable in the callback tuple. For the rest, supply a `_guaranteed` second argument to `world.filter()`:

```ts
// Auto-deduced — both non-null:
world.filter([Position, Velocity]).forEach([Position, Velocity], (e, [pos, vel]) => { ... });

// Manual hint for OR / NOT / PARENT / custom function:
world.filter({ OR: [Position, Velocity] }, [Position]).forEach([Position], (e, [pos]) => pos.x);
```

A `Filter` holds no tracked set, makes no registration calls, and needs no `destroy()`.

---

### `Bitset`

A compact, growable set of non-negative integers backed by 32-bit words. Used internally for entity archetypes and watchlists, and exposed in the public API so component data can use it for bit-flag fields.

| Method             | Description                                                              |
| ------------------ | ------------------------------------------------------------------------ |
| `add(n)`           | Set bit `n`.                                                             |
| `addBit(bptr)`     | Set the bit at a pre-computed `BitPtr`.                                  |
| `delete(n)`        | Clear bit `n`. Trims trailing zero words.                                |
| `has(n)`           | Returns `true` if bit `n` is set.                                        |
| `hasBit(bptr)`     | Fast check via a pre-computed `BitPtr`.                                  |
| `equal(other)`     | Returns `true` when both bitsets have the same bits set.                 |
| `hasBitset(other)` | Returns `true` when every bit set in `other` is also set in this bitset. |
| `forEach(cb)`      | Visit each set bit index in ascending order.                             |
| `indices()`        | Return all set bit indices as a `number[]`.                              |

```ts
class Tags extends Component {
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
