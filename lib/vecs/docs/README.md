# vecs Documentation

Single-topic guides for `@vworlds/vecs`. Each guide moves from concept to how-to to a woven
reference, and every example uses the real public API. The exhaustive per-symbol reference is the
JSDoc on the source in `lib/vecs/src/` — read it in your IDE; these guides carry the concepts,
the idioms, and the reference tables you reach for while designing.

## Reading order

Read in this order the first time through:

1. [Getting started](./getting-started.md) — install, first world, first system, first tick.
2. [Concepts](./concepts.md) — the mental model: world, entity, component, system, query.
3. [Execution model](./execution-model.md) — phases, the pipeline, deferred mutation, reactive
   routing. Read this before designing anything non-trivial.
4. Subsystem guides, in any order:
   - [Components](./components.md) — registration, hooks, traits, exclusivity, cleanup policies,
     interfaces, singletons.
   - [Entities](./entities.md) — creation, lookup, the component API, relationship targets, lifecycle,
     [synchronous world disposal and allowed call sites](./entities.md#disposing-a-world).
   - [Systems](./systems.md) — membership, reactive callbacks, callback options, `each`/`run`, cadence,
     component, relationship, and [clock injection](./systems.md#clock-injection), plus
     [opt-in timing and run counts](./systems.md#measuring-systems).
   - [Queries and filters](./queries-and-filters.md) — the query DSL, live queries, one-shot
     filters, grouped queries, `Bitset`.
   - [Relationships](./relationships.md) — links, target creation and projection, ownership, hierarchy,
     cleanup cascades.
   - [Modules](./modules.md) — packaging features, composition, the built-in modules.
   - [Subtree snapshots](./snapshots.md) — capturing, restoring, and moving an entity forest
     between two worlds.
5. [Design guide](./design-guide.md) — opinionated patterns and anti-patterns distilled from real
   designs. Read it once you know the machinery.
6. [Utilities](./utilities.md) — helper classes exported by `@vworlds/vecs` but not part of the ECS
   lifecycle model.

Keep the [Glossary](./glossary.md) at hand for terminology.

## Map

For Node clients that need replicated Phaser poses, see [Headless clients](../../vecs-phaser-client/README.md#headless-clients).

| Guide                                              | Covers                                                                                                                 |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| [getting-started.md](./getting-started.md)         | A runnable tutorial from `npm install` to a ticking world.                                                             |
| [concepts.md](./concepts.md)                       | The core vocabulary and how the pieces relate, including the shared `Vec2` type.                                       |
| [execution-model.md](./execution-model.md)         | `world.progress`, the 8 built-in phases, deferred commands, flush boundaries, event routing.                           |
| [components.md](./components.md)                   | Component registration, hooks, traits, exclusivity, cleanup, aliases, and singletons.                                  |
| [entities.md](./entities.md)                       | Entity creation, mutation, relationship targets, lifecycle, disposal, deferred reads.                                  |
| [systems.md](./systems.md)                         | `world.system`, callbacks, component/relationship/clock injection, ordering, cadence, tick sources, and opt-in timing. |
| [queries-and-filters.md](./queries-and-filters.md) | `QueryDSL`, `Query`, `Filter`, `groupBy`, `ignoreSource`.                                                              |
| [relationships.md](./relationships.md)             | Relationships, target creation, projection and ownership, hierarchy, traversal, and cleanup.                           |
| [modules.md](./modules.md)                         | `Module<Config>`, `world.module`, composition, built-in modules.                                                       |
| [snapshots.md](./snapshots.md)                     | `snapshotSubtree`, `restoreSubtree`, `moveSubtree`, and `OnSnapshot` capture policies.                                 |
| [design-guide.md](./design-guide.md)               | Patterns, anti-patterns, and a Phaser render-layer case study.                                                         |
| [utilities.md](./utilities.md)                     | Public helper classes: `Events`, `ArrayMap`, `IterableArrayMap`, plus `Bitset` cross-ref.                              |
| [glossary.md](./glossary.md)                       | ECS and vecs terminology.                                                                                              |

Networking (wire encoding with `@wireType`, protocol component ordering, replication, RPCs, server
sessions, and the client world) lives in the `@vworlds/vecs-wire`, `@vworlds/vecs-protocol`,
`@vworlds/vecs-server`, and `@vworlds/vecs-client` packages:

- [Remote procedure calls](../../vecs-protocol/docs/rpc.md) — the call channel and typed errors.
- [State diffs](../../vecs-protocol/docs/state-diffs.md) — what a diff carries, the order a client
  applies it in, and how a reused entity id stays unambiguous.
- [Sessions and caller context](../../vecs-server/docs/sessions.md) — per-connection RPC context,
  `closeSession`, and exactly-once teardown.
- [Client world](../../vecs-client/docs/client-world.md) — replication, render time,
  `invoke`/`listen`, and disposal.
