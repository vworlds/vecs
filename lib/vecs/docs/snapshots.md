# Subtree snapshots

A subtree snapshot moves an entity forest between two vecs worlds: capture it in one world,
recreate it in another, or do both. It is the primitive behind a multi-sector host, where a ship
crosses a world boundary and its ECS state has to appear in the next sector's world.

Three operations, one matched set:

| Operation         | Source world    | Destination world   |
| ----------------- | --------------- | ------------------- |
| `snapshotSubtree` | read-only       | unchanged           |
| `restoreSubtree`  | unchanged       | gets fresh entities |
| `moveSubtree`     | roots destroyed | gets fresh entities |

```ts
const result = world.moveSubtree(ship, nextSectorWorld, {
  components: [Position, LinearVelocity, Hull],
  relationships: [ChildOf, Carries],
  externalTargets: "error",
});

result.roots; // destination root entities
result.entities.get(sourceEid); // destination entity for one snapshot key
result.sourceToDestination.get(sourceEntity); // the same, keyed by source entity
```

## What a snapshot holds

Nothing live. Entity ids, component ids, and relationship edges are all world-local, so a snapshot
records:

- the component **classes** the forest carried, plus each instance's captured **data**;
- each relationship's class, its non-edge **data**, and its **internal targets** as snapshot keys;
- how many targets were **left behind** (see external targets below).

The source's instances are never attached to the destination, and never mutated. Restore builds
every destination component through the same materializer `Entity.set` uses, so aliases,
exclusivity, `add` hooks, and query entry fire exactly once per component, the same as for an
ordinary `set`.

## Selecting what crosses

```ts
world.snapshotSubtree(root, {
  traversal: ChildOf, // default; any registered relationship
  components: [Position, Hull],
  relationships: [ChildOf, Carries],
  externalTargets: "omit", // default
});
```

- **`traversal`** — the relationship that defines "subtree". `ChildOf` by default; a convoy might
  use its own ordering relationship instead. The forest is every entity reachable through that
  relationship, transitively.
- **`components` / `relationships`** — allowlists. Omit one to select every type in that category;
  supply one to select exactly those. `ChildOf` is captured as the traversal relationship whatever
  the `relationships` list says, since without it the result is not a subtree.
- **`externalTargets`** — what to do with a selected edge that points outside the forest.

A cycle in the traversal relationship, or an entity reachable from two roots in one call, is an
error: an ambiguous forest has no single correct capture.

## External targets

An entity outside the forest is not captured, so an edge to it has nowhere to land.

- `"omit"` (default) — drop the edge, record how many targets were dropped.
- `"error"` — refuse to capture at all.

Use `"error"` when leaving data behind is a bug you want to hear about; use `"omit"` when the edge
is genuinely world-bound, like a tether to something the next sector does not own.

## Snapshot policies

Per component type, capture follows the type's `OnSnapshot` declaration. Ordinary plain-data
components need no declaration at all:

```ts
class Position {
  x = 0;
  y = 0;
}
```

`Position` has no policy, so it uses **`ClonePublic`**: a fresh instance with the source instance's
own enumerable fields copied over. That is the same shallow copy `set` performs, and it is exactly
as aliasing-sensitive — a component holding a nested object shares it until something copies it.

### `DontSnapshot`

For state that cannot exist in another world: engine handles, sockets, live queries and systems.

```ts
world.component(PhysicsEngine).snapshotPolicy(DontSnapshot);
```

A `DontSnapshot` type is skipped during capture. **Selecting** one explicitly is an error, so a
caller cannot silently lose state it asked for by name.

### `CustomSnapshot`

For a component that mixes declarative state with runtime state. The owner supplies both halves.

```ts
world.component(Body).snapshotPolicy(CustomSnapshot, {
  // Keep the declarative fields, drop the engine handle.
  capture: (body) => ({ type: body.type }),
  // Build a destination-owned instance.
  materialize: (data) => Object.assign(new Body(), data),
});
```

`capture` receives the live source instance and returns detached data. `materialize` receives that
data and returns a freshly constructed instance belonging to no other entity. The captured value
never has to be JSON — whatever `capture` returns is handed to `materialize` verbatim — but it must
not reference the source world, its entities, or anything the source still holds.

A policy is declared by the module that owns the component type, **before any entity carries it**.
Declaring or changing a policy while the component has carriers throws: entities already captured
under the old policy would restore under a different one.

`@vworlds/vecs-physics` installs policies for its own components, which is why a physics subtree
moves without any physics-specific code in the caller: `PhysicsEngine` is `DontSnapshot`, while
`Body`, the shapes, `Chain`, and the joints capture their declarative fields and let the
destination lifecycle systems allocate fresh Box2D handles.

## Restore order

Restore is ordered, and the order is observable:

1. **Preflight** every captured class against the destination. A class that is not registered there,
   or that the destination declares `DontSnapshot`, fails here — before any entity exists.
2. **Allocate** one destination entity per record, so every edge target exists before any edge is
   added.
3. **Materialize** plain-data components.
4. **Rebuild edges**, traversal relationship first, then everything else. Hierarchy-sensitive
   policies such as `OneOf` and `Traversable` therefore see a complete tree.
5. **Assign** each relationship's non-edge data, in capture order.

If any step throws, everything the attempt created is destroyed and the error propagates, so a
failed restore leaves the destination as it was found.

## Move and rollback

`moveSubtree` captures and preflights **before** it destroys anything, so a snapshot that cannot be
restored leaves the source world untouched.

Once the source is destroyed and the destination restore fails, everything the restore created is
destroyed, the source snapshot is restored back into the source world, and the original error is
rethrown. The rollback rebuilds equivalent state with freshly allocated ids, so `Entity` references
held before a failed move are stale afterwards.

Destroying a root applies its component `remove` hooks and its relationship cleanup policies, which
can reach outside the captured forest. That is what "the source is gone" means; select transferable
data accordingly.

## Deferred worlds

All three operations throw while either world is deferred. Cross-world scheduling is the
application's job — a transfer that interleaved with a half-applied frame of mutations would have no
well-defined outcome. Call them between frames.

## Inheritance

`IsA` edges are never captured. An inheritance edge and the values it materialized would both be
captured, and the destination would end up holding two disagreeing answers. Move an inheriting
entity by selecting its effective values instead. (The inheritance work that introduces `IsA` is
not in vecs yet; when it lands, it must keep declaring `IsA` as `DontSnapshot`.)

## What this is not

- **Not serialization.** A snapshot is an in-memory value, not a wire format, and not stable across
  vecs versions. `@vworlds/vecs-wire` and `@vworlds/vecs-protocol` cover the network case.
- **Not a cross-world transaction.** Two live worlds are not locked together. Capture-then-restore
  cannot make two worlds atomically consistent; it makes the _transfer_ recoverable.
