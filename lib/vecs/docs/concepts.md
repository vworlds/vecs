# Concepts

The vecs mental model: what the pieces are, how they relate, and the one rule that makes the rest
fall into place.

## The golden rule

Components are **data**, systems are **behavior**, and **lifecycle is driven by the presence and
change of components — not by imperative bookkeeping**. You do not call `start()` on things or keep
side maps of what exists; you attach and remove components, and reactive systems respond. Nearly
every idiom in the [Design guide](./design-guide.md) is a consequence of taking this seriously.

## The pieces

| Concept                    | What it is                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **World**                  | Central container. Owns every entity, registered component, query, system, and the flat system pipeline.     |
| **Entity**                 | A numeric id (`eid`) with a set of components attached. Created via the world.                               |
| **Component**              | A registered plain data class with a no-argument constructor. No behavior.                                   |
| **System**                 | A `Query` plus per-tick logic (`update`, `each`, `run`), assigned to one pipeline phase.                     |
| **Query**                  | A reactive, always-up-to-date set of entities matching a predicate, with `enter`/`exit`/`update` callbacks.  |
| **Filter**                 | A non-reactive, one-shot scan: walks all world entities on each `forEach` call.                              |
| **Hook**                   | Lightweight component callbacks (`onAdd` / `onSet` / `onRemove`, plus relationship edge hooks).              |
| **Phase**                  | Marker component for entities used as pipeline ordering anchors.                                             |
| **Relationship**           | A component holding explicit edges to one or more target entities, with reverse lookup and cleanup cascades. |
| **Component trait**        | Policy attached to a component entity, configuring every use of that component type.                         |
| **Module**                 | A unit of packaging: a class whose `init()` registers components, systems, phases, and policy.               |
| **Exclusive components**   | A group of components where at most one may exist on any entity at a time.                                   |
| **Exclusive relationship** | A relationship carrying `Exclusive`, restricting each source to at most one target.                          |
| **Implements**             | Declares abstract/interface component aliases for a concrete component, for polymorphic queries.             |

## Data vs. behavior

A component is a bag of fields:

```ts
class Position {
  x = 0;
  y = 0;
}
```

It carries no methods that act on the world, no reference to its entity, and no lifecycle of its
own. All behavior lives in systems (and, for small cross-cutting reactions, in hooks). This split
is what makes composition work: any system can operate on any entity that happens to carry the
right components, and adding a capability to an entity is just adding a component.

Because a registered component is also an entity, it can itself carry components. Built-in
**component traits** use that meta-ECS layer to declare reusable policy: `Singleton` constrains a
component, `Implements` declares aliases, `Exclusive` constrains relationship cardinality, and
`Traversable` / `OwnedTarget` configure exclusive relationships. The trait remains data; a module
owns the hooks and metadata behavior it activates. Relationship `Exclusive` is unrelated to an
exclusive component group: one limits edge count, while the other limits coexisting component
types.

Prefer many small, single-purpose components over one large one. An entity that never rotates
simply omits `Rotation`; absence encodes "not applicable". See
[Components](./components.md).

## How a tick works, in brief

```text
world.component(C) / world.system(name) / world.query(name)  ×  N
        ↓
world.progress(now, delta)   — once per frame
```

`world.progress` runs every system in phase order. Inside a system body the world is **deferred**:
entity mutations are queued, then flushed after the system finishes, which routes `enter` /
`update` / `exit` events into the queries and systems that care. Newly created systems are inserted
into the pipeline the next time `progress` runs; standalone queries backfill already-matching
entities when they are built. The full story — phase taxonomy, ordering guarantees, flush
boundaries — is in [Execution model](./execution-model.md).

## Lifecycle is component presence

Because queries react to component presence and change, the component set _is_ the lifecycle:

- "This entity is renderable" — it has a renderable component; the render system's `enter` fires.
- "This resource must be released" — remove its component (or destroy the entity); `onRemove`
  fires.
- "This value changed" — `set`/`modified` fires `onSet` hooks and `update` callbacks.

So instead of factories, registries, and `Map<eid, resource>` side tables, you write systems gated
on component combinations. The canonical example is the companion-component pattern in the
[Design guide](./design-guide.md#7-patterns-reach-for-these).

## Where each topic lives

- Registering, configuring, hooking, and applying traits to components → [Components](./components.md)
- Creating, mutating, and destroying entities → [Entities](./entities.md)
- System membership, callbacks, and cadence → [Systems](./systems.md)
- The query DSL, live queries, filters, grouping → [Queries and filters](./queries-and-filters.md)
- Entity-to-entity links and hierarchy → [Relationships](./relationships.md)
- Packaging features → [Modules](./modules.md)
- Terminology → [Glossary](./glossary.md)
