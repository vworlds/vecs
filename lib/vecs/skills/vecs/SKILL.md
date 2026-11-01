---
name: vecs
description: "Designs, implements, reviews, and debugs games or applications using @vworlds/vecs. Use whenever a task creates or changes vecs components, entities, systems, queries, relationships, modules, phases, lifecycle, networked components, or ECS architecture."
---

# vecs Application Development

Use the documentation shipped with the consuming project's installed `@vworlds/vecs` package.
Those docs match the API version the project actually uses and are the source of truth for vecs
design and behavior.

## Before Working

1. Locate `node_modules/@vworlds/vecs/docs/`. In a workspace or non-npm install, resolve the
   installed `@vworlds/vecs` package and use its adjacent `docs/` directory.
2. Read `docs/design-guide.md` sections 1, 2, 8, and 9 before designing or changing ECS behavior.
3. Read the task-specific sections of that design guide:
   - Components or replicated state: section 3.
   - Systems or queries: section 4.
   - Ordering or timing: section 5.
   - Feature architecture: section 6.
   - Lifecycle and synchronization patterns: section 7.
4. Use `docs/README.md` to select any detailed subsystem guides needed by the task. Read
   `docs/concepts.md` and `docs/execution-model.md` when the design depends on unfamiliar vecs
   behavior.
5. Inspect the consuming project's existing vecs modules and conventions before proposing a new
   pattern.

Do not rely on memory or a different vecs checkout when installed documentation is available.
Confirm exact names and signatures against the installed declarations under
`node_modules/@vworlds/vecs/dist/`.

## Design From ECS Semantics

Start from the vecs golden rule: components are data, systems are behavior, and component presence
and change drive lifecycle.

Before implementing, identify:

- The state represented by each component and whether absence has meaning.
- Which component transition creates, updates, or removes related state or resources.
- Whether the work should react through `enter`, `update`, or `exit` rather than scan every frame.
  An `.each` must justify running every tick; when it does, narrow its query with a tag that exists
  only while the work is live (for example a `Firing` tag that a reactive `update` on the intent
  adds and removes) instead of looping over every candidate and returning early.
  ([`each` vs reactive](../../docs/design-guide.md#each-vs-reactive--dont-scan-when-you-can-react))
- Which phase owns the work and what earlier or later phase it must order against.
- Whether a multi-target relationship, an `Exclusive` relationship, an explicitly created owned
  target, a grouped query, or an attached resource expresses the lifecycle better than imperative
  bookkeeping.
- Whether the feature belongs in a `Module` that owns registration, systems, phases, and policy.

Prefer the idioms in the installed design guide over generic ECS patterns. vecs execution details,
including per-system flushes and reactive inbox routing, are part of the design model.

## Avoid Generic Workarounds

Check the design guide before introducing:

- Side maps keyed by entity id.
- Components containing behavior or broad god-components with optional sentinel fields.
- Per-frame scans for changes that vecs can route reactively.
- Manual lifecycle bookkeeping that duplicates component presence.
- System registration order as a substitute for explicit cross-feature phase ordering.
- Parallel object graphs that duplicate relationships already represented in the ECS.
- Wrapper abstractions that hide normal vecs entities, components, systems, or modules without a
  concrete need.

If the requested design conflicts with a documented vecs invariant, explain the conflict and use
the documented pattern unless the user explicitly chooses otherwise.

## Known Gotchas

Agents trip on these vecs behaviors repeatedly. Design guide sections 8 and 9 list them with the
other anti-patterns and pitfalls; each rule below links to the detail.

- Do not call `getMut` per tick unless a change is intended. It marks the component modified even
  without a callback and even if nothing is written, which fires `update` watchers and replication.
  Read with `get`. ([`getMut`](../../docs/entities.md#getmut-and-ensure-mutating-in-place))
- `.without(X)` does not filter the positive terms' candidates: it keeps a world-sized "not X" set,
  updated on every entity create and destroy and every `X` add or remove, and intersects it with
  them. Use it only when needed, after positive terms that keep the members small; a query with only
  `.without` terms tracks the whole world.
  ([Cost of `.without`](../../docs/queries-and-filters.md#the-cost-of-not-and-without))
- `entity.modified(C)` and `getMut(C)` coalesce into one `update` per drain; every `entity.set(C, …)`
  routes its own, and the system inbox never merges events. Write in place plus `modified`, or
  compare before `set`, and do not add per-tick dedupe batches when producers use `modified`/`getMut`.
  ([Repeated writes](../../docs/systems.md#repeated-writes-in-one-tick))
- A system's `enter` reaches only entities still in its query when the system drains. An entity
  that left the query or died first gets neither `enter` nor the paired `exit`, and a re-entry
  within one drain gives `enter`, `exit`, `enter`, so keep setup and teardown symmetric.
  ([`.enter`](../../docs/systems.md#entercallback--enterinject-callback--enteroptions-callback))
- Create relationship edges with `add(Rel, target)` and read them with `target()` / `targets()`.
  React to the relationship component being removed with `on("remove")` and to each removed edge
  with `on("targetRemove")`. `OwnedTarget` needs `Exclusive` and an explicitly created target, and
  destroys that target when its edge is removed.
  ([Edge hooks](../../docs/relationships.md#edge-hooks),
  [Owned targets](../../docs/relationships.md#owned-targets))
- Link entities with relationship edges, never with an `eid` or `Entity` kept in a component field.
  A destroyed entity's eid is reused after `reuseWaitFrames` (16 frames by default, 0 for replicated
  entities on a `ClientWorld`), so a stale eid can name an unrelated entity. A stored `Entity`
  dangles, and snapshots copy an eid unchanged and reject an `Entity`.
  ([Link with edges, not stored ids](../../docs/relationships.md#link-with-edges-not-stored-ids))
- Prefer `Exclusive` + `OwnedTarget` to a component field that holds a child entity. Removing or
  replacing the edge destroys the child and destroying the child removes the edge, so no remove hook
  is needed. ([Owned targets](../../docs/relationships.md#owned-targets))
- A `remove` hook also fires while its entity is being destroyed, with `entity.destroyed` already
  `true`. Write to it without a guard in a `remove` hook or `exit`: a dying entity silently drops
  every write, including `ensure`. Check `destroyed` only to skip other pointless or unsafe work
  (re-projecting a view, refreshing other entities, releasing shared state). In `exit`, `true` means
  death and `false` means it only left the query; `if (entity.destroyed) return;` expresses teardown
  only for entities that stay alive, not a write workaround.
  ([Hooks](../../docs/components.md#hooks-component-and-relationship-edges))
- A `destroyed` check outside per-step event buffers and hooks on a dying entity or edge target
  usually means a link that should be a relationship edge. Replace the link, not only add the check.
  ([Link with edges, not stored ids](../../docs/relationships.md#link-with-edges-not-stored-ids))
- `@vworlds/vecs-phaser`: a `DrawBy` child turns with its parent only with `InheritRotation`. The
  resolver derives a tagged child's `Rotation` every frame, so writing `Rotation` on it has no
  effect; set `InheritRotation.angle` instead.
  ([Turning with the parent](../../../vecs-phaser-client/README.md#turning-with-the-parent))
- `@vworlds/vecs-phaser`: `DrawBy` and `DrawIn` use `(OnDeleteTarget, Remove)`, so destroying a display
  parent detaches its children and leaves them alive, unlike `ChildOf`. Add `ChildOf` to the parent,
  or make the child an owned target, when it must die with the parent.
  ([Destroying the display parent](../../../vecs-phaser-client/README.md#destroying-the-display-parent))
- `@vworlds/vecs-physics` and `@vworlds/vecs-phaser-server`: pose `set` hooks and `update` systems
  on the physics and render pose fire only when the pose changes. To visit every body every step,
  iterate with `each`.
  ([Pose updates](../../../vecs-physics/docs/systems-and-phases.md#pose-updates-fire-only-when-the-pose-changes))
- `@vworlds/vecs-client`: attach a `ClientWorld` socket only after `socket.connect()`, so no ack
  precedes the data channel (`connectDgram` does this). Pending `invoke` calls reject with
  `RPC_CLOSED_CODE` on disconnect or dispose.
  ([Connecting](../../../vecs-client/docs/client-world.md#connecting),
  [Disconnection and disposal](../../../vecs-client/docs/client-world.md#disconnection-and-disposal))
- `@vworlds/vecs-physics` components hold plain data only, never Box2D wrappers or other class
  instances: snapshot capture rejects non-plain values.
  ([Plain data](../../../vecs-physics/docs/components.md#keep-component-fields-plain-data))

## Implement And Verify

1. Reuse existing components and modules where their semantics match; do not reuse them merely
   because their fields look similar.
2. Keep components small data classes and put behavior in systems or narrowly scoped lifecycle
   hooks as directed by the guide.
3. Express cross-feature ordering with phases. Treat same-phase registration order as a local
   implementation detail unless the installed docs explicitly make it part of the design.
4. Test lifecycle transitions, not only steady-state values: entry, mutation, edge addition and
   removal, exclusive edge replacement, destruction, and same-tick visibility where relevant.
5. Run the consuming project's typecheck and focused tests. Resolve API uncertainty from the
   installed declarations and docs rather than guessing.

For networking, physics, Phaser, client, or server integration, also inspect the README and
declarations shipped with the corresponding `@vworlds/vecs-*` package.
