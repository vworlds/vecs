# Getting Started

Build a small simulation from scratch: create a world, register components, write two systems, and
drive the loop with `world.progress`.

## Install

```sh
npm install @vworlds/vecs
```

The package ships TypeScript types; no extra tooling is required.

## 1. Create a world

A `World` owns every entity, registered component, query, system, and the update pipeline. Create
one per game session:

```ts
import { World } from "@vworlds/vecs";

const world = new World();
```

The constructor installs the built-in modules — identity names, interface aliases, singletons,
relationships, and the eight-phase pipeline — so the world is ready to use immediately (see
[Modules](./modules.md)).

## 2. Define and register components

Components are plain data classes: field initializers, a no-argument constructor, and no behavior.
Register each class with `world.component` before using it:

```ts
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

world.component(Position);
world.component(Velocity);
world.component(Health);
```

There is no automatic registration — using an unregistered class as a component throws. See
[Components](./components.md) for ids, hooks, and policies.

## 3. Add a system

Systems declare which entities they care about with `.with(...)` and attach behavior. `each` runs
once per matched entity on every tick:

```ts
world
  .system("Move")
  .with(Position, Velocity)
  .each([Position, Velocity], (e, [pos, vel]) => {
    pos.x += vel.vx;
    pos.y += vel.vy;
    e.modified(Position); // notify watchers that Position changed
  });
```

Two details to internalize early:

- The components listed in `.with` are guaranteed present, so `pos` and `vel` are non-nullable in
  the callback tuple.
- Mutating fields directly does not notify anyone. Call `e.modified(Position)` so hooks, `update`
  callbacks, and reactive queries see the change. See [Systems](./systems.md).

## 4. Add a reactive system in a later phase

Systems run in the world's phase pipeline and default to the `vecs::OnUpdate` phase. Place
follow-up work in a later phase — here, despawning dead entities during validation:

```ts
import { ON_VALIDATE } from "@vworlds/vecs";

world
  .system("Reap")
  .phase(ON_VALIDATE)
  .with(Health)
  .update(Health, (entity, health) => {
    if (health.hp <= 0) {
      entity.destroy();
    }
  });
```

`update(Health, ...)` fires only when `Health` is set or marked modified on a tracked entity, so
this system does no work for idle entities. Use `update({ watch: Health, onEnter: true }, ...)` when
you also want the callback to run for entities that already have `Health` as they enter. The phase
taxonomy and ordering rules are in [Execution model](./execution-model.md).

## 5. Observe lifecycle with hooks

For a per-component callback that is not worth a whole system, register hooks on the component
entity:

```ts
world
  .component(Health)
  .on("add", (entity, h) => console.log(`entity ${entity.eid} spawned with hp=${h.hp}`))
  .on("remove", (entity) => console.log(`entity ${entity.eid} died`));
```

The `add` event fires when the component is first attached, `remove` when it is detached or its
entity is destroyed, and `set` whenever its data is set or marked modified.

## 6. Spawn entities

`world.entity()` creates an entity; `set` attaches a component and assigns data in one call.
Calls chain:

```ts
world.entity().set(Position, { x: 0, y: 0 }).set(Velocity, { vx: 5, vy: 0 }).set(Health, { hp: 3 });
```

## 7. Drive the loop

`world.progress(now, delta)` runs one tick: every system in phase order, with structural changes
flushed after each system. Both arguments are milliseconds — `now` is your absolute clock, `delta`
the time since the previous tick:

```ts
let now = 0;
for (let tick = 0; tick < 5; tick++) {
  now += 16;
  world.progress(now, 16);
}
```

In a real game, call `world.progress` from your frame loop (`requestAnimationFrame`, a fixed-step
server loop, etc.).

## Complete program

```ts
import { ON_VALIDATE, World } from "@vworlds/vecs";

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

const world = new World();

world.component(Position);
world.component(Velocity);
world
  .component(Health)
  .on("add", (entity, h) => console.log(`entity ${entity.eid} spawned with hp=${h.hp}`))
  .on("remove", (entity) => console.log(`entity ${entity.eid} died`));

world
  .system("Move")
  .with(Position, Velocity)
  .each([Position, Velocity], (e, [pos, vel]) => {
    pos.x += vel.vx;
    pos.y += vel.vy;
    e.modified(Position);
  });

world
  .system("Drain")
  .with(Health)
  .each([Health], (e, [health]) => {
    health.hp -= 1;
    e.modified(Health);
  });

world
  .system("Reap")
  .phase(ON_VALIDATE)
  .with(Health)
  .update(Health, (entity, health) => {
    if (health.hp <= 0) {
      entity.destroy();
    }
  });

world.entity().set(Position, { x: 0, y: 0 }).set(Velocity, { vx: 5, vy: 0 }).set(Health, { hp: 3 });

let now = 0;
for (let tick = 0; tick < 5; tick++) {
  now += 16;
  world.progress(now, 16);
}
```

Run it and watch the entity spawn, drain, and die after three ticks.

## Where to go next

- [Concepts](./concepts.md) — the mental model behind what you just wrote.
- [Execution model](./execution-model.md) — why the phase placement and `modified` calls work.
- [Design guide](./design-guide.md) — the idioms to reach for as your design grows.
