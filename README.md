# vecs

A TypeScript Entity Component System (ECS) for real-time games and simulations.

`vecs` lets you model game state as **entities** (integer IDs) with **components** (typed data bags) attached to them. **Systems** declare which component combinations they care about and receive automatic callbacks when entities enter or leave their query, when component data changes, and on every tick. A **World** ties it all together and drives the update loop.

## Install

```
yarn add @vworlds/vecs
```

## Concepts

| Concept | What it is |
|---|---|
| **World** | Central container. Owns all entities, runs all systems. |
| **Component** | A plain data class. Extend `Component` and attach instances to entities. |
| **Entity** | An integer id with a set of components. Create via the world. |
| **System** | Reactive logic. Declare which components you need; get called when things change. |

### Lifecycle in brief

```
registerComponent() × N  →  system() × N  →  start()  →  runPhase() every frame
```

After `start()`, no new components or systems can be registered.

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
  .onEnter([Position, Velocity], (e, [pos, vel]) => {
    console.log(`entity ${e.eid} entered Move with pos=(${pos.x},${pos.y})`);
  })
  .onUpdate(Velocity, [Position], (vel, [pos]) => {
    // Called whenever vel.modified() is queued.
    pos.x += vel.vx;
    pos.y += vel.vy;
    pos.modified(); // propagate position change to other systems
  })
  .onExit((e) => {
    console.log(`entity ${e.eid} left Move`);
  });

// HealthSystem: despawns entities whose HP drops to zero.
world
  .system("Health")
  .phase(cleanup)
  .requires(Health)
  .onUpdate(Health, (health) => {
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
const pos = bullet.add(Position);
pos.x = 0;
pos.y = 0;

const vel = bullet.add(Velocity);
vel.vx = 5;
vel.vy = 0;
vel.modified(); // first update: notify Move system

const hp = bullet.add(Health);
hp.hp = 3;
hp.modified();

// ─── Game loop ─────────────────────────────────────────────────────────────

let now = 0;
for (let tick = 0; tick < 5; tick++) {
  now += 16;
  world.runPhase(update, now, 16);
  world.runPhase(cleanup, now, 16);
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
// collide with server-assigned ids (call before registerComponent):
world.setEntityIdRange(0x10000);
```

#### Systems

```ts
// Create, configure, and register a system in one chain:
world.system("MySystem")
  .phase("update")
  .requires(A, B)
  .onEnter(...)
  .onUpdate(...)
  .onExit(...);

world.start(); // must be called once, after all systems are set up
```

#### Phases

```ts
// Declare phases in the order they should run each frame:
const preUpdate = world.addPhase("preupdate");
const update    = world.addPhase("update");
const send      = world.addPhase("send");

// Each frame, drive them manually:
world.runPhase(preUpdate, Date.now(), deltaMs);
world.runPhase(update,    Date.now(), deltaMs);
world.runPhase(send,      Date.now(), deltaMs);
```

Systems with no explicit phase go into a built-in `"update"` phase.

#### Hooks

A hook is a shorthand for reacting to a single component's lifecycle without writing a full system:

```ts
world.hook(Sprite)
  .onAdd((sprite)    => sprite.initialize(scene))
  .onRemove((sprite) => sprite.destroy())
  .onSet((sprite)    => sprite.syncToScene());
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

const pos = entity.add(Position);
pos.x = 100;
pos.modified(); // tell the world this component changed
```

Every component instance exposes:

| Property / Method | Description |
|---|---|
| `entity` | The `Entity` this component belongs to. |
| `meta` | `ComponentMeta` — holds the type id, name, and bitset pointer. |
| `type` | Numeric type id (shorthand for `meta.type`). |
| `modified()` | Queue an `onSet` / `onUpdate` notification. Call after mutating fields. |

---

### Entity

```ts
const e = world.createEntity();
```

| Property / Method | Description |
|---|---|
| `eid` | Unique numeric entity id. |
| `world` | The `World` that owns this entity. |
| `add(Class)` | Attach a component; returns the typed instance. Idempotent. |
| `get(Class)` | Return the component instance, or `undefined` if not present. |
| `remove(Class)` | Detach a component (triggers `onRemove` hooks and `onExit` callbacks). |
| `destroy()` | Remove all components and unregister the entity. Recurses to children. |
| `empty` | `true` when no components are attached. |
| `forEachComponent(cb)` | Iterate over all attached components. |
| `parent` | Parent entity in the scene hierarchy, or `undefined`. |
| `children` | `Set<Entity>` of direct children (lazy, created on first access). |
| `events` | Typed event emitter. Currently emits `"destroy"` before teardown. |
| `properties` | `Map<string, any>` free-form bag for module-level bookkeeping. |

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

| Operator | Meaning |
|---|---|
| `{ HAS: [A, B] }` | Entity has all of A and B |
| `{ HAS_ONLY: [A, B] }` | Entity has exactly A and B, nothing else |
| `{ AND: [q1, q2] }` | Both sub-queries must match |
| `{ OR: [q1, q2] }` | Either sub-query matches |
| `{ NOT: q }` | Sub-query must not match |
| `{ PARENT: q }` | Entity's parent matches q |
| An array `[A, B]` | Shorthand for `HAS: [A, B]` |

#### `.phase(p)`

Assign the system to a named phase or an `IPhase` reference. Systems without a phase run in `"update"`.

```ts
.phase("preupdate")   // by name
.phase(myPhase)       // by IPhase reference
```

#### `.onEnter(callback)` / `.onEnter(inject, callback)`

Called once when an entity first matches the system's query.

```ts
// No injection:
.onEnter((e) => { console.log("entity joined", e.eid); })

// With injection — component instances resolved from the entity:
.onEnter([Position, Sprite], (e, [pos, sprite]) => {
  sprite.setPosition(pos.x, pos.y);
})

// Resolve from parent:
.onEnter([{ parent: Container }], (e, [container]) => {
  container.add(e.get(Sprite)!.gameObject);
})
```

#### `.onExit(callback)` / `.onExit(inject, callback)`

Called when an entity leaves the system (component removed or entity destroyed). Components removed in the same frame are still accessible in exit callbacks.

```ts
.onExit([Sprite], (e, [sprite]) => {
  sprite.destroy();
})
```

#### `.onUpdate(ComponentClass, callback)` / `.onUpdate(ComponentClass, inject, callback)`

Called when `component.modified()` is queued on a watched component of a tracked entity.

```ts
// Simple — receives the modified component:
.onUpdate(Position, (pos) => {
  renderer.setPosition(pos.x, pos.y);
})

// With injection — receives the modified component and extra components:
.onUpdate(Position, [Sprite], (pos, [sprite]) => {
  sprite.sprite.setPosition(pos.x, pos.y);
})
```

Calling `onUpdate` also adds that component type to the system's implicit `HAS` query (unless you called `query()` first).

#### `.onRun(callback)`

Called every tick when the system's phase runs, regardless of entity state. Use this for polling, network I/O, timers, etc.

```ts
.onRun((now, delta) => {
  sendNetworkPacket(now);
})
```

---

## Build & Test

```
yarn build
yarn test
```

---

## License

UNLICENSED
