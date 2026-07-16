# Glossary

ECS and vecs terminology, in alphabetical order. Each entry links to the guide that develops it.

**Archetype** — the set of component type ids attached to an entity, represented as the entity's
`componentBitmask` (a [`Bitset`](./utilities.md#bitset)). Query matching tests
archetypes with fast bitwise subset checks.

**Backfill** — when a tracked query or system is built, entities that already match are routed
through `enter` so the tracked set starts complete.
[Queries and filters](./queries-and-filters.md#lifecycle-build-backfill-destroy).

**Bitset** — a compact, growable set of non-negative integers backed by 32-bit words; used for
archetypes and watchlists, and exported for bit-flag component fields.
[Utilities](./utilities.md#bitset).

**Cascade (query)** — depth-first ordering of a query's members along a `Traversable`
relationship, via `{ with: ..., cascade: Rel }`.
[Relationships](./relationships.md#traversal-order-traversable-and-cascade).

**Cleanup policy** — what happens to dependent entities on destruction: `onDelete` (component
entity destroyed → carriers throw/strip/die) and `onDeleteTarget` (relationship target destroyed →
sources strip/die). [Components](./components.md#cleanup-policies-destroying-a-component-entity),
[Relationships](./relationships.md#cleanup-when-a-target-dies).

**Companion (wrapper) component** — a local, non-networked component holding a non-ECS resource
(render object, WASM handle) so the entity's component set drives the resource lifecycle.
[Components](./components.md#resources-as-components-non-ecs-objects).

**Component** — a registered plain data class with a no-argument constructor; pure data, no
behavior. [Components](./components.md).

**Component entity** — the entity backing a registered component class; returned by
`world.component(C)` and carrying the class's hooks and `ComponentMeta`.
[Components](./components.md#registration-worldcomponent).

**Deferred mode / flush** — inside systems, `forEach`, and `defer` blocks, entity mutations are
queued as commands; `flush` drains the queue at the scope boundary (after each system in the
pipeline). [Execution model](./execution-model.md#deferred-mutation-and-flush-boundaries).

**Entity** — a unique numeric id (`eid`) owned by a world, with a set of components attached.
[Entities](./entities.md).

**Exclusive components** — a declared group where at most one member may exist on an entity;
setting one removes the others. [Components](./components.md#exclusive-component-groups).

**Exclusive relationship** — a relationship carrying the `Exclusive` trait, restricting each
source to at most one target. Adding a different edge replaces the current edge. This is separate
from an exclusive component group. [Relationships](./relationships.md).

**Events** — a minimal typed event emitter helper exported for package-level events. It is not an
entity lifecycle API. [Utilities](./utilities.md#events).

**Filter** — a non-reactive, one-shot predicate that scans world entities on each `forEach`.
[Queries and filters](./queries-and-filters.md#filters-one-shot-scans).

**Hook** — an `onAdd` / `onSet` / `onRemove` callback registered per component class, or an
`onTargetAdd` / `onTargetRemove` callback for relationship edges, fired synchronously at the
mutation site. [Components](./components.md#hooks-component-and-relationship-edges).

**Implements / interface alias** — a declaration that a concrete component is queryable through
abstract/interface component types; aliases are read-only views of the same instance.
[Components](./components.md#interface-aliases-with-implements).

**Inbox** — a system's ordered queue of routed `enter` / `exit` / `update` events, replayed at the
top of the system's run. [Execution model](./execution-model.md#reactive-routing).

**Injection** — resolving component instances per entity into a typed callback tuple, including
singular `target` (the first relationship target), plural `targets` (one projection row per target),
and `down` (fan-out over children) markers.
[Systems](./systems.md#component-injection).

**Iter** — an opt-in reusable cursor passed to callbacks instead of the bare entity, exposing the
visited entity and the source entity of each injected slot.
[Systems](./systems.md#the-iter-cursor).

**Module** — a packaging unit (`class M extends Module<Config>`) whose `init()` registers
components, systems, and policy once per world. [Modules](./modules.md).

**Owned target entity** — an explicitly created zero-or-one aggregate entity targeted through a
relationship carrying both `Exclusive` and `OwnedTarget`. It is parented to the source and destroyed
when displaced, when its edge or relationship is removed, or when the source dies.
[Relationships](./relationships.md#owned-targets).

**Phase** — an entity used as a pipeline ordering anchor (tagged with the `Phase` component);
systems attach to exactly one phase via `DependsOn`.
[Execution model](./execution-model.md#phases-the-pipeline-spine).

**Pipeline** — the flat, ordered list of systems `world.progress` runs each tick; defined by an
ordered query over system entities. [Execution model](./execution-model.md#the-pipeline-is-a-query).

**Query** — a reactive, always-up-to-date set of entities matching a DSL predicate, with
`enter` / `exit` / `update` callbacks. [Queries and filters](./queries-and-filters.md).

**Query DSL** — the composable predicate language (`all` / `any` / `not` / `only` / `target` /
`source` / `parent` / `children` / `test`).
[Queries and filters](./queries-and-filters.md#the-query-dsl).

**Relationship** — a component holding explicit edges from its source entity to one or more targets,
with `target` / `targets` / `hasTarget` lookup, reverse lookup (`children`), and cleanup cascades.
Target storage is private; mutate edges with `add(Rel, target)` and `remove(Rel, target)`.
[Relationships](./relationships.md).

**Silence domain / `ignoreSource`** — a query configuration that drops `update` events originating
from systems matching another query, breaking write feedback loops.
[Queries and filters](./queries-and-filters.md#silencing-feedback-ignoresource).

**Singleton** — a component class constrained to at most one carrier entity; commonly stored on
its own component entity via `world.set` / `world.get`.
[Components](./components.md#singletons-and-world-global-data).

**System** — a query plus per-tick behavior (`run`, `each`) and inbox-replayed reactive callbacks,
assigned to one phase. [Systems](./systems.md).

**Tick source** — a clock (`IntervalTickSource`, `RateTickSource`, or another system) that gates
how often a system fires. [Systems](./systems.md#cadence-interval-rate-and-tick-sources).

**Trait (component trait)** — policy attached as a component to a registered component entity,
configuring every use of that component type. Built-ins include `Singleton`, `Implements`,
`Exclusive`, `Traversable`, and `OwnedTarget`.
[Components](./components.md#component-traits-policy-on-component-entities).

**Watchlist** — the set of component types a query or system reacts to via `update`, stored as a
bitmask. [Systems](./systems.md#reactive-callbacks-enter-update-exit).

**Wire type** — a field-level encoding declaration (`@wireType` from `@vworlds/vecs-wire`) used by the networking packages to serialize components. Networking is
documented with `@vworlds/vecs-wire` / `@vworlds/vecs-protocol`, not here.

**World** — the central container owning entities, component registrations, queries, systems, and
the pipeline; driven by `world.progress(now, delta)`. [Concepts](./concepts.md).
