# vecs

A TypeScript Entity Component System (ECS) for real-time games and simulations.

`vecs` lets you model game state as **entities** (numeric ids) with **components** (typed data
classes) attached to them. **Systems** declare which component combinations they care about and
receive automatic callbacks when entities enter or leave their query, when component data changes,
and on every tick. A **World** ties it all together and drives a phased update pipeline.

## Install

The core package also exports the structural `Vec2` type for two-dimensional points and vectors.

```sh
npm install @vworlds/vecs
```

## A taste

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
world.component(Health);

world
  .system("Move")
  .with(Position, Velocity)
  .each([Position, Velocity], (e, [pos, vel]) => {
    pos.x += vel.vx;
    pos.y += vel.vy;
    e.modified(Position);
  });

world
  .system("Reap")
  .phase(ON_VALIDATE)
  .with(Health)
  .update(Health, (entity, health) => {
    if (health.hp <= 0) entity.destroy();
  });

world.entity().set(Position, { x: 0, y: 0 }).set(Velocity, { vx: 5, vy: 0 }).set(Health, { hp: 3 });

world.progress(performance.now(), 16); // call once per frame
```

## Documentation

For synchronous world teardown and its allowed call sites, see
[Disposing a world](./docs/entities.md#disposing-a-world).

System entity callbacks can inject [`Now` and `Delta`](./docs/systems.md#clock-injection) alongside
components to read the processing tick's timestamp and the system's accumulated tick delta.

Inspect [system execution order and cadence](./docs/systems.md#introspection) with `world.pipeline`,
registered callbacks and watched components with `system.callbacks` and `system.watched`, and
[scoped module provenance](./docs/modules.md#scopes-and-module-provenance) through entity parents.
For opt-in timings and cadence run counts, see [Measuring systems](./docs/systems.md#measuring-systems).

For Node clients that need replicated Phaser poses, see [Headless clients](../vecs-phaser-client/README.md#headless-clients).
For server keepalive gates and the idle replicated-state clock, see [Replication](../../architecture/REPLICATION.md#pause-idle-sessions-with-a-gate).

For physics-driven change processing without extra pose watchers, see the
[post-step pose-change view](../vecs-physics/docs/queries.md#pose-changes).

The full documentation lives in [`docs/`](./docs/README.md). Recommended reading order:

1. [Getting started](./docs/getting-started.md) — install to first ticking world.
2. [Concepts](./docs/concepts.md) — the mental model.
3. [Execution model](./docs/execution-model.md) — phases, deferred mutation, event routing.
4. Subsystem guides: [Components and traits](./docs/components.md) · [Entities](./docs/entities.md) ·
   [Systems](./docs/systems.md) · [Queries and filters](./docs/queries-and-filters.md) ·
   [Relationships, edges, targets, and ownership](./docs/relationships.md) · [Modules](./docs/modules.md) ·
   [Subtree snapshots](./docs/snapshots.md)
5. [Design guide](./docs/design-guide.md) — patterns and anti-patterns from real designs.

Plus the [Utilities](./docs/utilities.md) guide for helper classes and the
[Glossary](./docs/glossary.md) for terminology. The exhaustive per-symbol reference is the JSDoc on
the source under [`src/`](./src/) — read it in your IDE.

Networking is documented alongside the packages that own it:
[Remote procedure calls](../vecs-protocol/docs/rpc.md) ·
[Sessions and caller context](../vecs-server/docs/sessions.md) ·
[Client world](../vecs-client/docs/client-world.md).
For MCP inspection through an opted-in browser connection, see
[Browser client targets](../vecs-mcp/docs/clients.md).

## Build & Test

```sh
npm run build
npm run test
npm run lint
```

## License

UNLICENSED
